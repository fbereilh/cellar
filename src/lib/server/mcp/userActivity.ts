/**
 * Cellar - telling the agent what the HUMAN changed.
 *
 * Cellar's agent surface reports STATE, never CHANGE. Every read tool is a full
 * snapshot of "now", so when the user deletes a cell in the UI the agent's held
 * handle fails with the same bare `no cell matches id "..."` string it gets for a
 * typo, and a user EDIT / ADD / MOVE is absorbed in total silence - the tool
 * simply returns the rewritten notebook as if the agent had always known it. The
 * model's only self-consistent readings of the delete case are "the tool is
 * flaky" or "handles do not round-trip", both wrong, and both what the watching
 * human sees as a broken tool.
 *
 * This module is the missing channel, in two halves that share one event tap:
 *
 *   (B) TOMBSTONES - a bounded per-notebook registry of recently-deleted cells,
 *       so a failed handle can say WHAT HAPPENED ("the user deleted it ~8s ago
 *       in the Cellar UI") instead of only naming a remedy. Distinguishing
 *       recently-deleted from never-existed is the whole point: an id that was
 *       never real still gets today's generic message.
 *
 *   (A) DIGEST - one optional extra text block on a tool result listing what
 *       changed outside this session since its last call. Emitted ONLY when
 *       there is something to say, so an idle user costs zero tokens.
 *
 * PULL, NOT PUSH, AND THAT IS SETTLED. Server-pushed MCP notifications cannot
 * carry this: probed against Claude Code 2.1.220, the client never sends
 * `resources/subscribe`, and `notifications/message`, `.../resources/updated`
 * and `.../resources/list_changed` were all delivered and NONE reached the
 * model. A tool result is the only surface the model actually reads, so the
 * digest rides the agent's own calls.
 *
 * THE PRE-ANNOUNCEMENT IN `INSTRUCTIONS` IS LOAD-BEARING, NOT POLISH. The same
 * probe showed that an UNANNOUNCED "the user deleted a cell" note reads to the
 * model as PROMPT INJECTION and is refused; with the channel declared up front
 * in the MCP server `instructions`, the identical payload makes the model
 * attribute the change to the human and adapt. `server.ts`'s INSTRUCTIONS clause
 * is what makes this module work at all - do not drop it as redundant prose.
 *
 * HONESTY BOUND: the digest is a bounded summary of what the bus emitted since a
 * cursor, never an exhaustive diff. It says "since your last call", points at
 * get_notebook_map as the authority (stated once in INSTRUCTIONS, not repeated
 * on every emission), and reports nothing it cannot verify.
 *
 * TWO FURTHER BOUNDS, KNOWN AND ACCEPTED (stated so they do not read as
 * oversights):
 *
 *   1. `activity` and `tombstones` are keyed by ABSOLUTE notebook path and are
 *      NOT mirrored by `notebook.ts`'s `dropDocs`/`rekeyDocs`. So a notebook
 *      rename orphans that notebook's entries under the old key, and a handle
 *      deleted just before the rename degrades to the generic not-found message.
 *      Both lists are per-notebook capped and tombstones expire by TTL, so this
 *      is a legibility gap on a rare path, not unbounded growth.
 *
 *   2. The digest cursor advances when the note is BUILT, not when the result is
 *      DELIVERED. A client that discards a response - the long-run client-timeout
 *      case `withProgress` mitigates - therefore consumes that window's activity
 *      and never sees it. A handler that THROWS correctly leaves the cursor
 *      untouched, so the gap is only the discarded-result path.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe, currentSeq } from '../events';
import { listCells } from '../notebook';
import { computeHandles, MIN_HANDLE } from './cellHandle';
import type { CellView, DispatchedEvent, PublishedEvent } from '../types';

/**
 * Entries kept per notebook. A hard bound on the growth axis that actually
 * matters: the map itself is keyed by notebook path, exactly like `events.ts`'s
 * `seqs` and `notebook.ts`'s `docs`, but an UNBOUNDED per-notebook list is what
 * would really accumulate over a long-lived Cellar.
 */
const ACTIVITY_CAP = 200;
const TOMBSTONE_CAP = 200;

/**
 * How long a deletion stays legible. After this a failed handle falls back to
 * the generic message, which is correct rather than a gap: an hour later, "no
 * cell matches this id" really is the whole truth.
 */
export const TOMBSTONE_TTL_MS = 30 * 60_000;

/** How many cell handles one clause names before it collapses to a count. */
const MAX_NAMED = 4;

/** The digest's marker, declared verbatim in INSTRUCTIONS so it is recognizable. */
export const DIGEST_PREFIX = '[cellar] user activity:';

/**
 * What a change is, from the agent's point of view. `restored` has no cell id -
 * a checkpoint restore replaces the whole document.
 */
type Kind = 'deleted' | 'added' | 'retyped' | 'edited' | 'moved' | 'restored';

/**
 * The bus event types worth reporting, and nothing else. Deliberately EXCLUDED
 * (v1): outputs cleared (already visible as has_output:false on the next read),
 * display settings / role / export flags (they change neither what code means nor
 * where it lives, and get_notebook_map reports them on demand), and runs (a
 * user's re-run does move the live namespace, but reporting it well needs
 * compression the digest does not have yet - kernel_state stays the live truth).
 */
const KIND_OF: Readonly<Record<string, Kind>> = {
	'cell:deleted': 'deleted',
	'cell:added': 'added',
	'cell:type': 'retyped',
	'cell:edited': 'edited',
	'cell:moved': 'moved',
	'notebook:restored': 'restored'
};

/**
 * Which fact wins when one cell changed several ways since the cursor. A cell
 * that was added and then edited was ADDED; one that was edited and then deleted
 * is GONE. Reporting both facts for one cell would double its handle in the
 * sentence for no gain, so the most consequential single verb is used.
 */
const PRECEDENCE: readonly Kind[] = ['deleted', 'added', 'retyped', 'edited', 'moved'];

const VERB: Readonly<Record<Kind, string>> = {
	deleted: 'deleted',
	added: 'added',
	retyped: 'changed the type of',
	edited: 'edited',
	moved: 'moved',
	restored: 'restored'
};

interface Entry {
	seq: number;
	kind: Kind;
	cellId: string | null;
	/** The MCP session that caused it, or null when it did not come from an agent. */
	by: string | null;
}

interface Tombstone {
	id: string;
	at: number;
	by: string | null;
	/**
	 * The initiating browser tab, when one was threaded. Attribution does NOT turn
	 * on this - `by` does - so it is read for exactly one thing: whether a deletion
	 * note may assert it happened "in the Cellar UI".
	 */
	origin: string | null;
}

const activity = new Map<string, Entry[]>(); // notebook abs path -> recent changes
const tombstones = new Map<string, Tombstone[]>(); // notebook abs path -> recent deletions
const cursors = new Map<string, Map<string, number>>(); // mcp sessionId -> nb -> last reported seq

// --- who caused a mutation ---------------------------------------------------

/**
 * The MCP session currently executing a tool, if any.
 *
 * This is how the agent's OWN effects are kept out of its OWN digest - reporting
 * them back would defeat the whole feature. An `AsyncLocalStorage` rather than a
 * field on the event because `EventEmitter.emit` is SYNCHRONOUS: a `publish()`
 * inside a tool handler runs this module's listener inside that handler's async
 * context, so the listener simply asks who it is running for. Nothing is added
 * to the event, so the SSE wire is byte-identical - which matters, since the same
 * bus carries streamed output deltas at ~40ms and pays per byte.
 *
 * ALS propagates across `await`, so an async write tool is covered; work that
 * genuinely escapes the context (a detached timer) reads as foreign, i.e. it is
 * over-reported rather than silently attributed to the agent.
 */
const agentSession = new AsyncLocalStorage<string>();

/** Run a tool handler tagged with its MCP session, so its mutations are attributable. */
export function runAsAgent<T>(sessionId: string | undefined, fn: () => T): T {
	return sessionId ? agentSession.run(sessionId, fn) : fn();
}

// --- the bus tap -------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function push<T>(map: Map<string, T[]>, nb: string, item: T, cap: number): void {
	const list = map.get(nb);
	if (!list) {
		map.set(nb, [item]);
		return;
	}
	list.push(item);
	if (list.length > cap) list.splice(0, list.length - cap);
}

/**
 * Append a change, COLLAPSING it into the list's TAIL when that tail already
 * records the same (cellId, kind, by).
 *
 * Without this the ring is a flat FIFO and a human typing in the UI emits one
 * `cell:edited` per 500ms debounced autosave, so sustained editing of ONE cell
 * during a long agent operation (a multi-minute `run_cell`) fills all
 * ACTIVITY_CAP slots with redundant entries for that cell and evicts the earlier
 * `cell:deleted` / `cell:added` / `cell:moved` the agent most needed - the digest
 * then reports the edit and silently omits the deletion. Collapsing is consistent
 * with `summarize`'s own one-verb-per-cell rule (PRECEDENCE), applied across calls
 * rather than only within one.
 *
 * The collapsed entry KEEPS ITS ORIGINAL `seq`; it is never moved forward. STATED
 * RESIDUAL: once a cell's edit has been reported to a session, further CONSECUTIVE
 * edits of that same cell - with no other reportable change in between - are not
 * re-reported to that session, because the entry's seq stays below its cursor.
 * That is the deliberate trade against advancing the seq, which would instead hide
 * the change from a session whose cursor lands BETWEEN the two seqs. Tail-ness
 * alone does not prove no cursor sits between them: the notebook's seq counter is
 * bumped by EVERY published event, not only by reportable ones. So this is a
 * bounded, stated trade, not an invariant.
 *
 * Only ever collapses a cell-scoped entry. A `restored` carries no cellId, and it
 * is the one kind whose repetition genuinely matters (each restore invalidates the
 * agent's handles afresh), so consecutive restores stay distinct.
 */
function recordChange(nb: string, entry: Entry): void {
	const list = activity.get(nb);
	const tail = list?.[list.length - 1];
	if (
		entry.cellId != null &&
		tail &&
		tail.cellId === entry.cellId &&
		tail.kind === entry.kind &&
		tail.by === entry.by
	)
		return;
	push(activity, nb, entry, ACTIVITY_CAP);
}

function record(event: PublishedEvent): void {
	const kind = KIND_OF[event.type];
	if (!kind) return;
	const by = agentSession.getStore() ?? null;
	const origin = str(event.originId);
	// `cell:added` carries the whole cell view; the rest carry a `cellId`.
	const cellId =
		kind === 'restored'
			? null
			: str((event.cell as { id?: unknown } | undefined)?.id) ?? str(event.cellId);
	if (kind !== 'restored' && !cellId) return;

	// A cell hidden from the agent must not surface in a digest OR a tombstone
	// message - `hidden_from_agent` is honored in every map, read, search, section
	// and result, and a deletion note naming one would disclose both that the cell
	// existed and that the user removed it. The flag can only be read at DELETE
	// time (the cell is spliced out before the event fires), so `notebook.ts`
	// carries it on the event; for every other kind the live document is consulted
	// at digest time, which is the honest moment ("is this hidden right now").
	if (kind === 'deleted' && event.hiddenFromAgent === true) return;

	recordChange(event.nb, { seq: event.seq, kind, cellId, by });
	if (kind === 'deleted' && cellId) {
		push(tombstones, event.nb, { id: cellId, at: Date.now(), by, origin }, TOMBSTONE_CAP);
	}
}

subscribe((event: DispatchedEvent) => {
	// Global snapshots (the run queue) carry no `nb`/`seq` and are never reportable.
	if ((event as { global?: boolean }).global) return;
	const pe = event as PublishedEvent;
	if (typeof pe.nb !== 'string' || typeof pe.seq !== 'number') return;
	try {
		record(pe);
	} catch {
		// A digest is a courtesy; it must never be able to break a document mutation
		// (this listener runs INSIDE publish(), i.e. inside the write path).
	}
});

// --- (B) legible deletion ----------------------------------------------------

function liveTombstones(nb: string, now: number): Tombstone[] {
	const list = tombstones.get(nb);
	if (!list?.length) return [];
	const fresh = list.filter((t) => now - t.at < TOMBSTONE_TTL_MS);
	if (fresh.length !== list.length) {
		if (fresh.length) tombstones.set(nb, fresh);
		else tombstones.delete(nb);
	}
	return fresh;
}

/**
 * "just now" / "8s ago" / "4m ago" / "2h ago" - deliberately coarse; the point is
 * recency, not precision. A whole phrase rather than a bare duration because the
 * sub-second case is the COMMON one here (the agent's very next call after the
 * user's click), and "0s ago" reads as a defect.
 */
function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 2) return 'just now';
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/**
 * A legible replacement for the generic not-found error, when the ref names a
 * cell that was RECENTLY DELETED. Returns null when it does not - a ref that was
 * never real keeps today's message, and preserving that distinction is what stops
 * the feature degenerating into always claiming a deletion.
 *
 * Matching is a prefix scan, like `resolveCellId`'s: handles are the shortest
 * unique prefix over the CURRENT cells, so a deletion can shorten a survivor's
 * handle and leave the agent holding a longer prefix of the cell that went. It is
 * floored at `MIN_HANDLE` for exactly that reason - the scan is over up to
 * TOMBSTONE_CAP UUIDs, so a 1-3 character ref (a hallucinated id, never a handle:
 * every handle Cellar emits is >= MIN_HANDLE and a full UUID is 36) would hit one
 * by pure coincidence and be reported as a deletion that never happened. A ref
 * that short falls back to the generic message, which is the truthful answer for
 * it, and the never-existed vs recently-deleted distinction survives.
 *
 * ATTRIBUTION IS THREE-WAY, decided by the tombstone's MCP session (`by`) against
 * the CALLER's (`callerSession`) - never by the browser tab (`origin`):
 *
 *   - `by` equals the caller  => the CALLING agent deleted the cell itself earlier
 *     in this session. Plausibly the commonest not-found path there is (an agent
 *     re-referencing a cell it removed while working from a stale plan), and
 *     describing self-inflicted staleness as a concurrent third-party editor pushes
 *     the model into re-planning around an editor that does not exist. This branch
 *     therefore must not say or imply that anyone else touched the notebook.
 *   - `by` is a DIFFERENT session => genuinely another agent.
 *   - `by` is null => the user, or Cellar acting on their behalf through a REST
 *     route, which reads as the user either way. Keying this off `origin` instead
 *     is the misattribution this module exists to prevent: a UI action does not
 *     always carry an `originId` (the navbar "Consolidate imports" sweep deletes
 *     emptied cells through a route that deliberately threads none), so it reported
 *     a human's own click as "an agent deleted it" - worse than the generic message
 *     it replaces, since another agent's action reads to the model as not its
 *     concern.
 *
 * The " in the Cellar UI" clause stays gated on `origin`, because that clause
 * specifically asserts a browser tab and only a threaded `originId` establishes
 * one - a consolidate-driven deletion reads "the user deleted it just now." with
 * no UI clause, which is true rather than over-claimed.
 */
export function deletionNote(nb: string, ref: string, callerSession?: string): string | null {
	const r = (ref ?? '').trim();
	if (r.length < MIN_HANDLE) return null;
	const hits = liveTombstones(nb, Date.now()).filter((t) => t.id === r || t.id.startsWith(r));
	if (!hits.length) return null;
	const t = hits[hits.length - 1]; // the most recent deletion this ref could name
	const when = ago(Date.now() - t.at);
	const tail = 'Your view of the notebook is out of date; the tool is working. Call get_notebook_map for the current handles.';
	if (t.by != null && callerSession != null && t.by === callerSession)
		return `cell "${r}" no longer exists - you deleted it ${when}, earlier in this same session. ${tail}`;
	const who = t.by != null ? 'an agent deleted it' : 'the user deleted it';
	const where = t.origin != null ? ' in the Cellar UI' : '';
	return `cell "${r}" no longer exists - ${who} ${when}${where}. ${tail}`;
}

// --- (A) the digest ----------------------------------------------------------

const hiddenFromAgent = (c: CellView): boolean => c.metadata?.cellar?.hidden_from_agent === true;

function safeCells(nb: string): CellView[] {
	try {
		return listCells(nb);
	} catch {
		return [];
	}
}

/** "a", "a and b", "a, b, and c" */
function joinClauses(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function clause(kind: Kind, handles: string[]): string {
	const verb = VERB[kind];
	if (handles.length === 1) return `${verb} cell ${handles[0]}`;
	if (handles.length <= MAX_NAMED) return `${verb} cells ${joinClauses(handles)}`;
	return `${verb} ${handles.length} cells (${handles.slice(0, MAX_NAMED).join(', ')}, +${handles.length - MAX_NAMED} more)`;
}

/**
 * Who to name, from the MCP session (`by`) alone - the same discriminator
 * `deletionNote` uses. Anything that is not THIS session is either another agent
 * (which ran under its own MCP session, so `by` is set) or Cellar acting on the
 * human's behalf through a REST route, which reads as the user either way.
 *
 * CALL THIS WITH THE ENTRIES THAT ACTUALLY PRODUCED THE SENTENCE, never the
 * unfiltered window. Attributing from a change the digest declined to report
 * makes the phrase claim an actor who did not touch any named cell, and - when
 * the declined change was a `hidden_from_agent` cell - discloses that the hidden
 * cell changed at all, which is the very invariant the filtering protects.
 */
function actorPhrase(entries: Entry[]): string {
	const agent = entries.some((e) => e.by != null);
	const human = entries.some((e) => e.by == null);
	if (agent && human) return 'the user and another agent';
	return agent ? 'another agent' : 'the user';
}

function summarize(entries: Entry[], nb: string): string | null {
	// A restore replaced the whole document, so every handle the agent holds may
	// be meaningless - that fact outranks (and would be misdescribed by) a list of
	// individual cell changes.
	const restores = entries.filter((e) => e.kind === 'restored');
	if (restores.length)
		return `${DIGEST_PREFIX} ${actorPhrase(restores)} restored a checkpoint, so this notebook was reverted wholesale - your cell handles may no longer exist. Re-read it with get_notebook_map before acting.`;

	// One verb per cell (see PRECEDENCE).
	const best = new Map<string, Kind>();
	for (const e of entries) {
		if (!e.cellId) continue;
		const prev = best.get(e.cellId);
		if (prev == null || PRECEDENCE.indexOf(e.kind) < PRECEDENCE.indexOf(prev)) best.set(e.cellId, e.kind);
	}
	if (!best.size) return null;

	const cells = safeCells(nb);
	const byId = new Map(cells.map((c) => [c.id, c]));
	const handles = computeHandles(cells);
	const buckets = new Map<Kind, string[]>();
	const reported = new Set<string>();
	for (const [id, kind] of best) {
		let handle: string;
		if (kind === 'deleted') {
			// The cell is gone, so it has no current handle; the >=8-char prefix is
			// what the agent was holding, and it names something that no longer exists.
			handle = id.slice(0, MIN_HANDLE);
		} else {
			const cell = byId.get(id);
			// Not in the document and not a recorded deletion: we cannot check whether
			// it was hidden, so we do not disclose it. Never report what you cannot verify.
			if (!cell || hiddenFromAgent(cell)) continue;
			handle = handles.get(id) ?? id.slice(0, MIN_HANDLE);
		}
		reported.add(id);
		const list = buckets.get(kind);
		if (list) list.push(handle);
		else buckets.set(kind, [handle]);
	}

	const parts = PRECEDENCE.filter((k) => buckets.has(k)).map((k) => clause(k, buckets.get(k)!));
	if (!parts.length) return null;
	// Attribute from the entries that survived the filter above, never the whole
	// window: an actor whose only change was to a cell this declined to name did
	// not touch anything the sentence mentions, and naming them would disclose that
	// a `hidden_from_agent` cell changed - the invariant the filter exists for. A
	// cell that IS reported and was touched by both still yields both actors.
	const contributing = entries.filter((e) => e.cellId != null && reported.has(e.cellId));
	return `${DIGEST_PREFIX} since your last call ${actorPhrase(contributing)} ${joinClauses(parts)}.`;
}

/**
 * The digest for one tool call, or null when there is nothing to say (the common
 * case, and it costs zero tokens because the block is OMITTED rather than emitted
 * empty).
 *
 * `upTo` is the notebook's `seq` snapshotted BEFORE the handler ran. That is the
 * subtle part: it keeps the agent's own effects and anything the user did DURING
 * a long run out of this call's digest and defers them to the next one, so a note
 * can never describe the very call that is returning it.
 *
 * The cursor advances UNCONDITIONALLY to `upTo`, past events this filtered out,
 * so a change that was not reportable cannot accumulate and resurface later. The
 * FIRST call for a (session, notebook) pair only seeds the cursor and reports
 * nothing: there is no "last call" for it to be since, and replaying the whole
 * history of the notebook would be both wrong and enormous.
 */
export function digestFor(sessionId: string, nb: string, upTo: number): string | null {
	let per = cursors.get(sessionId);
	if (!per) {
		per = new Map();
		cursors.set(sessionId, per);
	}
	const from = per.get(nb);
	// Never move backwards: two concurrent tool calls snapshot different seqs.
	per.set(nb, from == null ? upTo : Math.max(from, upTo));
	if (from == null || upTo <= from) return null;
	const buf = activity.get(nb);
	if (!buf?.length) return null;
	const fresh = buf.filter((e) => e.seq > from && e.seq <= upTo && e.by !== sessionId);
	if (!fresh.length) return null;
	return summarize(fresh, nb);
}

/**
 * Release this session's activity cursor. Called from `service.ts`'s
 * `forgetSession`, whose contract already requires that anything keyed by
 * `sessionId` be cleared there - a per-reconnected-bridge leak is exactly what
 * the session registry was written to close.
 */
export function forgetSessionActivity(sessionId: string): void {
	cursors.delete(sessionId);
}

/** Test seam: drop every recorded change, tombstone and cursor. */
export function __resetUserActivity(): void {
	activity.clear();
	tombstones.clear();
	cursors.clear();
}

/** Test seam: the notebook's current cursor for a session (undefined when unseeded). */
export function __cursorFor(sessionId: string, nb: string): number | undefined {
	return cursors.get(sessionId)?.get(nb);
}

/** Re-exported so callers need only this module to snapshot a cursor. */
export { currentSeq };
