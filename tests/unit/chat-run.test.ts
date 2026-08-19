/**
 * The chat run pipeline through the REAL `executeCellRun` + document layer,
 * with the engine scripted (`__setChatEngineForTests`) and the auth resolution
 * pinned (`__setChatAuthForTests`) - so what is proven is Cellar's own glue:
 *
 * - the prompt the ENGINE receives excludes a hidden cell (the run-path half of
 *   the transcript guarantee - the unit that makes "provably absent from what
 *   was sent" true where it matters);
 * - a successful run persists ONE `display_data` carrying `text/markdown` (the
 *   reply survives clean-on-save and a reload - read back from the .ipynb ON
 *   DISK), with `session` null (no kernel touched, ran_this_session honestly
 *   false) and never `kernel_unavailable`;
 * - each failure persists a friendly markdown message (never a traceback), and
 *   `lastRun.chatFailure` rides the published `run:end` so the bulk-run loop
 *   can stop on `rate_limited`;
 * - `abortChatRuns(nb)` reaches a run in flight (the interrupt/restart/teardown
 *   door) and it settles `cancelled`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEngine, ChatEngineRunArgs } from '../../src/lib/server/chat/engine';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let runmod: typeof import('../../src/lib/server/run');
let runchat: typeof import('../../src/lib/server/chat/run-chat');
let enginemod: typeof import('../../src/lib/server/chat/engine');
let authmod: typeof import('../../src/lib/server/chat/auth');
let activemod: typeof import('../../src/lib/server/chat/active');
let events: typeof import('../../src/lib/server/events');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-chat-run-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	runmod = await import('../../src/lib/server/run');
	runchat = await import('../../src/lib/server/chat/run-chat');
	enginemod = await import('../../src/lib/server/chat/engine');
	authmod = await import('../../src/lib/server/chat/auth');
	activemod = await import('../../src/lib/server/chat/active');
	events = await import('../../src/lib/server/events');
	authmod.__setChatAuthForTests({ kind: 'slot', slot: 'test', account: { loggedIn: true, email: 't@example.com' } });
});

afterEach(() => {
	enginemod.__setChatEngineForTests(null);
	activemod.__resetChatRuns();
});

/** A notebook: python cell / hidden cell / chat cell. */
function makeNotebook(name: string): { nb: string; ids: string[] } {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null, id: 'pycell' },
				{
					cell_type: 'code',
					source: ['SECRET = "hunter2"'],
					metadata: { cellar: { hidden_from_agent: true } },
					outputs: [],
					execution_count: null,
					id: 'hidden'
				},
				{
					cell_type: 'code',
					source: ['What is x?'],
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
	return { nb, ids: nbmod.listCells(nb).map((c) => c.id) };
}

function scriptedEngine(run: (args: ChatEngineRunArgs) => ReturnType<ChatEngine['run']>): { prompts: string[] } {
	const prompts: string[] = [];
	enginemod.__setChatEngineForTests({
		run(args) {
			prompts.push(args.prompt);
			return run(args);
		}
	});
	return { prompts };
}

describe('a successful chat run', () => {
	it('streams deltas, persists ONE markdown display_data, stamps ok with no session', async () => {
		const { nb } = makeNotebook('ok.ipynb');
		const { prompts } = scriptedEngine(async ({ onDelta }) => {
			onDelta('The value ');
			onDelta('is **1**.\n');
			return { ok: true, failure: null, engine: 'claude-cli/9.9.9', replyText: 'The value is **1**.' };
		});
		const endEvents: Record<string, unknown>[] = [];
		const unsub = events.subscribe((ev: Record<string, unknown>) => {
			if (ev.type === 'run:end' && ev.nb === nb) endEvents.push(ev);
		});
		try {
			const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'What is x?' });
			expect(res.status).toBe('ok');
			expect(res.session).toBeNull(); // no kernel: ran_this_session honestly false
			expect(res.kernelDown).toBe(false);
			expect(res.outputs).toEqual([
				{
					output_type: 'display_data',
					data: { 'text/markdown': 'The value is **1**.', 'text/plain': 'The value is **1**.' },
					metadata: {}
				}
			]);
			// The engine received the transcript: visible cells in, hidden cell OUT.
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain('x = 1');
			expect(prompts[0]).toContain('[question]\nWhat is x?');
			expect(prompts[0]).not.toContain('hunter2');
			expect(prompts[0]).not.toContain('SECRET');
			// The reply survived clean-on-save: it is IN the .ipynb on disk, as
			// text/markdown - a reload shows it, and plain Jupyter renders it.
			const disk = JSON.parse(readFileSync(nb, 'utf8'));
			const chat = disk.cells.find((c: { id: string }) => c.id === 'chatcell');
			expect(chat.outputs).toHaveLength(1);
			expect(chat.outputs[0].output_type).toBe('display_data');
			const diskMd = chat.outputs[0].data['text/markdown'];
			expect((Array.isArray(diskMd) ? diskMd.join('') : diskMd) as string).toBe('The value is **1**.');
			// lastRun: ok, engine provenance, NO chatFailure - and runtime-only
			// (stripped from the disk copy just read).
			expect(res.lastRun.status).toBe('ok');
			expect(res.lastRun.chatEngine).toBe('claude-cli/9.9.9');
			expect(res.lastRun.chatFailure).toBeUndefined();
			expect(chat.metadata.cellar?.lastRun).toBeUndefined();
			expect(endEvents).toHaveLength(1);
			expect(endEvents[0].chatFailure).toBeUndefined();
		} finally {
			unsub();
		}
	});

	it('an empty reply persists no output at all (nothing invented)', async () => {
		const { nb } = makeNotebook('empty.ipynb');
		scriptedEngine(async () => ({ ok: true, failure: null, engine: null, replyText: null }));
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
		expect(res.outputs).toEqual([]);
	});
});

describe('failures are distinct, friendly and legible to the bulk loop', () => {
	it('rate_limited persists actionable markdown and rides run:end as chatFailure', async () => {
		const { nb } = makeNotebook('limited.ipynb');
		scriptedEngine(async () => ({
			ok: false,
			failure: { kind: 'rate_limited', message: 'limit reached', resetsAt: 1_900_000_000 },
			engine: 'claude-cli/9.9.9',
			replyText: null
		}));
		const endEvents: Record<string, unknown>[] = [];
		const unsub = events.subscribe((ev: Record<string, unknown>) => {
			if (ev.type === 'run:end' && ev.nb === nb) endEvents.push(ev);
		});
		try {
			const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(res.status).toBe('error');
			expect(res.kernelDown).toBe(false); // a chat failure is never "kernel down"
			expect(res.lastRun.chatFailure).toBe('rate_limited');
			expect(endEvents[0].chatFailure).toBe('rate_limited'); // what runCodeIds stops on
			// A friendly markdown message, not a traceback.
			expect(res.outputs).toHaveLength(1);
			expect(res.outputs[0].output_type).toBe('display_data');
			const md = (res.outputs[0] as { data: Record<string, unknown> }).data['text/markdown'] as string;
			expect(md).toContain('Rate limited');
			expect(md).toContain('switch'); // names the remedy
		} finally {
			unsub();
		}
	});

	it('not_signed_in / not_installed are decided BEFORE any engine runs', async () => {
		const { nb } = makeNotebook('noauth.ipynb');
		const { prompts } = scriptedEngine(async () => {
			throw new Error('the engine must not run with no credential');
		});
		authmod.__setChatAuthForTests({ kind: 'none' });
		try {
			const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(prompts).toHaveLength(0);
			expect(res.status).toBe('error');
			expect(res.lastRun.chatFailure).toBe('not_signed_in');
			const md = (res.outputs[0] as { data: Record<string, string> }).data['text/markdown'];
			expect(md).toContain('Not signed in');

			authmod.__setChatAuthForTests({ kind: 'none', notInstalled: true });
			const res2 = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(res2.lastRun.chatFailure).toBe('not_installed');
			const md2 = (res2.outputs[0] as { data: Record<string, string> }).data['text/markdown'];
			expect(md2).toContain('not installed');
		} finally {
			authmod.__setChatAuthForTests({ kind: 'slot', slot: 'test', account: { loggedIn: true } });
		}
	});

	it('a partial reply cut by a failure keeps the streamed text AND the message', async () => {
		const { nb } = makeNotebook('partial.ipynb');
		scriptedEngine(async ({ onDelta }) => {
			onDelta('Half an ans');
			return { ok: false, failure: { kind: 'api_error', message: 'upstream 529' }, engine: null, replyText: null };
		});
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('error');
		expect(res.outputs).toHaveLength(2);
		expect(res.outputs[0].output_type).toBe('stream'); // the partial, honest as-is
		expect(res.outputs[1].output_type).toBe('display_data'); // the failure message
	});
});

describe('the stop doors reach a chat run', () => {
	it('abortChatRuns(nb) cancels a run in flight and the registry empties', async () => {
		const { nb } = makeNotebook('abort.ipynb');
		scriptedEngine(
			({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener('abort', () =>
						resolve({ ok: false, failure: { kind: 'cancelled', message: 'interrupted' }, engine: null, replyText: null })
					);
				})
		);
		const p = runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		// Let the run reach the engine, then stop it the way interrupt/restart do.
		await new Promise((r) => setTimeout(r, 50));
		expect(activemod.abortChatRuns(nb)).toBe(1);
		const res = await p;
		expect(res.status).toBe('error');
		expect(res.lastRun.chatFailure).toBe('cancelled');
		expect(activemod.abortChatRuns(nb)).toBe(0); // nothing left registered
	});

	it('kernel.ts calls abortChatRuns from interrupt, restart AND teardown (source guard)', async () => {
		const fs = await import('node:fs');
		const src = fs.readFileSync(new URL('../../src/lib/server/kernel.ts', import.meta.url), 'utf8');
		// One occurrence per door; the import line makes four total.
		const calls = src.match(/abortChatRuns\(/g) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(3);
		for (const fn of ['export async function interruptKernel', 'export async function restartKernel', 'async function teardownKernel']) {
			const body = src.slice(src.indexOf(fn));
			const nextFn = body.indexOf('\nexport ', 10);
			expect(body.slice(0, nextFn > 0 ? nextFn : 4000)).toContain('abortChatRuns(');
		}
	});
});

describe('chatReplyOutput (the finalize rule)', () => {
	it('converts pure streamed text, passes anything else through, invents nothing', () => {
		expect(runchat.chatReplyOutput([])).toBeNull();
		expect(
			runchat.chatReplyOutput([
				{ output_type: 'stream', name: 'stdout', text: 'a ' },
				{ output_type: 'stream', name: 'stdout', text: 'reply\n' }
			])
		).toEqual({ output_type: 'display_data', data: { 'text/markdown': 'a reply', 'text/plain': 'a reply' }, metadata: {} });
		// A failure display_data (or any non-stream output) passes through untouched.
		expect(runchat.chatReplyOutput([{ output_type: 'display_data', data: { 'text/markdown': 'x' }, metadata: {} }])).toBeNull();
		expect(runchat.chatReplyOutput([{ output_type: 'stream', name: 'stdout', text: '   \n' }])).toBeNull();
	});
});
