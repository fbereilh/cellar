/**
 * Mojo declaration carry-over - the RUN path (`run.ts` + `mojo-session.ts`).
 *
 * `mojo-carry.test.ts` proves what a program is made of. This file proves what
 * the run path FEEDS it: which cells count as "already ran", and when that record
 * is dropped. The real run queue and the real `executeCellRun` drive it, with
 * only Jupyter faked, so the assertion is on the code the kernel was handed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOJO_MAGIC_HEADER, MOJO_SETUP_MARKER } from '../../src/lib/server/mojo';
import { MOJO_CARRY_MARKER, MOJO_SYNTHESIZED_MAIN } from '../../src/lib/mojoCarry';

const h = vi.hoisted(() => {
	let seq = 0;
	function makeFuture() {
		let resolveDone: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const f = {
			onIOPub: null as ((msg: unknown) => void) | null,
			onReply: null as ((msg: unknown) => void) | null,
			onStdin: null as ((msg: unknown) => void) | null,
			done: undefined as unknown as Promise<{ content: { status: string; execution_count: number } }>,
			dispose: vi.fn(),
			_resolve: (status = 'ok') => resolveDone({ content: { status, execution_count: 1 } })
		};
		f.done = new Promise((res) => {
			resolveDone = res;
		});
		return f;
	}
	const stream = (text: string) => ({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text } });
	function makeFakeKernel() {
		seq += 1;
		return {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as const,
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				const f = makeFuture();
				if (code.includes(MOJO_SETUP_MARKER)) {
					queueMicrotask(() => {
						f.onIOPub?.(stream(`${MOJO_SETUP_MARKER} {"ready": true, "version": "26.5.0"}\n`));
						f._resolve('ok');
					});
					return f;
				}
				h.executed.push(code);
				const failing = h.fail.some((needle) => code.includes(needle));
				queueMicrotask(() => {
					if (h.stdout !== null) f.onIOPub?.(stream(h.stdout));
					f._resolve(failing ? 'error' : 'ok');
				});
				return f;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			dispose: vi.fn()
		};
	}
	return {
		startNew: vi.fn(async () => makeFakeKernel()),
		/** Every non-setup code string the kernel was asked to execute. */
		executed: [] as string[],
		/** A run whose code contains one of these replies `error`. */
		fail: [] as string[],
		/** What every run prints on stdout, or null for nothing. */
		stdout: null as string | null
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		runningChanged = { connect: vi.fn() };
		running() {
			return [][Symbol.iterator]();
		}
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o },
	CommsOverSubshells: { Disabled: 'disabled' },
	KernelAPI: { getKernelModel: vi.fn(async () => ({ execution_state: 'busy' })), interruptKernel: vi.fn(async () => {}) }
}));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');
let runmod: typeof import('../../src/lib/server/run');
let kernelmod: typeof import('../../src/lib/server/kernel');

const NB = 'mojo-carry.ipynb';
const PY_NB = 'python-carry.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);
const HELPER = 'def twice(x: Int) -> Int:\n    return x * 2';
const USE = 'def main():\n    print(twice(2))';

const add = (source: string, nb = abs()) => nbmod.addCell(null, 'code', nb, null, source).id;
async function run(cellId: string, source: string, nb = abs()) {
	const ticket = queue.enqueueRun({ nb, cellId, actor: 'user', source });
	if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
	await ticket.wait();
	try {
		return await runmod.executeCellRun({ nb, cellId, actor: 'user', source: ticket.source() });
	} finally {
		ticket.done();
	}
}
/** The program the kernel got for the LAST run, without the magic header. */
const lastProgram = () => h.executed[h.executed.length - 1].slice(MOJO_MAGIC_HEADER.length + 1);

beforeAll(async () => {
	process.env.CELLAR_WORKSPACE = mkdtempSync(join(tmpdir(), 'cellar-mojo-carry-'));
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '0';
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	runmod = await import('../../src/lib/server/run');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setNotebookLanguage('mojo', abs());
	nbmod.createNotebook(PY_NB, null, { focus: false });
});

beforeEach(async () => {
	h.executed.length = 0;
	h.fail = [];
	h.stdout = null;
	await kernelmod.shutdownKernel(abs()); // a fresh session, so nothing is carried in
});

describe('a later cell reaches what an earlier cell declared', () => {
	it('carries a helper from a cell that ran, and nothing from one that did not', async () => {
		const a = add(HELPER);
		add('def never_ran() -> Int:\n    return 0');
		const c = add(USE);
		await run(a, HELPER);
		expect(lastProgram()).toBe(`${HELPER}\n\n${MOJO_SYNTHESIZED_MAIN}\n`);
		await run(c, USE);
		expect(lastProgram()).toBe(`${USE}\n\n${MOJO_CARRY_MARKER}\n${HELPER}\n`);
		// The stored source stays the user's own text.
		expect(nbmod.getCell(c, abs())?.source).toBe(USE);
	});

	it('carries the source that RAN, and picks up an edit once the cell runs again', async () => {
		const a = add(HELPER);
		const c = add(USE);
		await run(a, HELPER);
		const edited = 'def twice(x: Int) -> Int:\n    return x * 20';
		nbmod.setSource(a, edited, abs());
		await run(c, USE);
		expect(lastProgram()).toContain('x * 2\n');
		await run(a, edited);
		await run(c, USE);
		expect(lastProgram()).toContain('x * 20');
		expect(lastProgram()).not.toContain('x * 2\n');
	});

	it('re-running a cell does not carry its own previous run into itself', async () => {
		const a = add(HELPER);
		await run(a, HELPER);
		await run(a, HELPER);
		expect(lastProgram()).toBe(`${HELPER}\n\n${MOJO_SYNTHESIZED_MAIN}\n`);
	});
});

describe('what is NOT carried', () => {
	it('a run that failed: it declared nothing', async () => {
		const bad = 'def broken() -> Int:\n    return nope';
		const a = add(bad);
		const c = add('def main():\n    print(broken())');
		h.fail = ['broken() -> Int'];
		expect((await run(a, bad)).status).toBe('error');
		h.fail = [];
		await run(c, 'def main():\n    print(broken())');
		expect(lastProgram()).not.toContain(MOJO_CARRY_MARKER);
	});

	it('a failed RE-run keeps the last good version', async () => {
		const a = add(HELPER);
		const c = add(USE);
		await run(a, HELPER);
		h.fail = ['x * 99'];
		await run(a, 'def twice(x: Int) -> Int:\n    return x * 99');
		h.fail = [];
		await run(c, USE);
		expect(lastProgram()).toContain(HELPER);
	});

	it('anything from before a kernel RESTART', async () => {
		const a = add(HELPER);
		const c = add(USE);
		await run(a, HELPER);
		await kernelmod.restartKernel(abs());
		await run(c, USE);
		expect(lastProgram()).toBe(USE);
	});

	it('a cell that has since been DELETED', async () => {
		const a = add(HELPER);
		const c = add(USE);
		await run(a, HELPER);
		nbmod.deleteCell(a, abs());
		await run(c, USE);
		expect(lastProgram()).toBe(USE);
	});

	it('a cell that opens with `%%mojo`, in either direction', async () => {
		const magic = `%%mojo\n${HELPER}\n\ndef main():\n    pass`;
		const a = add(magic);
		const c = add(USE);
		await run(a, magic);
		expect(h.executed[h.executed.length - 1]).toBe(magic);
		await run(c, USE);
		expect(lastProgram()).toBe(USE);
	});
});

describe('the synthesized main stays invisible', () => {
	it('drops the blank line Modular prints for a program with no output', async () => {
		h.stdout = '\n';
		const a = add(HELPER);
		const res = await run(a, HELPER);
		expect(res.outputs).toEqual([]);
	});

	it('keeps a blank line a cell with its OWN main printed', async () => {
		h.stdout = '\n';
		const c = add('def main():\n    print("")');
		const res = await run(c, 'def main():\n    print("")');
		expect(res.outputs).toHaveLength(1);
	});
});

describe('a PYTHON notebook is untouched', () => {
	it('sends the source verbatim and records nothing', async () => {
		const nb = nbmod.resolveNotebookPath(PY_NB);
		const a = add('def twice(x):\n    return x * 2', nb);
		await run(a, 'def twice(x):\n    return x * 2', nb);
		expect(h.executed[h.executed.length - 1]).toBe('def twice(x):\n    return x * 2');
	});
});
