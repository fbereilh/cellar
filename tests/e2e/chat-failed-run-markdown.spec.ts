import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { reapPids } from './chat-run-fixture';

/**
 * A chat run that FAILS, and one that is CANCELLED, as a human reads them: the
 * partial reply that survived is RENDERED markdown - the model's own emphasis
 * and Cellar's own tool-activity lines (the `>` quote, the backtick call
 * signature, `*(failed)*` / `*(no result)*`) - beside the failure message, and
 * never the literal syntax. Both are asserted in the browser, on disk and after
 * a reload, since the literal syntax was exactly what a reload used to bring
 * back for good.
 *
 * Whether every client ends up holding exactly what persisted - the no-retract
 * invariant the finalize has to respect - is PROVEN in `tests/unit/chat-run.test.ts`,
 * which replays every published frame by the client's own rules. This spec is
 * the half no frame replay can see: what the page paints.
 *
 * The CLI is a stub that emits the CLI's own `stream-json` shapes (the same ones
 * `chat-tool-lines.spec.ts` replays from a real capture), because neither a
 * failing API turn nor a run that hangs until Stop can be arranged on demand
 * against the real binary. It answers `auth status` too, so no signed-in CLI is
 * needed; the prompt it reads on stdin picks which of the two runs it plays.
 */

const CHAT_ID = 'chatcell0';
/** The question that makes the stub hang until Stop; any other one fails. */
const STOP_MARKER = 'PLEASE-HANG-UNTIL-STOPPED';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
/** The stub's pid on the hanging run, reaped at teardown come what may. */
const started: number[] = [];

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

const delta = (text: string) =>
	JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const toolUse = (id: string, query: string) =>
	JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'WebSearch', input: { query } }] } });
const toolResult = (id: string, isError: boolean, content: string) =>
	JSON.stringify({
		type: 'user',
		message: { content: [{ tool_use_id: id, type: 'tool_result', ...(isError ? { is_error: true } : {}), content }] }
	});

function installStubClaude(ws: string): void {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	// Web search is ON for this workspace (see beforeAll), so the session must
	// report exactly that tool or the engine fails the run closed as unsafe_init.
	const init = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: ['WebSearch'],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '9.9.9-stub'
	});
	// FAILED: text, an answered call, a failed call, more text - then the CLI
	// reports an error result and exits non-zero, as an overloaded API turn does.
	const failStream = join(ws, 'fail-stream.ndjson');
	writeFileSync(
		failStream,
		[
			delta('Here is some **partial** progress.\n'),
			toolUse('toolu_ok', 'node lts'),
			toolResult('toolu_ok', false, 'SECRETRESULTPAYLOAD ok'),
			toolUse('toolu_bad', 'node 26 release'),
			toolResult('toolu_bad', true, 'SECRETRESULTPAYLOAD 503'),
			delta('So far the answer is _v24_'),
			JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded' }),
			''
		].join('\n')
	);
	// CANCELLED: text, then a call that never comes back - the run hangs until Stop.
	const stopStream = join(ws, 'stop-stream.ndjson');
	writeFileSync(stopStream, [delta('Thinking about **it** now.\n'), toolUse('toolu_slow', 'slow search'), ''].join('\n'));
	const pidfile = join(ws, 'stub.pid');
	const bin = join(shim, 'claude');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "auth" ]; then',
			`  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.com"}'`,
			'  exit 0',
			'fi',
			'prompt=$(cat)', // drain the prompt off stdin, as the real CLI does
			`echo '${init}'`,
			'case "$prompt" in',
			`  *${STOP_MARKER}*)`,
			`    cat '${stopStream}'`,
			`    echo $$ > '${pidfile}'`,
			'    exec sleep 900 ;;',
			'  *)',
			`    cat '${failStream}'`,
			'    exit 1 ;;',
			'esac',
			''
		].join('\n')
	);
	chmodSync(bin, 0o755);
}

function seedNotebook(name: string, question: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						id: CHAT_ID,
						metadata: { cellar: { language: 'chat' } },
						source: [question],
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

async function openFresh(page: Page, name: string, question: string) {
	seedNotebook(name, question);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	const chat = cellBy(page, CHAT_ID);
	await expect(chat).toBeVisible({ timeout: 30_000 });
	return chat;
}

/** The chat cell's persisted outputs, straight off disk. */
function diskOutputs(name: string): { output_type: string; data?: Record<string, unknown> }[] {
	const doc = JSON.parse(readFileSync(join(workspace, name), 'utf8')) as { cells: Record<string, unknown>[] };
	const cell = doc.cells.find((c) => c.id === CHAT_ID) as { outputs?: { output_type: string }[] } | undefined;
	return cell?.outputs ?? [];
}

const mimeText = (v: unknown) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');

/**
 * The reply block is RENDERED: its emphasis is an element, its tool lines are a
 * blockquote of code spans, and none of the markdown that produced them is left
 * on the page as text.
 */
async function expectRenderedReply(reply: ReturnType<Page['locator']>, emphasis: string, calls: string[], marker: string) {
	await expect(reply.locator('strong, em').filter({ hasText: emphasis })).toHaveCount(1);
	const quote = reply.locator('blockquote');
	await expect(quote).toHaveCount(1);
	for (const call of calls) await expect(quote.locator('code').filter({ hasText: call })).toHaveCount(1);
	await expect(quote).toContainText(marker);
	const text = await reply.innerText();
	for (const literal of ['**', '> `', '*(', ')*', '\\']) expect(text).not.toContain(literal);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-chat-failed-md-e2e-'));
	installStubClaude(workspace);
	mkdirSync(join(workspace, '.cellar'), { recursive: true });
	writeFileSync(join(workspace, '.cellar', 'user-settings.json'), JSON.stringify({ 'cellar-chat-web-search': true }));
	const booted = await bootCellar(workspace, { CELLAR_CHAT_SLOTS: join(workspace, 'chat-slots') });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	reapPids(started);
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

test('a FAILED run renders its partial reply and tool lines beside the failure, and keeps them after a reload', async ({
	page
}) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const name = 'chat-failed.ipynb';
	const chat = await openFresh(page, name, 'what is the current node?');
	await chat.getByTestId('run').click();

	const blocks = chat.getByTestId('output-markdown');
	await expect(blocks).toHaveCount(2, { timeout: 120_000 });
	await expect(blocks.last()).toContainText('529 overloaded');
	await expectRenderedReply(blocks.first(), 'partial', ['WebSearch(node lts)', 'WebSearch(node 26 release)'], '(failed)');
	await expect(blocks.first()).toContainText('So far the answer is v24');
	// No stream element is left for the reply to show literally in.
	await expect(chat.locator('[data-testid="output"] pre')).toHaveCount(0);
	// The result payloads never reach the page.
	expect(await page.locator('body').innerText()).not.toContain('SECRETRESULTPAYLOAD');

	// On disk: two markdown outputs, the reply's syntax intact for the renderer.
	await expect.poll(() => diskOutputs(name).map((o) => o.output_type), { timeout: 30_000 }).toEqual(['display_data', 'display_data']);
	const saved = mimeText(diskOutputs(name)[0].data?.['text/markdown']);
	expect(saved).toContain('**partial**');
	expect(saved).toContain('> `WebSearch(node lts)`');
	expect(saved).toContain('`WebSearch(node 26 release)` *(failed)*');

	// A reopened notebook renders it the same way, with no CLI and no run.
	await page.reload();
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	const reopened = cellBy(page, CHAT_ID).getByTestId('output-markdown');
	await expect(reopened).toHaveCount(2, { timeout: 30_000 });
	await expectRenderedReply(reopened.first(), 'partial', ['WebSearch(node lts)', 'WebSearch(node 26 release)'], '(failed)');

	expect(errors).toEqual([]);
});

test('a CANCELLED run renders its partial reply and its no-result line beside the interruption', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const name = 'chat-cancelled.ipynb';
	const pidfile = join(workspace, 'stub.pid');
	rmSync(pidfile, { force: true });
	const chat = await openFresh(page, name, `${STOP_MARKER} what is it?`);
	await chat.getByTestId('run').click();

	// The partial reply has reached the page as live stream text before the stop.
	await expect(chat).toContainText('Thinking about', { timeout: 60_000 });
	await expect.poll(() => (existsSync(pidfile) ? Number(readFileSync(pidfile, 'utf8').trim()) : 0), { timeout: 30_000 }).toBeGreaterThan(0);
	started.push(Number(readFileSync(pidfile, 'utf8').trim()));

	await chat.getByTestId('cell-interrupt').click();
	await expect(chat.getByTestId('running-indicator')).toHaveCount(0, { timeout: 10_000 });

	const blocks = chat.getByTestId('output-markdown');
	await expect(blocks).toHaveCount(2, { timeout: 30_000 });
	await expect(blocks.last()).toContainText('(interrupted)');
	await expectRenderedReply(blocks.first(), 'it', ['WebSearch(slow search)'], '(no result)');
	await expect(chat.locator('[data-testid="output"] pre')).toHaveCount(0);

	await expect.poll(() => diskOutputs(name).map((o) => o.output_type), { timeout: 30_000 }).toEqual(['display_data', 'display_data']);
	const saved = mimeText(diskOutputs(name)[0].data?.['text/markdown']);
	expect(saved).toContain('**it**');
	expect(saved).toContain('`WebSearch(slow search)` *(no result)*');

	await page.reload();
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	const reopened = cellBy(page, CHAT_ID).getByTestId('output-markdown');
	await expect(reopened).toHaveCount(2, { timeout: 30_000 });
	await expectRenderedReply(reopened.first(), 'it', ['WebSearch(slow search)'], '(no result)');

	expect(errors).toEqual([]);
});
