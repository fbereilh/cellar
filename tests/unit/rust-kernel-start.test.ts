/**
 * A Rust notebook gets the Evcxr kernel, and a kernel's language is fixed at start.
 *
 * The REAL `kernel.ts` runs here with the Jupyter layer mocked, as in
 * `kernel-root.test.ts`. The risks are a request field and a set of injected
 * strings:
 *   - a Rust notebook must start the `rust` kernelspec and receive NO Python
 *     startup injection (Evcxr would report each one as a compile error),
 *   - a Python or Mojo notebook must start `python3` exactly as before,
 *   - a missing Evcxr binary must refuse the start without asking Jupyter,
 *   - a language change that crosses kernels must free the kernel, and one that
 *     does not must leave it alone.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	const execCodes: string[] = [];
	function makeFakeKernel(name: string) {
		seq += 1;
		return {
			id: `kernel-${seq}`,
			name,
			status: 'idle' as const,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: vi.fn((args: { code: string }) => {
				execCodes.push(args.code);
				return {
					onIOPub: null,
					done: Promise.resolve().then(() => ({ content: { status: 'ok', execution_count: 1 } }))
				};
			}),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return {
		execCodes,
		startNew: vi.fn(async (opts: { name: string }) => makeFakeKernel(opts.name)),
		dispose: vi.fn(),
		// nbPath -> notebook language (absent = python).
		languages: new Map<string, string>()
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
	getNotebookLanguage: (nb: string) => h.languages.get(nb) ?? 'python',
	getActiveNotebookPath: () => '/ws/a.ipynb',
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`),
	getNotebookRoot: () => null
}));
vi.mock('../../src/lib/server/notebookRoot', () => ({ notebookRoot: () => null }));
vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { completeInKernel, execute, inspectInKernel, liveKernelLanguage, shutdownKernel } from '../../src/lib/server/kernel';
import { syncKernelToNotebookLanguage } from '../../src/lib/server/notebook-language-actions';
import { EVCXR_ENV, RustKernelMissing } from '../../src/lib/server/rust';

const noop = () => {};
const tmp = mkdtempSync(join(tmpdir(), 'cellar-rust-kernel-'));
const evcxr = join(tmp, 'evcxr_jupyter');
const pythonSpecDir = join(tmp, 'jupyter', 'kernels', 'python3');
const rustSpecFile = join(tmp, 'jupyter', 'kernels', 'rust', 'kernel.json');

const RUST = '/ws/rust.ipynb';
const PY = '/ws/py.ipynb';
const MOJO = '/ws/mojo.ipynb';
const SWITCH = '/ws/switch.ipynb';

/** The options object the n-th kernel start was called with. */
function startArg(n: number): { name: string } {
	return (h.startNew.mock.calls[n] as unknown as [{ name: string }])[0];
}

beforeEach(() => {
	process.env.CELLAR_WORKSPACE = '/ws';
	process.env.CELLAR_KERNELSPEC_DIR = pythonSpecDir;
	mkdirSync(pythonSpecDir, { recursive: true });
	writeFileSync(evcxr, '#!/bin/sh\n');
	chmodSync(evcxr, 0o755);
	process.env[EVCXR_ENV] = evcxr;
	h.startNew.mockClear();
	h.execCodes.length = 0;
	h.languages.clear();
	h.languages.set(RUST, 'rust');
	h.languages.set(MOJO, 'mojo');
});

afterAll(() => {
	delete process.env[EVCXR_ENV];
	delete process.env.CELLAR_KERNELSPEC_DIR;
	rmSync(tmp, { recursive: true, force: true });
});

describe('which kernel a notebook starts', () => {
	it('a Rust notebook starts the rust kernelspec, written for the found binary', async () => {
		await execute(RUST, 'let x = 1;', noop);
		expect(startArg(0).name).toBe('rust');
		expect(JSON.parse(readFileSync(rustSpecFile, 'utf8')).argv[0]).toBe(evcxr);
		expect(liveKernelLanguage(RUST)).toBe('rust');
		await shutdownKernel(RUST);
	});

	it('a Rust kernel receives the cell and no Python startup injection', async () => {
		await execute(RUST, 'let x = 1;', noop);
		expect(h.execCodes).toContain('let x = 1;');
		const python = h.execCodes.filter((c) => /matplotlib|import sys|get_ipython|sys\.path/.test(c));
		expect(python).toEqual([]);
		await shutdownKernel(RUST);
	});

	it('a Python notebook still starts python3 with its startup injection', async () => {
		await execute(PY, 'x = 1', noop);
		expect(startArg(0).name).toBe('python3');
		expect(h.execCodes.some((c) => c.includes('get_ipython()'))).toBe(true);
		expect(liveKernelLanguage(PY)).toBe('python');
		await shutdownKernel(PY);
	});

	it('a Mojo notebook runs on the Python kernel', async () => {
		await execute(MOJO, 'x = 1', noop);
		expect(startArg(0).name).toBe('python3');
		expect(liveKernelLanguage(MOJO)).toBe('python');
		await shutdownKernel(MOJO);
	});

	it('a notebook with no kernel reports no kernel language', () => {
		expect(liveKernelLanguage('/ws/never-run.ipynb')).toBeNull();
	});
});

describe('editor introspection on a Rust kernel', () => {
	it('refuses completion and docs as not_python and never asks the kernel', async () => {
		await execute(RUST, 'let x = 1;', noop);
		const sent = h.execCodes.length;
		expect(await completeInKernel(RUST, 'x.', 2)).toEqual({ ok: false, reason: 'not_python' });
		expect(await inspectInKernel(RUST, 'x', 1, 0)).toEqual({ ok: false, reason: 'not_python' });
		expect(h.execCodes.length).toBe(sent);
		await shutdownKernel(RUST);
	});
});

describe('a missing Evcxr binary', () => {
	it('refuses the start with RustKernelMissing and never asks Jupyter', async () => {
		rmSync(evcxr);
		await expect(execute(RUST, 'let x = 1;', noop)).rejects.toBeInstanceOf(RustKernelMissing);
		expect(h.startNew).not.toHaveBeenCalled();
		expect(liveKernelLanguage(RUST)).toBeNull();
	});

	it('starts on the next run once the binary is installed', async () => {
		rmSync(evcxr);
		await expect(execute(RUST, 'let x = 1;', noop)).rejects.toBeInstanceOf(RustKernelMissing);
		writeFileSync(evcxr, '#!/bin/sh\n');
		chmodSync(evcxr, 0o755);
		await execute(RUST, 'let x = 1;', noop);
		expect(startArg(0).name).toBe('rust');
		expect(existsSync(rustSpecFile)).toBe(true);
		await shutdownKernel(RUST);
	});
});

describe('syncKernelToNotebookLanguage', () => {
	it('frees a Python kernel when the notebook becomes Rust, and the next run starts Evcxr', async () => {
		await execute(SWITCH, 'x = 1', noop);
		h.languages.set(SWITCH, 'rust');
		expect(await syncKernelToNotebookLanguage(SWITCH)).toEqual({ kernel_restarted: true, namespace_cleared: true });
		expect(liveKernelLanguage(SWITCH)).toBeNull();
		await execute(SWITCH, 'let x = 1;', noop);
		expect(startArg(1).name).toBe('rust');
		await shutdownKernel(SWITCH);
	});

	it('frees a Rust kernel when the notebook becomes Python', async () => {
		h.languages.set(SWITCH, 'rust');
		await execute(SWITCH, 'let x = 1;', noop);
		h.languages.set(SWITCH, 'python');
		expect((await syncKernelToNotebookLanguage(SWITCH)).kernel_restarted).toBe(true);
		expect(liveKernelLanguage(SWITCH)).toBeNull();
	});

	it('keeps the kernel across a Python to Mojo switch', async () => {
		await execute(SWITCH, 'x = 1', noop);
		h.languages.set(SWITCH, 'mojo');
		expect(await syncKernelToNotebookLanguage(SWITCH)).toEqual({ kernel_restarted: false, namespace_cleared: false });
		expect(liveKernelLanguage(SWITCH)).toBe('python');
		await shutdownKernel(SWITCH);
	});

	it('changes nothing for a notebook with no kernel', async () => {
		h.languages.set('/ws/idle.ipynb', 'rust');
		expect(await syncKernelToNotebookLanguage('/ws/idle.ipynb')).toEqual({
			kernel_restarted: false,
			namespace_cleared: false
		});
		expect(h.startNew).not.toHaveBeenCalled();
	});
});
