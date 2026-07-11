/**
 * Cellar — notebook checkpoints (snapshot / restore).
 *
 * A checkpoint is a full point-in-time snapshot of a notebook's cells — their
 * source, outputs, and metadata — so a bad edit (yours or an agent's) can be
 * reverted. Two things create them:
 *
 *   - a MANUAL "Checkpoint now" action (trigger `manual`), and
 *   - an AUTOMATIC snapshot taken BEFORE an agent action (trigger `agent`), so an
 *     agent's mutation or run can be undone. Agent actions arrive in bursts (a
 *     run_all is many run_cell calls; one agent turn fires several tools), so the
 *     auto path COALESCES: the first action of a burst snapshots the pre-burst
 *     state and the rest are folded into it, until a quiet gap starts a new burst.
 *     The result is one "before agent action" checkpoint per logical turn, which
 *     is exactly what "undo last agent action" restores.
 *
 * STORAGE mirrors `ui-state.js`: a single JSON file under the workspace's
 * `.cellar/` dir (already gitignored in full), keyed by workspace-relative
 * notebook path, so history is per-project, port-independent, and never a git
 * diff. The in-memory `cache` is the source of truth once loaded; disk writes are
 * debounced and flushed synchronously on process exit.
 *
 * BOUNDING. History is capped at `MAX_PER_NOTEBOOK` snapshots per notebook (FIFO
 * eviction). Outputs are INCLUDED (so a restore reproduces the rendered result),
 * but a single snapshot is capped at `MAX_SNAPSHOT_BYTES`: past that, its outputs
 * are dropped (source + metadata are always kept) and it is flagged
 * `outputsTruncated`, so one image-heavy notebook can never blow up the store.
 *
 * This module depends on `notebook.js` (read the live cells to snapshot, replace
 * the live cells to restore) but nothing in `notebook.js` depends on it — the
 * auto-checkpoint hook is called from the agent (MCP) layer, the one place that
 * unambiguously knows an *agent* is about to act.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
	/** Set when outputs were dropped to keep the snapshot under the size cap. */
	outputsTruncated?: boolean;
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
/** A snapshot larger than this (serialized) drops its outputs to stay bounded. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** A fresh agent action within this window of the last one folds into the same pre-burst checkpoint. */
const COALESCE_MS = 4000;

let cache: Record<string, Checkpoint[]> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let exitHookInstalled = false;

/** Per-notebook timestamp of the last agent action, for auto-checkpoint coalescing (in-memory only). */
const lastAgentAt = new Map<string, number>();

function storePath(): string {
	return join(workspaceRoot(), '.cellar', 'checkpoints.json');
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
		outputsTruncated: !!cp.outputsTruncated
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
 */
export function createCheckpoint(
	nb?: string | null,
	{ trigger = 'manual', label }: { trigger?: CheckpointTrigger; label?: string } = {}
): CheckpointMeta {
	const store = ensureLoaded();
	const key = keyFor(nb);
	// Deep-clone the live cells so later document mutations can't corrupt the stored
	// snapshot. Runtime metadata (lastRun/editedAt) rides along — it lives only in
	// this ephemeral `.cellar` file, never the `.ipynb`, and restoring it keeps
	// run-status honest (the kernel-session epoch check still gates ran_this_session).
	const cells = structuredClone(listCells(nb));
	const cp: Checkpoint = {
		id: randomUUID(),
		at: Date.now(),
		trigger,
		label: label || defaultLabel(trigger),
		cellCount: cells.length,
		cells
	};
	// Bound a single snapshot: if it's too big, drop outputs (keep source + metadata).
	if (JSON.stringify(cp).length > MAX_SNAPSHOT_BYTES) {
		for (const c of cp.cells) c.outputs = [];
		cp.outputsTruncated = true;
	}
	const list = store[key] ?? (store[key] = []);
	list.push(cp);
	while (list.length > MAX_PER_NOTEBOOK) list.shift();
	scheduleWrite();
	publishGlobal({ type: 'checkpoints:changed', nb: resolveNotebookPath(nb) });
	return metaOf(cp);
}

function defaultLabel(trigger: string): string {
	if (trigger === 'agent') return 'Before agent action';
	if (trigger === 'restore') return 'Before restore';
	return 'Manual checkpoint';
}

/**
 * Take an automatic pre-action checkpoint before an AGENT mutation/run, coalesced
 * so a burst of agent activity yields a single "before agent action" snapshot.
 * Returns the checkpoint metadata when one was taken, else null (folded into the
 * burst already in progress). Called from the MCP service layer.
 */
export function autoCheckpointBeforeAgentAction(nb?: string | null): CheckpointMeta | null {
	const key = keyFor(nb);
	const now = Date.now();
	const prev = lastAgentAt.get(key) ?? 0;
	lastAgentAt.set(key, now); // extend the burst on every action
	if (now - prev < COALESCE_MS) return null; // still inside an active burst
	return createCheckpoint(nb, { trigger: 'agent' });
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
	// Capture the current (about-to-be-replaced) state so the user can walk it back.
	createCheckpoint(nb, { trigger: 'restore' });
	replaceCells(nb, cp.cells, originId);
	return { ok: true, restored: metaOf(cp) };
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
