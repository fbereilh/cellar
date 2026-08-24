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
 *   the failure IS the persisted output, so a reader sees what went wrong
 *   without a second call;
 * - `abortChatRuns(nb)` reaches a run in flight (the interrupt/restart/teardown
 *   door) and it settles `cancelled`;
 * - an over-budget transcript is REFUSED before the engine is spawned, with a
 *   message naming the size, rather than sent and failed opaquely;
 * - what the run PUBLISHES leaves every client holding exactly the outputs the
 *   document persisted - including the capped case, whose truncation marker the
 *   finalize must not orphan.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChatEngine, ChatEngineRunArgs } from '../../src/lib/server/chat/engine';
import { CHAT_MODEL_DEFAULT, CHAT_MODEL_KEY, CHAT_OTHER_NOTEBOOKS_KEY, CHAT_WEB_SEARCH_KEY, CHAT_WORKSPACE_READS_KEY } from '../../src/lib/chatCell';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let runmod: typeof import('../../src/lib/server/run');
let runchat: typeof import('../../src/lib/server/chat/run-chat');
let enginemod: typeof import('../../src/lib/server/chat/engine');
let authmod: typeof import('../../src/lib/server/chat/auth');
let activemod: typeof import('../../src/lib/server/chat/active');
let events: typeof import('../../src/lib/server/events');
let settingsmod: typeof import('../../src/lib/server/user-settings');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-chat-run-'));
	process.env.CELLAR_WORKSPACE = WS;
	// The run glue reads the person-scoped settings store (chat model / web
	// search); point it at a throwaway file so this suite never reads the
	// developer's real ~/.cellar/settings.json - and so the threading tests below
	// can write to it.
	process.env.CELLAR_USER_SETTINGS = join(WS, 'user-settings.json');
	nbmod = await import('../../src/lib/server/notebook');
	runmod = await import('../../src/lib/server/run');
	runchat = await import('../../src/lib/server/chat/run-chat');
	enginemod = await import('../../src/lib/server/chat/engine');
	authmod = await import('../../src/lib/server/chat/auth');
	activemod = await import('../../src/lib/server/chat/active');
	events = await import('../../src/lib/server/events');
	settingsmod = await import('../../src/lib/server/user-settings');
	settingsmod.__resetUserSettingsCache();
	authmod.__setChatAuthForTests({ kind: 'slot', slot: 'test', account: { loggedIn: true, email: 't@example.com' } });
});

afterEach(() => {
	enginemod.__setChatEngineForTests(null);
	activemod.__resetChatRuns();
	// Undo whatever a threading test wrote, so key absence stays each test's default.
	settingsmod.setUserSettings({ [CHAT_MODEL_KEY]: null, [CHAT_WEB_SEARCH_KEY]: null, [CHAT_WORKSPACE_READS_KEY]: null, [CHAT_OTHER_NOTEBOOKS_KEY]: null });
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
			// lastRun: ok, and runtime-only (stripped from the disk copy just read).
			expect(res.lastRun.status).toBe('ok');
			expect(res.lastRun.session).toBeNull();
			expect(chat.metadata.cellar?.lastRun).toBeUndefined();
			expect(endEvents).toHaveLength(1);
			expect(endEvents[0].status).toBe('ok');
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

describe('a document deleted mid-run', () => {
	it('keeps flushing without throwing out of the interval, and still refuses to persist', async () => {
		// Deleting the notebook in the explorer runs `dropDocs` and removes the file
		// while the chat child is still streaming (SIGTERM does not retract bytes
		// already in the pipe). Every flush mirrors into the live doc, from a
		// setInterval and from the child's stdout handler - neither has a caller to
		// catch a throw, and nothing installs an uncaughtException handler, so it
		// would take down the process carrying every kernel websocket, the SSE
		// fan-out and the in-process MCP server.
		const { nb } = makeNotebook('deleted-mid-run.ipynb');
		const errors: unknown[] = [];
		const onError = (e: unknown) => errors.push(e);
		process.on('uncaughtException', onError);
		scriptedEngine(async ({ onDelta }) => {
			onDelta('partial ');
			nbmod.dropDocs(nb);
			rmSync(nb);
			// Let the ~40ms flush timer really fire against the gone document.
			await new Promise((r) => setTimeout(r, 200));
			onDelta('more\n');
			await new Promise((r) => setTimeout(r, 200));
			return { ok: true, failure: null, engine: 'claude-cli/9.9.9', replyText: 'partial more' };
		});
		try {
			// The PERSIST still throws: that caller genuinely requires a document,
			// and the run is awaited, so its rejection is handled rather than fatal.
			await expect(runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' })).rejects.toThrow(/notebook not found/);
		} finally {
			process.off('uncaughtException', onError);
		}
		expect(errors).toEqual([]);
	}, 15_000);
});

describe('failures are distinct, friendly and readable in the cell', () => {
	it('rate_limited persists actionable markdown as the run result', async () => {
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
			expect(res.lastRun.status).toBe('error');
			expect(endEvents[0].status).toBe('error');
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
			const md = (res.outputs[0] as { data: Record<string, string> }).data['text/markdown'];
			expect(md).toContain('Not signed in');

			authmod.__setChatAuthForTests({ kind: 'none', notInstalled: true });
			const res2 = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(res2.status).toBe('error');
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
		const cancelledMd = (res.outputs[0] as { data: Record<string, string> }).data['text/markdown'];
		expect(cancelledMd).toContain('interrupted');
		expect(activemod.abortChatRuns(nb)).toBe(0); // nothing left registered
	});

	it('the SHUTDOWN door stops a chat run even with NO kernel to shut down', async () => {
		// The ordinary state of a chat-only notebook: no kernel was ever started, so
		// every door that bails on a missing one steps over the run. Reached by
		// deleting the notebook in the file explorer, which leaves the billed child
		// streaming into a document that has just been dropped.
		const { nb } = makeNotebook('shutdown-nokernel.ipynb');
		const kernelmod = await import('../../src/lib/server/kernel');
		scriptedEngine(
			({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener('abort', () =>
						resolve({ ok: false, failure: { kind: 'cancelled', message: 'interrupted' }, engine: null, replyText: null })
					);
				})
		);
		const p = runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		await new Promise((r) => setTimeout(r, 50));

		// No kernel exists for this notebook, so the shutdown is a no-op FOR THE
		// KERNEL - and must still be a real stop for the chat run.
		expect(await kernelmod.shutdownKernel(nb)).toMatchObject({ status: 'not_started' });
		const res = await p;
		expect(res.status).toBe('error');
		expect((res.outputs[0] as { data: Record<string, string> }).data['text/markdown']).toContain('interrupted');
		expect(activemod.abortChatRuns(nb)).toBe(0);
	});

	it('deleting a FOLDER stops the chat runs of the notebooks under it', async () => {
		const fs = await import('node:fs');
		fs.mkdirSync(join(WS, 'sub'), { recursive: true });
		const { nb } = makeNotebook('sub/folder-delete.ipynb');
		const kernelmod = await import('../../src/lib/server/kernel');
		scriptedEngine(
			({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener('abort', () =>
						resolve({ ok: false, failure: { kind: 'cancelled', message: 'interrupted' }, engine: null, replyText: null })
					);
				})
		);
		const p = runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		await new Promise((r) => setTimeout(r, 50));

		// The notebook is UNDER the deleted folder, which is the at-or-under rule
		// `shutdownKernelsUnder` applies to kernels and must apply to chat runs too.
		expect(await kernelmod.shutdownKernelsUnder('sub')).toBe(0); // no kernels, still a stop
		const res = await p;
		expect(res.status).toBe('error');
		expect(activemod.abortChatRuns(nb)).toBe(0);
	});

	it('kernel.ts stops chat runs from EVERY door, above each no-kernel early return', async () => {
		const fs = await import('node:fs');
		const src = fs.readFileSync(new URL('../../src/lib/server/kernel.ts', import.meta.url), 'utf8');
		for (const fn of [
			'export async function interruptKernel',
			'export async function restartKernel',
			'export async function shutdownKernel',
			'export async function shutdownKernelsUnder',
			'async function teardownKernel'
		]) {
			const body = src.slice(src.indexOf(fn));
			const nextFn = body.indexOf('\nexport ', 10);
			const fnBody = body.slice(0, nextFn > 0 ? nextFn : 4000);
			expect(fnBody).toMatch(/abortChatRuns(Under)?\(/);
			// And BEFORE the early return, which is the whole point: an abort below it
			// is unreachable for the notebook that needs it most.
			const abortAt = fnBody.search(/abortChatRuns(Under)?\(/);
			const bailAt = fnBody.search(/if \(!nbKernel\)|if \(victims\.length === 0\)/);
			if (bailAt >= 0) expect(abortAt).toBeLessThan(bailAt);
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

/**
 * Replay this cell's published frames the way `LiveNotebook.applyOutput` does,
 * so a test can compare what every open tab ends up holding against what the
 * document persisted. A finalize that rewrites the outputs ARRAY but republishes
 * only one index would show up here as a length mismatch - the orphaned element
 * no reload-less client can ever be rid of.
 */
function clientMirror(nb: string, cellId: string): { outputs: Record<string, unknown>[]; stop: () => void } {
	const outputs: Record<string, unknown>[] = [];
	const unsub = events.subscribe((ev: Record<string, unknown>) => {
		if (ev.nb !== nb || ev.cellId !== cellId) return;
		if (ev.type === 'run:cleared') outputs.length = 0;
		else if (ev.type === 'run:output') outputs[ev.index as number] = ev.output as Record<string, unknown>;
		else if (ev.type === 'run:output-append') {
			const at = outputs[ev.index as number] as { text?: string } | undefined;
			const prev = at?.text ?? '';
			if (at) at.text = prev.slice(0, ev.keep as number) + (ev.chunk as string);
		}
	});
	return { outputs, stop: unsub };
}

describe('an over-budget transcript is refused, not sent', () => {
	it('nothing reaches the engine, and the message names the size and the levers', async () => {
		const { nb } = makeNotebook('huge.ipynb');
		// A single enormous stored output on the cell ABOVE - exactly the shape that
		// builds a multi-megabyte prompt on every run of this notebook.
		nbmod.setOutputs('pycell', [{ output_type: 'stream', name: 'stdout', text: 'x'.repeat(700_000) }], nb);
		const { prompts } = scriptedEngine(async () => {
			throw new Error('the engine must not be spawned for an over-budget transcript');
		});
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(prompts).toHaveLength(0);
		expect(res.status).toBe('error');
		expect(res.outputs).toHaveLength(1);
		const md = (res.outputs[0] as { data: Record<string, string> }).data['text/markdown'];
		expect(md).toContain('Too much to send');
		expect(md).toMatch(/0\.7 MB, over the 0\.6 MB/);
		expect(md).toMatch(/clear the outputs/i);
		expect(md).toContain('hidden_from_agent');
	});

	it('the same notebook sends fine once the heavy output is cleared', async () => {
		const { nb } = makeNotebook('huge2.ipynb');
		nbmod.setOutputs('pycell', [{ output_type: 'stream', name: 'stdout', text: 'x'.repeat(700_000) }], nb);
		scriptedEngine(async () => ({ ok: true, failure: null, engine: null, replyText: 'ok' }));
		const refused = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(refused.status).toBe('error');
		expect((refused.outputs[0] as { data: Record<string, string> }).data['text/markdown']).toContain('Too much to send');
		nbmod.clearOutputs('pycell', nb); // the remedy the message names
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
	});
});

describe('what the clients hold matches what was persisted', () => {
	it('an ordinary reply: the finalize replaces the streamed element in place', async () => {
		const { nb } = makeNotebook('mirror.ipynb');
		scriptedEngine(async ({ onDelta }) => {
			onDelta('a ');
			onDelta('reply');
			return { ok: true, failure: null, engine: null, replyText: 'a reply' };
		});
		const mirror = clientMirror(nb, 'chatcell');
		try {
			const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(res.outputs).toHaveLength(1);
			expect(mirror.outputs).toEqual(res.outputs);
		} finally {
			mirror.stop();
		}
	});

	it('a CAPPED reply keeps its truncation marker rather than orphaning it on every client', async () => {
		const { nb } = makeNotebook('capped.ipynb');
		scriptedEngine(async ({ onDelta }) => {
			// Past `DEFAULT_CAPS.maxStreamBytes`, so the accumulator trips and appends
			// its marker as a SECOND element - which the client has already been sent.
			onDelta('y'.repeat(600_000));
			onDelta('dropped');
			return { ok: true, failure: null, engine: null, replyText: null };
		});
		const mirror = clientMirror(nb, 'chatcell');
		try {
			const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(res.status).toBe('ok');
			// The marker survived into the persisted document, and every client holds
			// exactly those outputs - no element left behind at an index the finalize
			// stopped republishing.
			expect(res.outputs).toHaveLength(2);
			expect(res.outputs[1]).toMatchObject({ output_type: 'stream', name: 'stderr' });
			expect((res.outputs[1] as { text: string }).text).toMatch(/output truncated/);
			expect(mirror.outputs).toHaveLength(res.outputs.length);
			expect(mirror.outputs).toEqual(res.outputs);
			// And what is on disk agrees with both.
			const disk = JSON.parse(readFileSync(nb, 'utf8'));
			expect(disk.cells.find((c: { id: string }) => c.id === 'chatcell').outputs).toHaveLength(2);
		} finally {
			mirror.stop();
		}
	});
});

describe('the engine capability settings are read from the user store and gated', () => {
	/** Script the engine and capture the FULL args each run received. */
	function capturingEngine(): { args: ChatEngineRunArgs[] } {
		const args: ChatEngineRunArgs[] = [];
		enginemod.__setChatEngineForTests({
			async run(a) {
				args.push(a);
				return { ok: true, failure: null, engine: null, replyText: 'ok' };
			}
		});
		return { args };
	}

	it('absent keys thread the defaults: the model chat always ran, web search off', async () => {
		const { nb } = makeNotebook('settings-default.ipynb');
		const { args } = capturingEngine();
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
		expect(args).toHaveLength(1);
		expect(args[0].model).toBe(CHAT_MODEL_DEFAULT);
		expect(args[0].webSearch).toBe(false);
		// No file reach either: an upgraded install grants none until asked.
		expect(args[0].readRoot ?? null).toBeNull();
	});

	it('a stored model and an explicit web-search opt-in reach the engine', async () => {
		settingsmod.setUserSettings({ [CHAT_MODEL_KEY]: 'opus', [CHAT_WEB_SEARCH_KEY]: true });
		const { nb } = makeNotebook('settings-on.ipynb');
		const { args } = capturingEngine();
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
		expect(args[0].model).toBe('opus');
		expect(args[0].webSearch).toBe(true);
		// Search does NOT drag reads along: separate keys, separate capabilities.
		expect(args[0].readRoot ?? null).toBeNull();
	});

	it('the reads opt-in threads the WORKSPACE as the confinement root - not the notebook, not a code root', async () => {
		settingsmod.setUserSettings({ [CHAT_WORKSPACE_READS_KEY]: true });
		const { nb } = makeNotebook('settings-reads.ipynb');
		const { args } = capturingEngine();
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
		// The workspace root itself, resolved - the same directory every other file
		// surface in Cellar is scoped to. A code root may sit OUTSIDE the workspace
		// and grants no file reach anywhere else, so it must not be the answer here.
		expect(args[0].readRoot).toBe(resolve(WS));
		// ...and reads do not drag search along either.
		expect(args[0].webSearch).toBe(false);
	});

	it('the notebook being answered in reaches the engine so it can be DENIED, whatever the settings say', async () => {
		// Reads-on grants the workspace, and the notebook lives in it - so the engine
		// has to be told WHICH file to take back, or a single Read would hand back
		// the cells the transcript filter deliberately withheld. It is threaded on
		// EVERY run, not only reads-on ones, because the engine (not this layer)
		// owns when a denial is emitted.
		const { nb } = makeNotebook('settings-notebook-path.ipynb');
		const { args } = capturingEngine();
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
		expect(args[0].notebookPath).toBe(nb);
	});

	it('other notebooks are denied unless explicitly opted in - and the opt-in is its own key', async () => {
		// Default OFF, and a literal `true` is the only thing that opens them: this
		// key only ever NARROWS the read grant, so junk in the untyped store must
		// leave the narrower state in force.
		const { nb } = makeNotebook('settings-other-nb.ipynb');
		for (const [stored, expected] of [
			[undefined, false],
			['true', false],
			[1, false],
			[true, true]
		] as const) {
			settingsmod.setUserSettings(stored === undefined ? { [CHAT_WORKSPACE_READS_KEY]: true } : { [CHAT_WORKSPACE_READS_KEY]: true, [CHAT_OTHER_NOTEBOOKS_KEY]: stored });
			const { args } = capturingEngine();
			const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
			expect(res.status).toBe('ok');
			expect(args[0].otherNotebooks === true).toBe(expected);
		}
		// And it does not drag the other two capabilities along, in either direction:
		// on its own it grants no file reach at all, so it can only ever narrow one.
		settingsmod.setUserSettings({ [CHAT_WORKSPACE_READS_KEY]: null, [CHAT_WEB_SEARCH_KEY]: null, [CHAT_OTHER_NOTEBOOKS_KEY]: true });
		const { args } = capturingEngine();
		await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(args[0].readRoot ?? null).toBeNull();
		expect(args[0].webSearch).toBe(false);
	});

	it('hand-edited junk is gated BEFORE the seam: unknown model falls back, truthy-not-true search stays off', async () => {
		// What a hand-edited ~/.cellar/settings.json can hold: flag-shaped text where
		// a model id belongs, and the string "true" where the boolean opt-in belongs.
		settingsmod.setUserSettings({
			[CHAT_MODEL_KEY]: '--dangerously-injected',
			[CHAT_WEB_SEARCH_KEY]: 'true',
			[CHAT_WORKSPACE_READS_KEY]: 1
		});
		const { nb } = makeNotebook('settings-junk.ipynb');
		const { args } = capturingEngine();
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('ok');
		expect(args[0].model).toBe(CHAT_MODEL_DEFAULT);
		expect(args[0].webSearch).toBe(false);
		// A truthy-not-true reads value grants no file reach: `=== true` or nothing.
		expect(args[0].readRoot ?? null).toBeNull();
	});
});
