/**
 * Stop must reach a chat run at EVERY await it has, not just at the engine call.
 *
 * `interruptKernel`/`restartKernel`/`teardownKernel` stop a chat run by aborting
 * whatever `abortChatRuns(nb)` finds REGISTERED, so any await the run reaches
 * with nothing registered is a window in which Stop silently does nothing and
 * the CLI is spawned - and billed - anyway. `resolveChatAuth` is exactly such an
 * await: its probe cache lives 5s, so an ordinary run pays a real
 * `claude auth status` spawn, i.e. clicking Stop in the first second of a chat
 * run hit this window.
 *
 * The auth module is mocked so that await can be HELD OPEN, which is the only
 * way to observe the window deterministically; everything else - the run core,
 * the accumulator, the document, the abort registry - is real.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEngineResult } from '../../src/lib/server/chat/engine';

/** The held-open auth resolution: `entered` once a run is waiting on it. */
const authGate = vi.hoisted(() => ({ entered: false, release: null as null | (() => void) }));

vi.mock('../../src/lib/server/chat/auth', () => ({
	resolveChatAuth: async () => {
		authGate.entered = true;
		await new Promise<void>((resolve) => {
			authGate.release = resolve;
		});
		return { kind: 'slot', slot: 'test', account: { loggedIn: true } };
	},
	configDirFor: () => null
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let runmod: typeof import('../../src/lib/server/run');
let enginemod: typeof import('../../src/lib/server/chat/engine');
let activemod: typeof import('../../src/lib/server/chat/active');

/** Every prompt the engine was asked to answer - i.e. every billed turn. */
let turns: string[];

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-chat-abort-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	runmod = await import('../../src/lib/server/run');
	enginemod = await import('../../src/lib/server/chat/engine');
	activemod = await import('../../src/lib/server/chat/active');
});

afterEach(() => {
	enginemod.__setChatEngineForTests(null);
	activemod.__resetChatRuns();
	authGate.entered = false;
	authGate.release = null;
});

function scriptEngine(): void {
	turns = [];
	enginemod.__setChatEngineForTests({
		async run(args): Promise<ChatEngineResult> {
			turns.push(args.prompt);
			return { ok: true, failure: null, engine: 'scripted', replyText: 'answered' };
		}
	});
}

function makeNotebook(name: string): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null, id: 'pycell' },
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
	nbmod.listCells(nb);
	return nb;
}

const until = async (pred: () => boolean, ms = 3000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('condition not reached');
		await new Promise((r) => setTimeout(r, 5));
	}
};

describe('a stop landing while the account resolves', () => {
	it('is FOUND by abortChatRuns and cancels the run before the engine is asked', async () => {
		scriptEngine();
		const nb = makeNotebook('abort-window.ipynb');
		const p = runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'What is x?' });
		await until(() => authGate.entered);

		// The registry is what interrupt/restart/teardown reach through: an
		// unregistered run is a stop that silently does nothing.
		expect(activemod.abortChatRuns(nb)).toBe(1);

		authGate.release?.();
		const res = await p;
		// Nothing was sent, so nothing was billed...
		expect(turns).toEqual([]);
		// ...and the run says it was stopped rather than reporting a reply.
		expect(res.status).toBe('error');
		expect(res.lastRun.status).toBe('error');
		expect(res.outputs).toHaveLength(1);
		const md = (res.outputs[0] as { data: Record<string, string> }).data['text/markdown'];
		expect(md).toContain('interrupted');
		// Balanced: nothing is left registered for a settled run.
		expect(activemod.abortChatRuns(nb)).toBe(0);
	});

	it('leaves an unstopped run alone - it resolves, sends, and unregisters', async () => {
		scriptEngine();
		const nb = makeNotebook('no-abort.ipynb');
		const p = runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'What is x?' });
		await until(() => authGate.entered);
		expect(activemod.abortChatRuns(nb)).toBe(1); // registered, but not stopped before this
		activemod.__resetChatRuns();

		// Re-run cleanly: no abort at all this time.
		authGate.release?.();
		await p;
		authGate.entered = false;
		const p2 = runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'What is x?' });
		await until(() => authGate.entered);
		authGate.release?.();
		const res = await p2;
		expect(res.status).toBe('ok');
		expect(turns.length).toBeGreaterThanOrEqual(1);
		expect(activemod.abortChatRuns(nb)).toBe(0);
	});
});
