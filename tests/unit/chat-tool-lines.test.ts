/**
 * The chat cell's tool-activity lines, from the CLI's own bytes to what the
 * notebook persists.
 *
 * The fixtures are REAL claude 2.1.241 `stream-json` output, captured by running
 * the CLI with the same flag shape the chat engine uses and committed verbatim -
 * the only edit is that the `system` bookkeeping lines were dropped, because
 * they carry machine-specific paths (the capture machine's cwd and its home
 * directory) and the tool mapping does not consume them. Every event the mapping
 * DOES consume is byte-for-byte what the CLI emitted:
 *
 *   chat-cli-websearch.ndjson   one WebSearch, succeeded
 *   chat-cli-file-tools.ndjson  Read (ok), Read (a missing file: is_error),
 *                               Glob (a pattern of asterisks), Grep (with a path)
 *
 * What is pinned here:
 *
 * - the event-to-line mapping over those fixtures, through the REAL tracker and
 *   formatter, in the CLI's own order;
 * - that NO tool result content reaches the output - asserted against the real
 *   result strings the fixtures carry, including the one that names the child's
 *   working directory, because that is the leak the rule exists to stop;
 * - a failed/refused call is visibly distinguishable from a successful one;
 * - a path is workspace-relative, and one that resolves outside the workspace is
 *   NAMED rather than printed;
 * - an unrecognized tool renders its name and none of its input (the allowlist);
 * - the target is immune to markdown - a glob of asterisks and a query holding
 *   backticks both survive a real markdown-it render as literal text;
 * - the wiring through the REAL engine against a stub `claude` on PATH: the
 *   lines are reported, and NOTHING is reported from a session whose init report
 *   was never seen or did not match the request;
 * - the run glue end to end through the REAL `executeCellRun`: lines interleave
 *   with the reply in stream order, consecutive ones join into one blockquote,
 *   resumed reply text is not swallowed by it, the whole thing persists as the
 *   single markdown output and survives a round trip through the .ipynb on disk.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import {
	ChatToolTracker,
	OUTSIDE_WORKSPACE,
	toolCallLine,
	toolCallTarget,
	type ChatToolCall
} from '../../src/lib/server/chat/tool-lines';
import type { ChatEngineRunArgs } from '../../src/lib/server/chat/engine';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const WEBSEARCH_FIXTURE = join(FIXTURES, 'chat-cli-websearch.ndjson');
const FILE_TOOLS_FIXTURE = join(FIXTURES, 'chat-cli-file-tools.ndjson');
/** The workspace the file-tools capture ran in - its absolute paths are rooted there. */
const FIXTURE_WS = '/tmp/cellar-chat-tools-probe';

/** The reply engine's own markdown config (`$lib/markdown`'s `newEngine`). */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function fixtureEvents(file: string): Record<string, unknown>[] {
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Every `tool_result` string the fixture carries - what must never be rendered. */
function fixtureResultContents(file: string): string[] {
	const out: string[] = [];
	for (const ev of fixtureEvents(file)) {
		if (ev.type !== 'user') continue;
		const content = (ev.message as { content?: unknown[] } | undefined)?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Record<string, unknown>[]) {
			if (block?.type === 'tool_result' && typeof block.content === 'string') out.push(block.content);
		}
	}
	return out;
}

/** Drive the REAL tracker over a fixture; returns the calls it resolved, in order. */
function trackFixture(file: string): ChatToolCall[] {
	const tracker = new ChatToolTracker();
	const calls: ChatToolCall[] = [];
	for (const ev of fixtureEvents(file)) calls.push(...tracker.observe(ev));
	calls.push(...tracker.flush());
	return calls;
}

describe('the event-to-line mapping, over real CLI output', () => {
	it('maps a web-search run to one line naming the search and its query', () => {
		const calls = trackFixture(WEBSEARCH_FIXTURE);
		expect(calls).toEqual([
			{ name: 'WebSearch', input: { query: 'Node.js current stable version' }, outcome: 'ok' }
		]);
		expect(toolCallLine(calls[0], FIXTURE_WS)).toBe('`WebSearch(Node.js current stable version)`');
	});

	it('maps a file-tools run in the CLI’s own order, failure marked, paths relative', () => {
		const lines = trackFixture(FILE_TOOLS_FIXTURE).map((c) => toolCallLine(c, FIXTURE_WS));
		expect(lines).toEqual([
			'`Read(src/lib/loader.py)`',
			'`Read(src/lib/missing.py)` *(failed)*',
			'`Glob(**/*.csv)`',
			'`Grep(load, src)`'
		]);
	});

	it('renders a failed call differently from a successful one', () => {
		const [ok, failed] = trackFixture(FILE_TOOLS_FIXTURE);
		expect(ok.outcome).toBe('ok');
		expect(failed.outcome).toBe('failed');
		const okLine = toolCallLine(ok, FIXTURE_WS);
		const failedLine = toolCallLine(failed, FIXTURE_WS);
		expect(failedLine).toContain('*(failed)*');
		expect(okLine).not.toContain('failed');
		// And the difference survives the render, not just the source.
		expect(md.render(`> ${failedLine}`)).toContain('<em>(failed)</em>');
		expect(md.render(`> ${okLine}`)).not.toContain('<em>');
	});

	it('never renders one byte of a tool RESULT', () => {
		let totalChecked = 0;
		for (const file of [WEBSEARCH_FIXTURE, FILE_TOOLS_FIXTURE]) {
			const calls = trackFixture(file);
			const rendered = calls.map((c) => toolCallLine(c, FIXTURE_WS)).join('\n');
			// A result may legitimately ECHO something the call itself named (Grep
			// answers with the path it searched), so the assertion is about text that
			// could only have come FROM the result: every token of every result that
			// is not also somewhere in a call's own input.
			const fromCalls = JSON.stringify(calls.map((c) => c.input));
			const results = fixtureResultContents(file);
			expect(results.length).toBeGreaterThan(0); // the fixture really carries results
			let checked = 0;
			for (const result of results) {
				// Every non-trivial token of the result - not just the whole string, which
				// a truncating renderer would pass vacuously.
				for (const token of result.split(/\s+/).filter((t) => t.length >= 8)) {
					if (fromCalls.includes(token)) continue;
					checked++;
					expect(rendered).not.toContain(token);
				}
			}
			expect(checked).toBeGreaterThan(0); // this fixture contributed something
			totalChecked += checked;
		}
		// A fixture edit that emptied the check would pass every assertion above.
		expect(totalChecked).toBeGreaterThan(20);
	});

	it('leaks nothing from the failed read’s result, which names the child’s cwd', () => {
		const results = fixtureResultContents(FILE_TOOLS_FIXTURE);
		const cwdLeak = results.find((r) => r.includes('current working directory'));
		expect(cwdLeak).toBeTruthy();
		const rendered = trackFixture(FILE_TOOLS_FIXTURE)
			.map((c) => toolCallLine(c, FIXTURE_WS))
			.join('\n');
		expect(rendered).not.toContain('current working directory');
		expect(rendered).not.toContain('/private/tmp');
	});
});

describe('what a line may say', () => {
	const call = (name: string, input: Record<string, unknown>): ChatToolCall => ({ name, input, outcome: 'ok' });

	it('makes an absolute in-workspace path relative', () => {
		expect(toolCallTarget(call('Read', { file_path: '/ws/src/a.py' }), '/ws')).toBe('src/a.py');
	});

	it('NAMES an out-of-workspace path rather than printing it', () => {
		for (const path of ['/etc/passwd', '/Users/someone/secrets/keys.txt', '../../etc/passwd']) {
			const target = toolCallTarget(call('Read', { file_path: path }), '/ws');
			expect(target).toBe(OUTSIDE_WORKSPACE);
			expect(toolCallLine(call('Read', { file_path: path }), '/ws')).not.toContain('passwd');
		}
	});

	it('does not read a sibling directory sharing the workspace’s name as inside it', () => {
		// The boundary rule `toWorkspaceRel` owns: `/ws2/x.py` is not in `/ws`.
		expect(toolCallTarget(call('Read', { file_path: '/ws2/x.py' }), '/ws')).toBe(OUTSIDE_WORKSPACE);
	});

	it('normalizes a relative path and keeps it', () => {
		expect(toolCallTarget(call('Read', { file_path: './src/./a.py' }), '/ws')).toBe('src/a.py');
		expect(toolCallTarget(call('Read', { file_path: 'src/sub/../a.py' }), '/ws')).toBe('src/a.py');
	});

	it('renders an unrecognized tool’s NAME and none of its input', () => {
		const write = call('Write', { file_path: '/ws/out.txt', content: 'SENSITIVE PAYLOAD' });
		expect(toolCallTarget(write, '/ws')).toBeNull();
		const line = toolCallLine(write, '/ws');
		expect(line).toBe('`Write`');
		expect(line).not.toContain('SENSITIVE');
		expect(line).not.toContain('out.txt');
	});

	it('renders a known tool with no usable field as its bare name', () => {
		expect(toolCallLine(call('WebSearch', {}), '/ws')).toBe('`WebSearch`');
		expect(toolCallLine(call('WebSearch', { query: 42 }), '/ws')).toBe('`WebSearch`');
	});

	it('bounds a long target instead of dropping it', () => {
		const long = 'x'.repeat(500);
		const line = toolCallLine(call('WebSearch', { query: long }), '/ws');
		expect(line.length).toBeLessThan(200);
		expect(line).toContain('…');
		expect(line).toContain('WebSearch(');
	});

	it('flattens a multi-line target to one line', () => {
		const line = toolCallLine(call('WebSearch', { query: 'a\nb\tc' }), '/ws');
		expect(line).not.toContain('\n');
		expect(line).toContain('a b c');
	});

	it('marks a call whose result never arrived', () => {
		expect(toolCallLine({ name: 'WebSearch', input: { query: 'q' }, outcome: 'no_result' }, '/ws')).toBe(
			'`WebSearch(q)` *(no result)*'
		);
	});
});

describe('a target is immune to markdown', () => {
	it('keeps a glob of asterisks literal instead of opening emphasis', () => {
		const line = toolCallLine({ name: 'Glob', input: { pattern: '**/*.csv' }, outcome: 'ok' }, '/ws');
		const html = md.render(`> ${line}\n\nreply text`);
		expect(html).toContain('<code>Glob(**/*.csv)</code>');
		expect(html).not.toContain('<em>Glob'); // emphasis never opened
		expect(html).toContain('<p>reply text</p>'); // the reply after it is intact
	});

	it('survives a target holding backticks', () => {
		const line = toolCallLine({ name: 'WebSearch', input: { query: 'what does ``x`` mean' }, outcome: 'ok' }, '/ws');
		const html = md.render(`> ${line}`);
		expect(html).toContain('WebSearch(what does ``x`` mean)');
		expect(html.match(/<code>/g)).toHaveLength(1); // one span, not a broken pair
	});

	it('keeps underscores and dollars in a path or query literal', () => {
		const line = toolCallLine({ name: 'Read', input: { file_path: 'a_b_c/$x_y.py' }, outcome: 'ok' }, '/ws');
		expect(md.render(`> ${line}`)).toContain('<code>Read(a_b_c/$x_y.py)</code>');
	});
});

describe('the tracker', () => {
	const assistant = (blocks: unknown[]) => ({ type: 'assistant', message: { content: blocks } });
	const user = (blocks: unknown[]) => ({ type: 'user', message: { content: blocks } });

	it('reports each call once, in the order the CLI answered them', () => {
		const t = new ChatToolTracker();
		expect(t.observe(assistant([{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a' } }]))).toEqual([]);
		expect(t.observe(assistant([{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'b' } }]))).toEqual([]);
		// Answered out of order: the report follows the ANSWERS, which is the order
		// the reply's own text is interleaved with.
		expect(t.observe(user([{ type: 'tool_result', tool_use_id: 'b' }])).map((c) => c.input.file_path)).toEqual(['b']);
		expect(t.observe(user([{ type: 'tool_result', tool_use_id: 'a' }])).map((c) => c.input.file_path)).toEqual(['a']);
		// Each once: a repeat result reports nothing, and nothing is left to flush.
		expect(t.observe(user([{ type: 'tool_result', tool_use_id: 'a' }]))).toEqual([]);
		expect(t.flush()).toEqual([]);
	});

	it('reports parallel calls answered in one message, in that message’s order', () => {
		const t = new ChatToolTracker();
		t.observe(
			assistant([
				{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a' } },
				{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'b' } }
			])
		);
		const resolved = t.observe(
			user([
				{ type: 'tool_result', tool_use_id: 'a' },
				{ type: 'tool_result', tool_use_id: 'b', is_error: true }
			])
		);
		expect(resolved.map((c) => [c.input.file_path, c.outcome])).toEqual([
			['a', 'ok'],
			['b', 'failed']
		]);
	});

	it('flushes calls whose result never arrived, in the order they were made', () => {
		const t = new ChatToolTracker();
		t.observe(assistant([{ type: 'tool_use', id: 'a', name: 'WebSearch', input: { query: 'one' } }]));
		t.observe(assistant([{ type: 'tool_use', id: 'b', name: 'WebSearch', input: { query: 'two' } }]));
		t.observe(user([{ type: 'tool_result', tool_use_id: 'a' }]));
		const flushed = t.flush();
		expect(flushed.map((c) => [c.input.query, c.outcome])).toEqual([['two', 'no_result']]);
		expect(t.flush()).toEqual([]); // draining makes a second flush a no-op
	});

	it('ignores shapes it does not understand rather than throwing', () => {
		const t = new ChatToolTracker();
		for (const ev of [
			{ type: 'assistant' },
			{ type: 'assistant', message: { content: 'not an array' } },
			{ type: 'assistant', message: { content: [null, 7, { type: 'text', text: 'hi' }] } },
			{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }, // no id
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'never-seen' }] } },
			{ type: 'stream_event', event: { type: 'content_block_delta' } },
			{ type: 'result', subtype: 'success' }
		] as Record<string, unknown>[]) {
			expect(t.observe(ev)).toEqual([]);
		}
		expect(t.flush()).toEqual([]);
	});

	it('accepts a tool_use whose input is missing or not an object', () => {
		const t = new ChatToolTracker();
		t.observe(assistant([{ type: 'tool_use', id: 'a', name: 'Read' }]));
		t.observe(assistant([{ type: 'tool_use', id: 'b', name: 'Read', input: 'oops' }]));
		const a = t.observe(user([{ type: 'tool_result', tool_use_id: 'a' }]));
		const b = t.observe(user([{ type: 'tool_result', tool_use_id: 'b' }]));
		expect(a[0].input).toEqual({});
		expect(b[0].input).toEqual({});
		expect(toolCallLine(a[0], '/ws')).toBe('`Read`');
	});
});

// -- the wiring, through the REAL engine against a stub `claude` --------------

describe('the engine reports tool calls, and only from a verified session', () => {
	let BIN: string;
	const savedPath = process.env.PATH;

	beforeAll(() => {
		BIN = mkdtempSync(join(tmpdir(), 'cellar-tool-bin-'));
		process.env.PATH = `${BIN}:${process.env.PATH}`;
	});
	afterAll(() => {
		process.env.PATH = savedPath;
		rmSync(BIN, { recursive: true, force: true });
	});

	const SEARCH_INIT = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: ['WebSearch'],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '9.9.9-stub'
	});
	const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' });

	function stubClaude(script: string) {
		writeFileSync(join(BIN, 'claude'), `#!/bin/sh\n${script}\n`);
		chmodSync(join(BIN, 'claude'), 0o755);
	}

	async function runEngine(extra: Partial<ChatEngineRunArgs> = {}) {
		const { claudeCliEngine } = await import('../../src/lib/server/chat/claude-cli');
		const calls: ChatToolCall[] = [];
		const deltas: string[] = [];
		const res = await claudeCliEngine.run({
			prompt: 'q',
			configDir: null,
			webSearch: true,
			signal: new AbortController().signal,
			onDelta: (t) => deltas.push(t),
			onToolCall: (c) => calls.push(c),
			...extra
		} as ChatEngineRunArgs);
		return { res, calls, deltas };
	}

	it('reports the calls in a real captured stream, with the reply text', async () => {
		stubClaude(`cat > /dev/null\necho '${SEARCH_INIT}'\ncat '${WEBSEARCH_FIXTURE}'\necho '${RESULT}'`);
		const { res, calls, deltas } = await runEngine();
		expect(res.ok).toBe(true);
		expect(calls).toEqual([
			{ name: 'WebSearch', input: { query: 'Node.js current stable version' }, outcome: 'ok' }
		]);
		expect(deltas.join('')).toContain('Node.js has two active release lines');
	});

	it('reports NOTHING when the session never reported its capabilities', async () => {
		// No init line at all: the run fails closed, and a tool line is a claim about
		// what the run did, which an unverified session cannot support.
		stubClaude(`cat > /dev/null\ncat '${WEBSEARCH_FIXTURE}'\necho '${RESULT}'`);
		const { res, calls, deltas } = await runEngine();
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(calls).toEqual([]);
		expect(deltas).toEqual([]);
	});

	it('reports NOTHING from a session whose init did not match the request', async () => {
		const CAPABLE = JSON.stringify({
			type: 'system',
			subtype: 'init',
			tools: ['WebSearch', 'Bash'],
			mcp_servers: [],
			slash_commands: [],
			skills: []
		});
		stubClaude(`cat > /dev/null\necho '${CAPABLE}'\ncat '${WEBSEARCH_FIXTURE}'\necho '${RESULT}'\nsleep 0.2`);
		const { res, calls, deltas } = await runEngine();
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(calls).toEqual([]);
		expect(deltas).toEqual([]);
	});

	it('reports a call whose result never arrived, once, at settle', async () => {
		// The assistant's tool_use with no `user` answer after it: the CLI exited
		// mid-call. Exactly one report, marked `no result`.
		const toolUse = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 'x', name: 'WebSearch', input: { query: 'stopped' } }] }
		});
		stubClaude(`cat > /dev/null\necho '${SEARCH_INIT}'\necho '${toolUse}'\necho '${RESULT}'`);
		const { calls } = await runEngine();
		expect(calls).toEqual([{ name: 'WebSearch', input: { query: 'stopped' }, outcome: 'no_result' }]);
	});
});

// -- the run glue, through the REAL executeCellRun ----------------------------

describe('the run glue', () => {
	let WS: string;
	let nbmod: typeof import('../../src/lib/server/notebook');
	let runmod: typeof import('../../src/lib/server/run');
	let enginemod: typeof import('../../src/lib/server/chat/engine');
	let authmod: typeof import('../../src/lib/server/chat/auth');
	let activemod: typeof import('../../src/lib/server/chat/active');

	beforeAll(async () => {
		WS = mkdtempSync(join(tmpdir(), 'cellar-tool-lines-'));
		process.env.CELLAR_WORKSPACE = WS;
		process.env.CELLAR_USER_SETTINGS = join(WS, 'user-settings.json');
		nbmod = await import('../../src/lib/server/notebook');
		runmod = await import('../../src/lib/server/run');
		enginemod = await import('../../src/lib/server/chat/engine');
		authmod = await import('../../src/lib/server/chat/auth');
		activemod = await import('../../src/lib/server/chat/active');
		authmod.__setChatAuthForTests({ kind: 'slot', slot: 'test', account: { loggedIn: true } });
	});
	afterAll(() => rmSync(WS, { recursive: true, force: true }));
	afterEach(() => {
		enginemod.__setChatEngineForTests(null);
		activemod.__resetChatRuns();
	});

	function makeNotebook(name: string): string {
		const nb = join(WS, name);
		writeFileSync(
			nb,
			JSON.stringify({
				cells: [
					{
						cell_type: 'code',
						source: ['ask'],
						metadata: { cellar: { language: 'chat' } },
						outputs: [],
						execution_count: null,
						id: 'chatcell'
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		nbmod.listCells(nb);
		return nb;
	}

	/** The single markdown output a successful chat run persists. */
	async function replyMarkdown(nb: string): Promise<string> {
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'ask' });
		expect(res.status).toBe('ok');
		expect(res.outputs).toHaveLength(1);
		const out = res.outputs[0] as { output_type: string; data: Record<string, string> };
		expect(out.output_type).toBe('display_data');
		return out.data['text/markdown'];
	}

	it('interleaves the lines with the reply, in stream order', async () => {
		const nb = makeNotebook('order.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onDelta, onToolCall }) {
				onDelta('Let me look.\n');
				onToolCall?.({ name: 'Read', input: { file_path: join(WS, 'src/a.py') }, outcome: 'ok' });
				onDelta('It defines `f`.');
				return { ok: true, failure: null, engine: null, replyText: null };
			}
		});
		const md0 = await replyMarkdown(nb);
		expect(md0).toBe('Let me look.\n\n> `Read(src/a.py)`\n\nIt defines `f`.');
		// The blockquote does not swallow the reply text that resumes under it.
		const html = md.render(md0);
		expect(html.indexOf('Let me look')).toBeLessThan(html.indexOf('Read(src/a.py)'));
		expect(html.indexOf('Read(src/a.py)')).toBeLessThan(html.indexOf('It defines'));
		expect(html).toContain('<blockquote>');
		expect(html).toContain('<p>It defines <code>f</code>.</p>'); // outside the quote
	});

	it('joins consecutive calls into ONE blockquote, one per rendered line', async () => {
		const nb = makeNotebook('consecutive.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onDelta, onToolCall }) {
				onToolCall?.({ name: 'Glob', input: { pattern: '**/*.py' }, outcome: 'ok' });
				onToolCall?.({ name: 'Read', input: { file_path: 'src/a.py' }, outcome: 'failed' });
				onToolCall?.({ name: 'WebSearch', input: { query: 'q' }, outcome: 'no_result' });
				onDelta('Done.');
				return { ok: true, failure: null, engine: null, replyText: null };
			}
		});
		const html = md.render(await replyMarkdown(nb));
		expect(html.match(/<blockquote>/g)).toHaveLength(1);
		expect(html.match(/<br>/g)).toHaveLength(2); // three lines, two breaks
		expect(html).toContain('<code>Glob(**/*.py)</code>');
		expect(html).toContain('<em>(failed)</em>');
		expect(html).toContain('<em>(no result)</em>');
	});

	it('starts with a line when the model calls a tool before saying anything', async () => {
		const nb = makeNotebook('leading.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onDelta, onToolCall }) {
				onToolCall?.({ name: 'WebSearch', input: { query: 'node' }, outcome: 'ok' });
				onDelta('Node 24.');
				return { ok: true, failure: null, engine: null, replyText: null };
			}
		});
		expect(await replyMarkdown(nb)).toBe('> `WebSearch(node)`\n\nNode 24.');
	});

	it('still lands the engine’s final reply when only tool lines streamed', async () => {
		// `sawDelta` means the reply TEXT streamed. A CLI build that reports tool
		// calls but no text deltas must not have its whole reply dropped.
		const nb = makeNotebook('replytext.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onToolCall }) {
				onToolCall?.({ name: 'WebSearch', input: { query: 'node' }, outcome: 'ok' });
				return { ok: true, failure: null, engine: null, replyText: 'Node 24.' };
			}
		});
		expect(await replyMarkdown(nb)).toBe('> `WebSearch(node)`\n\nNode 24.');
	});

	it('survives a round trip through the .ipynb on disk', async () => {
		const nb = makeNotebook('roundtrip.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onDelta, onToolCall }) {
				onToolCall?.({ name: 'Read', input: { file_path: join(WS, 'data/sales.csv') }, outcome: 'ok' });
				onDelta('Two columns.');
				return { ok: true, failure: null, engine: null, replyText: null };
			}
		});
		const live = await replyMarkdown(nb);
		expect(live).toContain('> `Read(data/sales.csv)`');
		// Re-read from DISK through the document layer: what a reload shows.
		nbmod.dropDocs(nb);
		const cells = nbmod.listCells(nb);
		const chat = cells.find((c) => c.id === 'chatcell');
		const data = (chat?.outputs?.[0] as { data: Record<string, string | string[]> }).data;
		const diskMd = data['text/markdown'];
		expect(Array.isArray(diskMd) ? diskMd.join('') : diskMd).toBe(live);
	});

	it('a run with no reply text at all still persists its lines', async () => {
		const nb = makeNotebook('toolonly.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onToolCall }) {
				onToolCall?.({ name: 'WebSearch', input: { query: 'node' }, outcome: 'failed' });
				return { ok: true, failure: null, engine: null, replyText: null };
			}
		});
		expect(await replyMarkdown(nb)).toBe('> `WebSearch(node)` *(failed)*');
	});

	it('a run that calls no tool is byte-for-byte what it was before', async () => {
		const nb = makeNotebook('notools.ipynb');
		enginemod.__setChatEngineForTests({
			async run({ onDelta }) {
				onDelta('The value ');
				onDelta('is **1**.');
				return { ok: true, failure: null, engine: null, replyText: null };
			}
		});
		expect(await replyMarkdown(nb)).toBe('The value is **1**.');
	});
});
