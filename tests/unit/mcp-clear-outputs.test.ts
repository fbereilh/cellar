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
 * cleared (the call is a one-shot report, so a live run would outrun it), and
 * the clear-all form never discloses a cell the agent is not allowed to see.
 *
 * Drives the REAL service + notebook singletons against a scratch workspace,
 * with import-free sources (routeImports:false) so nothing touches the kernel or
 * the python dataflow subprocess.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
let cpmod: typeof import('../../src/lib/server/checkpoints');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-clear-outputs-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
	queue = await import('../../src/lib/server/run-queue');
	cpmod = await import('../../src/lib/server/checkpoints');
});

/**
 * The description of a tool as the SHIPPED server EMITS it at connect - the string
 * an agent is really billed for and the only thing most agents ever read about a
 * tool. Read over an in-memory MCP client off `createCellarMcpServer()`, the same
 * factory `startMcpServer` mints a session with, so a behaviour-preserving reformat
 * of the registration cannot break these assertions and a matching phrase in dead
 * code cannot satisfy them. (`mojo-cell-mcp.test.ts` uses the same route for the
 * emitted schemas.)
 */
async function emittedDescription(name: string): Promise<string> {
	const srv = await import('../../src/lib/server/mcp/server');
	const server = srv.createCellarMcpServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const tool = (await client.listTools()).tools.find((t) => t.name === name);
	expect(tool, `${name} must be registered`).toBeTruthy();
	expect(tool!.description, `${name} must carry a description`).toBeTruthy();
	return tool!.description!;
}

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

/**
 * A `chmod 0o500` directory does not stop root, so every refuse-before-destroying
 * test below would pass VACUOUSLY there (no write failure ⇒ no refusal to observe ⇒
 * the assertions never run against the path they exist for). Probe once and skip
 * with the reason rather than assert something the environment cannot produce.
 */
const chmodBlocksWrites = (() => {
	const probe = mkdtempSync(join(tmpdir(), 'cellar-chmod-probe-'));
	try {
		chmodSync(probe, 0o500);
		writeFileSync(join(probe, 'x'), 'x');
		return false; // the write went through: chmod is not enforced for us
	} catch {
		return true;
	} finally {
		try {
			chmodSync(probe, 0o700);
		} catch {}
	}
})();

/**
 * Run `fn` with the checkpoint sidecar directory unwritable - what a full disk or an
 * unwritable `.cellar/` looks like from here. The first checkpoint is forced so the
 * directory exists to be locked.
 */
function withUnwritableSidecars<T>(target: string, fn: () => T): T {
	cpmod.createCheckpoint(target, { trigger: 'manual' });
	const dir = join(WS, '.cellar', 'checkpoints');
	chmodSync(dir, 0o500);
	try {
		return fn();
	} finally {
		chmodSync(dir, 0o700);
	}
}

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

describe('a cell whose run is IN FLIGHT is skipped, not reported as a clear it cannot promise', () => {
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
			// The shared clear path truncates the run's accumulator, so a clear of a
			// running cell would STICK - but this call is a one-shot report, not a live
			// view, and the run goes on emitting, so "cleared" describes a state the
			// very next flush has already moved past. It says what it did NOT do
			// instead. (The UI's clear-all deliberately diverges and does clear it.)
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

describe('the pre-clear checkpoint really can give the outputs back', () => {
	/**
	 * A notebook built through the NOTEBOOK api, not the service - so no agent
	 * action has been recorded for it. It used to matter which was which: under the
	 * old single-tier throttle only a notebook's FIRST agent action snapshotted, so
	 * a clear anywhere else in the sequence took none. It no longer does, which is
	 * the point of the position sweep below.
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

	it('says nothing when the checkpoint holds the outputs - which is now every ordinary clear', () => {
		const { target } = makeUntouchedNotebook('undo-ok.ipynb', 'small\n');
		const r = svc.clearOutputs(undefined, target);
		expect(r).toMatchObject({ ok: true, count: 2 });
		// No `undo` field: the agent pays no tokens for a caveat that no longer applies.
		expect(r).not.toHaveProperty('undo');
	});

	it('checkpoints EVERY clear, wherever it falls in the agent action sequence', async () => {
		// THE HEADLINE REGRESSION. `autoCheckpointBeforeAgentAction` snapshots on the
		// first agent action and then once every N, so four out of five clears used to
		// be preceded by NO snapshot at all - the position in the sequence decided
		// whether the user's outputs were recoverable. A destructive action is never
		// throttled now, so the position must not matter: run the clear at six
		// consecutive positions and every one of them must be its own checkpoint.
		const { target, handles } = await makeNotebook('undo-positions.ipynb', 8);
		const agentsBefore = cpmod.listCheckpoints(target).filter((c) => c.trigger === 'agent').length;

		for (let i = 0; i < 6; i++) {
			nbmod.setOutputs(svc.resolveRef(target, handles[i]), out(`o ${i}\n`), target);
			const r = svc.clearOutputs([handles[i]], target);
			expect(r, `clear at position ${i}`).toMatchObject({ ok: true, count: 1 });
			expect(r, `clear at position ${i} claims no lost undo`).not.toHaveProperty('undo');
		}

		const agentsAfter = cpmod.listCheckpoints(target).filter((c) => c.trigger === 'agent').length;
		// Six clears, six snapshots. Under the throttle this was one.
		expect(agentsAfter - agentsBefore).toBe(6);
	});

	it("restores outputs far past the old 2 MB snapshot cap - this tool's own use case", () => {
		// An output-heavy notebook is exactly what `clear_outputs` exists for, and it
		// is exactly what used to blow the inline snapshot cap: the checkpoint kept
		// sources and DROPPED every cell's outputs, then the cleared document was
		// persisted, so they were gone for good. Outputs live in their own file now,
		// so size is not what decides whether undo works.
		const big = 'x'.repeat(1_600_000); // 2 cells => ~3.2 MB, over the old cap
		const { target, ids } = makeUntouchedNotebook('undo-big.ipynb', `${big}\n`);

		const r = svc.clearOutputs(undefined, target);
		expect(r).toMatchObject({ ok: true, count: 2 });
		expect(r).not.toHaveProperty('undo');
		expect(withOutputs(target)).toEqual([]);

		expect(cpmod.undoLastAgentAction(target).ok).toBe(true);
		// Byte-for-byte, not merely "some output came back".
		const back = nbmod.listCells(target).filter((c) => ids.includes(c.id));
		expect(back).toHaveLength(2);
		for (const c of back) expect((c.outputs?.[0] as { text?: string })?.text).toBe(`${big}\n`);
	});

	it.skipIf(!chmodBlocksWrites)('REFUSES before clearing when the checkpoint cannot store the outputs', () => {
		// The one case left: the sidecar could not be written (a full disk, an
		// unwritable `.cellar/`). Simulated by making the checkpoints directory
		// unwritable, which is what the failure looks like from here. The rule under
		// test is the ORDER - the refusal lands BEFORE anything is destroyed, so the
		// user never discovers the loss at undo time.
		const { target } = makeUntouchedNotebook('undo-refused.ipynb', 'keep me\n');
		withUnwritableSidecars(target, () => {
			const r = svc.clearOutputs(undefined, target);
			expect(r).toMatchObject({ ok: false, refused: 'outputs_unrecoverable' });
			expect(r.ok === false && 'reason' in r && r.reason).toMatch(/nothing was changed/i);
			expect(r.ok === false && 'reason' in r && r.reason).toMatch(/allow_unrecoverable/);
			// Nothing was destroyed, and no leftover checkpoint of an unchanged document.
			expect(withOutputs(target)).toEqual([1, 2]);
			expect(cpmod.listCheckpoints(target).filter((c) => c.trigger === 'agent')).toHaveLength(0);
		});
	});

	it.skipIf(!chmodBlocksWrites)('leaves the OLDEST snapshot alone when it refuses at the history cap', async () => {
		// A refusal says "nothing was changed", and that has to be literally true. The
		// snapshot used to be entered in the store and then removed - but ENTERING it is
		// what triggers FIFO eviction, so at MAX_PER_NOTEBOOK (25) a call that was about
		// to refuse had already destroyed the oldest snapshot and rm'd its sidecar,
		// possibly a human's own manual save point. It is now abandoned before it is
		// committed, so the store is untouched.
		// Built WITHOUT agent tools, so the history holds only the checkpoints this test
		// takes and the oldest of them is one that already sees the outputs.
		const { target, ids } = makeUntouchedNotebook('refuse-at-cap.ipynb', 'the results\n');
		const id = ids[0]; // a full UUID, which `asFullId` accepts like any handle
		// Fill the history to MAX_PER_NOTEBOOK so the very next commit would evict.
		while (cpmod.listCheckpoints(target).length < 25) cpmod.createCheckpoint(target, { trigger: 'manual' });
		const before = cpmod.listCheckpoints(target);
		expect(before).toHaveLength(25);
		// The one a committed-then-removed snapshot would have destroyed on its way out.
		const victim = before.at(-1)!;
		expect(victim.outputsTruncated, 'the oldest snapshot really holds the outputs').toBe(false);

		// Sidecar writes now fail; the directory already exists (every checkpoint above
		// stored one), so this is exactly the full-disk / unwritable-.cellar shape.
		const dir = join(WS, '.cellar', 'checkpoints');
		chmodSync(dir, 0o500);
		try {
			expect(svc.clearOutputs([id], target)).toMatchObject({ ok: false, refused: 'outputs_unrecoverable' });
		} finally {
			chmodSync(dir, 0o700);
		}

		const after = cpmod.listCheckpoints(target);
		expect(after.map((c) => c.id), 'a refused call evicted nothing and added nothing').toEqual(before.map((c) => c.id));
		// ...and that oldest snapshot still RESTORES its outputs, so its sidecar was
		// not rm'd either - the store is byte-for-byte where the call found it.
		nbmod.clearOutputs(id, target);
		expect(nbmod.listCells(target).find((c) => c.id === id)?.outputs ?? []).toHaveLength(0);
		expect(cpmod.restoreCheckpoint(target, victim.id).ok).toBe(true);
		expect(nbmod.listCells(target).find((c) => c.id === id)?.outputs ?? []).toHaveLength(1);
	});

	it.skipIf(!chmodBlocksWrites)('proceeds and SAYS SO when the caller waives the guarantee', () => {
		// `allow_unrecoverable` exists because clearing outputs is itself how a user
		// frees a full disk, so a flat refusal would trap them. A knowing caller still
		// gets the fact in its result.
		const { target } = makeUntouchedNotebook('undo-waived.ipynb', 'gone\n');
		withUnwritableSidecars(target, () => {
			const r = svc.clearOutputs(undefined, target, { allowUnrecoverable: true });
			expect(r).toMatchObject({ ok: true, count: 2 });
			expect(r.ok && r.undo).toMatchObject({ outputs_recoverable: false });
			expect(withOutputs(target)).toEqual([]);
		});
	});

	it('keeps the tool DESCRIPTION matching what undo now guarantees', async () => {
		// A tool description is paid on every MCP session AND is the only thing most
		// agents ever read, so a WRONG claim there does more damage than a wrong result
		// field. It used to over-claim ("one undoable checkpoint"); it was then
		// corrected to under-claim ("throttled", "undo may not") because both halves
		// really could fail. Both halves are fixed, so the caveats must go with them -
		// an agent told undo may not work will not use undo. Asserted on the string
		// the SHIPPED server EMITS at connect, which is what an agent is billed for.
		const desc = await emittedDescription('clear_outputs');
		expect(desc).not.toMatch(/throttled/);
		expect(desc).not.toMatch(/undo may not/);
		// ...and what replaces them is the guarantee plus its ONE exception, named.
		expect(desc).toMatch(/undo restores them/);
		expect(desc).toMatch(/REFUSED before clearing/);
		expect(desc).toMatch(/allow_unrecoverable/);
		// ...and honest WITHOUT growing: the same string is billed on every MCP
		// session, so a correction has to be paid for by cutting words elsewhere.
		// `mcp-ergonomics.spec.ts` asserts this same bound over the real wire, but
		// e2e is deliberately out of CI and the no-mistakes gate, so a description
		// that grew past it merged green and only failed much later. Carry the bound
		// here too, where it actually runs.
		expect(desc.length).toBeLessThan(700);
	});
});

describe('set_cell_type is on the destructive tier exactly when it drops outputs', () => {
	/**
	 * `applyCellType` clears a cell's outputs whenever it leaves nbformat `code`, so
	 * converting a code cell to markdown/raw is output-destroying and must take the
	 * never-throttled snapshot - the same tier `clear_outputs` and `delete_cells` take.
	 * Every other conversion changes no outputs and stays on the throttled tier, where
	 * a run's or an edit's snapshot belongs; putting them all on the destructive tier
	 * would mint a checkpoint per retype and evict the history worth going back to.
	 */
	async function retypeDeepInABatch(name: string, to: 'markdown' | 'sql') {
		const { target, handles } = await makeNotebook(name, 3);
		// Several actions deep, so the throttle would have skipped a snapshot here.
		for (let i = 0; i < 3; i++) await svc.editCell(handles[0], `a = ${i}`, { nb: target, routeImports: false });
		const before = cpmod.listCheckpoints(target).length;
		const id = svc.resolveRef(target, handles[1]);
		const r = svc.setType(handles[1], to, target);
		expect(r).toMatchObject({ ok: true });
		return { target, id, taken: cpmod.listCheckpoints(target).length - before };
	}

	it('snapshots a code→markdown conversion mid-batch, and undo returns the outputs', async () => {
		const { target, id, taken } = await retypeDeepInABatch('retype-md.ipynb', 'markdown');
		expect(taken, 'the conversion took its own checkpoint').toBe(1);
		expect(nbmod.listCells(target).find((c) => c.id === id)?.outputs ?? []).toHaveLength(0);

		expect(cpmod.undoLastAgentAction(target).ok).toBe(true);
		const back = nbmod.listCells(target).find((c) => c.id === id);
		expect(back?.cell_type).toBe('code');
		expect((back?.outputs?.[0] as { text?: string })?.text).toBe('out 1\n');
	});

	it('leaves a conversion that keeps outputs on the throttled tier', async () => {
		// sql is still nbformat `code`, so its outputs survive and nothing is destroyed.
		const { target, id, taken } = await retypeDeepInABatch('retype-sql.ipynb', 'sql');
		expect(taken, 'no destructive snapshot for a conversion that destroys nothing').toBe(0);
		expect(nbmod.listCells(target).find((c) => c.id === id)?.outputs ?? []).toHaveLength(1);
	});

	/**
	 * The tier alone is not the whole guarantee: a never-throttled snapshot that could
	 * not KEEP the outputs still leaves undo a lie, so this conversion owes the same
	 * refuse-before-destroying guard its two siblings take. Left out, `set_cell_type`
	 * was the one output-destroying tool that could still destroy silently.
	 */
	it.skipIf(!chmodBlocksWrites)('REFUSES the conversion when the checkpoint cannot store the outputs', async () => {
		const { target, handles } = await makeNotebook('retype-refused.ipynb', 2);
		const id = svc.resolveRef(target, handles[1]);
		withUnwritableSidecars(target, () => {
			// Counted as a DELTA: building the notebook is itself agent work, so it has
			// already minted checkpoints of its own.
			const before = cpmod.listCheckpoints(target).length;
			const r = svc.setType(handles[1], 'markdown', target);
			expect(r).toMatchObject({ ok: false, refused: 'outputs_unrecoverable' });
			expect(r.ok === false && 'reason' in r && r.reason).toMatch(/nothing was changed/i);
			expect(r.ok === false && 'reason' in r && r.reason).toMatch(/allow_unrecoverable/);
			// Nothing converted, nothing destroyed, no leftover snapshot of an unchanged doc.
			const cell = nbmod.listCells(target).find((c) => c.id === id);
			expect(cell?.cell_type).toBe('code');
			expect(cell?.outputs ?? []).toHaveLength(1);
			expect(cpmod.listCheckpoints(target).length - before, 'a refused call leaves no snapshot behind').toBe(0);
		});
	});

	it.skipIf(!chmodBlocksWrites)('converts anyway when the caller waives the guarantee, and SAYS what was lost', async () => {
		const { target, handles } = await makeNotebook('retype-waived.ipynb', 2);
		const id = svc.resolveRef(target, handles[1]);
		withUnwritableSidecars(target, () => {
			const r = svc.setType(handles[1], 'markdown', target, { allowUnrecoverable: true });
			expect(r).toMatchObject({ ok: true });
			// The refusal is the primary mitigation, but a caller that WAIVED it still
			// deserves the fact in its own result - the same `undo` shape `clear_outputs`
			// reports, from every destructive tool rather than from that one alone.
			expect(r.ok && 'undo' in r && r.undo).toMatchObject({ outputs_recoverable: false });
			expect(nbmod.listCells(target).find((c) => c.id === id)?.cell_type).toBe('markdown');
		});
	});

	it('says nothing about undo on an ordinary conversion that really is recoverable', async () => {
		const { target, handles } = await makeNotebook('retype-ordinary.ipynb', 2);
		const r = svc.setType(handles[1], 'markdown', target);
		expect(r).toMatchObject({ ok: true });
		// Conditional, so an ordinary call pays no tokens for it.
		expect(r.ok && 'undo' in r).toBe(false);
	});

	it('keeps the tool DESCRIPTION naming the guarantee and its exception', async () => {
		// The description is the only thing most agents ever read about this tool, and
		// it already told them the conversion "drops that cell's outputs" - so it has to
		// say what now happens to them, and that the call can be refused. Read off the
		// description the SHIPPED server really EMITS at connect (the delivered
		// contract), not off the registration's source text.
		const desc = await emittedDescription('set_cell_type');
		expect(desc).toMatch(/unthrottled checkpoint stores them for undo/);
		expect(desc).toMatch(/REFUSED/);
		expect(desc).toMatch(/allow_unrecoverable/);
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

describe('the destructive surface as an AGENT receives it, over the shipped registration', () => {
	/**
	 * A tool result reaches an agent through its HANDLER, and a handler that answers
	 * with its own success literal instead of forwarding the service result drops
	 * whatever the service added - silently, and invisibly to any assertion made on
	 * the service function. That is exactly how `set_cell_type` came to answer the
	 * wire with `{"ok":true}` over destroyed outputs while its three siblings
	 * reported the loss, so the `undo` warning is pinned HERE, at the layer an agent
	 * actually reads, for every destructive tool that can produce one.
	 */
	async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
		const srv = await import('../../src/lib/server/mcp/server');
		const server = srv.createCellarMcpServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const res = await client.callTool({ name, arguments: args });
		const first = (res.content as { type: string; text: string }[])[0];
		return { isError: res.isError === true, payload: res.isError ? { text: first.text } : JSON.parse(first.text) };
	}

	/** Two code cells carrying saved output, built through the notebook api. */
	function seed(name: string): { target: string; ids: string[] } {
		const target = abs(name);
		nbmod.createNotebook(name);
		const ids: string[] = [];
		for (let i = 0; i < 2; i++) {
			const cell = nbmod.addCell(null, 'code', target, null, `a = ${i}`);
			nbmod.setOutputs(cell.id, out('gone\n'), target);
			ids.push(cell.id);
		}
		return { target, ids };
	}

	/** `withUnwritableSidecars`, for a call that has to be awaited. */
	async function unwritable<T>(target: string, fn: () => Promise<T>): Promise<T> {
		cpmod.createCheckpoint(target, { trigger: 'manual' });
		const dir = join(WS, '.cellar', 'checkpoints');
		chmodSync(dir, 0o500);
		try {
			return await fn();
		} finally {
			chmodSync(dir, 0o700);
		}
	}

	/**
	 * The three destructive tools this file owns, each addressed the way it destroys
	 * outputs; `consolidate_imports` is pinned the same way in
	 * `mcp-consolidate-checkpoint.test.ts`, which owns its sweep fixture.
	 */
	const TOOLS = ['clear_outputs', 'delete_cells', 'set_cell_type'];
	const argsFor = (name: string, ids: string[]): Record<string, unknown> =>
		name === 'delete_cells'
			? { ids: [ids[0]] }
			: name === 'set_cell_type'
				? { id: ids[0], cell_type: 'markdown' }
				: {};

	it.skipIf(!chmodBlocksWrites)('carries the waived-path undo warning on EVERY destructive tool result', async () => {
		for (const name of TOOLS) {
			const nb = `wire-waived-${name}.ipynb`;
			const { target, ids } = seed(nb);
			const r = await unwritable(target, () =>
				callTool(name, { ...argsFor(name, ids), allow_unrecoverable: true, notebook: nb })
			);
			expect(r.isError, `${name} should have proceeded`).toBe(false);
			expect(r.payload.undo, `${name} must report the loss it was allowed to cause`).toMatchObject({
				outputs_recoverable: false
			});
		}
	});

	it('says nothing about undo when the checkpoint really holds the outputs', async () => {
		for (const name of TOOLS) {
			const nb = `wire-ordinary-${name}.ipynb`;
			const { ids } = seed(nb);
			const r = await callTool(name, { ...argsFor(name, ids), notebook: nb });
			expect(r.isError, `${name} should have succeeded`).toBe(false);
			// Conditional, so an ordinary call pays no tokens for it.
			expect('undo' in r.payload, `${name} must not warn about an undo that works`).toBe(false);
		}
	});
});

describe('every destructive tool description holds the four honesty facts inside the bound', () => {
	/**
	 * A description is billed on EVERY session, so an honesty correction has to be
	 * paid for by cutting words rather than by growing the string (AGENTS.md's own
	 * rule). The four destructive tools each have to say that the checkpoint stores
	 * the outputs, that it is never throttled away, that the call is REFUSED if it
	 * cannot, and that `allow_unrecoverable:true` proceeds knowingly - and say it
	 * under 700 chars. The bound is pinned per tool here so the rule is enforced
	 * where it was previously only stated; the wire half lives in
	 * `tests/e2e/mcp-ergonomics.spec.ts`, which CI and the gate never run.
	 */
	for (const name of ['clear_outputs', 'delete_cells', 'set_cell_type', 'consolidate_imports']) {
		it(`${name} stays under the 700-char bound`, async () => {
			expect((await emittedDescription(name)).length).toBeLessThan(700);
		});
	}

	it('keeps delete_cells naming the guarantee and its exception', async () => {
		const desc = await emittedDescription('delete_cells');
		expect(desc).toMatch(/never throttled away/);
		expect(desc).toMatch(/undo restores the cells WITH their outputs/);
		expect(desc).toMatch(/REFUSED before deleting anything/);
		expect(desc).toMatch(/allow_unrecoverable/);
	});
});

describe('delete_cells answers the tier\'s TWO questions separately', () => {
	/**
	 * A delete is never throttled WHATEVER the cells hold - it destroys the cell's
	 * SOURCE, which may exist in no other snapshot if the cell was created inside the
	 * current throttle batch - but it only pays the uncapped sidecar and the
	 * synchronous index flush when a cell it removes really carries outputs. Its two
	 * siblings (`set_cell_type`, `consolidate_imports`) destroy NOTHING when their own
	 * guard is false, so for them both answers fall together; delete is the one caller
	 * where they come apart, which is why the tests below drive both axes against ONE
	 * notebook shape and let only the deleted cell's outputs differ.
	 */
	const BIG = 'y'.repeat(1_600_000); // 2 cells => ~3.2 MB, past MAX_SNAPSHOT_BYTES

	/** Two cells carrying far more output than the capped tier will store, plus one more. */
	function heavyNotebook(name: string, tailOutput: string | null): { target: string; tailId: string } {
		const target = abs(name);
		nbmod.createNotebook(name);
		for (let i = 0; i < 2; i++) {
			const c = nbmod.addCell(null, 'code', target, null, `heavy = ${i}`);
			nbmod.setOutputs(c.id, out(`${BIG}\n`), target);
		}
		const tail = nbmod.addCell(null, 'code', target, null, 'tail = 1');
		if (tailOutput !== null) nbmod.setOutputs(tail.id, out(tailOutput), target);
		return { target, tailId: tail.id };
	}

	// Tolerates an absent directory so this block does not depend on an earlier test
	// having minted the first sidecar.
	const sidecarCount = () => {
		const dir = join(WS, '.cellar', 'checkpoints');
		return existsSync(dir) ? readdirSync(dir).length : 0;
	};
	const agentSnapshots = (target: string) => cpmod.listCheckpoints(target).filter((c) => c.trigger === 'agent');

	it('snapshots an output-LESS delete mid-batch without storing the notebook\'s unrelated outputs', () => {
		const { target, tailId } = heavyNotebook('delete-sources-only.ipynb', null);
		// Walk into the middle of a throttle batch: action 1 snapshots, the next two are
		// exactly the ones the recoverable tier folds into it.
		expect(cpmod.autoCheckpointBeforeAgentAction(target), 'action 1 always snapshots').not.toBeNull();
		expect(cpmod.autoCheckpointBeforeAgentAction(target), 'action 2 is folded in').toBeNull();
		expect(cpmod.autoCheckpointBeforeAgentAction(target), 'action 3 is folded in').toBeNull();

		const before = agentSnapshots(target).length;
		const sidecarsBefore = sidecarCount();
		expect(svc.removeCells([tailId], target)).toMatchObject({ ok: true, count: 1 });

		// AXIS (a): never throttled. The delete took its own snapshot even though the
		// recoverable tier would have skipped this position...
		expect(agentSnapshots(target).length - before, 'the delete snapshotted itself').toBe(1);

		// AXIS (b): it destroyed no outputs, so it did NOT stringify and write the
		// notebook's 3.2 MB of unrelated results. Same notebook, same volume - only the
		// deleted cell's outputs differ from the test below.
		expect(sidecarCount(), 'no sidecar for outputs this call never touched').toBe(sidecarsBefore);
		expect(agentSnapshots(target)[0].outputsTruncated, 'capped, and it says so').toBe(true);

		// ...and that same snapshot is what brings the deleted SOURCE back, which is the
		// whole reason a delete may not be throttled.
		expect(nbmod.listCells(target).some((c) => c.id === tailId)).toBe(false);
		expect(cpmod.undoLastAgentAction(target).ok).toBe(true);
		expect(nbmod.listCells(target).find((c) => c.id === tailId)?.source).toBe('tail = 1');
	});

	it('stores the outputs when the deleted cell really carries them, and undo returns them', () => {
		const { target, tailId } = heavyNotebook('delete-with-outputs.ipynb', 'the results\n');
		const sidecarsBefore = sidecarCount();
		const r = svc.removeCells([tailId], target);
		expect(r).toMatchObject({ ok: true, count: 1 });
		expect(r).not.toHaveProperty('undo');
		// The same notebook shape as above, and this time the sidecar IS written -
		// uncapped, so the notebook's 3.2 MB rides along rather than being dropped.
		expect(sidecarCount(), 'the deleted outputs were stored').toBe(sidecarsBefore + 1);

		expect(cpmod.undoLastAgentAction(target).ok).toBe(true);
		const back = nbmod.listCells(target).find((c) => c.id === tailId);
		expect(back?.source).toBe('tail = 1');
		expect((back?.outputs?.[0] as { text?: string })?.text, 'the cell came back WITH its results').toBe('the results\n');
	});
});

describe('an index write that never lands is treated as an unrecoverable checkpoint', () => {
	/**
	 * The sidecar is written synchronously and so is the destruction it protects, so a
	 * `guaranteed` snapshot flushes its index entry synchronously too - an entry that
	 * never reaches disk leaves the sidecar an orphan the next start's sweep DELETES,
	 * which is the sidecar-unwritable case with the same user-visible consequence. It
	 * therefore takes the same refusal and the same waiver rather than failing
	 * invisibly at the one moment durability matters.
	 */
	function withUnwritableIndex<T>(target: string, fn: () => T): T {
		// Force the sidecar directory into existence and leave it WRITABLE: the point
		// is that the outputs land and only the reference to them does not.
		cpmod.createCheckpoint(target, { trigger: 'manual' });
		const index = join(WS, '.cellar', 'checkpoints.json');
		writeFileSync(index, '{}');
		chmodSync(index, 0o400);
		try {
			return fn();
		} finally {
			chmodSync(index, 0o600);
		}
	}

	it.skipIf(!chmodBlocksWrites)('REFUSES before clearing, and leaves no orphaned sidecar behind', () => {
		const target = abs('index-unwritable.ipynb');
		nbmod.createNotebook('index-unwritable.ipynb');
		for (let i = 0; i < 2; i++) {
			const c = nbmod.addCell(null, 'code', target, null, `a = ${i}`);
			nbmod.setOutputs(c.id, out('keep me\n'), target);
		}
		withUnwritableIndex(target, () => {
			const sidecarsBefore = readdirSync(join(WS, '.cellar', 'checkpoints')).length;
			const agentsBefore = cpmod.listCheckpoints(target).filter((c) => c.trigger === 'agent').length;

			const r = svc.clearOutputs(undefined, target);
			expect(r).toMatchObject({ ok: false, refused: 'outputs_unrecoverable' });
			expect(r.ok === false && 'reason' in r && r.reason).toMatch(/nothing was changed/i);
			expect(r.ok === false && 'reason' in r && r.reason).toMatch(/allow_unrecoverable/);

			// Nothing destroyed, nothing committed, and the sidecar the abandoned
			// snapshot had already written is gone rather than left for the sweep.
			expect(withOutputs(target)).toEqual([1, 2]);
			expect(cpmod.listCheckpoints(target).filter((c) => c.trigger === 'agent')).toHaveLength(agentsBefore);
			expect(readdirSync(join(WS, '.cellar', 'checkpoints')).length).toBe(sidecarsBefore);
		});
	});

	it.skipIf(!chmodBlocksWrites)('proceeds on the waiver, keeping an undo record that works in this process', () => {
		const target = abs('index-unwritable-waived.ipynb');
		nbmod.createNotebook('index-unwritable-waived.ipynb');
		const cell = nbmod.addCell(null, 'code', target, null, 'a = 0');
		nbmod.setOutputs(cell.id, out('gone\n'), target);
		withUnwritableIndex(target, () => {
			expect(svc.clearOutputs(undefined, target, { allowUnrecoverable: true })).toMatchObject({ ok: true, count: 1 });
			expect(withOutputs(target)).toEqual([]);
			// The entry was KEPT, not abandoned: only the reference's DURABILITY was
			// waived, so undo still works here and only a crash before the retry lands
			// would lose it.
			expect(cpmod.undoLastAgentAction(target).ok).toBe(true);
			expect((nbmod.listCells(target).find((c) => c.id === cell.id)?.outputs?.[0] as { text?: string })?.text).toBe('gone\n');
		});
	});
});
