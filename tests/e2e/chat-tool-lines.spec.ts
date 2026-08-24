import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * A tool-using chat run, as a HUMAN sees it: the whole chain from the CLI's own
 * bytes through the engine, the run glue, the streaming rail and SSE to what the
 * browser paints, what the `.ipynb` holds, and what comes back after a reload.
 *
 * ## Why the CLI is a stub here, and what that does NOT weaken
 *
 * The events replayed are the REAL ones - `tests/unit/fixtures/chat-cli-websearch.ndjson`
 * is verbatim claude 2.1.241 `stream-json` output, and the stub simply `cat`s it,
 * so every byte the parser sees came from the real binary. What the stub buys is
 * determinism and cost: the shapes are already pinned against the real CLI (in
 * the unit suite, off the same fixture) and its live BEHAVIOUR is pinned by
 * `chat-websearch-grant.spec.ts`, which spends real turns for exactly that. What
 * neither of those can see is the browser, which is this spec's subject: whether
 * the annotations reach a reader, read as subordinate, survive a reload, and
 * carry no result content into the page or the file - and a model free to phrase
 * its reply differently on every run could not pin any of that.
 *
 * The FAILED call is the one synthesized pair (a second WebSearch answered
 * `is_error: true`). Its real shape is pinned off the real file-tools fixture in
 * the unit suite, where a missing file and a confinement refusal both arrive
 * exactly that way; forcing a live search to fail on demand is not something a
 * test can arrange.
 *
 * Gated only on the kernel runtime, which `bootCellar` needs for its sidecar -
 * not on a signed-in `claude`, since the stub answers `auth status` too.
 */

const CHAT_ID = 'chatcell0';
const QUESTION = 'What is the current stable Node.js?';
const FIXTURE = join(import.meta.dirname, '..', 'unit', 'fixtures', 'chat-cli-websearch.ndjson');

/** The search the fixture really made - what the first line must name. */
const REAL_QUERY = 'Node.js current stable version';
/** The synthesized second call, answered with an error. */
const FAILED_QUERY = 'node 26 release date';
/** A third call, made AFTER the prose - so the annotations are seen interleaving. */
const LATE_QUERY = 'node 24 lts end of life';

/**
 * Text that appears ONLY inside the fixture's `tool_result` payload - never in
 * the model's own reply. Asserting on these is what makes "no result content"
 * a real assertion rather than a restatement of the reply.
 */
const RESULT_ONLY = ['v26.5.1', 'Direct Links', 'RisingStack Engineering', 'npm Docs'];

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

/** A mime payload as nbformat stores it: a string, or an array of lines. */
const mimeText = (v: unknown) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');

/** The chat cell's persisted markdown, straight off disk. */
function diskReply(name: string): string {
	const doc = JSON.parse(readFileSync(join(workspace, name), 'utf8')) as { cells: Record<string, unknown>[] };
	const cell = doc.cells.find((c) => c.id === CHAT_ID) as { outputs?: Record<string, unknown>[] } | undefined;
	const out = cell?.outputs?.[0]?.data as Record<string, unknown> | undefined;
	return mimeText(out?.['text/markdown']);
}

/** One synthesized tool_use + tool_result pair, in the CLI's own shape. */
function toolPair(id: string, query: string, isError: boolean, content: string): string[] {
	return [
		JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id, name: 'WebSearch', input: { query } }] }
		}),
		JSON.stringify({
			type: 'user',
			message: { content: [{ tool_use_id: id, type: 'tool_result', ...(isError ? { is_error: true } : {}), content }] }
		})
	];
}

/**
 * The stream the stub replays: the real capture, with two synthesized pairs
 * placed so the run exercises BOTH shapes a reader meets.
 *
 *   the real WebSearch (ok)   ─┐ back to back, so they must merge into ONE
 *   a synthesized one (failed)─┘ dim block, one call per line
 *   the model's prose            (the annotations come BEFORE the text that follows)
 *   a third call (ok)            a SECOND block after the prose - the interleaving
 *
 * The real capture's own `result` line stays last, so the run settles as the CLI
 * settles it.
 */
function stubStream(): string {
	const real = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
	// The real capture answers its search, then streams prose, then results.
	const answeredAt = real.findIndex((l) => l.includes('"type":"user"'));
	const resultAt = real.findIndex((l) => l.includes('"type":"result"'));
	expectIndex(answeredAt, 'the fixture answers its tool call');
	expectIndex(resultAt, 'the fixture ends with a result');
	return [
		...real.slice(0, answeredAt + 1),
		// Result content the output must never show - the same rule the real
		// payload above is asserted against.
		...toolPair('toolu_stub_failed', FAILED_QUERY, true, 'Search failed: SECRETRESULTPAYLOAD upstream returned 503'),
		...real.slice(answeredAt + 1, resultAt),
		...toolPair('toolu_stub_late', LATE_QUERY, false, 'SECRETRESULTPAYLOAD late results'),
		...real.slice(resultAt)
	].join('\n');
}

/** A fixture that no longer has the shape this spec replays is a broken spec. */
function expectIndex(at: number, what: string): void {
	if (at < 0) throw new Error(`the committed CLI fixture no longer matches: ${what}`);
}

/**
 * Install a stub `claude` in the shim directory `bootCellar` puts on the
 * launcher's PATH (it mkdir's that directory and writes only `open`/`xdg-open`,
 * so seeding it first is safe). It answers BOTH things Cellar asks the binary:
 * `auth status --json`, and the `-p` run itself.
 */
function installStubClaude(ws: string): void {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	const stream = join(ws, 'stub-stream.ndjson');
	writeFileSync(stream, `${stubStream()}\n`);
	// The init the engine's exact-allowlist assertion must accept: this run opted
	// into web search, so the session must report exactly that tool.
	const init = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: ['WebSearch'],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '2.1.241-stub'
	});
	const bin = join(shim, 'claude');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "auth" ]; then',
			`  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.com"}'`,
			'  exit 0',
			'fi',
			'cat > /dev/null', // drain the prompt off stdin, as the real CLI does
			`echo '${init}'`,
			`cat '${stream}'`,
			'exit 0',
			''
		].join('\n')
	);
	chmodSync(bin, 0o755);
}

function seedNotebook(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						id: CHAT_ID,
						metadata: { cellar: { language: 'chat' } },
						source: [QUESTION],
						outputs: [],
						execution_count: null
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
}

async function openFresh(page: Page, name: string): Promise<string> {
	seedNotebook(name);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(cellBy(page, CHAT_ID)).toBeVisible({ timeout: 30_000 });
	return name;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-tool-lines-e2e-'));
	installStubClaude(workspace);
	// Web search ON, so the engine requests the tool the stub's init reports. The
	// harness points CELLAR_USER_SETTINGS at this file.
	mkdirSync(join(workspace, '.cellar'), { recursive: true });
	writeFileSync(join(workspace, '.cellar', 'user-settings.json'), JSON.stringify({ 'cellar-chat-web-search': true }));
	const booted = await bootCellar(workspace, { CELLAR_CHAT_SLOTS: join(workspace, 'chat-slots') });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
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

test('a tool-using chat run shows one line per call, in order, and never a result', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'tool-lines.ipynb');
	const chat = cellBy(page, CHAT_ID);

	await chat.getByTestId('run').click();

	// The reply lands as RENDERED markdown, and the annotations are inside it.
	const reply = chat.getByTestId('output-markdown');
	await expect(reply).toBeVisible({ timeout: 120_000 });
	await expect(reply).toContainText(`WebSearch(${REAL_QUERY})`, { timeout: 60_000 });

	await expect(reply).toContainText(`WebSearch(${LATE_QUERY})`, { timeout: 60_000 });

	// One line per call, in the order the CLI answered them, INTERLEAVED with the
	// reply - each line before the text that follows it. Read off the rendered
	// text, which is what a human sees.
	const rendered = (await reply.innerText()).replace(/\s+/g, ' ');
	const firstAt = rendered.indexOf(`WebSearch(${REAL_QUERY})`);
	const failedAt = rendered.indexOf(`WebSearch(${FAILED_QUERY})`);
	const proseAt = rendered.indexOf('Node.js has two active release lines');
	const lateAt = rendered.indexOf(`WebSearch(${LATE_QUERY})`);
	expect(firstAt).toBeGreaterThanOrEqual(0);
	expect(failedAt).toBeGreaterThan(firstAt);
	expect(proseAt).toBeGreaterThan(failedAt);
	expect(lateAt).toBeGreaterThan(proseAt);

	// The failed call is visibly distinguishable from the successful one: the
	// marker sits on ITS line and on no other.
	const lines = (await reply.innerText()).split('\n');
	const okLine = lines.find((l) => l.includes(`WebSearch(${REAL_QUERY})`)) ?? '';
	const failLine = lines.find((l) => l.includes(`WebSearch(${FAILED_QUERY})`)) ?? '';
	expect(failLine).toContain('(failed)');
	expect(okLine).not.toContain('(failed)');

	// NOT ONE BYTE of any tool result reaches the page - neither the real search
	// payload's contents nor the synthesized failure's.
	const pageText = await page.locator('body').innerText();
	for (const token of [...RESULT_ONLY, 'SECRETRESULTPAYLOAD', 'upstream returned 503', 'late results']) {
		expect(pageText).not.toContain(token);
	}

	// Nor into the file. Read the persisted reply once it has landed.
	await expect.poll(() => diskReply(nb), { timeout: 30_000 }).toContain(`WebSearch(${REAL_QUERY})`);
	const saved = diskReply(nb);
	expect(saved).toContain('> `WebSearch(');
	expect(saved).toContain('*(failed)*');
	for (const token of [...RESULT_ONLY, 'SECRETRESULTPAYLOAD']) expect(saved).not.toContain(token);

	expect(errors).toEqual([]);
});

test('the annotations are subordinate to the answer, and survive a reload', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'tool-lines-reload.ipynb');
	const chat = cellBy(page, CHAT_ID);
	await chat.getByTestId('run').click();
	const reply = chat.getByTestId('output-markdown');
	await expect(reply).toContainText(`WebSearch(${REAL_QUERY})`, { timeout: 120_000 });

	await expect(reply).toContainText(`WebSearch(${LATE_QUERY})`, { timeout: 60_000 });

	// Consecutive calls merge into ONE dim block, one per line - the harness
	// reading, not a stack of separately-bordered quotes - while the call made
	// after the prose gets its own block, under the text it followed.
	const quotes = reply.locator('blockquote');
	await expect(quotes).toHaveCount(2);
	await expect(quotes.first().locator('code')).toHaveCount(2);
	await expect(quotes.nth(1).locator('code')).toHaveCount(1);

	// Subordinate: the block's ink is dimmer than the answer's, and it is set
	// apart by its own left rule. Both come from the app's existing blockquote
	// style, so this asserts the annotations really landed in that family.
	const style = await quotes.first().evaluate((el) => {
		const cs = getComputedStyle(el);
		const body = getComputedStyle(el.closest('[data-testid="output-markdown"]') as HTMLElement);
		return { quote: cs.color, body: body.color, borderLeft: parseFloat(cs.borderLeftWidth) };
	});
	expect(style.borderLeft).toBeGreaterThan(0);
	expect(style.quote).not.toBe(style.body);

	// A reopened notebook shows them, with no CLI and no run: this is what makes
	// the provenance durable rather than a live-only affordance.
	await expect.poll(() => diskReply(nb), { timeout: 30_000 }).toContain('WebSearch(');
	await page.reload();
	await page.locator(`[data-testid="tree-file"][data-path="${nb}"]`).click();
	const reopened = cellBy(page, CHAT_ID).getByTestId('output-markdown');
	await expect(reopened).toBeVisible({ timeout: 30_000 });
	await expect(reopened).toContainText(`WebSearch(${REAL_QUERY})`);
	await expect(reopened).toContainText('(failed)');
	await expect(reopened).toContainText(`WebSearch(${LATE_QUERY})`);
	await expect(reopened.locator('blockquote')).toHaveCount(2);

	expect(errors).toEqual([]);
});
