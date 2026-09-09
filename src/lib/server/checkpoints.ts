/**
 * Cellar — notebook checkpoints (snapshot / restore).
 *
 * A checkpoint is a full point-in-time snapshot of a notebook's cells — their
 * source, outputs, and metadata — so a bad edit (yours or an agent's) can be
 * reverted. Two things create them:
 *
 *   - a MANUAL "Checkpoint now" action (trigger `manual`), and
 *   - an AUTOMATIC snapshot taken BEFORE an agent action (trigger `agent`), so an
 *     agent's mutation or run can be undone.
 *
 * THE AUTO PATH HAS TWO TIERS, and which tier an action takes is a statement about
 * what that action DESTROYS — not about how important it is.
 *
 *   - RECOVERABLE actions (a run, an edit, an add, a move, a consolidate) go through
 *     `autoCheckpointBeforeAgentAction`, which THROTTLES BY COUNT: it snapshots on
 *     the first agent action for a notebook and then once every
 *     `CHECKPOINT_EVERY_N_ACTIONS` actions, skipping the ones in between. Agent
 *     actions are frequent (a run_all is many run_cell calls; one agent turn fires
 *     several tools), so snapshotting before *every* one would mint far more
 *     checkpoints than `MAX_PER_NOTEBOOK` can hold and evict the very state worth
 *     going back to. Each snapshot is taken BEFORE the action, so it captures the
 *     state just before that batch of up to N actions began — restoring it walks the
 *     notebook back to before the batch. A `CHECKPOINT_MAX_GAP_MS` time backstop also
 *     snapshots if it's been a long while since the last auto checkpoint, so a slow,
 *     sparse agent still gets periodic backups. The count is the primary trigger;
 *     time is only a floor. What makes the throttle SAFE here is that the state these
 *     actions overwrite can be produced again: a run's outputs come back by re-running,
 *     and an edit's previous source is recoverable from the batch snapshot.
 *
 *   - DESTRUCTIVE actions — the ones that DELETE saved outputs, which nothing but a
 *     re-run can recreate and a re-run may be impossible (the kernel is gone, the
 *     cluster is down, the query cost an hour) — go through
 *     `checkpointBeforeDestructiveAgentAction`, which is NEVER throttled. Under the
 *     old single-tier rule four out of every five `clear_outputs` calls were preceded
 *     by NO snapshot at all, so "the agent wiped my results" had no undo behind it.
 *     Today that is `clear_outputs`, `delete_cells`, the `set_cell_type` conversions
 *     that drop a code cell's outputs, and a `consolidate_imports` sweep that would
 *     delete an imports-only cell carrying saved output. A run is deliberately NOT in
 *     this set: it is the highest-frequency action there is and re-running is its own
 *     recovery.
 *
 * Note the tier is decided from what the action WOULD destroy in THIS document, not
 * from which tool was called: a `set_cell_type` that keeps the outputs, and a
 * consolidate that deletes nothing, are both correctly on the throttled tier.
 *
 * STORAGE mirrors `ui-state.js`: a single JSON file under the workspace's
 * `.cellar/` dir (already gitignored in full), keyed by workspace-relative
 * notebook path, so history is per-project, port-independent, and never a git
 * diff. The in-memory `cache` is the source of truth once loaded; disk writes are
 * debounced and flushed synchronously on process exit.
 *
 * OUTPUTS ARE STORED OUT-OF-BAND, one file per checkpoint at
 * `.cellar/checkpoints/<id>.json`, and the index above holds only sources +
 * metadata. That split is what makes undo after a clear actually work. Inline,
 * every snapshot's outputs sat in the single index file, which is held in memory
 * and re-serialized on EVERY write — so a per-snapshot `MAX_SNAPSHOT_BYTES` cap had
 * to drop them, and it dropped them for exactly the output-heavy notebook
 * `clear_outputs` exists to shed weight from. Out-of-band there is no such cap:
 * the sidecar is written ONCE, read only on restore, and deleted on eviction, so
 * the repeated-write path got CHEAPER at the same time as the guarantee got real.
 *
 * BOUNDING. History is capped at `MAX_PER_NOTEBOOK` snapshots per notebook (FIFO
 * eviction, which deletes the evicted snapshot's sidecar with it). Sidecars are
 * bounded in total by `outputBudgetBytes()` across the workspace (256 MB, or
 * `CELLAR_CHECKPOINT_OUTPUT_BUDGET_BYTES`), and
 * the eviction rule is NEWEST-WINS: the snapshot just taken always keeps its
 * outputs, and older sidecars are shed until the store is under budget. That
 * inversion is the guarantee — "the destructive action you just took is undoable"
 * is a promise about the newest snapshot, while an old checkpoint losing its
 * outputs is a degradation of history, not a broken promise. A shed snapshot is
 * flagged `outputsTruncated` and still restores its sources.
 *
 * THE ONE REMAINING CASE where outputs cannot be preserved is a sidecar that could
 * not be WRITTEN (a full disk, an unwritable `.cellar/`, a payload past the JS
 * string limit). That is an error rather than a policy, so it is flagged
 * `outputsTruncated` with the cause on `outputsError`, and the destructive tools
 * REFUSE before destroying anything rather than reporting the loss afterwards. Such
 * a snapshot is ABANDONED before it is ever entered in the store
 * (`abandonIfOutputsLost`), never entered and then removed — see `createCheckpoint`
 * for why the difference is a real one and not bookkeeping.
 *
 * This module depends on `notebook.js` (read the live cells to snapshot, replace
 * the live cells to restore) but nothing in `notebook.js` depends on it — the
 * auto-checkpoint hook is called from the agent (MCP) layer, the one place that
 * unambiguously knows an *agent* is about to act.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceRoot } from '$lib/server/fstree';
import { listCells, replaceCells, resolveNotebookPath } from '$lib/server/notebook';
import { publishGlobal } from '$lib/server/events';
import type { CellView } from './types';

/** Why a checkpoint was taken. */
export type CheckpointTrigger = 'manual' | 'agent' | 'restore';

/** A full point-in-time snapshot of a notebook's cells (source + outputs + metadata). */
export interface Checkpoint {
	id: string;
	at: number;
	trigger: CheckpointTrigger;
	label: string;
	cellCount: number;
	/**
	 * Set when this snapshot holds NO outputs — either its sidecar was shed to keep
	 * the store under `outputBudgetBytes()`, or writing it failed. Sources
	 * and metadata are always kept, so such a checkpoint still restores.
	 */
	outputsTruncated?: boolean;
	/** Why the outputs are missing, when the sidecar could not be written or read. */
	outputsError?: string;
	/** True while `.cellar/checkpoints/<id>.json` holds this snapshot's outputs. */
	outputsStored?: boolean;
	/** Serialized size of that sidecar, for the store-wide budget. */
	outputBytes?: number;
	/**
	 * Sources + metadata. `outputs` is EMPTY here whenever `outputsStored` is set —
	 * the outputs live in the sidecar. A checkpoint written by an older Cellar has
	 * neither flag and carries its outputs inline; `snapshotCells` reads both shapes.
	 */
	cells: CellView[];
}

/** The metadata view of a checkpoint (everything but the heavy `cells` payload). */
export interface CheckpointMeta {
	id: string;
	at: number;
	trigger: CheckpointTrigger;
	label: string;
	cellCount: number;
	outputsTruncated: boolean;
	/** Why the outputs are missing; present only alongside `outputsTruncated`. */
	outputsError?: string;
}

/** The outcome of a restore / undo. */
export interface RestoreResult {
	ok: boolean;
	error?: string;
	restored?: CheckpointMeta;
}

const WRITE_DEBOUNCE_MS = 250;
/** Max checkpoints retained per notebook (oldest evicted first). */
const MAX_PER_NOTEBOOK = 25;
/**
 * Total on-disk budget for output sidecars across the whole workspace. Past it the
 * OLDEST sidecars are shed (see NEWEST-WINS above), never the one just written — so
 * a destructive action's own undo is never the thing traded away. Overridable so a
 * test can drive the eviction without writing hundreds of megabytes.
 */
function outputBudgetBytes(): number {
	const raw = Number(process.env.CELLAR_CHECKPOINT_OUTPUT_BUDGET_BYTES);
	return Number.isFinite(raw) && raw > 0 ? raw : 256 * 1024 * 1024;
}
/**
 * Auto-checkpoint throttle: take one automatic snapshot per this many agent
 * actions (plus the very first). The captain may retune this single constant.
 */
const CHECKPOINT_EVERY_N_ACTIONS = 5;
/**
 * Time backstop for the count throttle: if this long has passed since the last
 * auto checkpoint while the agent is still acting, snapshot even when fewer than
 * `CHECKPOINT_EVERY_N_ACTIONS` actions have occurred — so a slow, sparse agent
 * still gets periodic backups. Secondary to the count trigger.
 */
const CHECKPOINT_MAX_GAP_MS = 3 * 60 * 1000;

let cache: Record<string, Checkpoint[]> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let exitHookInstalled = false;

/** Per-notebook count of agent actions since the last auto checkpoint (in-memory only). */
const actionsSinceCheckpoint = new Map<string, number>();
/** Per-notebook timestamp of the last auto checkpoint, for the time backstop (in-memory only). */
const lastAutoCheckpointAt = new Map<string, number>();

function storePath(): string {
	return join(workspaceRoot(), '.cellar', 'checkpoints.json');
}

/** Directory holding one outputs sidecar per checkpoint. */
function outputsDir(): string {
	return join(workspaceRoot(), '.cellar', 'checkpoints');
}

function outputsPath(id: string): string {
	return join(outputsDir(), `${id}.json`);
}

/** The message a failed sidecar write / read reports as `outputsError`. */
function outputsErrorText(e: unknown): string {
	const code = (e as { code?: string } | null)?.code;
	// A raw message can carry an absolute server path; the errno (or the error's
	// name for a RangeError from an over-long JSON string) says enough.
	return code || (e instanceof Error ? e.name : 'unknown error');
}

/**
 * Drop a checkpoint's outputs: delete its sidecar and record that it no longer
 * holds them. The checkpoint itself survives and still restores its sources — this
 * is the budget's eviction step, not a deletion.
 */
function shedOutputs(cp: Checkpoint, reason: string): void {
	if (cp.outputsStored) {
		try {
			rmSync(outputsPath(cp.id), { force: true });
		} catch {}
	}
	cp.outputsStored = false;
	delete cp.outputBytes;
	cp.outputsTruncated = true;
	cp.outputsError = reason;
}

/**
 * Keep the sidecar store under `outputBudgetBytes()` by shedding the
 * OLDEST sidecars first. `keepId` — the snapshot just taken — is never shed even
 * when it alone exceeds the budget: it is the one whose outputs a destructive
 * action's undo depends on, and the next checkpoint's own budget pass ages it out
 * once it is no longer the newest.
 */
function enforceOutputBudget(store: Record<string, Checkpoint[]>, keepId: string): void {
	const stored: Checkpoint[] = [];
	let total = 0;
	for (const list of Object.values(store)) {
		for (const cp of list) {
			if (!cp.outputsStored) continue;
			stored.push(cp);
			total += cp.outputBytes ?? 0;
		}
	}
	const budget = outputBudgetBytes();
	if (total <= budget) return;
	stored.sort((a, b) => a.at - b.at);
	for (const cp of stored) {
		if (total <= budget) break;
		if (cp.id === keepId) continue;
		total -= cp.outputBytes ?? 0;
		shedOutputs(cp, 'shed to keep the checkpoint store under its size budget');
	}
}

/**
 * Delete sidecars no checkpoint refers to any more — a partial write this process
 * could not clean up, a crash mid-write, or a hand-deleted `checkpoints.json`. Runs
 * once, from the single `ensureLoaded` miss, so it costs one readdir per process.
 *
 * It deliberately does NOT need to cover "the sidecar landed but the index write was
 * still debounced": `createCheckpoint` flushes the index synchronously whenever a
 * sidecar was written, precisely so this sweep can never erase a live undo record.
 *
 * STATED LIMIT: a SECOND Cellar instance in the same workspace (`cellar --new`,
 * which the per-folder instance lock otherwise prevents) can sweep a sidecar the
 * first has written but not yet flushed into its index. It degrades honestly rather
 * than silently — the later restore finds the file gone, sheds the entry and reports
 * `outputsTruncated` — and it is the same last-writer-wins hazard `checkpoints.json`
 * itself already carries between two instances.
 */
function sweepOrphanOutputs(store: Record<string, Checkpoint[]>): void {
	try {
		const live = new Set<string>();
		for (const list of Object.values(store)) for (const cp of list) if (cp.outputsStored) live.add(cp.id);
		for (const name of readdirSync(outputsDir())) {
			if (!name.endsWith('.json')) continue;
			if (!live.has(name.slice(0, -'.json'.length))) rmSync(join(outputsDir(), name), { force: true });
		}
	} catch {}
}

/** Workspace-relative key for a notebook path (absolute, relative, or nullish → active). */
function keyFor(nb?: string | null): string {
	const abs = resolveNotebookPath(nb); // canonical absolute id
	const rel = relative(workspaceRoot(), abs);
	// A path outside the workspace (shouldn't happen for a notebook) falls back to
	// its absolute form so the key stays stable rather than an unusable `../…`.
	return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

/** Load the store once; a missing / unparseable file is an empty store. */
function ensureLoaded(): Record<string, Checkpoint[]> {
	if (cache !== null) return cache;
	try {
		const p = storePath();
		// Dynamic disk boundary: JSON.parse is `any`. Shape-guard to a plain object,
		// then cast to the store type (individual entries are trusted as written).
		const parsed: unknown = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
		cache =
			parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, Checkpoint[]>)
				: {};
	} catch {
		cache = {};
	}
	sweepOrphanOutputs(cache);
	return cache;
}

/** Metadata view of a checkpoint (everything but the heavy `cells` payload). */
function metaOf(cp: Checkpoint): CheckpointMeta {
	return {
		id: cp.id,
		at: cp.at,
		trigger: cp.trigger,
		label: cp.label,
		cellCount: cp.cellCount,
		outputsTruncated: !!cp.outputsTruncated,
		...(cp.outputsTruncated && cp.outputsError ? { outputsError: cp.outputsError } : {})
	};
}

/** Checkpoints for a notebook, newest first, metadata only. */
export function listCheckpoints(nb?: string | null): CheckpointMeta[] {
	const store = ensureLoaded();
	const list = store[keyFor(nb)] ?? [];
	return list.map(metaOf).reverse();
}

/**
 * Snapshot the notebook's current cells into a new checkpoint and return its
 * metadata. `trigger` labels why it was taken (`manual` / `agent` / `restore`).
 *
 * `abandonIfOutputsLost` is for a caller that will REFUSE its action when the
 * outputs could not be stored (the destructive tier). It decides that BEFORE the
 * entry is committed, and that ordering is the whole point: committing the entry
 * and then removing it cannot be a no-op, because `list.push` is what triggers
 * FIFO eviction, so at `MAX_PER_NOTEBOOK` a call that is about to refuse had
 * already destroyed the oldest snapshot and `rmSync`'d its sidecar - possibly a
 * human `manual` one - while its own refusal said "nothing was changed". Abandoned,
 * nothing is pushed, nothing is evicted, no `checkpoints:changed` is published and
 * the store is not marked dirty, so a refused call really does change nothing. The
 * metadata is still RETURNED, so the caller can name the cause in its refusal.
 */
export function createCheckpoint(
	nb?: string | null,
	{
		trigger = 'manual',
		label,
		abandonIfOutputsLost = false
	}: { trigger?: CheckpointTrigger; label?: string; abandonIfOutputsLost?: boolean } = {}
): CheckpointMeta {
	const store = ensureLoaded();
	const key = keyFor(nb);
	const live = listCells(nb);
	// The two halves are cloned SEPARATELY and never held at once: sources + metadata
	// are cloned into the index entry (metadata is the only mutable part - id,
	// cell_type and source are strings), while the outputs stay ALIASED to the live
	// doc just long enough to be serialized straight into the sidecar. Cloning the
	// whole cell first and then serializing it, as this used to, held two full copies
	// of a multi-megabyte output set in memory to write one.
	//
	// Runtime metadata (lastRun/editedAt/importBindings) rides along - it lives only in
	// this ephemeral `.cellar` file, never the `.ipynb`, and restoring it keeps
	// run-status AND staleness honest (the kernel-session epoch check still gates
	// ran_this_session; the import-change stamps still scope an imports-cell edit).
	const cells: CellView[] = live.map((c) => ({
		id: c.id,
		cell_type: c.cell_type,
		source: c.source,
		outputs: [],
		metadata: structuredClone(c.metadata ?? {})
	}));
	const cp: Checkpoint = {
		id: randomUUID(),
		at: Date.now(),
		trigger,
		label: label || defaultLabel(trigger),
		cellCount: cells.length,
		cells
	};
	storeOutputs(cp, live);
	// Decided BEFORE anything is committed - see `abandonIfOutputsLost` above.
	if (abandonIfOutputsLost && cp.outputsTruncated) return metaOf(cp);
	const list = store[key] ?? (store[key] = []);
	list.push(cp);
	// FIFO eviction takes the evicted snapshot's sidecar with it, or `.cellar/` would
	// accumulate a file per checkpoint the index no longer knows about.
	while (list.length > MAX_PER_NOTEBOOK) {
		const gone = list.shift();
		if (gone?.outputsStored) {
			try {
				rmSync(outputsPath(gone.id), { force: true });
			} catch {}
		}
	}
	enforceOutputBudget(store, cp.id);
	scheduleWrite();
	// A sidecar on disk that the index does not yet REFERENCE is a file
	// `sweepOrphanOutputs` deletes on the next start - so between the synchronous
	// sidecar write and the 250ms debounced index write there is a window in which a
	// SIGKILL makes the destruction durable and its undo record not merely lost but
	// actively erased. Flushing the index synchronously whenever a sidecar was really
	// written closes it, and is proportionate: this path has just done a synchronous
	// whole-file write of the outputs themselves, so one small index write beside it
	// is a rounding error. A checkpoint that stored NO sidecar has nothing a sweep
	// could delete, so it keeps the ordinary debounced path.
	if (cp.outputsStored) flush();
	publishGlobal({ type: 'checkpoints:changed', nb: resolveNotebookPath(nb) });
	return metaOf(cp);
}

/**
 * Write this snapshot's outputs to its sidecar, or record why it could not be done.
 * A notebook with no outputs at all writes nothing and is NOT flagged truncated -
 * there is nothing missing, so a destructive action on it has nothing to warn about.
 *
 * `live` is the live document's cell views, so the outputs are serialized without a
 * second copy; the resulting string is the sidecar's exact bytes.
 */
function storeOutputs(cp: Checkpoint, live: CellView[]): void {
	if (!live.some((c) => c.outputs?.length)) return;
	try {
		const json = JSON.stringify(live.map((c) => c.outputs ?? []));
		mkdirSync(outputsDir(), { recursive: true });
		writeFileSync(outputsPath(cp.id), json);
		cp.outputsStored = true;
		cp.outputBytes = Buffer.byteLength(json);
	} catch (e) {
		// A full disk, an unwritable `.cellar/`, or a payload past the JS string limit.
		// Flagged rather than thrown: a source-only checkpoint is still worth keeping,
		// and the destructive tools read this flag to refuse BEFORE destroying anything.
		//
		// A failed `writeFileSync` can leave a PARTIAL file behind (ENOSPC truncates
		// mid-write), and this entry will never claim to own it, so nothing but the
		// once-per-process orphan sweep would ever remove it. Delete it here instead:
		// the entry may also be ABANDONED outright above, in which case there is no
		// entry left to attribute the file to at all.
		try {
			rmSync(outputsPath(cp.id), { force: true });
		} catch {}
		cp.outputsStored = false;
		cp.outputsTruncated = true;
		cp.outputsError = outputsErrorText(e);
	}
}

/**
 * A checkpoint's cells with their outputs re-attached from the sidecar. A snapshot
 * written by an older Cellar carries them inline and is returned as-is.
 *
 * A sidecar that cannot be read is recorded on the stored entry (so the History
 * panel and every later read stop claiming outputs that are gone) and the sources
 * are still returned - restoring them beats refusing the restore outright.
 */
function snapshotCells(cp: Checkpoint): CellView[] {
	if (!cp.outputsStored) return cp.cells;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(outputsPath(cp.id), 'utf8'));
	} catch (e) {
		return withoutOutputs(cp, outputsErrorText(e));
	}
	// The payload is POSITIONAL - one outputs array per cell, in the snapshot's own
	// order - so a length mismatch means it does not belong to these cells and must
	// not be zipped onto them.
	if (!Array.isArray(parsed) || parsed.length !== cp.cells.length) return withoutOutputs(cp, 'unexpected shape');
	return cp.cells.map((c, i) => ({ ...c, outputs: (parsed[i] ?? []) as CellView['outputs'] }));
}

/** Record that a sidecar is unusable and fall back to the snapshot's sources. */
function withoutOutputs(cp: Checkpoint, why: string): CellView[] {
	shedOutputs(cp, `the stored outputs could not be read (${why})`);
	scheduleWrite();
	return cp.cells;
}

function defaultLabel(trigger: string): string {
	if (trigger === 'agent') return 'Before agent action';
	if (trigger === 'restore') return 'Before restore';
	return 'Manual checkpoint';
}

/**
 * Take an automatic pre-action checkpoint before an AGENT mutation/run, throttled
 * to one snapshot per `CHECKPOINT_EVERY_N_ACTIONS` agent actions (plus the first
 * action for a notebook, and a `CHECKPOINT_MAX_GAP_MS` time backstop). Returns the
 * checkpoint metadata when one was taken, else null (this action was skipped and
 * folded into the batch protected by the previous checkpoint). Because the snapshot
 * is taken BEFORE the action, restoring it walks the notebook back to before the
 * current batch of up to N actions. Called from the MCP service layer.
 */
export function autoCheckpointBeforeAgentAction(nb?: string | null): CheckpointMeta | null {
	const key = keyFor(nb);
	const now = Date.now();
	// `undefined` = never acted on this notebook → always snapshot the first action.
	const firstAction = !actionsSinceCheckpoint.has(key);
	const count = (actionsSinceCheckpoint.get(key) ?? 0) + 1;
	const lastAt = lastAutoCheckpointAt.get(key) ?? 0;

	const dueByCount = firstAction || count >= CHECKPOINT_EVERY_N_ACTIONS;
	// Backstop only after a prior checkpoint exists; the first action already covers t=0.
	const dueByTime = lastAt !== 0 && now - lastAt >= CHECKPOINT_MAX_GAP_MS;

	if (dueByCount || dueByTime) {
		actionsSinceCheckpoint.set(key, 0); // reset → exactly one checkpoint per N actions
		lastAutoCheckpointAt.set(key, now);
		return createCheckpoint(nb, { trigger: 'agent' });
	}
	actionsSinceCheckpoint.set(key, count);
	return null;
}

/**
 * Snapshot before a DESTRUCTIVE agent action - one that deletes saved outputs -
 * and NEVER throttle it. Returns the checkpoint's metadata; the caller reads
 * `outputsTruncated` to decide whether the action it is about to take is
 * recoverable (see the tiers in the header).
 *
 * Deliberately does NOT touch the throttle counters, in either direction. Reading
 * them would make a destructive action's snapshot depend on how many runs preceded
 * it, which is the bug; writing them would let a destructive action grant or spend
 * credit the recoverable tier is owed, so an ABANDONED call would leave the counters
 * describing a snapshot that was never entered. The two tiers are independent
 * mechanisms over one store.
 *
 * `abandonIfOutputsLost` is passed straight through: a caller that will refuse when
 * the outputs could not be stored must ALSO not commit the entry, or the commit's
 * own FIFO eviction destroys an older snapshot on the way to a refusal claiming
 * nothing was changed. See `createCheckpoint`.
 */
export function checkpointBeforeDestructiveAgentAction(
	nb?: string | null,
	{ abandonIfOutputsLost = false }: { abandonIfOutputsLost?: boolean } = {}
): CheckpointMeta {
	return createCheckpoint(nb, { trigger: 'agent', abandonIfOutputsLost });
}

/** Find a stored checkpoint (with its cells) by id, or null. */
function findCheckpoint(key: string, id: string): Checkpoint | null {
	const store = ensureLoaded();
	return (store[key] ?? []).find((c) => c.id === id) ?? null;
}

/**
 * Restore a notebook to a checkpoint: replace the live document's cells with the
 * snapshot, persist (clean-on-save keeps the `.ipynb` git-clean), and broadcast
 * `notebook:restored` so every open tab refetches. The pre-restore state is
 * snapshotted first (trigger `restore`), so a restore is itself undoable.
 */
export function restoreCheckpoint(nb: string | null | undefined, id: string, originId?: string | null): RestoreResult {
	const key = keyFor(nb);
	const cp = findCheckpoint(key, id);
	if (!cp) return { ok: false, error: 'not_found' };
	// Read the sidecar FIRST. The pre-restore snapshot below runs the store-wide
	// budget pass, which sheds the OLDEST sidecars and spares only the snapshot it
	// just took - so `cp`, being older, is exactly what a tight budget would shed out
	// from under this restore.
	const cells = snapshotCells(cp);
	// Read the meta HERE - after `snapshotCells`, which flags the entry when the
	// sidecar could not be read, and BEFORE the pre-restore snapshot below, whose
	// budget pass may shed this checkpoint's (already-read) sidecar. Either side of
	// that window the result would describe something other than what this restore
	// actually did: too optimistic before, too pessimistic after.
	const restored = metaOf(cp);
	// Capture the current (about-to-be-replaced) state so the user can walk it back.
	createCheckpoint(nb, { trigger: 'restore' });
	replaceCells(nb, cells, originId);
	return { ok: true, restored };
}

/**
 * Restore the newest AGENT-triggered checkpoint — the "undo last agent action"
 * headline flow. Returns `{ok:false, error:'no_agent_checkpoint'}` when the agent
 * has not acted (so there is nothing to undo).
 */
export function undoLastAgentAction(nb: string | null | undefined, originId?: string | null): RestoreResult {
	const store = ensureLoaded();
	const list = store[keyFor(nb)] ?? [];
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i].trigger === 'agent') return restoreCheckpoint(nb, list[i].id, originId);
	}
	return { ok: false, error: 'no_agent_checkpoint' };
}

function scheduleWrite(): void {
	dirty = true;
	installExitHook();
	if (writeTimer) return;
	writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
	if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

function flush(): void {
	if (writeTimer) {
		clearTimeout(writeTimer);
		writeTimer = null;
	}
	if (!dirty || cache === null) return;
	dirty = false;
	try {
		const p = storePath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(cache, null, 2) + '\n');
	} catch {}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once('exit', flush);
}
