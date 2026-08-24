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
const FILE_FIXTURE = join(import.meta.dirname, '..', 'unit', 'fixtures', 'chat-cli-file-tools.ndjson');
/** The workspace the file-tools capture ran in - its absolute paths are rooted there. */
const FILE_FIXTURE_WS = '/tmp/cellar-chat-tools-probe';

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
/** A SECOND instance, with workspace READS on rather than web search. */
let readsLauncher: ChildProcess | null = null;
let readsWorkspace = '';
let readsURL = '';

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
function diskReply(name: string, ws = workspace): string {
	const doc = JSON.parse(readFileSync(join(ws, name), 'utf8')) as { cells: Record<string, unknown>[] };
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

/**
 * The file-tools capture, re-rooted at THIS run's workspace.
 *
 * The events are the real ones and the substitution is one directory string for
 * another - which is the whole point: the capture's `Read` calls carry ABSOLUTE
 * paths, so re-rooting them is what lets the browser prove the workspace-relative
 * rendering on real input instead of a hand-written path. One synthesized read of
 * `/etc/passwd` is appended, because a path OUTSIDE the workspace is the other
 * half of that rule and no in-workspace capture can contain one.
 */
function fileStubStream(ws: string): string {
	const real = readFileSync(FILE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
	expectIndex(real.findIndex((l) => l.includes(FILE_FIXTURE_WS)), 'the file fixture carries absolute paths');
	const rerooted = real.map((l) => l.split(FILE_FIXTURE_WS).join(ws));
	const resultAt = rerooted.findIndex((l) => l.includes('"type":"result"'));
	expectIndex(resultAt, 'the file fixture ends with a result');
	const outside = [
		JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 'toolu_stub_outside', name: 'Read', input: { file_path: '/etc/passwd' } }] }
		}),
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						tool_use_id: 'toolu_stub_outside',
						type: 'tool_result',
						is_error: true,
						content: 'Claude requested permissions to read from /etc/passwd, but you have not granted it yet.'
					}
				]
			}
		})
	];
	return [...rerooted.slice(0, resultAt), ...outside, ...rerooted.slice(resultAt)].join('\n');
}

/** The stub for the READS shape: its init must report exactly the read tools. */
function installReadsStubClaude(ws: string): void {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	const stream = join(ws, 'stub-stream.ndjson');
	writeFileSync(stream, `${fileStubStream(ws)}\n`);
	const init = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: ['Read', 'Glob', 'Grep'],
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
			'cat > /dev/null',
			`echo '${init}'`,
			`cat '${stream}'`,
			'exit 0',
			''
		].join('\n')
	);
	chmodSync(bin, 0o755);
}

function seedNotebook(name: string, ws = workspace): void {
	writeFileSync(
		join(ws, name),
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

async function openFresh(page: Page, name: string, ws = workspace, url = baseURL): Promise<string> {
	seedNotebook(name, ws);
	await page.goto(`${url}/?ws=${encodeURIComponent(ws)}`);
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

	// The reads shape gets its OWN instance: the capability is a person-scoped
	// setting the engine reads at run time, and the stub's init has to report the
	// tool set THAT run requests, so one workspace cannot serve both.
	readsWorkspace = mkdtempSync(join(tmpdir(), 'cellar-tool-lines-reads-'));
	installReadsStubClaude(readsWorkspace);
	mkdirSync(join(readsWorkspace, '.cellar'), { recursive: true });
	writeFileSync(
		join(readsWorkspace, '.cellar', 'user-settings.json'),
		JSON.stringify({ 'cellar-chat-workspace-reads': true })
	);
	const bootedReads = await bootCellar(readsWorkspace, { CELLAR_CHAT_SLOTS: join(readsWorkspace, 'chat-slots') });
	readsLauncher = bootedReads.proc;
	readsURL = bootedReads.url;
});

test.afterAll(() => {
	for (const proc of [launcher, readsLauncher]) if (proc) killCellar(proc);
	launcher = null;
	readsLauncher = null;
	for (const ws of [workspace, readsWorkspace]) {
		if (!ws || !existsSync(ws)) continue;
		try {
			rmSync(ws, { recursive: true, force: true });
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

test('a workspace read shows the tool and the workspace-relative path, and never an outside one', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'reads.ipynb', readsWorkspace, readsURL);
	const chat = cellBy(page, CHAT_ID);
	await chat.getByTestId('run').click();

	const reply = chat.getByTestId('output-markdown');
	await expect(reply).toBeVisible({ timeout: 120_000 });
	await expect(reply).toContainText('Read(src/lib/loader.py)', { timeout: 60_000 });

	const rendered = await reply.innerText();
	// The capture's calls carried ABSOLUTE paths under this workspace; every one
	// reads workspace-relative, and the absolute prefix appears nowhere.
	expect(rendered).toContain('Read(src/lib/loader.py)');
	expect(rendered).toContain('Read(src/lib/missing.py)');
	expect(rendered).toContain('Glob(**/*.csv)');
	expect(rendered).toContain('Grep(load, src)');
	expect(rendered).not.toContain(readsWorkspace);
	expect(rendered).not.toContain('/private/');

	// The failed read is marked, the successful one is not.
	const lines = rendered.split('\n');
	expect(lines.find((l) => l.includes('Read(src/lib/missing.py)')) ?? '').toContain('(failed)');
	expect(lines.find((l) => l.includes('Read(src/lib/loader.py)')) ?? '').not.toContain('(failed)');

	// A path OUTSIDE the workspace is NAMED, never printed - and it is the one
	// the CLI refused, so it also carries the failed marker.
	const outsideLine = lines.find((l) => l.includes('outside the workspace')) ?? '';
	expect(outsideLine).toContain('Read(outside the workspace)');
	expect(outsideLine).toContain('(failed)');
	expect(rendered).not.toContain('passwd');

	// And no result content, in the page or the file - a read's result is the
	// user's own file content, which is exactly what must not land in a notebook.
	const pageText = await page.locator('body').innerText();
	for (const token of ['def load_sales', 'return 42', 'current working directory', 'granted it yet']) {
		expect(pageText).not.toContain(token);
	}
	await expect.poll(() => diskReply(nb, readsWorkspace), { timeout: 30_000 }).toContain('Read(src/lib/loader.py)');
	const saved = diskReply(nb, readsWorkspace);
	expect(saved).not.toContain(readsWorkspace);
	expect(saved).not.toContain('passwd');
	expect(saved).toContain('outside the workspace');

	expect(errors).toEqual([]);
});
