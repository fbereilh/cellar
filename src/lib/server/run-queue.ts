/**
 * Cellar — per-notebook kernel run queues.
 *
 * Cellar runs ONE kernel per notebook (see `kernel.ts`). Each kernel serializes
 * its own cells — one cell of a notebook runs at a time — but DIFFERENT notebooks
 * execute in parallel against isolated namespaces. So the queue is sharded per
 * notebook: a `Map<nbPath, { active, pending }>`. A run queued in notebook B no
 * longer waits behind a run in notebook A; it waits only behind notebook B's own
 * cells. Before this module a run requested while a kernel was busy was simply
 * dropped (the UI early-returned, the MCP tools raced into `execute()`); this is
 * the FIFO that makes a second run of the SAME notebook *wait* instead.
 *
 * The queue lives on the server, not the browser, because the kernels do: an
 * agent's MCP run must interleave with a user's UI run on the same notebook in
 * submission order, and neither a per-notebook component nor a per-tab flag can
 * see both. Entries are keyed by `(notebook, cellId)` — cell ids are unique per
 * document, not across documents.
 *
 * Each queue is a *slot* primitive: it decides WHO runs next in its notebook,
 * never how. Both run entry points (`/api/cells/[id]/run` and the MCP `runCell`)
 * keep owning their own execution + streaming; they just take a ticket first:
 *
 *   const ticket = enqueueRun({ nb, cellId, actor, source });
 *   if (ticket.duplicate) …            // already running or already queued (in nb)
 *   try { await ticket.wait(); }       // resolves when nb's kernel is ours
 *   catch (RunCancelled) { … }         // a restart/interrupt dropped it
 *   finally { ticket.done(); }         // hand nb's kernel to the next entry
 *
 * Every change to a notebook's pending list is broadcast as a `queue:changed`
 * event carrying the FULL cross-notebook snapshot (every busy kernel's running
 * cell + every notebook's ordered queue, each entry tagged with its `nb`), so a
 * client renders "queued · 2" by reading a snapshot rather than reconstructing it
 * from a stream of deltas (a missed event self-heals on the next one). The MCP
 * `run_queue` tool reads the whole per-notebook map (`queuesByNotebook`) so an
 * agent sees every notebook's own queue; `queueStateFor` returns one slice.
 */
import { publishGlobal } from './events';
import type { Actor, QueueEntryView, QueueState, RunningView } from './types';

/** Rejection reason handed to a pending run that a restart/interrupt dropped. */
export class RunCancelled extends Error {
	reason: string;
	constructor(reason: string) {
		super(`run cancelled: ${reason}`);
		this.name = 'RunCancelled';
		this.reason = reason;
	}
}

/** An internal queue entry: the pending run plus the promise handed to its owner. */
interface QueueEntry {
	key: string;
	nb: string;
	cellId: string;
	actor: Actor;
	source: string;
	promise?: Promise<void>;
	resolve?: () => void;
	reject?: (err: Error) => void;
}

/** One notebook's kernel queue: the run holding its kernel + those waiting. */
interface NotebookQueue {
	active: QueueEntry | null;
	pending: QueueEntry[];
}

/**
 * The ticket returned to a run's owner from `enqueueRun`. A discriminated union
 * on `duplicate`: a duplicate submission carries only its position, while a fresh
 * ticket carries the wait/source/cancel/done handles the owner drives.
 */
export type RunTicket =
	| { duplicate: true; position: number }
	| {
			duplicate: false;
			queued: boolean;
			position: number;
			/** The source to execute, read at dequeue time (a duplicate may have refreshed it). */
			source: () => string;
			wait: () => Promise<void>;
			/** Drop THIS entry if it is still pending (identity-checked, never by key). */
			cancel: (reason?: string) => boolean;
			done: () => void;
	  };

/** Per-notebook queues, keyed by absolute notebook path. */
const queues = new Map<string, NotebookQueue>();

// A cell id is only unique within its document, so the queue key must carry both.
const keyOf = (nb: string, cellId: string) => `${nb} ${cellId}`;

/** The notebook's queue, creating an empty one on first reference. */
function queueFor(nb: string): NotebookQueue {
	let q = queues.get(nb);
	if (!q) {
		q = { active: null, pending: [] };
		queues.set(nb, q);
	}
	return q;
}

/**
 * Drop a notebook's queue record once it is fully idle (no active run, nothing
 * pending). Keeps the Map from growing without bound as notebooks come and go;
 * the next run re-creates it lazily.
 */
function pruneIfIdle(nb: string): void {
	const q = queues.get(nb);
	if (q && !q.active && q.pending.length === 0) queues.delete(nb);
}

/** Ordered snapshot of ONE notebook's pending runs; `position` is 1-based (1 = next). */
function pendingSnapshot(q: NotebookQueue): QueueEntryView[] {
	return q.pending.map((e, i) => ({ nb: e.nb, cellId: e.cellId, actor: e.actor, position: i + 1 }));
}

/**
 * One notebook's queue state, in the exact `{ running, queue }` shape the MCP
 * `run_queue` tool has always returned (single running cell). Resolving a
 * kernel-surface call to the active notebook keeps that shape unchanged while the
 * queues are sharded underneath.
 */
export function queueStateFor(nb: string): QueueState {
	const q = queues.get(nb);
	if (!q) return { running: null, queue: [] };
	return {
		running: q.active ? { nb: q.active.nb, cellId: q.active.cellId, actor: q.active.actor } : null,
		queue: pendingSnapshot(q)
	};
}

/**
 * The whole-app queue snapshot across every notebook: one `running` entry per
 * busy kernel (notebooks execute in parallel, so there can be several) plus every
 * notebook's ordered pending runs, each tagged with its `nb`. This is what the
 * `queue:changed` SSE broadcast carries — the client filters `queue` and `running`
 * by its own notebook id, so two notebooks each render only their own state.
 */
export function queueStateAll(): { running: RunningView[]; queue: QueueEntryView[] } {
	const running: RunningView[] = [];
	const queue: QueueEntryView[] = [];
	for (const q of queues.values()) {
		if (q.active) running.push({ nb: q.active.nb, cellId: q.active.cellId, actor: q.active.actor });
		for (const item of pendingSnapshot(q)) queue.push(item);
	}
	return { running, queue };
}

/**
 * The per-notebook queue map: `{ [absNbPath]: {running, queue} }`, one entry for
 * every notebook that has an active or pending run. This is what the MCP
 * `run_queue` tool returns so an agent sees each notebook's OWN kernel queue —
 * with one kernel per notebook, a run only ever waits behind its own notebook's
 * cells, and cross-notebook contention no longer exists. Only non-idle notebooks
 * appear (an idle queue is pruned); a notebook absent from the map has an empty
 * queue. Keyed by absolute path — the caller maps to workspace-relative for the
 * agent-facing shape.
 */
export function queuesByNotebook(): Record<string, QueueState> {
	const out: Record<string, QueueState> = {};
	for (const [nb, q] of queues) {
		out[nb] = {
			running: q.active ? { nb: q.active.nb, cellId: q.active.cellId, actor: q.active.actor } : null,
			queue: pendingSnapshot(q)
		};
	}
	return out;
}

function broadcast() {
	publishGlobal({ type: 'queue:changed', ...queueStateAll() });
}

/** 1-based position of a pending run in its notebook, or 0 when running / not queued. */
export function queuePosition(nb: string, cellId: string): number {
	const q = queues.get(nb);
	if (!q) return 0;
	const key = keyOf(nb, cellId);
	const i = q.pending.findIndex((e) => e.key === key);
	return i < 0 ? 0 : i + 1;
}

/**
 * Claim a notebook's kernel for one cell run.
 *
 * Returns a ticket. `duplicate: true` means that cell is already running or
 * already queued IN THIS NOTEBOOK: re-running it must not enqueue it twice. In
 * that case the pending entry's `source` is refreshed to the newly submitted one,
 * so pressing Run again after editing a queued cell runs what you last submitted
 * rather than a stale snapshot — the reason it is safe to simply drop the second
 * request.
 *
 * When the notebook's kernel is free the ticket resolves immediately
 * (`queued: false`), so an uncontended run is exactly as direct as it was before
 * the queue existed. Another notebook being busy never queues this one.
 */
export function enqueueRun({
	nb,
	cellId,
	actor = 'user',
	source = ''
}: {
	nb: string;
	cellId: string;
	actor?: Actor;
	source?: string;
}): RunTicket {
	const q = queueFor(nb);
	const key = keyOf(nb, cellId);
	if (q.active?.key === key) return { duplicate: true, position: 0 };
	const already = q.pending.find((e) => e.key === key);
	if (already) {
		already.source = source; // the latest submission wins; still one queued run
		return { duplicate: true, position: queuePosition(nb, cellId) };
	}

	const entry: QueueEntry = { key, nb, cellId, actor, source };
	entry.promise = new Promise<void>((resolve, reject) => {
		entry.resolve = resolve;
		entry.reject = reject;
	});
	// A cancelled entry whose owner has already returned must not surface as an
	// unhandled rejection. `.catch()` marks it handled without consuming it: the
	// owner's own `await ticket.wait()` still sees the rejection.
	entry.promise.catch(() => {});

	let queued: boolean;
	if (q.active) {
		q.pending.push(entry);
		queued = true;
	} else {
		q.active = entry;
		entry.resolve!();
		queued = false;
	}
	// Broadcast on BOTH paths, so `running` in the snapshot is always the kernels'
	// truth and not merely "whatever was running when a queue last changed". A tab
	// that connects (or a notebook that mounts) mid-run is seeded from this, and
	// would otherwise render cells queued behind a cell it shows as idle.
	broadcast();

	return {
		duplicate: false,
		queued,
		position: queued ? q.pending.length : 0,
		/** The source to execute, read at dequeue time (a duplicate submission may have refreshed it). */
		source: () => entry.source,
		wait: () => entry.promise!,
		/** Drop THIS entry if it is still pending (identity-checked, never by key). */
		cancel: (reason = 'cancelled') => cancelEntry(entry, reason),
		done: () => release(entry)
	};
}

/**
 * Release a notebook's kernel and hand it to the next entry in THAT notebook's
 * queue. Safe to call for an entry that was already cancelled (it is simply no
 * longer anywhere) — which is why every caller can put it in a `finally`.
 */
function release(entry: QueueEntry): void {
	const q = queues.get(entry.nb);
	if (!q) return;
	if (q.active !== entry) {
		const i = q.pending.indexOf(entry);
		if (i >= 0) {
			q.pending.splice(i, 1);
			broadcast();
		}
		pruneIfIdle(entry.nb);
		return;
	}
	q.active = q.pending.shift() ?? null;
	// Resolve BEFORE broadcasting so the snapshot no longer lists the entry that
	// just started; its owner publishes the `run:start` that replaces the badge.
	if (q.active) q.active.resolve!();
	broadcast();
	pruneIfIdle(entry.nb);
}

/** Drop a specific pending entry from its notebook's queue. No-op once running/gone. */
function cancelEntry(entry: QueueEntry, reason: string): boolean {
	const q = queues.get(entry.nb);
	if (!q) return false;
	const i = q.pending.indexOf(entry);
	if (i < 0) return false;
	q.pending.splice(i, 1);
	entry.reject!(new RunCancelled(reason));
	broadcast();
	pruneIfIdle(entry.nb);
	return true;
}

/**
 * Cancel the pending run for a cell (its cell was deleted). A run already
 * executing is the kernel's to finish — interrupt it instead.
 */
export function cancelRun(nb: string, cellId: string, reason = 'cell_removed'): boolean {
	const q = queues.get(nb);
	if (!q) return false;
	const entry = q.pending.find((e) => e.key === keyOf(nb, cellId));
	return entry ? cancelEntry(entry, reason) : false;
}

/**
 * Drop every PENDING run of ONE notebook — what that notebook's kernel
 * interrupt / restart / rebind / autorestart must do. Queued work was submitted
 * against the namespace that is about to vanish; silently running it against a
 * fresh kernel would execute cell N+1 without cell N's definitions. The *active*
 * run is not touched here: the kernel operation itself is what ends it, and its
 * owner then releases the slot into an empty queue. Other notebooks' queues are
 * untouched — restarting one notebook's kernel must not drop another's runs.
 *
 * @returns {number} how many pending runs were dropped
 */
export function clearRunQueue(nb: string, reason = 'kernel_restart'): number {
	const q = queues.get(nb);
	if (!q || !q.pending.length) return 0;
	const dropped = q.pending.splice(0, q.pending.length);
	for (const entry of dropped) entry.reject!(new RunCancelled(reason));
	broadcast();
	pruneIfIdle(nb);
	return dropped.length;
}
