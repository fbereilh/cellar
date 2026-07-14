/**
 * Long-running MCP run tools must not go silent.
 *
 * An agent's MCP client (Claude Code) enforces a per-tool-call timeout (~60s by
 * default) and DISCARDS the eventual result if the server holds the response open
 * that long with no traffic — so a cell that runs longer than the timeout makes
 * the agent hang and lose the result even though the run finishes server-side.
 * `withProgress` is the fix: while the run tool awaits the kernel it emits
 * periodic MCP progress notifications against the request's progressToken, which
 * resets the client's timeout and keeps the call alive, and it STILL returns the
 * full result at the end (contract unchanged).
 *
 * These drive the real helper with a fake clock and a stubbed sendNotification —
 * no kernel, no network — so they assert exactly the two guarantees: heartbeats
 * fire on the interval while awaiting, and the final value is delivered.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ProgressNote = { method: string; params: { progressToken: string | number; progress: number; total?: number; message?: string } };

// Derive the local's type from the module so it matches `withProgress`'s real
// `ToolExtra`-typed signature (which isn't exported); a hand-written `unknown`
// param is contravariantly incompatible under strict function checks.
let withProgress: typeof import('../../src/lib/server/mcp/server').withProgress;
let PROGRESS_INTERVAL_MS: number;

beforeAll(async () => {
	// The server module imports the whole service graph; a workspace keeps any
	// import-time env read happy. We never run a service function here.
	process.env.CELLAR_WORKSPACE = mkdtempSync(join(tmpdir(), 'cellar-progress-'));
	const mod = await import('../../src/lib/server/mcp/server');
	withProgress = mod.withProgress;
	PROGRESS_INTERVAL_MS = mod.PROGRESS_INTERVAL_MS;
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withProgress — MCP long-run keepalive', () => {
	it('emits periodic progress notifications while awaiting, then returns the result', async () => {
		const sent: ProgressNote[] = [];
		const extra = { _meta: { progressToken: 'tok-1' }, sendNotification: async (n: ProgressNote) => void sent.push(n) };

		let resolveRun!: (v: string) => void;
		const runPromise = new Promise<string>((r) => (resolveRun = r));
		const p = withProgress(extra, () => runPromise);

		// Sit in the kernel for ~3.2 intervals: three heartbeats should have fired,
		// monotonically increasing, each carrying the request's progressToken.
		await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3 + 1000);
		expect(sent.length).toBe(3);
		expect(sent[0]).toMatchObject({ method: 'notifications/progress', params: { progressToken: 'tok-1', progress: 1 } });
		expect(sent.map((n) => n.params.progress)).toEqual([1, 2, 3]);

		// The run finishes: the full result is delivered (contract unchanged) and the
		// heartbeat stops — no notifications after resolution.
		resolveRun('the-real-result');
		await expect(p).resolves.toBe('the-real-result');
		await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2);
		expect(sent.length).toBe(3);
	});

	it('is a no-op passthrough when the client sent no progressToken', async () => {
		const sent: ProgressNote[] = [];
		const extra = { sendNotification: async (n: ProgressNote) => void sent.push(n) };
		const p = withProgress(extra, async () => 'x');
		await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 5);
		await expect(p).resolves.toBe('x');
		expect(sent).toEqual([]);
	});

	it('a fast run under one interval sends no notifications', async () => {
		const sent: ProgressNote[] = [];
		const extra = { _meta: { progressToken: 7 }, sendNotification: async (n: ProgressNote) => void sent.push(n) };
		const p = withProgress(extra, async () => 42);
		await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS - 1);
		await expect(p).resolves.toBe(42);
		expect(sent).toEqual([]);
	});

	it('a failing sendNotification never breaks the run', async () => {
		const extra = { _meta: { progressToken: 'x' }, sendNotification: async () => { throw new Error('transport gone'); } };
		let resolveRun!: (v: string) => void;
		const runPromise = new Promise<string>((r) => (resolveRun = r));
		const p = withProgress(extra, () => runPromise);
		await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2);
		resolveRun('ok');
		await expect(p).resolves.toBe('ok');
	});
});
