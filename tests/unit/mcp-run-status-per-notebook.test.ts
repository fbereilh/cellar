/**
 * Per-notebook run-status doctrine (kernel-per-notebook, Phase 2).
 *
 * Each notebook has its OWN kernel with its own session epoch, so the run-status
 * split (ok_session / error_session = ran against the live namespace vs
 * ok_persisted / error_persisted = saved output from a prior session) must be
 * judged against THAT notebook's epoch — never the user's active tab. These tests
 * drive the REAL service + notebook + run-queue + kernel manager against a scratch
 * workspace, with only the Jupyter layer faked (each `startNew` yields a distinct
 * kernel; every execute emits one `{}` stdout line so a cell has persisted output
 * and the introspection probe parses cleanly, or an error output for a `# ERR`
 * cell). Two notebooks A and B run cells; running or restarting A must never move
 * B's run-status.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	function makeFakeKernel() {
		seq += 1;
		return {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as const,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			// Emit one output on every execute so a run leaves persisted output on the
			// cell (needed to tell ok_persisted from unrun after a restart) and the
			// namespace probe gets a parseable JSON line. A `# ERR` source raises.
			requestExecute: (args: { code?: string }) => {
				const isErr = typeof args?.code === 'string' && args.code.includes('# ERR');
				const future: { onIOPub: ((msg: unknown) => void) | null; done: Promise<unknown> } = {
					onIOPub: null,
					done: undefined as unknown as Promise<unknown>
				};
				future.done = new Promise((resolve) => {
					queueMicrotask(() => {
						if (isErr) {
							// A `# BIGERR` cell carries its own (long) source lines back as the
							// traceback, so the traceback-cap test can drive a real oversized stack.
							const big = typeof args?.code === 'string' && args.code.includes('# BIGERR');
							const traceback = big ? (args.code as string).split('\n') : ['ValueError: boom'];
							future.onIOPub?.({ header: { msg_type: 'error' }, parent_header: {}, content: { ename: 'ValueError', evalue: 'boom', traceback } });
							resolve({ content: { status: 'error', execution_count: 1 } });
						} else {
							future.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: '{}' } });
							resolve({ content: { status: 'ok', execution_count: 1 } });
						}
					});
				});
				return future;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return { startNew: vi.fn(async () => makeFakeKernel()) };
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

// Staleness needs a Python subprocess for the dependency graph; stub it so the
// test is fast + deterministic, but keep the SID honest and per-notebook (it is
// exactly what getNotebookStaleness reads: currentSessionId(nb)). The run-status
// split is what we assert, and it is independent of the dependency graph.
vi.mock('../../src/lib/server/dataflow', async () => {
	const { currentSessionId } = await import('../../src/lib/server/kernel');
	return {
		getNotebookStaleness: async (nb?: string | null) => ({ sid: currentSessionId(nb), cells: {} }),
		analyzeDataflow: async () => ({})
	};
});

vi.mock('../../src/lib/server/logs', () => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let kern: typeof import('../../src/lib/server/kernel');

const A = 'nb-a.ipynb';
const B = 'nb-b.ipynb';
const absA = () => nbmod.resolveNotebookPath(A);
const absB = () => nbmod.resolveNotebookPath(B);

// Add one code cell to a notebook and run it; return its id.
async function addAndRunCell(rel: string, source: string): Promise<string> {
	const abs = nbmod.resolveNotebookPath(rel);
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: abs, routeImports: false });
	const id = ids[0];
	await svc.runCell(id, abs);
	return id;
}

// Add + run a cell whose fake-kernel error output has a large multi-line traceback
// (via the `# BIGERR` marker), for the traceback-cap test. Returns its id.
async function addAndRunCellWithTraceback(rel: string, lines: string[]): Promise<string> {
	const source = ['raise ValueError("boom")  # ERR # BIGERR', ...lines].join('\n');
	return addAndRunCell(rel, source);
}

// The run_status the read tool reports for one cell of a notebook. readCell no
// longer carries ran_this_session (dropped as fully derivable from run_status:
// ok_session/error_session ⇒ true, everything else ⇒ false), so run_status is the
// session signal here.
async function status(rel: string, id: string): Promise<{ run_status: string }> {
	const r = (await svc.readCell(id, nbmod.resolveNotebookPath(rel))) as { run_status: string; ran_this_session?: unknown };
	// The trimmed read shape must NOT leak the derivable flag.
	expect('ran_this_session' in r).toBe(false);
	return { run_status: r.run_status };
}

let a1 = '';
let b1 = '';
let aErr = '';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-run-status-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	kern = await import('../../src/lib/server/kernel');
	// Materialize both notebooks on disk; leave the USER active tab on A to prove B
	// is judged against B's epoch and not the active one.
	nbmod.createNotebook(A, null, { focus: false });
	nbmod.createNotebook(B, null, { focus: false });
	nbmod.setActiveNotebook(A);
});

describe('per-notebook run-status doctrine', () => {
	it('a run in A marks A live against A\'s own epoch, and B against B\'s', async () => {
		a1 = await addAndRunCell(A, 'a = 1');
		b1 = await addAndRunCell(B, 'b = 1');

		// Each notebook's kernel is live with a distinct epoch.
		expect(kern.currentSessionId(absA())).not.toBeNull();
		expect(kern.currentSessionId(absB())).not.toBeNull();
		expect(kern.currentSessionId(absA())).not.toBe(kern.currentSessionId(absB()));

		// Both cells ran this session, each judged against its OWN kernel.
		expect(await status(A, a1)).toEqual({ run_status: 'ok_session' });
		expect(await status(B, b1)).toEqual({ run_status: 'ok_session' });
	});

	it('running another cell in A does not disturb B\'s run-status', async () => {
		const bBefore = kern.currentSessionId(absB());
		await addAndRunCell(A, 'a2 = 2');
		// B's epoch is untouched, and its cell is still live.
		expect(kern.currentSessionId(absB())).toBe(bBefore);
		expect(await status(B, b1)).toEqual({ run_status: 'ok_session' });
	});

	it('search_cells and get_full_output classify each notebook against its own epoch', () => {
		// search_cells samples the TARGET notebook's epoch (not the active tab, which is A).
		const inB = svc.searchCells('b = 1', 'input', absB());
		expect(inB.find((r) => r.id === b1)?.ran_this_session).toBe(true);

		const full = svc.getFullOutput(b1, 'medium', absB()) as { ran_this_session: boolean };
		expect(full.ran_this_session).toBe(true);
	});

	it('get_errors reports a live error against the notebook\'s own epoch', async () => {
		aErr = await addAndRunCell(A, 'raise ValueError("boom")  # ERR');
		const errsA = svc.getErrors(absA());
		const e = errsA.find((x) => x.id === aErr);
		expect(e).toBeTruthy();
		// get_errors dropped ran_this_session; run_status conveys session-ness.
		expect('ran_this_session' in (e ?? {})).toBe(false);
		expect(e?.run_status).toBe('error_session');
		// B has no errors of its own.
		expect(svc.getErrors(absB())).toEqual([]);
	});

	it('restarting A reverts ONLY A\'s cells to persisted; B stays ok_session', async () => {
		const bBefore = kern.currentSessionId(absB());
		await kern.restartKernel(absA());

		// A's cell now reads as saved-from-a-previous-session; the error becomes leftover.
		expect(await status(A, a1)).toEqual({ run_status: 'ok_persisted' });
		expect(await status(A, aErr)).toEqual({ run_status: 'error_persisted' });

		// B's kernel and run-status are completely untouched by A's restart.
		expect(kern.currentSessionId(absB())).toBe(bBefore);
		expect(await status(B, b1)).toEqual({ run_status: 'ok_session' });
	});

	it('get_notebook_map and kernel_state carry each notebook\'s own epoch', async () => {
		const mapA = (await svc.getNotebookMap(absA())) as { kernel: { session_id: number | null } };
		const mapB = (await svc.getNotebookMap(absB())) as { kernel: { session_id: number | null } };
		expect(mapA.kernel.session_id).toBe(kern.currentSessionId(absA()));
		expect(mapB.kernel.session_id).toBe(kern.currentSessionId(absB()));
		expect(mapA.kernel.session_id).not.toBe(mapB.kernel.session_id);

		const stateA = (await svc.getKernelState(absA())) as { session_id: number | null };
		const stateB = (await svc.getKernelState(absB())) as { session_id: number | null };
		expect(stateA.session_id).toBe(kern.currentSessionId(absA()));
		expect(stateB.session_id).toBe(kern.currentSessionId(absB()));
	});
});

// Token-diet #2: the read/map/output payloads dropped fields an agent can derive
// or that are constant/duplicated, while keeping every load-bearing signal.
describe('trimmed read/map/output shapes', () => {
	it('notebook-map leaves drop ran_this_session/visible/kind but keep run_status + has_output', async () => {
		const map = (await svc.getNotebookMap(absB())) as { databricks: unknown; sections: Array<Record<string, unknown>> };
		const leaf = map.sections.find((n) => n.id === b1) as Record<string, unknown> | undefined;
		expect(leaf).toBeTruthy();
		// Dropped (derivable / constant).
		expect('ran_this_session' in leaf!).toBe(false);
		expect('visible' in leaf!).toBe(false);
		expect('kind' in leaf!).toBe(false);
		// Kept (the only session signal + the output presence boolean).
		expect(leaf!.run_status).toBe('ok_session');
		expect('has_output' in leaf!).toBe(true);
		// The map's databricks block is the minimal boolean, not the boilerplate note.
		expect(map.databricks).toEqual({ connected: false });
	});

	it('map section nodes drop kind + the duplicated summary but keep title/level/children', async () => {
		// A carries a heading cell so it has a section node.
		await svc.addCells([{ cell_type: 'markdown', source: '# Section A' }], null, { nb: absA(), routeImports: false });
		const map = (await svc.getNotebookMap(absA())) as { sections: Array<Record<string, unknown>> };
		const section = map.sections.find((n) => Array.isArray(n.children)) as Record<string, unknown> | undefined;
		expect(section).toBeTruthy();
		expect('kind' in section!).toBe(false);
		expect('summary' in section!).toBe(false);
		expect('visible' in section!).toBe(false);
		expect(section!.title).toBe('Section A');
		expect(typeof section!.level).toBe('number');
	});

	it('read_cell omits has_output + visible', async () => {
		const r = (await svc.readCell(b1, absB())) as Record<string, unknown>;
		expect('has_output' in r).toBe(false);
		expect('visible' in r).toBe(false);
		// The agent still sees output presence via the returned array.
		expect(Array.isArray(r.outputs)).toBe(true);
	});

	it('search_cells STILL carries ran_this_session (its only session signal)', () => {
		const hits = svc.searchCells('b = 1', 'input', absB()) as Array<Record<string, unknown>>;
		const hit = hits.find((r) => r.id === b1);
		expect(hit).toBeTruthy();
		expect('ran_this_session' in hit!).toBe(true);
		// search does NOT return run_status, so ran_this_session must stay.
		expect('run_status' in hit!).toBe(false);
	});

	it('get_errors caps each traceback at READ_CAP; get_full_output(full) keeps the whole stack', async () => {
		const longLine = 'x'.repeat(4000);
		const bigErr = await addAndRunCellWithTraceback(A, Array.from({ length: 60 }, (_, i) => `frame ${i}: ${longLine}`));
		const errs = svc.getErrors(absA());
		const e = errs.find((x) => x.id === bigErr) as { traceback: string } | undefined;
		expect(e).toBeTruthy();
		// READ_CAP (800) + the ~60-char truncation marker; far below MEDIUM_CAP (4000).
		expect(e!.traceback.length).toBeLessThan(1000);
		expect(e!.traceback).toContain('get_full_output');
		// The full stack is still reachable.
		const full = svc.getFullOutput(bigErr, 'full', absA()) as { outputs: Array<{ text?: string }> };
		const errOut = full.outputs.find((o) => typeof o.text === 'string' && o.text.includes('frame 59'));
		expect(errOut).toBeTruthy();
	});
});
