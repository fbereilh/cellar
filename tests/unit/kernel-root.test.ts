/**
 * A notebook's CODE ROOT reaches the kernel — the two bindings, and nothing else.
 *
 * A root changes exactly two things about a kernel:
 *   1. the process's working directory, sent as the `path` field of the
 *      kernel-start request (jupyter resolves it under `root_dir`), and
 *   2. the entry Cellar prepends to `sys.path` at startup.
 *
 * Both are asserted here against the REAL `kernel.ts` with the Jupyter layer
 * mocked, because the whole risk is a request field and an injected string: a
 * notebook with no root must send the SAME request it always did (no `path` at
 * all), and a notebook with one must send that root — the two are opposite
 * failures and one test cannot see both.
 *
 * `sys.path` is read off the recorded SESSION rather than the document on
 * purpose: `restart()` reuses the process (and its cwd), so re-injecting a root
 * the document has since changed would put `sys.path` and the real cwd in
 * disagreement. The restart case below pins that.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;
	const execCodes: string[] = [];
	/** What the fake kernel reports as its cwd, or null to print nothing at all. */
	const fakeCwd: { value: string | null } = { value: null };
	function makeFakeKernel() {
		seq += 1;
		return {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as const,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: vi.fn((args: { code: string }) => {
				execCodes.push(args.code);
				const future: { onIOPub: null | ((msg: unknown) => void); done: Promise<unknown> } = {
					onIOPub: null,
					// Resolved a microtask later, so `onIOPub` — which the caller assigns
					// AFTER this returns — is in place before any output is delivered.
					done: Promise.resolve().then(() => {
						// The startup cwd verification is the one injection whose ANSWER
						// matters, so the fake kernel can be told to report a cwd. Left unset
						// it prints nothing, which `verifyKernelCwd` treats as unverifiable
						// (never a mismatch), so every other test here is unaffected.
						if (fakeCwd.value !== null && args.code.includes('getcwd')) {
							future.onIOPub?.({
								header: { msg_type: 'stream' },
								content: { name: 'stdout', text: `${fakeCwd.value}\n` }
							});
						}
						return { content: { status: 'ok', execution_count: 1 } };
					})
				};
				return future;
			}),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return {
		execCodes,
		fakeCwd,
		startNew: vi.fn(async () => makeFakeKernel()),
		dispose: vi.fn(),
		// nbPath -> declared workspace-relative root (null = the workspace root).
		roots: new Map<string, string | null>()
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
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`),
	getNotebookRoot: (nb: string) => h.roots.get(nb) ?? null
}));

// The resolver's fs checks are the subject of `notebook-root.test.ts`; here the
// fake workspace has no real directories, so only its RESULT matters — which
// root each kernel is started with.
vi.mock('../../src/lib/server/notebookRoot', () => ({
	notebookRoot: (nb: string) => {
		const rel = h.roots.get(nb) ?? null;
		// The real `ResolvedRoot` shape: `apiPath` is what jupyter is sent and is
		// deliberately a SEPARATE field from the persisted declaration, so that the
		// wiring assertions below are about the field the kernel actually reads.
		// An external worktree is `../name`, resolved outside the fake workspace.
		if (!rel) return null;
		const external = rel.startsWith('../');
		return {
			rel,
			dir: external ? `/${rel.replace(/^\.\.\//, '')}` : `/ws/${rel}`,
			apiPath: rel,
			kind: external ? 'worktree' : 'workspace'
		};
	}
}));

vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { execute, restartKernel, shutdownKernel } from '../../src/lib/server/kernel';

const noop = () => {};

/** The options object the n-th kernel start was called with. */
function startArg(n: number): unknown {
	return (h.startNew.mock.calls[n] as unknown as unknown[])[0];
}
const PLAIN = '/ws/plain.ipynb';
const ROOTED = '/ws/rooted.ipynb';

/** The `sys.path.insert` root the startup injection used, or null when it injected none. */
function injectedSysPathRoot(): string | null {
	const line = h.execCodes.map((c) => /_cellar_root = "([^"]+)"/.exec(c)).find(Boolean);
	return line ? line[1] : null;
}

beforeEach(() => {
	process.env.CELLAR_WORKSPACE = '/ws';
	h.startNew.mockClear();
	h.execCodes.length = 0;
});

describe('a notebook with NO declared root is byte-for-byte unchanged', () => {
	it('starts its kernel with no `path` field at all', async () => {
		h.roots.set(PLAIN, null);
		await execute(PLAIN, 'x=1', noop);
		expect(h.startNew).toHaveBeenCalledTimes(1);
		// Not `path: undefined`, not `path: ''` — the field must be ABSENT, so the
		// request the sidecar sees is the one it has always seen.
		expect(startArg(0)).toEqual({ name: 'python3' });
		await shutdownKernel(PLAIN);
	});

	it('prepends the WORKSPACE root to sys.path, as before', async () => {
		h.roots.set(PLAIN, null);
		await execute(PLAIN, 'x=1', noop);
		expect(injectedSysPathRoot()).toBe('/ws');
		await shutdownKernel(PLAIN);
	});
});

describe('a notebook WITH a declared root', () => {
	it('starts its kernel at that root and puts it on sys.path', async () => {
		h.roots.set(ROOTED, 'roots/pr-482');
		await execute(ROOTED, 'x=1', noop);
		// The workspace-relative root is what jupyter resolves under `root_dir`.
		expect(startArg(0)).toEqual({ name: 'python3', path: 'roots/pr-482' });
		// …and the ABSOLUTE directory is what goes on sys.path.
		expect(injectedSysPathRoot()).toBe('/ws/roots/pr-482');
		await shutdownKernel(ROOTED);
	});

	it('leaves a sibling notebook on the workspace: two roots, one instance', async () => {
		h.roots.set(PLAIN, null);
		h.roots.set(ROOTED, 'roots/pr-482');
		await execute(PLAIN, 'x=1', noop);
		await execute(ROOTED, 'y=2', noop);
		expect(h.startNew.mock.calls.map((_c, i) => startArg(i))).toEqual([
			{ name: 'python3' },
			{ name: 'python3', path: 'roots/pr-482' }
		]);
		await shutdownKernel(PLAIN);
		await shutdownKernel(ROOTED);
	});

	it('re-injects the root the PROCESS runs in on restart, not the document’s new one', async () => {
		h.roots.set(ROOTED, 'roots/pr-482');
		await execute(ROOTED, 'x=1', noop);
		// The declaration changes underneath (a hand edit, or another surface) WITHOUT
		// the kernel being freed. `restart()` reuses the same process, whose cwd is
		// still the old root — so the re-injected sys.path must be the old one too.
		h.roots.set(ROOTED, 'roots/other');
		h.execCodes.length = 0;
		await restartKernel(ROOTED);
		expect(injectedSysPathRoot()).toBe('/ws/roots/pr-482');
		// Freeing the kernel is what applies the new root: the next run starts there.
		await shutdownKernel(ROOTED);
		h.startNew.mockClear();
		h.execCodes.length = 0;
		await execute(ROOTED, 'z=3', noop);
		expect(startArg(0)).toEqual({ name: 'python3', path: 'roots/other' });
		expect(injectedSysPathRoot()).toBe('/ws/roots/other');
		await shutdownKernel(ROOTED);
	});
});

describe('a kernel whose cwd is REFUSED is never left serving runs', () => {
	const WT = '/ws/wt.ipynb';

	beforeEach(() => {
		h.roots.set(WT, '../pr-398');
		h.fakeCwd.value = null;
	});

	it('a START that fails verification shuts the process down and refuses', async () => {
		h.fakeCwd.value = '/somewhere/else';
		await expect(execute(WT, 'x=1', noop)).rejects.toThrow(/declared code root/i);
		// The refused start left no process behind, so nothing would ever reap it…
		const started = h.startNew.mock.results[0].value as Promise<{
			shutdown: { mock: { calls: unknown[] } };
			statusChanged: { disconnect: { mock: { calls: unknown[] } } };
		}>;
		expect((await started).shutdown.mock.calls.length).toBe(1);
		// …and no LISTENER behind either. Every other teardown path disconnects the
		// status handler (`teardownKernel`), and this one must match: the map entry
		// outlives the shutdown (the `startPromise.catch` drops it), and
		// `nbKernel.connection` still points at this kernel, so a flip emitted while
		// the process goes away would otherwise fan a `kernel:status` snapshot out to
		// every tab for a kernel that has already been refused.
		expect((await started).statusChanged.disconnect.mock.calls.length).toBe(1);
		// …and no entry behind either: the next run is a fresh START, not a reuse.
		h.fakeCwd.value = null;
		h.startNew.mockClear();
		await execute(WT, 'x=1', noop);
		expect(h.startNew).toHaveBeenCalledTimes(1);
		await shutdownKernel(WT);
	});

	it('a RESTART that fails verification tears the kernel down instead of keeping it', async () => {
		// The regression: `getKernel` short-circuits on an EXISTING map entry without
		// re-verifying, and a restart's entry is already there with a resolved
		// `startPromise` — so a refusal that merely propagated left every LATER run
		// executing against the kernel whose cwd had just been refused, which is
		// exactly the silent degrade the verification exists to prevent.
		await execute(WT, 'x=1', noop);
		const first = await (h.startNew.mock.results[0].value as Promise<{ id: string; shutdown: { mock: { calls: unknown[] } } }>);

		h.fakeCwd.value = '/somewhere/else';
		await expect(restartKernel(WT)).rejects.toThrow(/declared code root/i);
		expect(first.shutdown.mock.calls.length).toBe(1);

		// The proof that matters: the next run gets a NEW kernel, never the refused one.
		h.fakeCwd.value = null;
		h.startNew.mockClear();
		await execute(WT, 'y=2', noop);
		expect(h.startNew).toHaveBeenCalledTimes(1);
		const next = await (h.startNew.mock.results[0].value as Promise<{ id: string }>);
		expect(next.id).not.toBe(first.id);
		await shutdownKernel(WT);
	});
});
