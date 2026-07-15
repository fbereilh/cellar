import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSessionRegistry, SESSION_IDLE_MS } from '../../src/lib/server/mcp/sessions';

/**
 * MCP agent-session cleanup (memory-leak fix).
 *
 * Two halves:
 *  - the transport-agnostic McpSessionRegistry (full teardown on close + idle
 *    reaper), tested with a fake server so no HTTP/SDK is needed; and
 *  - the shared-resource-safety guarantee, tested against the REAL service +
 *    notebook singletons: forgetting a session releases only its pin and leaves
 *    the shared document + every other session untouched.
 */

/** A stand-in for an McpServer that records whether `close()` ran. */
function fakeServer() {
	const s = { closed: 0, close: vi.fn(() => { s.closed++; }) };
	return s;
}

describe('McpSessionRegistry — full teardown on close', () => {
	it('forget() closes the server, drops the entry, and clears per-session service state', () => {
		const forgotten: string[] = [];
		const reg = new McpSessionRegistry(sid => forgotten.push(sid));
		const server = fakeServer();
		reg.register('s1', { server, transport: {}, lastActivity: Date.now() });
		expect(reg.size).toBe(1);
		expect(reg.has('s1')).toBe(true);

		const did = reg.forget('s1');

		expect(did).toBe(true);
		expect(server.close).toHaveBeenCalledTimes(1); // McpServer closed → registrations dropped
		expect(reg.has('s1')).toBe(false); // entry gone
		expect(reg.size).toBe(0);
		expect(forgotten).toEqual(['s1']); // per-session service state cleared via the hook
	});

	it('forget() is idempotent and re-entrant-safe (server.close → onclose → forget is a no-op)', () => {
		let hookCalls = 0;
		const reg = new McpSessionRegistry(() => { hookCalls++; });
		// A server whose close() re-enters forget() — exactly what the real onclose does.
		const server = {
			close: vi.fn(() => {
				reg.forget('s1'); // re-entrant: entry is already deleted, so this returns false
			})
		};
		reg.register('s1', { server, transport: {}, lastActivity: Date.now() });

		expect(reg.forget('s1')).toBe(true);
		expect(server.close).toHaveBeenCalledTimes(1); // not called again by the re-entry
		expect(hookCalls).toBe(1); // per-session state cleared exactly once
		expect(reg.forget('s1')).toBe(false); // forgetting again is a no-op
		expect(hookCalls).toBe(1);
	});
});

describe('McpSessionRegistry — idle reaper', () => {
	it('reaps a session idle past the threshold via the same forget path', () => {
		const forgotten: string[] = [];
		const reg = new McpSessionRegistry(sid => forgotten.push(sid));
		const server = fakeServer();
		const now = 1_000_000;
		reg.register('stale', { server, transport: {}, lastActivity: now - SESSION_IDLE_MS - 1 });

		const reaped = reg.reapIdle(SESSION_IDLE_MS, now);

		expect(reaped).toEqual(['stale']);
		expect(server.close).toHaveBeenCalledTimes(1); // reaper used the full teardown
		expect(reg.has('stale')).toBe(false);
		expect(forgotten).toEqual(['stale']);
	});

	it('does NOT reap a session whose activity was bumped (touch keeps it alive)', () => {
		const reg = new McpSessionRegistry(() => {});
		const now = 2_000_000;
		// Registered long ago — would be reaped...
		reg.register('active', { server: fakeServer(), transport: {}, lastActivity: now - SESSION_IDLE_MS - 5 });
		// ...but a request just bumped it.
		reg.touch('active', now);

		expect(reg.reapIdle(SESSION_IDLE_MS, now)).toEqual([]);
		expect(reg.has('active')).toBe(true);
	});

	it('startReaper installs an unref\'d timer and is idempotent', () => {
		const reg = new McpSessionRegistry(() => {});
		const spy = vi.spyOn(global, 'setInterval');
		try {
			reg.startReaper();
			reg.startReaper(); // second call is a no-op
			expect(spy).toHaveBeenCalledTimes(1);
			const timer = spy.mock.results[0].value as { unref?: () => void };
			// unref keeps the timer from holding the process open.
			expect(typeof timer.unref).toBe('function');
		} finally {
			reg.stopReaper();
			spy.mockRestore();
		}
	});
});

describe('shared-resource safety (real service + notebook)', () => {
	let WS: string;
	let svc: typeof import('../../src/lib/server/mcp/service');
	let nbmod: typeof import('../../src/lib/server/notebook');
	const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

	beforeAll(async () => {
		WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-cleanup-'));
		process.env.CELLAR_WORKSPACE = WS;
		svc = await import('../../src/lib/server/mcp/service');
		nbmod = await import('../../src/lib/server/notebook');
	});

	it('forgetSession drops only the caller\'s pin — the shared doc and other sessions are untouched', async () => {
		const A = 'clean-a.ipynb';
		const B = 'clean-b.ipynb';
		svc.useNotebook('sessA', A);
		svc.useNotebook('sessB', B);
		// A real cell in A's shared document.
		await svc.addCells([{ cell_type: 'code', source: 'ka = 1' }], null, { nb: svc.targetFor('sessA'), routeImports: false });
		expect(nbmod.listCells(abs(A)).map(c => c.source)).toContain('ka = 1');
		expect(svc.currentNotebook('sessA').pinned).toBe(true);

		// Forget session A — the exact call the transport close / reaper make.
		svc.forgetSession('sessA');

		// A's pin is gone: it now falls back to the active notebook.
		expect(svc.currentNotebook('sessA').pinned).toBe(false);
		// The shared document is NOT closed — its cell survives.
		expect(nbmod.listCells(abs(A)).map(c => c.source)).toContain('ka = 1');
		// Session B is entirely unaffected — its pin still resolves to B.
		expect(svc.currentNotebook('sessB').pinned).toBe(true);
		expect(svc.targetFor('sessB')).toBe(abs(B));

		// A NEW session on the same notebook still works (shared doc intact).
		svc.useNotebook('sessC', A);
		expect(svc.targetFor('sessC')).toBe(abs(A));
		await svc.addCells([{ cell_type: 'code', source: 'kc = 3' }], null, { nb: svc.targetFor('sessC'), routeImports: false });
		expect(nbmod.listCells(abs(A)).map(c => c.source)).toContain('kc = 3');
	});

	it('forgetSession is idempotent for an unknown session', () => {
		expect(() => svc.forgetSession('never-existed')).not.toThrow();
	});
});
