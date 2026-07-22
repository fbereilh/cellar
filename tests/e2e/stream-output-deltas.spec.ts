import { test, expect, type Page, type Locator, type Response } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the K1 streamed-output DELTA protocol, driven through the real UI + the
 * real `/run` NDJSON wire the initiating tab consumes.
 *
 * The fix (perf/output: stream SSE output as deltas, not the whole buffer per
 * flush) must satisfy two things a reviewer cares about at once:
 *   1. a slow streaming cell still renders BYTE-CORRECT live in the browser, and
 *   2. the wire now carries small `output-append` DELTAS instead of the whole
 *      growing buffer every ~40ms flush — O(size), not O(size × ticks).
 *
 * So this runs two cells against the REAL kernel — a plain streaming log
 * (pure-append deltas) and a `\r`-overwrite progress bar (terminal tail-splice
 * deltas) — and, using Playwright's PASSIVE network capture of the `/run`
 * response (no interception, so the app streams normally), proves:
 *   - the rendered output text in the page is byte-correct;
 *   - the wire established each stream element with exactly ONE full `output`
 *     frame, then only `output-append` deltas;
 *   - replaying those frames (the client's splice) reconstructs the exact text; and
 *   - the bytes actually put on the wire are ~O(final size), far below the
 *     pre-fix whole-buffer-per-tick cost.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like smoke.spec).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** Where reviewer-visible screenshots + the wire transcript land. */
const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || '';

// A plain streaming log: one line per ~60ms across many 40ms flush ticks. Each
// line is its own append, so the deltas are pure appends (keep === base).
const LOG_LINES = 40;
const LOG_SRC = [
	'import time, sys',
	`for i in range(${LOG_LINES}):`,
	'    print(f"line {i:04d}")',
	'    sys.stdout.flush()',
	'    time.sleep(0.06)'
].join('\n');
const LOG_FINAL = Array.from({ length: LOG_LINES }, (_, i) => `line ${String(i).padStart(4, '0')}`).join('\n') + '\n';
const LOG_LAST = `line ${String(LOG_LINES - 1).padStart(4, '0')}`;

// A `\r`-overwrite progress bar: the terminal reducer collapses it to the final
// line, and because it rewrites earlier bytes the deltas are tail-splices
// (keep < base) rather than pure appends. The full-tier reducer renders the true
// final SCREEN, so the trailing `\n` after "done" leaves a trailing blank row
// that is trimmed (exactly what `pyte` / a real terminal capture shows) — hence
// no trailing newline here, unlike a plain (un-reduced) log.
const BAR_SRC = [
	'import time, sys',
	'for i in range(0, 101, 2):',
	'    bar = "#" * (i // 2)',
	'    sys.stdout.write(f"\\r{i:3d}%|{bar:<50}| {i}/100")',
	'    sys.stdout.flush()',
	'    time.sleep(0.05)',
	'sys.stdout.write("\\n")',
	'print("done")'
].join('\n');
const BAR_FINAL = `100%|${'#'.repeat(50)}| 100/100\ndone`;

// A MULTI-LINE cursor repaint (Phase 2 — the case the cheap tier cannot undo):
// two stacked "bars" repainted in place each tick via cursor-up (ESC[1A) +
// erase-line (ESC[2K). The full-tier VT emulator collapses the whole animation
// to the two final lines; the cheap tier would leave raw `[1A`/`[2K` escapes.
const MULTI_SRC = [
	'import time, sys',
	'sys.stdout.write("barA:   0%\\nbarB:   0%")',
	'sys.stdout.flush()',
	'for i in range(10, 101, 10):',
	'    sys.stdout.write(f"\\x1b[1A\\r\\x1b[2KbarA: {i:3d}%\\x1b[1B\\r\\x1b[2KbarB: {i:3d}%")',
	'    sys.stdout.flush()',
	'    time.sleep(0.05)',
	'sys.stdout.write("\\n")',
	'print("done")'
].join('\n');
const MULTI_FINAL = 'barA: 100%\nbarB: 100%\ndone';

/** A code cell for the seeded notebook. */
function cell(id: string, source: string) {
	return {
		id,
		cell_type: 'code',
		metadata: {},
		execution_count: null,
		outputs: [],
		source: source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))
	};
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-stream-'));

	const venv = join(workspace, '.venv');
	expect(spawnSync('uv', ['venv', venv], { stdio: 'inherit' }).status).toBe(0);
	expect(
		spawnSync('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'ipykernel'], { stdio: 'inherit' }).status
	).toBe(0);

	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		JSON.stringify(
			{
				cells: [cell('c-log', LOG_SRC), cell('c-bar', BAR_SRC), cell('c-multi', MULTI_SRC)],
				metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

type WireEvent =
	| { type: 'output'; index: number; output: { output_type: string; text?: string } }
	| { type: 'output-append'; index: number; base: number; keep: number; chunk: string }
	| { type: string };

/** Parse the captured `/run` NDJSON body into its events. */
function parseNdjson(body: string): WireEvent[] {
	return body
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as WireEvent);
}

/**
 * Reconstruct one stream element's text from the wire frames at `index`, applying
 * the SAME splice the client uses: a full `output` frame establishes the text, a
 * delta splices prev.slice(0, keep) + chunk — and its `base` must match the current
 * length (else the client would refetch; in a healthy in-order stream base always
 * matches, so a mismatch here is a hard failure).
 */
function reconstruct(events: WireEvent[], index: number): string {
	let text: string | null = null;
	for (const e of events) {
		if (e.type === 'output') {
			const f = e as Extract<WireEvent, { type: 'output' }>;
			if (f.index === index) text = f.output.text ?? '';
		} else if (e.type === 'output-append') {
			const d = e as Extract<WireEvent, { type: 'output-append' }>;
			if (d.index !== index) continue;
			const cur: string = text ?? '';
			expect(cur.length).toBe(d.base);
			text = cur.slice(0, d.keep) + d.chunk;
		}
	}
	return text ?? '';
}

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/**
 * Run cell `c`, capture its `/run` NDJSON passively (Playwright buffers the
 * response body without intercepting it, so the app streams normally), and wait
 * for the run to actually FINISH by observing the final text in the DOM — the
 * `running-indicator` briefly reads absent between click and `run:start`, so it is
 * not a reliable completion signal.
 */
async function runAndCapture(page: Page, c: Locator, doneText: string): Promise<WireEvent[]> {
	let runResp: Response | null = null;
	const onResp = (r: Response) => {
		if (r.url().includes('/api/cells/') && r.url().endsWith('/run')) runResp = r;
	};
	page.on('response', onResp);
	await c.getByTestId('run').click();
	// The real "done" signal: the final expected content is on screen.
	await expect(c.getByTestId('output-scroll')).toContainText(doneText, { timeout: 90_000 });
	// The stream closes at run:end just after the last output; give it a beat, then
	// read the fully-buffered body.
	await expect.poll(async () => (runResp ? 'ready' : 'waiting'), { timeout: 10_000 }).toBe('ready');
	const body = await (runResp as unknown as Response).text();
	page.off('response', onResp);
	return parseNdjson(body);
}

test('a slow streaming cell renders byte-correct while the wire carries deltas, not the whole buffer', async ({
	page
}) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(3);

	// ---- 1. Plain streaming log: pure-append deltas ----
	const logEvents = await runAndCapture(page, cells.nth(0), LOG_LAST);

	// The browser shows the exact final text, first line through last.
	const logOut = cells.nth(0).getByTestId('output-scroll');
	await expect(logOut).toContainText('line 0000');
	await expect(logOut).toContainText(LOG_LAST);

	const logFull = logEvents.filter((e) => e.type === 'output');
	const logDeltas = logEvents.filter((e) => e.type === 'output-append') as Extract<WireEvent, { type: 'output-append' }>[];
	// A slow log spanning many 40ms ticks must have streamed as deltas, and each
	// stream ELEMENT is established by exactly ONE full frame — never re-sent whole.
	expect(logDeltas.length).toBeGreaterThan(3);
	for (const idx of new Set(logFull.map((e) => (e as { index: number }).index))) {
		expect(logFull.filter((e) => (e as { index: number }).index === idx).length).toBe(1);
	}
	// A pure-append log: every delta keeps the whole prior length (no tail rewrite).
	expect(logDeltas.every((d) => d.keep === d.base)).toBe(true);
	// The wire frames reconstruct the exact final text (the client's splice logic).
	const streamIdx = (logFull[0] as { index: number }).index;
	expect(reconstruct(logEvents, streamIdx)).toBe(LOG_FINAL);

	// Bytes actually on the wire = the one full first frame + every delta chunk. The
	// pre-fix code re-sent the WHOLE growing buffer each flush (Σ ≈ size²/line), so
	// this tight O(size) bound proves that blowup is gone.
	const wireBytes =
		logFull.reduce((n, e) => n + ((e as { output: { text?: string } }).output.text?.length ?? 0), 0) +
		logDeltas.reduce((n, d) => n + d.chunk.length, 0);
	const finalSize = LOG_FINAL.length;
	expect(wireBytes).toBeLessThan(finalSize * 2);
	expect(wireBytes).toBeGreaterThanOrEqual(finalSize);
	// The pre-fix cost: the whole growing buffer re-sent on each of these emissions.
	const emissions = logFull.length + logDeltas.length;
	const naiveBytes = (emissions * (emissions + 1) * (finalSize / Math.max(1, emissions))) / 2;

	// ---- 2. `\r` progress bar: terminal tail-splice deltas ----
	const barEvents = await runAndCapture(page, cells.nth(1), 'done');

	const barOut = cells.nth(1).getByTestId('output-scroll');
	await expect(barOut).toContainText('100%|');
	await expect(barOut).toContainText('| 100/100');
	await expect(barOut).toContainText('done');
	// The reduced text collapses the \r frames — no carriage return survives to the DOM.
	expect(await barOut.textContent()).not.toContain('\r');

	const barFull = barEvents.filter((e) => e.type === 'output');
	const barDeltas = barEvents.filter((e) => e.type === 'output-append') as Extract<WireEvent, { type: 'output-append' }>[];
	expect(barDeltas.length).toBeGreaterThan(0);
	// A CR-overwrite rewrites earlier bytes, so at least one delta is a tail-splice.
	expect(barDeltas.some((d) => d.keep < d.base)).toBe(true);
	const barIdx = (barFull[0] as { index: number }).index;
	expect(reconstruct(barEvents, barIdx)).toBe(BAR_FINAL);

	// ---- 3. Multi-line cursor repaint: full-tier VT collapse (Phase 2) ----
	const multiEvents = await runAndCapture(page, cells.nth(2), 'done');

	const multiOut = cells.nth(2).getByTestId('output-scroll');
	await expect(multiOut).toContainText('barA: 100%');
	await expect(multiOut).toContainText('barB: 100%');
	await expect(multiOut).toContainText('done');
	// The VT emulator collapsed the vertical repaint — no CR nor raw escape reaches
	// the DOM (the cheap tier would have leaked `[1A`/`[2K` here).
	const multiText = (await multiOut.textContent()) ?? '';
	expect(multiText).not.toContain('\r');
	expect(multiText).not.toContain('\x1b');
	expect(multiText).not.toContain('[2K');

	const multiFull = multiEvents.filter((e) => e.type === 'output');
	const multiDeltas = multiEvents.filter((e) => e.type === 'output-append') as Extract<
		WireEvent,
		{ type: 'output-append' }
	>[];
	expect(multiDeltas.length).toBeGreaterThan(0);
	// A vertical repaint rewrites an EARLIER line, so at least one delta tail-splices.
	expect(multiDeltas.some((d) => d.keep < d.base)).toBe(true);
	const multiIdx = (multiFull[0] as { index: number }).index;
	// The client's splice reconstructs the exact final screen, byte-for-byte.
	expect(reconstruct(multiEvents, multiIdx)).toBe(MULTI_FINAL);

	// ---- Evidence: screenshot + a wire transcript artifact ----
	if (EVIDENCE) {
		mkdirSync(EVIDENCE, { recursive: true });
		await page.screenshot({ path: join(EVIDENCE, 'stream-output-deltas.png'), fullPage: true });
		const transcript = [
			'K1 streamed-output delta protocol — real /run NDJSON wire capture',
			'',
			`Plain streaming log cell (c-log): ${LOG_LINES} lines, final size ${finalSize} bytes`,
			`  full "output" frames on wire      : ${logFull.length}   (one per stream element — never re-sent whole)`,
			`  "output-append" delta frames      : ${logDeltas.length}`,
			`  all deltas pure-append (keep==base): ${logDeltas.every((d) => d.keep === d.base)}`,
			`  BYTES actually on wire (post-fix)  : ${wireBytes}`,
			`  bytes if whole buffer re-sent/emit : ${Math.round(naiveBytes)}   (pre-fix O(size × ticks) shape)`,
			`  reduction factor (approx)          : ${(naiveBytes / Math.max(1, wireBytes)).toFixed(1)}×`,
			`  reconstructed == final rendered    : ${reconstruct(logEvents, streamIdx) === LOG_FINAL}`,
			'',
			'Progress-bar cell (c-bar): \\r-overwrite → terminal reducer collapse',
			`  full "output" frames on wire       : ${barFull.length}`,
			`  "output-append" delta frames       : ${barDeltas.length}`,
			`  tail-splice deltas present (keep<base): ${barDeltas.some((d) => d.keep < d.base)}`,
			`  reconstructed final line           : ${JSON.stringify(reconstruct(barEvents, barIdx))}`,
			'',
			'Multi-line repaint cell (c-multi): cursor-up + erase-line → full-tier VT collapse',
			`  full "output" frames on wire       : ${multiFull.length}`,
			`  "output-append" delta frames       : ${multiDeltas.length}`,
			`  tail-splice deltas present (keep<base): ${multiDeltas.some((d) => d.keep < d.base)}`,
			`  reconstructed final screen         : ${JSON.stringify(reconstruct(multiEvents, multiIdx))}`,
			''
		].join('\n');
		writeFileSync(join(EVIDENCE, 'stream-output-deltas.txt'), transcript);
	}
});
