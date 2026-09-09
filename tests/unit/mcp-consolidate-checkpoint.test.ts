/**
 * `consolidate_imports` on the DESTRUCTIVE checkpoint tier.
 *
 * A consolidate sweep DELETES any cell it empties, and an imports-only cell
 * routinely carries saved output (`import tensorflow` leaves a FutureWarning on
 * stderr), so that delete destroys results exactly as `delete_cells` does. On the
 * shared throttled tier four out of five such sweeps were preceded by no snapshot at
 * all, and the one that was is up to N actions older than the cell it removed - or
 * predates it entirely when the cell was created inside the same batch.
 *
 * What is pinned here is the whole rule, in both directions: a sweep that really
 * deletes an output-carrying cell takes the never-throttled snapshot and undo brings
 * that cell back WITH its outputs; a sweep that deletes nothing (the everyday
 * idempotent re-consolidate) stays on the cheap throttled tier and mints nothing;
 * and a sweep whose snapshot could not store the outputs is REFUSED before it sweeps.
 *
 * The kernel is out of scope (the imports cell RUNS when something moved), so
 * `executeCellRun` is stubbed - what is under test is the checkpoint decision and
 * what undo gives back.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/run', () => ({
	executeCellRun: vi.fn(async () => ({
		outputs: [],
		status: 'ok',
		session: 1,
		kernelDown: false,
		lastRun: { at: 0, durationMs: 0, actor: 'agent', status: 'ok', session: 1 }
	})),
	clearOutputsForQueue: () => {}
}));

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let cpmod: typeof import('../../src/lib/server/checkpoints');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-consolidate-cp-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	cpmod = await import('../../src/lib/server/checkpoints');
});

/**
 * chmod is not enforced for root, so a test that makes the sidecar directory
 * unwritable would pass VACUOUSLY there. Probed once and skipped with the reason
 * in the name (the same gate `mcp-clear-outputs.test.ts` uses).
 */
const chmodBlocksWrites = (() => {
	const probe = mkdtempSync(join(tmpdir(), 'cellar-chmod-probe-'));
	try {
		chmodSync(probe, 0o500);
		writeFileSync(join(probe, 'x'), 'x');
		return false;
	} catch {
		return true;
	} finally {
		try {
			chmodSync(probe, 0o700);
		} catch {}
	}
})();

const out = (text: string) => [{ output_type: 'stream' as const, name: 'stdout' as const, text }];

/**
 * A notebook whose FIRST cell is nothing but imports and carries saved output (the
 * shape a real `import tensorflow` cell has after one run), plus a code cell that
 * uses them. Consolidating adopts nothing - the imports cell is a fresh one at index
 * 0 - so the imports-only cell is emptied by the sweep and DELETED with its output.
 */
function notebookWithDisposableImportsCell(name: string): { target: string; doomedId: string } {
	const target = nbmod.resolveNotebookPath(name);
	nbmod.createNotebook(name);
	// The starter cell holds the code, so the sweep has a designated imports cell to
	// create and the import-only cell below is genuinely disposable.
	const starter = nbmod.listCells(target)[0]!;
	nbmod.setSource(starter.id, 'df = pd.DataFrame()', target);
	const doomed = nbmod.addCell(starter.id, 'code', target, null, 'import pandas as pd');
	nbmod.setOutputs(doomed.id, out('FutureWarning: pandas will change\n'), target);
	return { target, doomedId: doomed.id };
}

/** How many checkpoints a call minted for this notebook. */
async function checkpointsTakenBy(target: string, fn: () => Promise<unknown>): Promise<number> {
	const before = cpmod.listCheckpoints(target).length;
	await fn();
	return cpmod.listCheckpoints(target).length - before;
}

describe('a sweep that deletes an output-carrying cell is never throttled', () => {
	it('snapshots mid-batch and undo brings the deleted cell back WITH its outputs', async () => {
		const { target, doomedId } = notebookWithDisposableImportsCell('sweep-destroys.ipynb');
		// Several agent actions deep, so the shared throttle would have skipped this one.
		for (let i = 0; i < 3; i++) cpmod.autoCheckpointBeforeAgentAction(target);

		const taken = await checkpointsTakenBy(target, () => svc.consolidate(target));
		expect(taken, 'the sweep took its own checkpoint').toBe(1);

		// The cell really is gone, output and all.
		expect(nbmod.listCells(target).some((c) => c.id === doomedId)).toBe(false);

		expect(cpmod.undoLastAgentAction(target).ok).toBe(true);
		const back = nbmod.listCells(target).find((c) => c.id === doomedId);
		expect(back, 'undo restored the deleted cell').toBeTruthy();
		expect((back!.outputs?.[0] as { text?: string })?.text).toBe('FutureWarning: pandas will change\n');
	});

	it.skipIf(!chmodBlocksWrites)('REFUSES before sweeping when the checkpoint cannot store the outputs', async () => {
		const { target, doomedId } = notebookWithDisposableImportsCell('sweep-refused.ipynb');
		// The sidecar dir must EXIST before it is made unwritable, or the failure would
		// be a mkdir one rather than the full-disk shape under test.
		cpmod.createCheckpoint(target, { trigger: 'manual' });
		const dir = join(WS, '.cellar', 'checkpoints');
		const before = cpmod.listCheckpoints(target).length;
		const sourceBefore = nbmod.listCells(target).map((c) => c.source);

		chmodSync(dir, 0o500);
		let r: Awaited<ReturnType<typeof svc.consolidate>>;
		try {
			r = await svc.consolidate(target);
		} finally {
			chmodSync(dir, 0o700);
		}

		expect(r).toMatchObject({ ok: false, refused: 'outputs_unrecoverable' });
		expect('reason' in r && r.reason).toMatch(/nothing was changed/i);
		expect('reason' in r && r.reason).toMatch(/allow_unrecoverable/);
		// Nothing swept, nothing deleted, and no leftover snapshot of an unchanged doc.
		expect(nbmod.listCells(target).map((c) => c.source)).toEqual(sourceBefore);
		expect(nbmod.listCells(target).some((c) => c.id === doomedId)).toBe(true);
		expect(cpmod.listCheckpoints(target).length - before, 'a refused call leaves no snapshot').toBe(0);
	});

	it.skipIf(!chmodBlocksWrites)('sweeps anyway when the caller waives the guarantee, and SAYS what was lost', async () => {
		const { target, doomedId } = notebookWithDisposableImportsCell('sweep-waived.ipynb');
		cpmod.createCheckpoint(target, { trigger: 'manual' });
		const dir = join(WS, '.cellar', 'checkpoints');
		chmodSync(dir, 0o500);
		let r: Awaited<ReturnType<typeof svc.consolidate>>;
		try {
			r = await svc.consolidate(target, { allowUnrecoverable: true });
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(r).toMatchObject({ changed: true });
		// The refusal is the primary mitigation; a caller that WAIVED it still gets the
		// fact in its own result, in the one `undo` shape every destructive tool uses.
		expect('undo' in r && r.undo).toMatchObject({ outputs_recoverable: false });
		expect(nbmod.listCells(target).some((c) => c.id === doomedId)).toBe(false);
	});

	it('says nothing about undo on an ordinary sweep whose outputs really are recoverable', async () => {
		const { target } = notebookWithDisposableImportsCell('sweep-ordinary.ipynb');
		const r = await svc.consolidate(target);
		expect(r).toMatchObject({ changed: true });
		// Conditional, so an ordinary sweep pays no tokens for it.
		expect('undo' in r).toBe(false);
	});
});

describe('a sweep that deletes nothing stays on the throttled tier', () => {
	it('mints no destructive checkpoint for an idempotent re-consolidate', async () => {
		const { target } = notebookWithDisposableImportsCell('sweep-idempotent.ipynb');
		// First sweep: destructive, and it deletes the imports-only cell.
		await svc.consolidate(target);
		// Put the recoverable tier mid-batch so a throttled call is due to be SKIPPED;
		// a destructive one would snapshot regardless, which is what tells them apart.
		for (let i = 0; i < 2; i++) cpmod.autoCheckpointBeforeAgentAction(target);

		const taken = await checkpointsTakenBy(target, () => svc.consolidate(target));
		expect(taken, 'nothing was destroyed, so nothing was snapshotted').toBe(0);
	});

	it('mints no destructive checkpoint when the swept cell carries no output', async () => {
		// The same sweep, same deletion - but the cell holds no saved result, so there
		// is nothing a re-run could not recreate and nothing to protect.
		const target = nbmod.resolveNotebookPath('sweep-no-output.ipynb');
		nbmod.createNotebook('sweep-no-output.ipynb');
		const starter = nbmod.listCells(target)[0]!;
		nbmod.setSource(starter.id, 'df = pd.DataFrame()', target);
		nbmod.addCell(starter.id, 'code', target, null, 'import pandas as pd');
		for (let i = 0; i < 2; i++) cpmod.autoCheckpointBeforeAgentAction(target);

		const taken = await checkpointsTakenBy(target, () => svc.consolidate(target));
		expect(taken, 'a delete that destroys no output is not destructive').toBe(0);
	});
});

/**
 * An in-memory MCP client over the SHIPPED `createCellarMcpServer()` - the same
 * factory `startMcpServer` mints a session with - so what is asserted is what an
 * agent is really handed at connect and on a call, never the registration's source
 * text (a reformat cannot break it, dead code cannot satisfy it).
 */
async function connectAgent(): Promise<{ desc?: string; call: (args: Record<string, unknown>) => Promise<{ isError: boolean; payload: Record<string, unknown> }> }> {
	const srv = await import('../../src/lib/server/mcp/server');
	const server = srv.createCellarMcpServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const desc = (await client.listTools()).tools.find((t) => t.name === 'consolidate_imports')?.description;
	return {
		desc,
		call: async (args) => {
			const res = await client.callTool({ name: 'consolidate_imports', arguments: args });
			const first = (res.content as { type: string; text: string }[])[0];
			return { isError: res.isError === true, payload: res.isError ? { text: first.text } : JSON.parse(first.text) };
		}
	};
}

describe('what the AGENT is handed - the shipped registration, not the service function', () => {
	/**
	 * A tool result reaches an agent through its HANDLER, so a handler that answers
	 * with its own success literal rather than forwarding the service result drops
	 * whatever the service added, invisibly to any assertion made on the service.
	 * The waived-path `undo` warning is therefore pinned at this layer too.
	 */
	it.skipIf(!chmodBlocksWrites)('carries the waived-path undo warning on the wire', async () => {
		const nb = 'sweep-wire-waived.ipynb';
		const { target } = notebookWithDisposableImportsCell(nb);
		cpmod.createCheckpoint(target, { trigger: 'manual' });
		const { call } = await connectAgent();
		const dir = join(WS, '.cellar', 'checkpoints');
		chmodSync(dir, 0o500);
		let r: { isError: boolean; payload: Record<string, unknown> };
		try {
			r = await call({ allow_unrecoverable: true, notebook: nb });
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(r.isError, 'the waived sweep should have proceeded').toBe(false);
		expect(r.payload.undo).toMatchObject({ outputs_recoverable: false });
	});

	it('says nothing about undo on an ordinary sweep', async () => {
		const nb = 'sweep-wire-ordinary.ipynb';
		notebookWithDisposableImportsCell(nb);
		const { call } = await connectAgent();
		const r = await call({ notebook: nb });
		expect(r.isError).toBe(false);
		// Conditional, so an ordinary sweep pays no tokens for it.
		expect('undo' in r.payload).toBe(false);
	});
});

describe('the description an agent is billed for says what the sweep now guarantees', () => {
	it('names the delete, the undo it now backs, and the one case it refuses', async () => {
		// The description is the only thing most agents ever read about this tool, and
		// it never said the sweep DELETES cells at all - so it has to say that, what now
		// happens to their outputs, and that the call can be refused. Read off the string
		// the SHIPPED server EMITS at connect, not off the registration's source text.
		const desc = (await connectAgent()).desc;
		expect(desc, 'consolidate_imports must be registered with a description').toBeTruthy();

		expect(desc).toMatch(/EMPTIES is deleted/);
		expect(desc).toMatch(/undo brings that cell back WITH them/);
		expect(desc).toMatch(/REFUSES before sweeping/);
		expect(desc).toMatch(/allow_unrecoverable/);
		// ...and paid for by cutting elsewhere rather than by growing the string every
		// session is billed for: the same 700-char bound its destructive siblings hold.
		expect(desc!.length).toBeLessThan(700);
	});
});
