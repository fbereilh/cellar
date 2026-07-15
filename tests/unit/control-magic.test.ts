/**
 * `%restart_python` — the Cellar control magic (managed kernel restart).
 *
 * Two layers are covered:
 *  - the PURE module (`controlMagic.ts`): the Python snippet that registers the
 *    magic, and `controlOp` which interprets the wire payload;
 *  - the SERVER trigger (`kernel.ts`): a `cellar.control` comm carrying
 *    `{op:'restart'}` runs a MANAGED restart of ONLY the calling notebook's kernel
 *    (its epoch advances, another notebook's is untouched), keeping the connection.
 *
 * The whole Jupyter layer is mocked (as in kernel-manager.test), and the fake
 * kernel captures every `registerCommTarget` handler + executed code so the test
 * can drive the `cellar.control` handler exactly as an incoming `comm_open` would.
 * Each fake kernel carries a distinct `id`, so a test finds the RIGHT kernel entry
 * by matching the live connection id (`getKernelInfo(nb).id`) rather than by array
 * position.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CONTROL_COMM_TARGET, RESTART_MAGIC_CODE, controlOp } from '../../src/lib/server/controlMagic';

type CommHandler = (comm: unknown, msg: unknown) => void;
interface FakeEntry {
	id: string;
	targets: Map<string, CommHandler>;
	codes: string[];
	restart: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => {
	let seq = 0;
	const entries: FakeEntry[] = [];
	function makeFakeKernel() {
		seq += 1;
		const targets = new Map<string, CommHandler>();
		const codes: string[] = [];
		const restart = vi.fn(async () => {});
		const id = `kernel-${seq}`;
		entries.push({ id, targets, codes, restart });
		return {
			id,
			name: 'python3',
			status: 'idle' as const,
			registerCommTarget: vi.fn((target: string, handler: CommHandler) => targets.set(target, handler)),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: vi.fn((req: { code: string }) => {
				codes.push(req.code);
				return { onIOPub: null as unknown, done: Promise.resolve({ content: { status: 'ok', execution_count: 1 } }) };
			}),
			restart,
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return {
		startNew: vi.fn(async () => makeFakeKernel()),
		dispose: vi.fn(),
		entries
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		dispose = h.dispose;
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => '/ws/a.ipynb',
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => p
}));

vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { execute, currentSessionId, getKernelInfo } from '../../src/lib/server/kernel';

const noop = () => {};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The fake kernel entry backing notebook `nb`'s live connection. */
function entryFor(nb: string): FakeEntry {
	const id = getKernelInfo(nb).id;
	const entry = h.entries.find((e) => e.id === id);
	if (!entry) throw new Error(`no fake kernel for ${nb} (id ${id})`);
	return entry;
}

/** Drive notebook `nb`'s captured `cellar.control` handler with `data`. */
function fireControl(nb: string, data: unknown) {
	const handler = entryFor(nb).targets.get(CONTROL_COMM_TARGET);
	if (!handler) throw new Error(`no ${CONTROL_COMM_TARGET} handler for ${nb}`);
	handler({ onMsg: null }, { content: { data } }); // shaped like a comm_open
}

describe('controlMagic (pure)', () => {
	it('interprets a control payload into its op, else null', () => {
		expect(controlOp({ op: 'restart' })).toBe('restart');
		expect(controlOp({ op: 'other' })).toBe('other');
		expect(controlOp({})).toBeNull();
		expect(controlOp(null)).toBeNull();
		expect(controlOp('restart')).toBeNull();
		expect(controlOp({ op: 5 })).toBeNull();
	});

	it('registers a %restart_python line magic that opens a cellar.control restart comm', () => {
		expect(RESTART_MAGIC_CODE).toContain("magic_name='restart_python'");
		expect(RESTART_MAGIC_CODE).toContain("magic_kind='line'");
		expect(RESTART_MAGIC_CODE).toContain("target_name='cellar.control'");
		expect(RESTART_MAGIC_CODE).toContain("'op': 'restart'");
		expect(RESTART_MAGIC_CODE).toContain('Restarting Python kernel...');
	});
});

describe('%restart_python — managed restart trigger', () => {
	beforeEach(() => h.startNew.mockClear());

	it('injects the restart magic + control comm target at kernel startup', async () => {
		await execute('/ws/inject.ipynb', 'x=1', noop);
		const entry = entryFor('/ws/inject.ipynb');
		// initKernel ran the magic registration silently on first start — the startup
		// injections are coalesced into ONE exec, so the magic rides inside a combined
		// setup string rather than its own round-trip.
		expect(entry.codes.some((c: string) => c.includes(RESTART_MAGIC_CODE))).toBe(true);
		// …and registered the control comm target so a restart signal can land.
		expect(entry.targets.has(CONTROL_COMM_TARGET)).toBe(true);
	});

	it('a control restart bumps ONLY the calling notebook and keeps the connection', async () => {
		const A = '/ws/restart-a.ipynb';
		const B = '/ws/restart-b.ipynb';
		await execute(A, 'x=1', noop);
		await execute(B, 'y=2', noop);
		const aEntry = entryFor(A);
		const aBefore = currentSessionId(A);
		const bBefore = currentSessionId(B);
		const aId = getKernelInfo(A).id;

		fireControl(A, { op: 'restart' });
		await tick();

		// A restarted: SAME connection (restart(), never a new startNew), epoch advanced.
		expect(aEntry.restart).toHaveBeenCalledTimes(1);
		expect(getKernelInfo(A).id).toBe(aId);
		expect(currentSessionId(A)).not.toBe(aBefore);
		// B is untouched.
		expect(currentSessionId(B)).toBe(bBefore);
		expect(entryFor(B).restart).not.toHaveBeenCalled();
	});

	it('ignores a control payload with an unknown op', async () => {
		const N = '/ws/ignore.ipynb';
		await execute(N, 'x=1', noop);
		const entry = entryFor(N);
		const before = currentSessionId(N);
		fireControl(N, { op: 'nope' });
		await tick();
		expect(entry.restart).not.toHaveBeenCalled();
		expect(currentSessionId(N)).toBe(before);
	});
});
