/**
 * MCP `clear_outputs`: clearing cell outputs from the agent surface.
 *
 * Clearing outputs existed only in the UI ("Clear all outputs") and as internal
 * helpers, so an agent facing a stale figure or a megabyte traceback had to
 * delete and recreate the cell. This is that capability wired as a first-class
 * tool, in `delete_cells`' shape: batch, handle-addressed, all-or-nothing.
 *
 * The contracts worth pinning are the ones a wrong guess would silently break:
 * the ADDRESSING rule (omit ids ⇒ clear everything, an EMPTY list is a refusal,
 * a bad handle clears nothing), the promise that clearing OUTPUT changes no RUN
 * semantics — `lastRun` survives, so `run_status` / `ran_this_session` are
 * untouched and only `has_output` flips — and two rules about what the result
 * may CLAIM: a cell whose run is in flight is skipped rather than reported
 * cleared (the run would write its outputs straight back), and the clear-all
 * form never discloses a cell the agent is not allowed to see.
 *
 * Drives the REAL service + notebook singletons against a scratch workspace,
 * with import-free sources (routeImports:false) so nothing touches the kernel or
 * the python dataflow subprocess.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A `.py` notebook's real read/write shell out to jupytext in the project venv,
// which a unit test has no business needing. Only the round-trip is stubbed: the
// point of the `.py` case below is that clearing outputs must not CALL the
// writer at all, so the stub records every write it is asked to make.
const py = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('../../src/lib/server/jupytext', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/lib/server/jupytext')>();
	return {
		...real,
		readPyNotebook: () => ({
			format: 'percent',
			cells: [0, 1].map((i) => ({ id: null, cell_type: 'code', source: `a = ${i}`, outputs: [], metadata: {} }))
		}),
		writePyNotebook: (path: string) => {
			py.writes.push(path);
		}
	};
});

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');
let queue: typeof import('../../src/lib/server/run-queue');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-clear-outputs-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
	queue = await import('../../src/lib/server/run-queue');
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

describe('a cell whose run is IN FLIGHT is skipped, not silently un-cleared', () => {
	/** Hold a notebook's kernel slot for one cell, exactly as a real run does. */
	function holdKernel(target: string, fullId: string) {
		const ticket = queue.enqueueRun({ nb: target, cellId: fullId, actor: 'user', source: 'a = 1' });
		return () => {
			if (!ticket.duplicate) ticket.done();
		};
	}

	it('clear-all leaves the running cell alone and names it in `skipped`', async () => {
		const { target, handles } = await makeNotebook('clear-running-all.ipynb', 3);
		const release = holdKernel(target, svc.resolveRef(target, handles[1]));
		try {
			// Clearing a running cell would be undone seconds later: the run's next
			// accumulator flush (setOutputsLive) and its run:end (setOutputs) write the
			// outputs straight back. Reporting it as cleared would be a success the
			// notebook never keeps, so the tool says what it did NOT do instead.
			const r = svc.clearOutputs(undefined, target);
			expect(r).toMatchObject({ ok: true, count: 2, skipped: [handles[1]] });
			// Cell index 2 is the running one (index 0 is the empty starter cell).
			expect(withOutputs(target)).toEqual([2]);
		} finally {
			release();
		}
		// Once the run has released the kernel there is nothing to undo the clear, so
		// the very same call now applies and reports no skips.
		const after = svc.clearOutputs(undefined, target);
		expect(after).toMatchObject({ ok: true, count: 1 });
		expect(after).not.toHaveProperty('skipped');
	});

	it('skips an EXPLICITLY named running cell too, rather than claiming a clear', async () => {
		const { target, handles } = await makeNotebook('clear-running-named.ipynb', 2);
		const release = holdKernel(target, svc.resolveRef(target, handles[0]));
		try {
			const r = svc.clearOutputs([handles[0]], target);
			// Nothing cleared ⇒ nothing written, and the output is untouched.
			expect(r).toMatchObject({ ok: true, count: 0, cleared: [], skipped: [handles[0]] });
			expect(withOutputs(target)).toEqual([1, 2]);
		} finally {
			release();
		}
	});

	it('does NOT skip a merely QUEUED cell - a queued run has emitted nothing yet', async () => {
		const { target, handles } = await makeNotebook('clear-queued.ipynb', 3);
		// Cell A holds the kernel; cell B is behind it in the FIFO. B's outputs are
		// the PREVIOUS run's, and nothing is going to write over them until B's turn
		// comes, so clearing B is honest.
		const releaseA = holdKernel(target, svc.resolveRef(target, handles[0]));
		const releaseB = holdKernel(target, svc.resolveRef(target, handles[1]));
		try {
			const r = svc.clearOutputs([handles[1]], target);
			expect(r).toMatchObject({ ok: true, count: 1, cleared: [handles[1]] });
			expect(r).not.toHaveProperty('skipped');
		} finally {
			releaseB();
			releaseA();
		}
	});
});

describe('the clear-all form never discloses a cell hidden from the agent', () => {
	it('clears a hidden cell but keeps it out of cleared / count / skipped', async () => {
		const { target, handles } = await makeNotebook('clear-hidden.ipynb', 3);
		svc.setCellVisibility(handles[1], true, target);

		// `hidden_from_agent` is honored in every map, read, search, section and
		// result, and run_all draws exactly this line: it RUNS hidden cells, it just
		// does not report them. The clear-all form addresses cells the agent never
		// named, so returning a hidden handle would leak both the cell's existence
		// and its address.
		const r = svc.clearOutputs(undefined, target);
		expect(r.ok && r.cleared).toEqual([handles[0], handles[2]]);
		// count and cleared must agree, or an agent reading count alone learns the
		// hidden cell is there after all.
		expect(r.ok && r.count).toBe(2);
		// The hidden cell WAS cleared - only the report is filtered.
		expect(withOutputs(target)).toEqual([]);
	});

	it('does not disclose a hidden cell that was skipped for running either', async () => {
		const { target, handles } = await makeNotebook('clear-hidden-running.ipynb', 2);
		svc.setCellVisibility(handles[0], true, target);
		const ticket = queue.enqueueRun({ nb: target, cellId: svc.resolveRef(target, handles[0]), actor: 'user', source: 'a = 1' });
		try {
			const r = svc.clearOutputs(undefined, target);
			expect(r).toMatchObject({ ok: true, count: 1, cleared: [handles[1]] });
			expect(r).not.toHaveProperty('skipped');
		} finally {
			if (!ticket.duplicate) ticket.done();
		}
	});

	it('still echoes a hidden handle the agent NAMED itself', async () => {
		const { target, handles } = await makeNotebook('clear-hidden-named.ipynb', 2);
		svc.setCellVisibility(handles[0], true, target);

		// The asymmetry is the point: this handle came FROM the agent, so echoing it
		// discloses nothing new - which is why delete_cells reports named cells too.
		// Filtering here would instead make the tool look like it silently ignored
		// the request.
		expect(svc.clearOutputs([handles[0]], target)).toMatchObject({ ok: true, count: 1, cleared: [handles[0]] });
	});
});

describe('the result never claims an undo it cannot deliver', () => {
	/**
	 * A notebook built through the NOTEBOOK api, not the service - so no agent
	 * action has been recorded for it and the clear below is its FIRST, which is
	 * the one case the throttle always snapshots.
	 */
	function makeUntouchedNotebook(name: string, text: string): { target: string; ids: string[] } {
		const target = abs(name);
		nbmod.createNotebook(name);
		const ids: string[] = [];
		for (let i = 0; i < 2; i++) {
			const cell = nbmod.addCell(null, 'code', target, null, `a = ${i}`);
			nbmod.setOutputs(cell.id, out(text), target);
			ids.push(cell.id);
		}
		return { target, ids };
	}

	it('says nothing when the pre-clear checkpoint really does hold the outputs', () => {
		const { target } = makeUntouchedNotebook('undo-ok.ipynb', 'small\n');

		// First agent action for this notebook ⇒ a checkpoint IS taken, and the
		// snapshot is far under the size bound, so its outputs are stored. Undo works,
		// so there is nothing to warn about and the agent pays no tokens for silence.
		const r = svc.clearOutputs(undefined, target);
		expect(r).toMatchObject({ ok: true, count: 2 });
		expect(r).not.toHaveProperty('undo');
	});

	it('warns when the checkpoint was THROTTLED away, so undo lands on an earlier state', async () => {
		// `makeNotebook` goes through the service, which spends this notebook's first
		// agent action on the add - so the clear is folded into that batch and takes no
		// snapshot of its own (auto-checkpoints are one per N actions).
		const { target, handles } = await makeNotebook('undo-throttled.ipynb', 2);

		const r = svc.clearOutputs([handles[0]], target);
		expect(r).toMatchObject({ ok: true, count: 1 });
		// The whole point: the agent is told the outputs it just destroyed are not
		// coming back from undo, rather than being left to assume they are.
		expect(r.ok && r.undo).toMatchObject({ outputs_recoverable: false });
		expect(r.ok && r.undo?.reason).toMatch(/throttled/);
	});

	it('warns when the checkpoint was too big to keep outputs - this tool\'s own use case', () => {
		// An output-heavy notebook is exactly what `clear_outputs` exists for, and it
		// is exactly what blows past the snapshot size bound: the checkpoint then keeps
		// sources and DROPS every cell's outputs. The cleared document is persisted
		// straight afterwards, so those outputs are gone for good - the one case where
		// a cheerful "undoable" would have been a lie.
		const { target } = makeUntouchedNotebook('undo-truncated.ipynb', `${'x'.repeat(1_600_000)}\n`);

		const r = svc.clearOutputs(undefined, target);
		expect(r).toMatchObject({ ok: true, count: 2 });
		expect(r.ok && r.undo).toMatchObject({ outputs_recoverable: false });
		expect(r.ok && r.undo?.reason).toMatch(/too large/);
	});

	it('keeps the tool DESCRIPTION honest about that limit', () => {
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const desc = src.slice(src.indexOf("registerTool('clear_outputs'"));
		const line = desc.slice(0, desc.indexOf('\n'));

		// A tool description is paid on every MCP session AND is the only thing most
		// agents ever read, so an over-claim there does more damage than a wrong
		// result field. This one promised "the whole batch is one undoable
		// checkpoint" while both halves could fail; pin the correction so it cannot
		// quietly regrow.
		expect(line).not.toMatch(/undoable/);
		expect(line).toMatch(/throttled/);
		expect(line).toMatch(/undo may not/);
	});
});

describe('a .py (jupytext) notebook clears in memory without a jupytext write', () => {
	it('emits cell:cleared but never calls the writer', async () => {
		const target = abs('text-notebook.py');
		writeFileSync(target, '# %%\na = 0\n\n# %%\na = 1\n');
		const cells = nbmod.listCells(target);
		for (const c of cells) nbmod.setOutputs(c.id, out('live only\n'), target);
		py.writes.length = 0;

		const seen: string[] = [];
		const off = events.subscribe((e) => {
			const ev = e as { type: string; nb?: string; cellId?: string };
			if (ev.type === 'cell:cleared' && ev.nb === target) seen.push(ev.cellId!);
		});
		let r: ReturnType<typeof svc.clearOutputs>;
		try {
			r = svc.clearOutputs(undefined, target);
		} finally {
			off();
		}

		// A text notebook carries no outputs on disk, so persisting would re-run the
		// whole jupytext conversion on the shared Node process to produce
		// byte-identical bytes and churn the file's mtime. The EVENTS must still
		// fire, or an open tab keeps rendering outputs the document no longer has.
		expect(py.writes).toEqual([]);
		expect(seen).toEqual(cells.map((c) => c.id));
		expect(r!).toMatchObject({ ok: true, count: 2 });
		expect(withOutputs(target)).toEqual([]);
	});

	it('applies the same rule to the SINGLE-cell clear the UI drives', () => {
		const target = abs('text-notebook-single.py');
		writeFileSync(target, '# %%\na = 0\n\n# %%\na = 1\n');
		const cells = nbmod.listCells(target);
		for (const c of cells) nbmod.setOutputs(c.id, out('live only\n'), target);
		py.writes.length = 0;

		const seen: string[] = [];
		const off = events.subscribe((e) => {
			const ev = e as { type: string; nb?: string; cellId?: string };
			if (ev.type === 'cell:cleared' && ev.nb === target) seen.push(ev.cellId!);
		});
		try {
			// The UI clears one cell per request (and its "Clear all" loops over them),
			// so an unguarded persist here is one blocking jupytext conversion PER CELL
			// for a file that stores no outputs at all. The two clear paths must agree,
			// or which surface the human used decides what the disk does.
			for (const c of cells) nbmod.clearOutputs(c.id, target);
		} finally {
			off();
		}

		expect(py.writes).toEqual([]);
		expect(seen).toEqual(cells.map((c) => c.id));
		expect(withOutputs(target)).toEqual([]);
	});
});
