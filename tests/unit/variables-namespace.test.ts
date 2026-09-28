/**
 * The Variables panel clears rows whose namespace died, however it died and
 * whoever killed it.
 *
 * The page's OWN restart / shutdown cleared the panel; a FOREIGN one (an agent's
 * `restart_kernel`, another tab's Shut down, an autorestart) reached nothing, so
 * the page listed variables from a namespace that no longer existed. The fix tags
 * the rows with the (notebook, session) the probe really read and asks every
 * lifecycle broadcast whether that namespace survives. This file drives:
 *
 *   1. the pure rule (`$lib/variablesNamespace`) across every lifecycle shape;
 *   2. the SERVER half: `inspectVariables` names the namespace it read, taken
 *      from the probe's own execute rather than sampled around the await;
 *   3. source guards on the shell wiring - `+page.svelte` cannot be mounted under
 *      vitest (no SvelteKit plugin), and e2e is absent from the pre-push gate. The
 *      behavioural proof in a real browser is `tests/e2e/foreign-action-refresh.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStreamEvent } from '../../src/lib/server/types';
import type { KernelListEntry } from '../../src/lib/kernelBadge';
import {
	namespaceOf,
	namespaceSurvives,
	anyNamespaceDied,
	shutdownEnds
} from '../../src/lib/variablesNamespace';

const h = vi.hoisted(() => ({
	status: 'idle' as 'idle' | 'busy' | 'not_started',
	active: '/ws/nb.ipynb',
	execute: vi.fn()
}));

vi.mock('../../src/lib/server/kernel', () => ({
	kernelStatus: () => ({ status: h.status, id: 'k1' }),
	kernelSession: () => ({ session_id: 9 }),
	currentSessionId: () => 9,
	execute: h.execute
}));

vi.mock('../../src/lib/server/notebook', () => ({
	getNotebookRoot: () => null,
	getActiveNotebookPath: () => h.active,
	resolveNotebookPath: (nb?: string | null) => nb ?? h.active,
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, '')
}));

vi.mock('../../src/lib/server/run-queue', () => ({
	queueStateFor: () => ({ running: null, queue: [] })
}));

import { inspectVariables } from '../../src/lib/server/inspect';

const entry = (path: string, session_id: number | null): KernelListEntry => ({
	path,
	name: 'python3',
	started: true,
	id: 'k-' + path,
	status: 'idle',
	session_id,
	busy: false,
	memoryRss: null
});

describe('the rule: does the namespace the rows describe survive?', () => {
	const ns = { path: 'a.ipynb', session: 4 };

	it('survives a snapshot where its notebook keeps the same session', () => {
		expect(namespaceSurvives(ns, [entry('a.ipynb', 4), entry('b.ipynb', 7)])).toBe(true);
	});

	it('dies on a RESTART / autorestart: the notebook reports a new session', () => {
		expect(namespaceSurvives(ns, [entry('a.ipynb', 8)])).toBe(false);
	});

	it('dies on a SHUTDOWN / cull / rebind / replaced server: the notebook has no kernel', () => {
		expect(namespaceSurvives(ns, [entry('b.ipynb', 7)])).toBe(false);
		expect(namespaceSurvives(ns, [])).toBe(false);
	});

	it('is not convicted by a kernel whose session is not known yet', () => {
		// A connecting kernel reports `session_id: null`; that is evidence of nothing
		// (a restart keeps its connection and so always reports one).
		expect(namespaceSurvives(ns, [entry('a.ipynb', null)])).toBe(true);
	});

	it('compares paths separator-blind', () => {
		expect(namespaceSurvives({ path: 'd\\a.ipynb', session: 4 }, [entry('d/a.ipynb', 4)])).toBe(true);
	});

	it('another notebook dying never convicts these rows', () => {
		expect(namespaceSurvives(ns, [entry('a.ipynb', 4)])).toBe(true); // b vanished; a is fine
	});
});

describe('the rule: did ANY namespace die between two snapshots?', () => {
	it('reports a restart and a shutdown, anywhere', () => {
		expect(anyNamespaceDied([entry('b.ipynb', 2)], [entry('b.ipynb', 5)])).toBe(true);
		expect(anyNamespaceDied([entry('b.ipynb', 2)], [])).toBe(true);
	});

	it('does not report a start, a busy/idle flip, or a kernel still connecting', () => {
		expect(anyNamespaceDied([], [entry('b.ipynb', 5)])).toBe(false); // first start
		expect(anyNamespaceDied([entry('b.ipynb', null)], [entry('b.ipynb', 5)])).toBe(false); // connected
		expect(anyNamespaceDied([entry('b.ipynb', 5)], [{ ...entry('b.ipynb', 5), busy: true }])).toBe(false);
	});
});

describe('the rule: does a kernel:shutdown end these rows?', () => {
	const ns = { path: 'a.ipynb', session: 4 };

	it('ends rows read from exactly the session that died', () => {
		expect(shutdownEnds(ns, 'a.ipynb', 4)).toBe(true);
	});

	it('never clears rows a NEWER kernel of the same notebook produced', () => {
		expect(shutdownEnds(ns, 'a.ipynb', 3)).toBe(false);
	});

	it('leaves another notebook alone, and a path it cannot read alone', () => {
		expect(shutdownEnds(ns, 'b.ipynb', 4)).toBe(false);
		expect(shutdownEnds(ns, null, 4)).toBe(false);
	});

	it('takes an event that names no session at its word for the whole notebook', () => {
		expect(shutdownEnds(ns, 'a.ipynb', undefined)).toBe(true);
	});
});

describe('namespaceOf: a probe reply names its namespace or none', () => {
	it('tags a reply that names both a path and a session', () => {
		expect(namespaceOf({ path: 'a.ipynb', session_id: 3 })).toEqual({ path: 'a.ipynb', session: 3 });
	});

	it('tags nothing for a kernel that is not running, or an older server', () => {
		expect(namespaceOf({ path: 'a.ipynb', session_id: null })).toBeNull();
		expect(namespaceOf({})).toBeNull();
		expect(namespaceOf(null)).toBeNull();
	});
});

describe('inspectVariables names the namespace it read', () => {
	beforeEach(() => {
		h.status = 'idle';
		h.active = '/ws/nb.ipynb';
		h.execute.mockReset();
	});

	it("reports the session the probe EXECUTED in, not the one sampled beside it", async () => {
		// `kernelSession` would say 9; the probe's own kernel event says 6 - the
		// namespace the list was really read from, which is the only honest tag.
		h.execute.mockImplementation((_nb: string, _code: string, onEvent: (e: RunStreamEvent) => void) => {
			onEvent({ type: 'kernel', id: 'k1', session: 6 } as RunStreamEvent);
			onEvent({
				type: 'output',
				output: {
					output_type: 'stream',
					name: 'stdout',
					text: JSON.stringify({ imports: [], functions: [], classes: [], variables: [] })
				}
			} as RunStreamEvent);
			return Promise.resolve({ status: 'ok' });
		});
		const res = await inspectVariables();
		expect(res).toMatchObject({ path: 'nb.ipynb', session_id: 6, variables: [] });
		// Pinned to the notebook it named, never re-reading the active one at execute time.
		expect(h.execute.mock.calls[0][0]).toBe('/ws/nb.ipynb');
	});

	it('names the notebook with no session when there is no kernel', async () => {
		h.status = 'not_started';
		expect(await inspectVariables()).toEqual({ variables: [], path: 'nb.ipynb', session_id: null });
		expect(h.execute).not.toHaveBeenCalled();
	});
});

describe('the shell wires every lifecycle broadcast to that rule', () => {
	const src = readFileSync(join(process.cwd(), 'src/routes/+page.svelte'), 'utf8');
	function blockAt(marker: string): string {
		const start = src.indexOf(marker);
		expect(start, `anchor not found: ${marker}`).toBeGreaterThan(-1);
		let depth = 0;
		for (let i = start + marker.indexOf('{'); i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
		}
		throw new Error('unbalanced');
	}
	const handler = blockAt('subscribeEvents((ev: ClientEvent) => {');
	const branch = (type: string) => {
		const i = handler.indexOf(`if (ev.type === '${type}') {`);
		expect(i, type).toBeGreaterThan(-1);
		return handler.slice(i, handler.indexOf('return;', i));
	};

	it('tags the rows wherever the probe writes them, and untags them on a wipe', () => {
		expect(blockAt('async function refreshVariables() {')).toMatch(
			/variables = body\.variables;\s*varsNamespace = namespaceOf\(body\);/
		);
		expect(blockAt('function wipeVariablesLocally() {')).toContain('varsNamespace = null');
	});

	it('a kernel:status snapshot clears dead rows and re-reads the badge', () => {
		const status = branch('kernel:status');
		expect(status).toContain('namespaceSurvives(varsNamespace, next)');
		expect(status).toContain('anyNamespaceDied(prev, next)');
		expect(status).toContain('onNamespaceDeath(');
		// Compared against the previous SSE snapshot, never against `kernels`, which a
		// fetch reply can overwrite out of order.
		expect(status).toMatch(/const prev = lastSeenKernels;/);
	});

	it('a kernel:shutdown clears rows read from the session that died', () => {
		const shutdown = branch('kernel:shutdown');
		expect(shutdown).toContain('shutdownEnds(varsNamespace, rel, ev.session_id)');
		expect(shutdown).toContain('onNamespaceDeath(');
	});

	it('the death handler wipes the rows, supersedes an in-flight probe and re-reads the badge', () => {
		const death = blockAt('function onNamespaceDeath(rowsDead: boolean) {');
		expect(death).toContain('if (rowsDead) wipeVariablesLocally();');
		expect(death).toMatch(/varsReqSeq\+\+;[\s\S]*scheduleForeignVariablesRefresh\(\)/);
		expect(death).toContain('refreshKernel()');
	});

	it('a FOREIGN variables-wipe re-reads the panel; our own returns first', () => {
		const wiped = handler.slice(handler.indexOf("if (ev.type === 'kernel:variables-wiped') {"));
		expect(wiped.indexOf('ev.originId === originId) return;')).toBeGreaterThan(-1);
		expect(wiped.indexOf('ev.originId === originId) return;')).toBeLessThan(
			wiped.indexOf('scheduleForeignVariablesRefresh()')
		);
		// ...and our own wipe tells the server who asked, or it could never tell.
		expect(blockAt('async function wipeKernel(path: string) {')).toContain(
			'JSON.stringify({ path, originId })'
		);
	});
});
