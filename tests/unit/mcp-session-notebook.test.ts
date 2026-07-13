import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-MCP-session working notebook (the multi-agent targeting fix).
 *
 * Each MCP session may PIN its own working notebook, independent of the user's
 * focused tab (the global "active" notebook) and of any other agent. These tests
 * exercise the real service + notebook singletons against a scratch workspace,
 * addressing plain non-import sources so nothing touches the kernel or the
 * python dataflow subprocess (routeImports:false, and we read back through the
 * document model rather than the staleness-carrying read tools).
 */

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);
const sources = (rel: string) => nbmod.listCells(abs(rel)).map((c) => c.source);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-nb-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
});

describe('per-session working notebook', () => {
	it('two sessions pin two notebooks and each write lands in its own', async () => {
		const A = 'agent-a.ipynb';
		const B = 'agent-b.ipynb';
		const ra = svc.useNotebook('sessA', A);
		const rb = svc.useNotebook('sessB', B);
		expect(ra.pinned).toBe(true);
		expect(rb.pinned).toBe(true);
		expect(ra.working_notebook).toBe(A);
		expect(rb.working_notebook).toBe(B);

		// Targets resolve to the pinned notebooks.
		expect(svc.targetFor('sessA')).toBe(abs(A));
		expect(svc.targetFor('sessB')).toBe(abs(B));

		// A write from each session, targeted through the session's own resolution.
		const addA = await svc.addCells([{ cell_type: 'code', source: 'xa = 1' }], null, {
			nb: svc.targetFor('sessA'),
			routeImports: false
		});
		const addB = await svc.addCells([{ cell_type: 'code', source: 'xb = 2' }], null, {
			nb: svc.targetFor('sessB'),
			routeImports: false
		});
		expect(addA.ids.length).toBe(1);
		expect(addB.ids.length).toBe(1);

		// Each cell is in its own notebook, and not the other's.
		expect(sources(A)).toContain('xa = 1');
		expect(sources(A)).not.toContain('xb = 2');
		expect(sources(B)).toContain('xb = 2');
		expect(sources(B)).not.toContain('xa = 1');
	});

	it('switching the USER active tab does NOT redirect either pinned session', async () => {
		// The user focuses B; both agents keep their own pins.
		nbmod.setActiveNotebook('agent-b.ipynb');
		expect(svc.targetFor('sessA')).toBe(abs('agent-a.ipynb'));
		expect(svc.targetFor('sessB')).toBe(abs('agent-b.ipynb'));

		// The user focuses A; still no redirect.
		nbmod.setActiveNotebook('agent-a.ipynb');
		expect(svc.targetFor('sessA')).toBe(abs('agent-a.ipynb'));
		expect(svc.targetFor('sessB')).toBe(abs('agent-b.ipynb'));

		// An edit from session B while the user looks at A still lands in B.
		const bId = nbmod.listCells(abs('agent-b.ipynb')).find((c) => c.source === 'xb = 2')!.id;
		await svc.editCell(bId, 'xb = 22', { nb: svc.targetFor('sessB'), routeImports: false });
		expect(sources('agent-b.ipynb')).toContain('xb = 22');
		expect(sources('agent-a.ipynb')).not.toContain('xb = 22');
	});

	it('an unpinned session falls back to the user active notebook', () => {
		nbmod.setActiveNotebook('agent-a.ipynb');
		expect(svc.targetFor('sessNew')).toBe(abs('agent-a.ipynb'));
		nbmod.setActiveNotebook('agent-b.ipynb');
		expect(svc.targetFor('sessNew')).toBe(abs('agent-b.ipynb'));
		// No session id at all → active notebook (single-agent backward compatibility).
		expect(svc.targetFor(undefined)).toBe(abs('agent-b.ipynb'));
	});

	it('an explicit per-call notebook overrides the session pin for one call only', () => {
		svc.useNotebook('sessD', 'agent-a.ipynb');
		// Explicit wins for this call.
		expect(svc.targetFor('sessD', 'agent-b.ipynb')).toBe(abs('agent-b.ipynb'));
		// The pin itself is unchanged.
		expect(svc.targetFor('sessD')).toBe(abs('agent-a.ipynb'));
	});

	it('current_notebook reports the pin, and the active fallback when unpinned', () => {
		const pinned = svc.currentNotebook('sessA');
		expect(pinned.pinned).toBe(true);
		expect(pinned.source).toBe('session_pin');
		expect(pinned.working_notebook).toBe('agent-a.ipynb');

		nbmod.setActiveNotebook('agent-b.ipynb');
		const unpinned = svc.currentNotebook('sessZ');
		expect(unpinned.pinned).toBe(false);
		expect(unpinned.source).toBe('active_fallback');
		expect(unpinned.working_notebook).toBe('agent-b.ipynb');
	});

	it('pinning a working notebook does not steal the user focus (active pointer unchanged)', () => {
		nbmod.setActiveNotebook('agent-b.ipynb');
		const before = nbmod.getActiveNotebookPath();
		svc.useNotebook('sessE', 'agent-a.ipynb');
		// The agent declared its notebook, but the user's active tab is untouched.
		expect(nbmod.getActiveNotebookPath()).toBe(before);
		expect(svc.targetFor('sessE')).toBe(abs('agent-a.ipynb'));
	});
});
