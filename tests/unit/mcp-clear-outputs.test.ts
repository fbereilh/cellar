/**
 * MCP `clear_outputs`: clearing cell outputs from the agent surface.
 *
 * Clearing outputs existed only in the UI ("Clear all outputs") and as internal
 * helpers, so an agent facing a stale figure or a megabyte traceback had to
 * delete and recreate the cell. This is that capability wired as a first-class
 * tool, in `delete_cells`' shape: batch, handle-addressed, all-or-nothing.
 *
 * The two contracts worth pinning are the ones a wrong guess would silently
 * break: the ADDRESSING rule (omit ids ⇒ clear everything, an EMPTY list is a
 * refusal, a bad handle clears nothing) and the promise that clearing OUTPUT
 * changes no RUN semantics — `lastRun` survives, so `run_status` /
 * `ran_this_session` are untouched and only `has_output` flips.
 *
 * Drives the REAL service + notebook singletons against a scratch workspace,
 * with import-free sources (routeImports:false) so nothing touches the kernel or
 * the python dataflow subprocess.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-clear-outputs-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
});

/** One stream output, the shape a `print()` leaves behind. */
const out = (text: string) => [{ output_type: 'stream' as const, name: 'stdout' as const, text }];

/**
 * A notebook of `n` code cells, each carrying a saved output — set through the
 * real `setOutputs`, so the outputs are on disk exactly as a run would leave
 * them. Returns the emitted handles (what an agent gets back).
 */
async function makeNotebook(name: string, n: number): Promise<{ target: string; handles: string[] }> {
	const target = abs(name);
	svc.useNotebook(`sess-${name}`, name);
	const specs = Array.from({ length: n }, (_, i) => ({ cell_type: 'code' as const, source: `a = ${i}` }));
	const { ids } = await svc.addCells(specs, null, { nb: target, routeImports: false });
	for (const [i, h] of ids.entries()) nbmod.setOutputs(svc.resolveRef(target, h), out(`out ${i}\n`), target);
	return { target, handles: ids };
}

/** Which cells still hold outputs, by index over the live document. */
const withOutputs = (target: string) =>
	nbmod
		.listCells(target)
		.map((c, i) => (c.outputs?.length ? i : -1))
		.filter((i) => i >= 0);

describe('clear_outputs clears the cells it is given', () => {
	it('clears exactly the named cells and leaves every other output intact', async () => {
		const { target, handles } = await makeNotebook('clear-some.ipynb', 5);
		// Cell 0 is the empty starter cell a fresh notebook is created with, so the
		// five carrying output are 1..5 — clear three of them, out of document order.
		const r = svc.clearOutputs([handles[3], handles[0], handles[2]], target);

		expect(r.ok).toBe(true);
		expect(r.ok && r.count).toBe(3);
		expect(r.ok && r.cleared).toHaveLength(3);
		// Only the untouched cells still hold output.
		expect(withOutputs(target)).toEqual([2, 5]);
	});

	it('clears exactly one cell when given one id (the single-cell case, same tool)', async () => {
		const { target, handles } = await makeNotebook('clear-one.ipynb', 3);
		expect(svc.clearOutputs([handles[1]], target)).toMatchObject({ ok: true, count: 1 });
		expect(withOutputs(target)).toEqual([1, 3]);
	});

	it('collapses duplicate ids instead of clearing twice', async () => {
		const { target, handles } = await makeNotebook('clear-dupes.ipynb', 3);
		const r = svc.clearOutputs([handles[0], handles[0], handles[2]], target);
		expect(r.ok && r.count).toBe(2);
		expect(withOutputs(target)).toEqual([2]);
	});

	it('persists, so the cleared state survives a reload from the .ipynb', async () => {
		const { target, handles } = await makeNotebook('clear-persist.ipynb', 3);
		svc.clearOutputs([handles[0], handles[1]], target);

		const onDisk = JSON.parse(readFileSync(target, 'utf8')) as { cells: Array<{ outputs?: unknown[] }> };
		// Index 0 is the empty starter cell (never had output); 1 and 2 were cleared,
		// 3 was not — the human's git sees exactly that.
		expect(onDisk.cells.map((c) => (c.outputs?.length ?? 0) > 0)).toEqual([false, false, false, true]);
	});

	it('emits one cell:cleared per cleared cell, despite being one document write', async () => {
		const { target, handles } = await makeNotebook('clear-events.ipynb', 4);
		// The batch is ONE persist (notebook.ts clearOutputsForCells), but the client
		// contract is unchanged: every open tab gets the same per-cell event it
		// already applies, so a connected UI updates live with no new event shape.
		const seen: string[] = [];
		const off = events.subscribe((e) => {
			const ev = e as { type: string; nb?: string; cellId?: string };
			if (ev.type === 'cell:cleared' && ev.nb === target) seen.push(ev.cellId!);
		});
		try {
			svc.clearOutputs([handles[0], handles[2]], target);
		} finally {
			off();
		}
		expect(seen).toEqual([handles[0], handles[2]].map((h) => svc.resolveRef(target, h)));
	});
});

describe('clear_outputs clears EVERYTHING when ids are omitted', () => {
	it('omitting ids clears every cell in the notebook', async () => {
		const { target } = await makeNotebook('clear-all.ipynb', 6);
		const r = svc.clearOutputs(undefined, target);

		expect(r.ok).toBe(true);
		// Six cells carried output; the empty starter cell never did, so it is a
		// no-op and is not listed.
		expect(r.ok && r.count).toBe(6);
		expect(withOutputs(target)).toEqual([]);
	});

	it('an EMPTY ids array is a refusal, NOT a clear-all', async () => {
		const { target } = await makeNotebook('clear-empty.ipynb', 3);
		const before = withOutputs(target);

		// The whole point of the rule: an agent whose computed id list came out
		// empty must never wipe the notebook by accident. Omitting ids is the only
		// way to say "everything".
		const r = svc.clearOutputs([], target);
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ missing: null });
		expect(withOutputs(target)).toEqual(before);
	});
});

describe('clear_outputs is all-or-nothing, and harmless where there is nothing to do', () => {
	it('clears NOTHING when any id is unknown — a typo cannot half-apply a batch', async () => {
		const { target, handles } = await makeNotebook('clear-bad.ipynb', 4);
		const before = withOutputs(target);

		const r = svc.clearOutputs([handles[0], handles[1], 'no-such-cell', handles[2]], target);
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ missing: 'no-such-cell' });
		expect(withOutputs(target)).toEqual(before);
	});

	it('no-ops cleanly on a cell that has no outputs, and reports it as nothing cleared', async () => {
		const { target, handles } = await makeNotebook('clear-noop.ipynb', 2);
		// Clear once…
		expect(svc.clearOutputs([handles[0]], target)).toMatchObject({ ok: true, count: 1 });
		// …and again: still ok, but honest that it changed nothing.
		const again = svc.clearOutputs([handles[0]], target);
		expect(again).toMatchObject({ ok: true, count: 0 });
		expect(again.ok && again.cleared).toEqual([]);

		// A markdown cell (which can never carry output) is likewise a no-op, not an
		// error — an agent clearing a mixed selection must not have to filter first.
		const { ids } = await svc.addCells([{ cell_type: 'markdown', source: '# note' }], null, {
			nb: target,
			routeImports: false
		});
		expect(svc.clearOutputs([ids[0]], target)).toMatchObject({ ok: true, count: 0 });
	});

	it('writes nothing when the batch would change nothing', async () => {
		const { target, handles } = await makeNotebook('clear-nowrite.ipynb', 2);
		svc.clearOutputs(undefined, target);
		const after = readFileSync(target, 'utf8');

		// A second clear-all has nothing to do: no event, and the file is not even
		// rewritten byte-identically (which would churn mtime and the write lock).
		let events_seen = 0;
		const off = events.subscribe((e) => {
			if ((e as { type: string; nb?: string }).type === 'cell:cleared') events_seen++;
		});
		try {
			expect(svc.clearOutputs([handles[0], handles[1]], target)).toMatchObject({ ok: true, count: 0 });
		} finally {
			off();
		}
		expect(events_seen).toBe(0);
		expect(readFileSync(target, 'utf8')).toBe(after);
	});
});

describe('clearing OUTPUT does not change RUN semantics', () => {
	it('leaves lastRun intact, so run_status / ran_this_session are unaffected', async () => {
		const { target, handles } = await makeNotebook('clear-lastrun.ipynb', 2);
		const full = svc.resolveRef(target, handles[0]);

		// Stamp the cell as having run in the live session, exactly as a real run
		// does (the runtime-only stamp `run_status`/`ran_this_session` derive from —
		// never `outputs.length`).
		const session = nbmod.getCell(full, target)!;
		session.metadata = session.metadata ?? {};
		session.metadata.cellar = session.metadata.cellar ?? {};
		session.metadata.cellar.lastRun = { at: Date.now(), durationMs: 1, status: 'ok', actor: 'agent', session: 1 };

		svc.clearOutputs([handles[0]], target);

		// The stamp survives: clearing an output says nothing about whether the cell
		// ran, so staleness and the live/persisted split read the same as before.
		// (This is exactly what the UI clear does — it touches outputs only.)
		expect(nbmod.getCell(full, target)!.metadata?.cellar?.lastRun).toMatchObject({ status: 'ok', session: 1 });
		expect(nbmod.getCell(full, target)!.outputs).toEqual([]);
	});
});
