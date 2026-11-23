/**
 * Connecting Databricks from a RUST notebook is refused before anything is sent.
 *
 * Every Databricks kernel op is Python source. `runInKernel`'s guard used to read
 * only the LIVE kernel's language, which is null until a kernel exists - so for a
 * Rust notebook that had not run a cell the guard passed and `execute()` STARTED an
 * Evcxr kernel just to send it Python. With Evcxr installed the connect then failed
 * with a Rust compiler error; with it missing, `RustKernelMissing` fell into the
 * catch-all and the sidebar told the user to "Restart Cellar, then connect again".
 *
 * Driven through the REAL `connect()` and the REAL `kernel.ts` (only the Jupyter
 * layer is faked), so the assertion that no kernel was started is about the code
 * the user hits.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	function makeFuture(code: string) {
		let resolve: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const done = new Promise<{ content: { status: string; execution_count: number } }>((r) => {
			resolve = r;
		});
		return {
			onIOPub: null as ((msg: unknown) => void) | null,
			onReply: null as ((msg: unknown) => void) | null,
			onStdin: null as ((msg: unknown) => void) | null,
			done,
			dispose: vi.fn(),
			settle: () => resolve({ content: { status: 'ok', execution_count: 1 } }),
			code
		};
	}

	function makeKernel() {
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
				const f = makeFuture(code);
				// The lock holder: a Databricks connect against a cold cluster, which
				// legitimately never answers for minutes. Everything else (the startup
				// injections) settles at once, so it can never be confused with it.
				if (code.includes('_cellar_dbx_connect')) h.hanging = f;
				else queueMicrotask(f.settle);
				return f;
			},
			restart: vi.fn(async () => {}),
			// The kernel never surrenders, so the interrupt must escalate - the F1 shape,
			// which is what puts a `KernelExecuteAborted` into `runInKernel`'s catch.
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			dispose: vi.fn()
		};
	}

	return {
		makeKernel,
		hanging: null as ReturnType<typeof makeFuture> | null,
		startNew: vi.fn(async () => makeKernel()),
		getKernelModel: vi.fn(async () => ({ execution_state: 'busy' })),
		interruptKernel: vi.fn(async () => {})
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
	KernelAPI: { getKernelModel: h.getKernelModel, interruptKernel: h.interruptKernel }
}));

const logs = vi.hoisted(() => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));
vi.mock('../../src/lib/server/logs', () => logs);

const venv = vi.hoisted(() => ({ installPackages: vi.fn(async () => {}) }));
vi.mock('../../src/lib/server/venv.js', async (orig) => ({
	...(await orig<typeof import('../../src/lib/server/venv.js')>()),
	hasUv: async () => true,
	installPackages: venv.installPackages
}));

let dbx: typeof import('../../src/lib/server/databricks');
let kernelmod: typeof import('../../src/lib/server/kernel');
let nbmod: typeof import('../../src/lib/server/notebook');
let dir: string;
const NB = () => join(dir, 'n.ipynb');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, budgetMs = 5000) {
	const deadline = Date.now() + budgetMs;
	while (!fn() && Date.now() < deadline) await sleep(5);
	if (!fn()) throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-rust-'));
	writeFileSync(join(dir, '.databrickscfg'), '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = join(dir, '.databrickscfg');
	process.env.CELLAR_WORKSPACE = dir;
	delete process.env.CELLAR_PROJECT_VENV;
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod = await import('../../src/lib/server/notebook');
	dbx = await import('../../src/lib/server/databricks');
	nbmod.createNotebook('n.ipynb', null, { focus: false });
	nbmod.setNotebookLanguage('rust', NB());
});

describe('connecting Databricks from a Rust notebook', () => {
	it('is refused as not_python_kernel before any kernel is started', async () => {
		const nb = NB();
		h.startNew.mockClear();
		// The trap: no kernel exists yet, so a live-only check had nothing to read.
		expect(kernelmod.liveKernelLanguage(nb)).toBeNull();

		const err = await dbx
			.connect({ profile: 'test', clusterId: '0101-abc-def', clusterName: 'c', nb })
			.then(
				() => null,
				(e: unknown) => e as { code?: string; message?: string }
			);

		expect(err).toBeTruthy();
		expect(err!.code).toBe('not_python_kernel');
		expect(String(err!.message)).toMatch(/rust kernel/i);
		// Not the unreachable-kernel report, whose remedy is to restart Cellar.
		expect(err!.code).not.toBe('kernel_unavailable');
		// Nothing was started to receive Python it could never run.
		expect(h.startNew).not.toHaveBeenCalled();
		expect(kernelmod.liveKernelLanguage(nb)).toBeNull();
	});

	it('is a state conflict the user resolves by switching language', () => {
		expect(dbx.statusFor('not_python_kernel')).toBe(409);
	});

	it('still lets a Python notebook reach its kernel', async () => {
		nbmod.createNotebook('py.ipynb', null, { focus: false });
		const nb = join(dir, 'py.ipynb');
		h.startNew.mockClear();
		h.startNew.mockImplementationOnce(async () => {
			throw new Error('sidecar unreachable');
		});
		const err = await dbx
			.connect({ profile: 'test', clusterId: '0101-abc-def', clusterName: 'c', nb })
			.then(
				() => null,
				(e: unknown) => e as { code?: string }
			);
		// The guard let it through to the kernel start, which is what failed here.
		expect(h.startNew).toHaveBeenCalled();
		expect(err!.code).toBe('kernel_unavailable');
	});
});

describe('a Rust notebook with a LIVE kernel', () => {
	/**
	 * A stub project interpreter answering every probe with a cluster on DBR 13.3 and
	 * an installed databricks-connect 17.3 - the "client newer than the cluster" case
	 * that makes a connect re-pin the client and restart the kernel.
	 */
	function useNewerClientStub() {
		const stub = join(dir, 'stub-python');
		const answer = {
			ok: true,
			spark_version: '13.3.x-scala2.12',
			state: 'RUNNING',
			sdk: true,
			connect: true,
			sdk_version: '0.50.0',
			connect_version: '17.3.1'
		};
		writeFileSync(stub, `#!/bin/sh\ncat <<'EOF'\n__CELLAR_DBX__${JSON.stringify(answer)}\nEOF\n`, { mode: 0o755 });
		process.env.CELLAR_PROJECT_VENV = stub;
	}

	async function liveRustKernel(name: string) {
		const evcxr = join(dir, 'evcxr_jupyter');
		writeFileSync(evcxr, '#!/bin/sh\n', { mode: 0o755 });
		process.env.CELLAR_EVCXR = evcxr;
		const specDir = join(dir, 'jupyter', 'kernels', 'python3');
		mkdirSync(specDir, { recursive: true });
		process.env.CELLAR_KERNELSPEC_DIR = specDir;
		nbmod.createNotebook(name, null, { focus: false });
		const nb = join(dir, name);
		nbmod.setNotebookLanguage('rust', nb);
		h.startNew.mockClear();
		await kernelmod.execute(nb, 'let x = 1;', () => {});
		expect(kernelmod.liveKernelLanguage(nb)).toBe('rust');
		const kernel = await h.startNew.mock.results[0].value;
		return { nb, kernel: kernel as ReturnType<typeof h.makeKernel> };
	}

	it('refuses a connect without re-pinning the client or restarting the kernel', async () => {
		const { nb, kernel } = await liveRustKernel('live-connect.ipynb');
		useNewerClientStub();
		venv.installPackages.mockClear();
		try {
			await expect(
				dbx.connect({ profile: 'test', clusterId: '0101-abc-def', clusterName: 'c', nb })
			).rejects.toMatchObject({ code: 'not_python_kernel' });
		} finally {
			delete process.env.CELLAR_PROJECT_VENV;
		}
		expect(venv.installPackages).not.toHaveBeenCalled();
		expect(kernel.restart).not.toHaveBeenCalled();
		expect(kernelmod.liveKernelLanguage(nb)).toBe('rust');
	});

	it('refuses the runtime toggle without restarting the kernel', async () => {
		const { nb, kernel } = await liveRustKernel('live-runtime.ipynb');
		await expect(dbx.setRuntimeAdvertisement({ enable: true, nb })).rejects.toMatchObject({
			code: 'not_python_kernel'
		});
		expect(kernel.restart).not.toHaveBeenCalled();
	});
});
