<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import Notebook from '$lib/Notebook.svelte';
	import { subscribeEvents, originId } from '$lib/events-client';
	import { cellIdOfKey, computeFolding, headerLevel, outlineHeadings, withHeadingLevel } from '$lib/headings';
	import { notebookCellChanges, NO_CELL_CHANGES } from '$lib/gitdiff';
	import { cellClipboard } from '$lib/cellClipboard';
	import { clampMoveIndex, isImportsCell } from '$lib/importsRole';
	import { exportCellCount } from '$lib/exportRole';
	import { shortcuts, chordFromEvent, SEQUENCE_TIMEOUT_MS } from '$lib/shortcuts.svelte';
	import type { ShortcutMode, EffectiveShortcut } from '$lib/shortcuts.svelte';
	import { getUi, setUi } from '$lib/uiState';
	import type { CellView, CellOutput, CellType, LogicalCellType, Actor, RunningView, QueueEntryView, LastRun, CellarNamespace, PublishedEvent } from '$lib/server/types';
	import type { UICell, KeyMode, FoldRegistryHandle, NotebookApiHandle, CellRegisterApi } from '$lib/types';
	import type { ClientEvent } from '$lib/events-client';
	import type { Folding } from '$lib/headings';
	import type { StalenessMap } from '$lib/staleness';
	import type { ClipboardCell } from '$lib/cellClipboard';

	interface Props {
		/** Workspace path addressing this notebook (the REST API resolves it server-side). */
		path: string;
		active?: boolean;
		/** The shell's `fsRefreshSignal`: a bump re-fetches the git HEAD baseline. */
		gitRefresh?: number;
		onCellsChange?: (path: string, cells: UICell[]) => void;
		/** (path, foldedIds, folding): the sidebar Outline renders from this. */
		onFoldsChange?: (path: string, foldedIds: Set<string>, folding: Folding) => void;
		/** (path, handle|null): lets the Outline drive this notebook's folds. */
		onRegisterFolds?: (path: string, handle: FoldRegistryHandle | null) => void;
		/** (path, api|null): lets the sidebar drop a cell in here. */
		onRegisterApi?: (path: string, api: NotebookApiHandle | null) => void;
		onRunStart?: (path: string, id: string) => void;
		onRunEnd?: () => void;
		/** Interrupt the shared kernel (same handler the Kernels sidebar uses). */
		onInterruptKernel?: () => void;
	}

	/** A structural document event as this component reads it (see events.js). */
	type StructuralEvent =
		| { type: 'cell:added'; cell?: CellView; afterId?: string | null; index?: number }
		| { type: 'cell:role'; cellId: string; role?: string | null }
		| { type: 'cell:export'; cellId: string; exported: boolean }
		| { type: 'cell:deleted'; cellId: string }
		| { type: 'cell:moved'; cellId: string; toIndex: number }
		| { type: 'cell:type'; cellId: string; cell_type: CellType; language?: string | null }
		| { type: 'cell:cleared'; cellId: string }
		| { type: 'cell:rendered'; cellId: string }
		| { type: 'cell:edited'; cellId: string; source: string }
		| { type: 'notebook:export-target'; target: string | null };

	/** A run-lifecycle event (run:start / run:output / run:end). */
	type RunEvent =
		| { type: 'run:start'; cellId?: string; actor?: Actor }
		| { type: 'run:output'; cellId?: string; output: CellOutput }
		| { type: 'run:end'; cellId?: string; at?: number; durationMs?: number; actor?: Actor };

	/** A kernel run-queue snapshot (queue:changed). */
	interface QueueChangedEvent {
		type?: string;
		running?: RunningView | null;
		queue?: QueueEntryView[];
	}

	// A live, kernel-attached notebook document addressed by its workspace path.
	// Owns its own cell array + all cell operations (every request carries
	// `nb: path` so it mutates *this* notebook's file, not the active one). The
	// default workspace notebook and every opened `.ipynb` use this same
	// component — one code path, one behavior. Runs go through the single shared
	// kernel, which serializes them itself: a run requested while it is busy is
	// queued server-side (`run-queue.js`), so this component never gates a run.
	// `gitRefresh` is the shell's `fsRefreshSignal`: a bump means the workspace's
	// git state may have moved, so re-fetch the HEAD baseline the cells diff against.
	let {
		path,
		active = false,
		gitRefresh = 0,
		onCellsChange,
		onFoldsChange,
		onRegisterFolds,
		onRegisterApi,
		onRunStart,
		onRunEnd,
		onInterruptKernel
	}: Props = $props();

	let cells = $state<UICell[]>([]);
	let fetching = $state(true); // loading the notebook's cells from the server
	let loadError = $state('');
	// nbdev-style export: the notebook's `.py` module target + how many cells are
	// marked for export. `exportTarget` mirrors `notebook.metadata.cellar.export_target`
	// (loaded on mount, kept live via the `notebook:export-target` SSE event); the
	// count derives from the live cell flags. Rendered as a header bar at the top of
	// the notebook (Notebook.svelte) once either is set.
	let exportTarget = $state<string | null>(null);
	const exportCount = $derived(exportCellCount(cells));
	let runningId = $state<string | null>(null); // the cell running in THIS notebook (≤1)
	// Cells of THIS notebook waiting in the kernel's global FIFO → their 1-based
	// position in that queue (1 = next up). The positions are global on purpose:
	// a cell queued here may be waiting behind a cell in another notebook, and
	// "queued · 3" should say so. Mirrored from the server's `queue:changed`
	// snapshot, never derived locally — the queue spans notebooks and tabs, so no
	// single client can compute it.
	let queued = $state<Record<string, number>>({});
	let activeId = $state<string | null>(null); // the selected/focused cell (visual emphasis)
	// The cell an AGENT (MCP) is currently running here, or null. Distinct from
	// `runningId` - which is set for every run, including this tab's own and other
	// tabs' user runs - because only an agent run may move the viewport (see
	// "Follow the agent" below). Never used for visuals; the running affordance
	// keys off `runningId` for all runs alike.
	let agentRunningId = $state<string | null>(null);
	let keyMode = $state<KeyMode>('command'); // 'command' | 'edit' (visuals only; the dispatcher reads the DOM)
	// This notebook's DOM subtree. Scopes the modal-keyboard handler and cell
	// lookups (ids repeat across the open, still-mounted notebooks), and takes
	// focus when the tab activates - so it must be a real, focusable box.
	let rootEl = $state<HTMLElement | null>(null);

	// Canonical (absolute) notebook id, learned from the server on load. The shell
	// addresses this component by a workspace-relative `path` (fine for the REST
	// API, which resolves it server-side), but SSE events are tagged with the
	// server's absolute doc key — so we filter on this, the one id both sides
	// agree on. `null` until the first load resolves; events are ignored until then
	// (the load itself is the initial sync).
	let canonicalId: string | null = null;
	let lastSeq: number | null = null; // last per-notebook `seq` seen (gap detection → refetch)

	// ---- Staleness -----------------------------------------------------------
	// Per-cell staleness verdict (id → {state, reason, upstream}), computed on the
	// SERVER (it owns the dependency graph + the run epochs) and fetched here, so
	// the UI and the MCP agent surface render the exact same verdict. Refetched
	// (debounced) whenever something that could change it happens: a run ends, a
	// cell is edited, the notebook structure changes, or the kernel is reset.
	let staleness = $state<StalenessMap>({});
	let stalenessTimer: ReturnType<typeof setTimeout>;
	async function refreshStaleness() {
		try {
			const res = await fetch(`/api/notebooks/staleness?path=${encodeURIComponent(path)}`);
			if (!res.ok) return;
			const body = await res.json();
			staleness = body.cells ?? {};
		} catch {}
	}
	function scheduleStaleness() {
		clearTimeout(stalenessTimer);
		stalenessTimer = setTimeout(refreshStaleness, 250);
	}
	$effect(() => () => clearTimeout(stalenessTimer));

	// ---- Collapsible headings ------------------------------------------------
	// THE per-notebook fold state: the set of folded heading keys (see
	// `headings.js` - a key addresses one heading occurrence, since a markdown cell
	// can hold several headings and each folds its own section). The sidebar
	// Outline reads and writes this same set through `onFoldsChange` /
	// `onRegisterFolds`, so the outline's chevrons and the notebook's chevrons are
	// one control over one state and cannot diverge.
	//
	// Kept runtime-only (localStorage keyed by this notebook), never written to
	// the `.ipynb`, so folding a section produces zero git-diff noise. Folded
	// cells stay in `cells` (they run/persist normally); we only hide them from
	// the rendered flow.
	let foldedIds = $state<Set<string>>(new Set());
	const folding = $derived(computeFolding(cells, foldedIds));

	// Publish the fold state (and let the Outline toggle it) - see `+page.svelte`.
	$effect(() => {
		onFoldsChange?.(path, foldedIds, folding);
	});
	$effect(() => {
		onRegisterFolds?.(path, { toggle: toggleFold, collapseAll: () => setAllFolded(true), expandAll: () => setAllFolded(false) });
		return () => onRegisterFolds?.(path, null);
	});
	// Same shape as the fold registry: an imperative handle the shell hands to the
	// sidebar (Databricks preview) and the command palette. `dispatch` runs the very
	// action the modal keyboard runs for a registry shortcut id, so the palette and
	// the keyboard share one handler and cannot diverge.
	$effect(() => {
		onRegisterApi?.(path, { insertAndRunCode, dispatch: dispatchCommand, runAll, clearAll, runAbove, runBelow, runStale, exportPy, save });
		return () => onRegisterApi?.(path, null);
	});

	function foldStorageKey(): string | null {
		return canonicalId ? `cellar-folds:${canonicalId}` : null;
	}
	function loadFolds() {
		const key = foldStorageKey();
		if (!key) return;
		const saved = getUi(key, null);
		foldedIds = new Set(Array.isArray(saved) ? saved : []);
	}
	function saveFolds() {
		const key = foldStorageKey();
		if (!key) return;
		setUi(key, [...foldedIds]);
	}
	function toggleFold(key: string) {
		const next = new Set(foldedIds);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		foldedIds = next;
		saveFolds();
		// Command mode always acts on the selected cell, so the selection can never
		// be a cell the user cannot see: a fold that hides it hands it to the cell
		// holding the header that swallowed it. (`folding` is derived, so it already
		// reflects `next`.)
		if (activeId && folding.hidden.has(activeId)) activeId = cellIdOfKey(key);
	}

	// Collapse/expand every heading section in one go, writing the same shared fold
	// state the chevrons do (so the notebook and the Outline stay one view of one
	// state). Idempotent: `folded=true` yields the full set of heading keys, `false`
	// the empty set, regardless of the starting state.
	function setAllFolded(folded: boolean) {
		const next = folded ? new Set(outlineHeadings(cells).map((h) => h.key)) : new Set<string>();
		foldedIds = next;
		saveFolds();
		// A collapse-all can hide the selected cell; hand the selection to the
		// nearest header that still owns it (the same rule `toggleFold` applies).
		if (activeId && computeFolding(cells, next).hidden.has(activeId)) {
			const id = activeId;
			const owner = outlineHeadings(cells).find((h) =>
				computeFolding(cells, new Set([h.key])).hidden.has(id)
			);
			if (owner) activeId = owner.cellId;
		}
	}

	// ---- Collapsible code editors --------------------------------------------
	// Per-cell "collapse the code editor to a fixed scrollable height" choice.
	// Like the fold state above, kept runtime-only (localStorage keyed by this
	// notebook), never written to the `.ipynb` — a pure view preference with zero
	// git-diff (the deliberate contrast with `output_scrolled`, which does
	// round-trip to disk). A cell id maps to an explicit boolean (true = force
	// collapsed, false = force full height); an absent id means auto (the Cell
	// collapses it only when the editor is taller than the cap).
	let editorCollapsed = $state<Record<string, boolean | undefined>>({});

	function editorCollapsedKey(): string | null {
		return canonicalId ? `cellar-editor-collapsed:${canonicalId}` : null;
	}
	function loadEditorCollapsed() {
		const key = editorCollapsedKey();
		if (!key) return;
		const saved = getUi(key, null);
		editorCollapsed = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
	}
	function saveEditorCollapsed() {
		const key = editorCollapsedKey();
		if (!key) return;
		setUi(key, editorCollapsed);
	}
	function setEditorCollapsed(id: string, collapsed: boolean | null | undefined) {
		const next = { ...editorCollapsed };
		if (collapsed === null || collapsed === undefined) delete next[id];
		else next[id] = collapsed;
		editorCollapsed = next;
		saveEditorCollapsed();
	}

	// ---- Git cell decorations ------------------------------------------------
	// The notebook-level counterpart of the editor's gutter change bars: mark
	// which *cells* differ from the notebook's git-HEAD version. The server hands
	// out HEAD's cells once (normalized through the same `deserialize` the live
	// doc uses); the diff itself is a `$derived` over the live cells, so a cell
	// lights up the moment its edit lands and goes quiet again when it is undone.
	// An untracked notebook has no baseline → no decorations.
	let gitBaselineCells = $state.raw<CellView[] | null>(null);

	async function loadGitBaseline() {
		let baseline: CellView[] | null = null;
		try {
			const res = await fetch(`/api/fs/git/head?path=${encodeURIComponent(path)}&kind=notebook`);
			const body = await res.json();
			if (res.ok && body.tracked) baseline = body.cells;
		} catch {}
		gitBaselineCells = baseline;
	}

	// Re-baseline on mount and whenever the shell signals the workspace's git
	// state may have moved; `focus` covers a commit/checkout made outside Cellar.
	$effect(() => {
		gitRefresh;
		loadGitBaseline();
	});
	onMount(() => {
		const onFocus = () => loadGitBaseline();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	const gitChanges = $derived(gitBaselineCells ? notebookCellChanges(gitBaselineCells, cells) : NO_CELL_CHANGES);

	// ---- Follow the agent ----------------------------------------------------
	// When an agent runs a cell we bring that cell into view, so a human watching
	// can keep up with what is executing. Three rules keep it from being hostile:
	//
	//   1. Agent runs only. `run:start` already carries `actor`; a user's own run
	//      (this tab or another) never moves anyone's viewport.
	//   2. Follow-tail, not fight-the-user: we scroll only when the running cell
	//      isn't already on screen, and never while the user is typing in this
	//      notebook (a viewport jump mid-keystroke is the hostile case).
	//   3. Selection is untouched - `activeId` stays where the user left it. The
	//      running cell is marked by its own (warning-hued) accent in `Cell.svelte`.

	let followedId: string | null = null; // last agent-run cell we scrolled to (one scroll per run)
	let lastTypedAt = 0; // last keystroke inside this notebook (see `userIsTyping`)

	// Typing guard. Focus alone is too coarse - a cell keeps editor focus long
	// after the user stopped typing, and following would silently never happen.
	const TYPING_GRACE_MS = 3000;
	function userIsTyping() {
		if (Date.now() - lastTypedAt > TYPING_GRACE_MS) return false;
		const el = document.activeElement;
		return !!(el && rootEl?.contains(el));
	}

	$effect(() => {
		const el = rootEl;
		if (!el) return;
		const onType = () => (lastTypedAt = Date.now());
		el.addEventListener('keydown', onType, true);
		return () => el.removeEventListener('keydown', onType, true);
	});

	// The scrollable ancestor the notebook lives in (the shell gives each notebook
	// tab its own `overflow-y-auto` pane). Falls back to the viewport.
	function scrollParent(el: HTMLElement): HTMLElement | null {
		for (let p = el.parentElement; p; p = p.parentElement) {
			const oy = getComputedStyle(p).overflowY;
			if (oy === 'auto' || oy === 'scroll') return p;
		}
		return null;
	}

	// "Already visible" means the cell's TOP edge is on screen with room to spare:
	// the run affordance (accent bar, spinner) lives at the top, so a tall cell
	// scrolled past its header is not actually showing the user anything.
	function cellIsVisible(el: HTMLElement): boolean {
		const parent = scrollParent(el);
		const view = parent ? parent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
		const r = el.getBoundingClientRect();
		return r.top >= view.top - 4 && r.top <= view.bottom - Math.min(r.height, 96);
	}

	function reducedMotion(): boolean {
		return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	}

	// Snappy programmatic scroll. The browser's native `behavior: 'smooth'` is
	// noticeably laggy on this heavy app (long main-thread frames during a run),
	// so we drive a short ease-out tween on the container's `scrollTop` ourselves
	// (~140ms) via rAF. Honors prefers-reduced-motion by jumping instantly.
	const SCROLL_TWEEN_MS = 140;
	function tweenScrollTop(parent: HTMLElement, top: number) {
		const target = Math.max(0, Math.min(top, parent.scrollHeight - parent.clientHeight));
		const start = parent.scrollTop;
		const dist = target - start;
		if (reducedMotion() || Math.abs(dist) < 1) {
			parent.scrollTop = target;
			return;
		}
		const t0 = performance.now();
		const step = (now: number) => {
			const p = Math.min(1, (now - t0) / SCROLL_TWEEN_MS);
			const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
			parent.scrollTop = start + dist * eased;
			if (p < 1) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	// Bring a cell the *agent* is running into view: center it when it fits, else
	// pin its top. Distinct from `scrollCellIntoView` (keyboard selection), which
	// wants the smallest possible movement, not a deliberate reframing.
	function scrollElementIntoView(el: HTMLElement) {
		const parent = scrollParent(el);
		if (!parent) {
			el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
			return;
		}
		const view = parent.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const margin = 24;
		// Center a cell that fits; otherwise pin its top near the pane's top so the
		// header + first outputs are what the user sees (centering a tall cell would
		// push its top off screen).
		const delta =
			r.height + margin * 2 <= view.height
				? r.top - view.top - (view.height - r.height) / 2
				: r.top - view.top - margin;
		tweenScrollTop(parent, parent.scrollTop + delta);
	}

	// Unfold whatever collapsed sections hide `id`, so a cell the agent is running
	// is actually rendered (a `display:none` cell can neither be scrolled to nor
	// show its running accent). Fold state is runtime-only, so this costs the user
	// nothing but a re-fold. Removes exactly the folded headers whose own section
	// contains the cell - nested outer folds included, unrelated folds untouched.
	function revealCell(id: string) {
		if (!folding.hidden.has(id)) return;
		const next = new Set(foldedIds);
		for (const key of foldedIds) {
			if (computeFolding(cells, new Set([key])).hidden.has(id)) next.delete(key);
		}
		foldedIds = next;
		saveFolds();
	}

	async function followCell(id: string) {
		if (userIsTyping()) return;
		// Adding/updating an import re-runs the imports cell; following it would
		// reframe the viewport to it (wherever it sits) and back once the agent's
		// real cell runs - jarring. Leave the user's scroll put. Position-independent:
		// keyed on the role, not the top, so it holds now the cell can live anywhere.
		if (isImportsCell(findCell(id))) return;
		revealCell(id);
		await tick(); // an `add_and_run` cell (or a just-revealed one) needs its DOM node
		// Scope the lookup to THIS notebook: cell ids are unique per document, not
		// across documents, and every open notebook stays mounted (hidden).
		const el = rootEl?.querySelector(`[data-cell-id="${CSS.escape(id)}"]`) as HTMLElement | null;
		if (!el || cellIsVisible(el)) return;
		scrollElementIntoView(el);
	}

	// Follow on agent `run:start`, and also when the user switches to this tab
	// while an agent run is already in flight (a hidden pane has no geometry to
	// scroll). One scroll per run: `followedId` clears when the run ends.
	$effect(() => {
		const id = agentRunningId;
		const visible = active;
		if (!id) {
			followedId = null;
			return;
		}
		if (!visible || id === followedId) return;
		followedId = id;
		// `untrack`: followCell reads (and revealCell writes) fold state - tracking
		// those would re-run this effect on every cell edit, and turn the unfold
		// into a write-what-you-read loop.
		untrack(() => followCell(id));
	});

	function setActive(id: string | null) {
		activeId = id;
	}

	// Each Cell registers its imperative API (by id) so the shortcut actions can
	// focus/blur its editor, enter edit mode, and run its *live* editor text.
	const cellApis: Record<string, CellRegisterApi> = {};
	function registerCell(id: string, api: CellRegisterApi | null) {
		if (api) cellApis[id] = api;
		else delete cellApis[id];
	}
	function findCell(id: string | null | undefined): UICell | undefined {
		return cells.find((c) => c.id === id);
	}
	/** The per-cell API for `id`, or undefined (safe for a null/absent selection). */
	function apiOf(id: string | null | undefined): CellRegisterApi | undefined {
		return id ? cellApis[id] : undefined;
	}

	// The editor holding focus IS edit mode; losing it drops back to command mode.
	function onEditorFocus(id: string) {
		activeId = id;
		keyMode = 'edit';
	}
	function onEditorBlur(id: string) {
		if (activeId === id) keyMode = 'command';
	}

	// Report the live cells array (a reactive proxy) upward so the shell's
	// sidebar (outline / search / variables) reflects this notebook when active.
	// Re-runs when the array reference changes (add/delete/reorder); in-place
	// source/output edits propagate through the shared proxy without re-reporting.
	$effect(() => {
		onCellsChange?.(path, cells);
	});

	async function load() {
		fetching = true;
		try {
			const res = await fetch(`/api/notebooks?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'could not open notebook');
			cells = body.notebook.cells;
			canonicalId = body.notebook.path; // the absolute id SSE events are tagged with
			exportTarget = body.notebook.exportTarget ?? null; // nbdev export target
			// A notebook always has a selected cell (command mode acts on it), so
			// j/k and the rest work the moment the notebook opens.
			if (!activeId || !cells.some((c) => c.id === activeId)) activeId = cells[0]?.id ?? null;
			loadFolds(); // restore this notebook's collapsed sections (runtime-only, per notebook)
			loadEditorCollapsed(); // restore this notebook's collapsed code editors (runtime-only)
			// This refetch is the correctness backstop (reconnect / seq gap): the
			// freshly loaded cells carry authoritative outputs, so drop any stale live
			// run state. Otherwise a lost run:end (tab disconnected while an agent run
			// finished server-side) would leave the spinner stuck and, via runCell's
			// `runningId === id` double-submit guard, permanently refuse to re-run it.
			runningId = null;
			agentRunningId = null;
			lastSeq = null; // reconnect refetches once here; don't also trip the seq-gap check
			// `queued` is NOT reset: the queue lives on the server and outlives this
			// refetch. Apply any snapshot that arrived before we knew our absolute id.
			if (pendingQueueEvent) {
				const ev = pendingQueueEvent;
				pendingQueueEvent = null;
				applyQueueEvent(ev);
			}
			refreshStaleness();
		} catch (err) {
			loadError = String((err as Error)?.message ?? err);
		} finally {
			fetching = false;
		}
	}
	// Load the authoritative cells from the server on mount. The server holds the
	// live doc across tab close/reopen, so a remounted tab reflects in-session
	// edits (rather than a stale snapshot), and cells are only created once the
	// real source is known — so each Cell's editor seeds with correct content.
	onMount(load);

	// Live server→client sync. Subscribe to the shared per-tab event stream and
	// apply run-lifecycle events that target THIS notebook, so an agent-driven run
	// (or a run from another tab) shows the running indicator + streaming outputs
	// with no reload. Our own UI runs are skipped here (we render them from the
	// `/run` NDJSON response) via the per-tab `originId`, so they never double-apply.
	// Apply a structural document event (agent-driven, or from another tab) as a
	// live patch to `cells`. Insert/remove/reorder/retype in place — cheap and
	// reload-free; the seq-gap backstop refetches if we ever miss one. Each patch
	// is idempotent enough to tolerate an out-of-order or duplicate delivery.
	function applyStructuralEvent(ev: StructuralEvent) {
		if (ev.type === 'cell:added') {
			if (!ev.cell || findCell(ev.cell.id)) return; // already present → no double-insert
			const view: UICell = {
				id: ev.cell.id,
				cell_type: ev.cell.cell_type,
				source: ev.cell.source,
				outputs: ev.cell.outputs ?? [],
				metadata: ev.cell.metadata ?? {}
			};
			// `index` is authoritative when present (an insert at the very top - the
			// imports cell - has no `afterId` to hang off, and appending would be wrong).
			const i = ev.afterId ? cells.findIndex((c) => c.id === ev.afterId) : -1;
			if (typeof ev.index === 'number') {
				const at = Math.max(0, Math.min(ev.index, cells.length));
				cells = [...cells.slice(0, at), view, ...cells.slice(at)];
			} else if (i >= 0) cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
			else cells = [...cells, view];
		} else if (ev.type === 'cell:role') {
			// A cell was designated (or un-designated) the notebook's imports cell.
			// Reassign `metadata` rather than mutating it: the cell may have had no
			// `cellar` namespace at all, and a deep write would not be seen.
			const cell = findCell(ev.cellId);
			if (cell) {
				const cellar = { ...(cell.metadata?.cellar ?? {}) };
				if (ev.role) cellar.role = ev.role;
				else delete cellar.role;
				cell.metadata = { ...(cell.metadata ?? {}), cellar };
			}
		} else if (ev.type === 'cell:export') {
			// A cell was marked (or unmarked) for nbdev-style export. Reassign metadata
			// for reactivity (the cell may have had no `cellar` namespace).
			const cell = findCell(ev.cellId);
			if (cell) {
				const cellar = { ...(cell.metadata?.cellar ?? {}) };
				if (ev.exported) cellar.export = true;
				else delete cellar.export;
				cell.metadata = { ...(cell.metadata ?? {}), cellar };
			}
		} else if (ev.type === 'notebook:export-target') {
			exportTarget = ev.target;
		} else if (ev.type === 'cell:deleted') {
			const i = cells.findIndex((c) => c.id === ev.cellId);
			cells = cells.filter((c) => c.id !== ev.cellId);
			if (runningId === ev.cellId) runningId = null;
			if (agentRunningId === ev.cellId) agentRunningId = null;
			if (activeId === ev.cellId) activeId = null;
		} else if (ev.type === 'cell:moved') {
			const from = cells.findIndex((c) => c.id === ev.cellId);
			if (from < 0) return;
			const next = [...cells];
			const [cell] = next.splice(from, 1);
			const to = Math.max(0, Math.min(ev.toIndex, next.length));
			next.splice(to, 0, cell);
			cells = next;
		} else if (ev.type === 'cell:type') {
			const cell = findCell(ev.cellId);
			if (cell) {
				cell.cell_type = ev.cell_type;
				if (ev.cell_type === 'markdown') cell.outputs = [];
				// The event carries the new language (sql | null) so a remote code↔sql
				// switch re-highlights the editor live. Reassign metadata for reactivity.
				const cellar = { ...(cell.metadata?.cellar ?? {}) };
				if (ev.language === 'sql') cellar.language = 'sql';
				else delete cellar.language;
				cell.metadata = { ...(cell.metadata ?? {}), cellar };
			}
		} else if (ev.type === 'cell:cleared') {
			const cell = findCell(ev.cellId);
			if (cell) cell.outputs = [];
		} else if (ev.type === 'cell:rendered') {
			// A markdown cell was "run" (agent run_cell / add_and_run). Markdown doesn't
			// execute on the kernel; running it renders it, so flip the cell to its
			// rendered view. View-only (no doc mutation, no staleness recompute).
			cellApis[ev.cellId]?.showRendered?.();
			return;
		} else if (ev.type === 'cell:edited') {
			// Don't blindly overwrite the editor: hand the new source to the Cell,
			// which applies it only when the user isn't actively editing that cell
			// (else it surfaces a "changed on server" affordance). A fresh object
			// each time so the Cell's effect fires even on a same-source re-edit.
			const cell = findCell(ev.cellId);
			if (cell) cell.remoteEdit = { source: ev.source };
		}
		// Any structural change (add/edit/type/delete/move/clear) can shift the
		// dependency graph or the run/edit stamps — recompute staleness.
		scheduleStaleness();
	}

	// The kernel's queue, rebroadcast in full on every change (and replayed to us
	// on subscribe / SSE connect). Keep only this notebook's entries, but preserve
	// their GLOBAL position so the badge tells the truth about how many runs are
	// ahead. A snapshot that lands before `load()` has told us our absolute id is
	// held, not dropped: it may be the only one until the queue next changes.
	let pendingQueueEvent: QueueChangedEvent | null = null;
	function applyQueueEvent(ev: QueueChangedEvent) {
		if (!canonicalId) {
			pendingQueueEvent = ev;
			return;
		}
		const next: Record<string, number> = {};
		for (const item of ev.queue ?? []) {
			if (item.nb === canonicalId) next[item.cellId] = item.position;
		}
		queued = next;

		// The snapshot also names the cell holding the kernel, which is how a tab that
		// connects mid-run learns what is executing — `run:start` fired before it was
		// listening. Without this, such a tab renders cells "queued · 1" behind a cell
		// it shows as idle. `run:start` still owns `agentRunningId`: adopting a
		// running cell must not scroll a tab that never saw the agent start it.
		const running = ev.running?.nb === canonicalId ? ev.running.cellId : null;
		if (running) {
			if (findCell(running)) runningId = running;
		} else if (runningId) {
			// The kernel is idle, or busy with another notebook: nothing of ours runs.
			runningId = null;
		}
	}

	function applyRunEvent(ev: RunEvent) {
		const cell = ev.cellId ? findCell(ev.cellId) : undefined;
		if (ev.type === 'run:start') {
			if (cell) {
				runningId = ev.cellId ?? null;
				// Only an agent's run earns the viewport; a user run in another tab
				// must not scroll this one.
				if (ev.actor === 'agent') agentRunningId = ev.cellId ?? null;
				// Clear stale output the moment execution starts (the server fires
				// run:start when the kernel is actually claimed, after any queue wait),
				// so a re-run reads as "running, no output yet" until fresh output
				// streams in — not the prior run's result lingering under a spinner.
				cell.outputs = [];
			}
		} else if (ev.type === 'run:output') {
			if (cell) cell.outputs = [...(cell.outputs ?? []), ev.output];
		} else if (ev.type === 'run:end') {
			stampLastRun(cell, ev); // update the run-metadata badge (agent / other-tab runs)
			if (runningId === ev.cellId) runningId = null;
			if (agentRunningId === ev.cellId) agentRunningId = null;
			scheduleStaleness(); // a finished run clears/creates staleness downstream
		}
	}

	// Store runtime-only run metadata on a cell so `Cell.svelte` renders its badge.
	// Reassigns `metadata` (not a deep mutation) to trigger reactivity even when
	// the cell had no `cellar` namespace yet. Ignores events without `at` (older
	// run:end shapes / non-run events).
	function stampLastRun(cell: UICell | undefined, ev: { at?: number; durationMs?: number; actor?: Actor }) {
		if (!cell || ev.at == null) return;
		const cellar: CellarNamespace = {
			...(cell.metadata?.cellar ?? {}),
			lastRun: { at: ev.at, durationMs: ev.durationMs, actor: ev.actor } as LastRun
		};
		cell.metadata = { ...(cell.metadata ?? {}), cellar };
	}
	onMount(() =>
		subscribeEvents((ev: ClientEvent) => {
			// (Re)connect → refetch as the correctness backstop (covers events missed
			// while disconnected). `canonicalId` gates until the first load resolves.
			if (ev.type === 'sse:open') {
				if (canonicalId) load();
				return;
			}
			if (ev.type === 'hello') return;
			// The run queue spans every notebook (one kernel), so its events carry no
			// `nb` and no `seq`: each is a full snapshot. Dispatch before the
			// per-notebook filter, and without the `originId` echo suppression below —
			// the queue is shared state, not one tab's action, so every tab renders it.
			if (ev.type === 'queue:changed') {
				applyQueueEvent(ev as unknown as QueueChangedEvent);
				return;
			}
			// Past this point every event is a per-notebook `PublishedEvent`.
			const pe = ev as PublishedEvent;
			if (!canonicalId || pe.nb !== canonicalId) return;
			// A gap in this notebook's monotonic seq means we missed events → refetch.
			if (lastSeq !== null && pe.seq > lastSeq + 1) load();
			lastSeq = pe.seq; // advance even for our own echo, so it isn't seen as a gap
			// A checkpoint restore replaces the whole document; every tab (the initiating
			// one included, since it applies no optimistic local change) refetches.
			if (pe.type === 'notebook:restored') {
				load();
				return;
			}
			if (pe.originId && pe.originId === originId) return; // our own UI action
			if (pe.type?.startsWith('cell:') || pe.type === 'notebook:export-target')
				applyStructuralEvent(pe as unknown as StructuralEvent);
			else applyRunEvent(pe as unknown as RunEvent);
		})
	);

	// When this notebook is focused, make it the active notebook the agent-facing
	// (MCP) tools default to, and own the modal keyboard.
	$effect(() => {
		if (!active) return;
		fetch('/api/notebooks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path })
		}).catch(() => {});
		window.addEventListener('keydown', onKeydown, true);
		return () => {
			window.removeEventListener('keydown', onKeydown, true);
			clearPending(); // a half-typed `d` must not survive into the next tab
		};
	});

	// Command-mode keys only fire for keystrokes aimed at this notebook, so a
	// freshly activated notebook tab must take the keyboard: otherwise focus is
	// still on whatever opened it (a file-tree button) and `j`/`k` do nothing
	// until the user clicks a cell. Never steals focus from an editor in use.
	$effect(() => {
		if (!active || fetching || !rootEl) return;
		if (!rootEl.contains(document.activeElement)) rootEl.focus({ preventScroll: true });
	});

	/**
	 * Request a run. The single shared kernel runs one cell at a time app-wide,
	 * but the serialization lives on the SERVER (`run-queue.js`): a run requested
	 * while the kernel is busy waits its turn in a kernel-global FIFO instead of
	 * being dropped, and the `/run` response stream simply stays open across the
	 * wait. So this function no longer gates on a busy flag — it POSTs, and the
	 * server decides when the cell actually executes.
	 *
	 * The only local guard left is against enqueueing the same cell twice from the
	 * same click; the server dedupes authoritatively (`run:duplicate`), because a
	 * second tab or an agent can ask for the same cell at the same moment.
	 */
	async function runCell(id: string, source: string) {
		const cell = findCell(id);
		if (!cell) return;
		// Markdown "runs" by rendering client-side (in the Cell) — no kernel.
		if (cell.cell_type === 'markdown') {
			await editCell(id, source);
			return;
		}
		if (runningId === id || queued[id] != null) return;
		onRunStart?.(path, id);
		cell.source = source;
		// The run's own lifecycle, learned from the server: `started` flips on the
		// `run:start` frame. Everything that mutates this cell's outputs is gated on
		// it, so a request the server refused (duplicate) or dropped (a restart
		// cancelled the queued run) never touches what is on screen.
		let started = false;
		try {
			const res = await fetch(`/api/cells/${id}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source, nb: path, originId })
			});
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl;
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					const ev = JSON.parse(line);
					if (ev.type === 'run:start') {
						// The kernel is ours now (immediately, or after a wait in the queue).
						// Clear stale output at execution start so the cell reads as
						// "running, no output yet" until fresh output streams in.
						started = true;
						runningId = id;
						cell.outputs = [];
					} else if (ev.type === 'output') {
						cell.outputs = [...(cell.outputs ?? []), ev.output];
					} else if (ev.type === 'run:end') {
						stampLastRun(cell, ev); // this tab's own user run → its badge
					}
					// `run:duplicate` / `run:cancelled` close the stream without a run:start:
					// the cell keeps its outputs untouched (we only clear on run:start) and
					// the queue badge (if any) is cleared by the `queue:changed` broadcast.
				}
			}
		} catch (err) {
			// The request itself failed (the server is gone). That IS this cell's result.
			cell.outputs = [{ output_type: 'error', ename: 'CellarError', evalue: String(err), traceback: [String(err)] }];
		} finally {
			// Only a run WE actually started may clear the spinner: a request the server
			// answered `run:duplicate` was refused precisely because that cell is running
			// (here or in another tab), and clearing then would erase a live indicator.
			// The `=== id` test additionally keeps an overlapping run's spinner alone.
			if (started && runningId === id) runningId = null;
			onRunEnd?.();
			scheduleStaleness(); // this cell (and its dependents) may have changed staleness
		}
	}

	// ---- Bulk run actions (Run above / below / stale) ------------------------
	// Run a set of code cells one at a time, in the given (document) order. `runCell`
	// awaits the whole run before returning, so awaiting it in sequence keeps the
	// execution order — which is dependency order for these actions (a cell's
	// upstreams always precede it), so downstream cells run against fresh inputs.
	async function runCodeIds(ids: string[]) {
		for (const id of ids) {
			const cell = findCell(id);
			if (!cell || cell.cell_type !== 'code') continue;
			// Use the editor's LIVE text, not the debounced `cell.source`.
			const src = cellApis[id]?.currentSource?.() ?? cell.source;
			await runCell(id, src);
		}
		refreshStaleness();
	}
	function codeIdsInRange(from: number, to: number): string[] {
		return cells.slice(from, to).filter((c) => c.cell_type === 'code').map((c) => c.id);
	}
	/** Run every code cell above the selected one (exclusive). */
	function runAbove() {
		const i = cells.findIndex((c) => c.id === activeId);
		if (i < 0) return;
		runCodeIds(codeIdsInRange(0, i));
	}
	/** Run the selected cell and every code cell below it (Jupyter's "run all below"). */
	function runBelow() {
		const i = cells.findIndex((c) => c.id === activeId);
		if (i < 0) return;
		runCodeIds(codeIdsInRange(i, cells.length));
	}
	/** Run every STALE code cell, in document (dependency) order — clears staleness. */
	function runStale() {
		runCodeIds(cells.filter((c) => staleness[c.id]?.state === 'stale').map((c) => c.id));
	}

	/**
	 * Save the notebook now (Cmd/Ctrl+S). Edits already autosave on a debounce, so
	 * the job here is to flush every cell's pending edit immediately and let the
	 * normal PATCH persistence write it — no separate save endpoint. Awaits all
	 * flushed PATCHes so the caller's "Saved" confirmation means persisted. A cell
	 * with nothing dirty flushes to a resolved no-op.
	 */
	async function save() {
		await Promise.all(Object.values(cellApis).map((a) => a.flush?.() ?? Promise.resolve()));
	}

	async function editCell(id: string, source: string, { keepalive = false }: { keepalive?: boolean } = {}) {
		const cell = findCell(id);
		if (cell) cell.source = source;
		// Only the page-unload flush opts into `keepalive`: the browser caps the
		// combined keepalive body at ~64KB and rejects past it, so normal
		// (page-alive) autosaves stay plain fetch. `.catch` keeps a rejected PATCH
		// from surfacing as an unhandled rejection either way.
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source, nb: path, originId }),
			keepalive
		}).catch(() => {});
		// The edit stamped `editedAt` server-side, so this cell (and everything that
		// uses its names) may now be stale — recompute from the server's view.
		scheduleStaleness();
	}

	async function clearCell(id: string) {
		const cell = findCell(id);
		if (cell) cell.outputs = [];
		await fetch(`/api/cells/${id}/clear?nb=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}`, { method: 'POST' });
		scheduleStaleness();
	}

	async function setType(id: string, cellType: LogicalCellType) {
		const cell = findCell(id);
		if (cell) {
			// 'sql' is a code cell tagged cellar.language='sql' ($lib/cellLanguage.js);
			// 'code' clears that tag. Reassign metadata (the cell may have had no cellar
			// namespace) so the SQL/Python grammar switch in Cell.svelte reacts.
			cell.cell_type = cellType === 'markdown' ? 'markdown' : 'code';
			const cellar = { ...(cell.metadata?.cellar ?? {}) };
			if (cellType === 'sql') cellar.language = 'sql';
			else delete cellar.language;
			cell.metadata = { ...(cell.metadata ?? {}), cellar };
			if (cell.cell_type === 'markdown') cell.outputs = [];
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cell_type: cellType, nb: path, originId })
		});
		scheduleStaleness();
	}

	/**
	 * Designate `id` the notebook's imports cell, or un-designate it (`role: null`).
	 * Exactly one imports cell per notebook, so marking a new one strips the role
	 * from any other — applied optimistically here and enforced server-side by
	 * `setCellRole`. Reassign each affected cell's `metadata` (it may have had no
	 * `cellar` namespace) so the imports badge/menu react.
	 */
	async function setRole(id: string, role: string | null) {
		for (const c of cells) {
			const has = c.metadata?.cellar?.role != null;
			const target = c.id === id;
			if (!target && !has) continue; // untouched
			const cellar = { ...(c.metadata?.cellar ?? {}) };
			if (target && role) cellar.role = role;
			else delete cellar.role;
			c.metadata = { ...(c.metadata ?? {}), cellar };
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ role, nb: path, originId })
		}).catch(() => {});
	}

	/**
	 * Mark (or unmark) a code cell for nbdev-style export to the `.py` module.
	 * Applied optimistically here (reassign metadata so the badge/menu react) and
	 * persisted server-side, which also regenerates the module on save.
	 */
	async function setExport(id: string, exported: boolean) {
		const cell = findCell(id);
		if (cell) {
			const cellar = { ...(cell.metadata?.cellar ?? {}) };
			if (exported) cellar.export = true;
			else delete cellar.export;
			cell.metadata = { ...(cell.metadata ?? {}), cellar };
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ export: exported, nb: path, originId })
		}).catch(() => {});
	}

	/** Set (or clear) the notebook's `.py` export target. Optimistic + persisted. */
	async function setExportTargetValue(target: string) {
		exportTarget = target.trim() || null;
		await fetch('/api/notebooks/export-py', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'set-target', target, path, originId })
		}).catch(() => {});
	}

	/** Regenerate the `.py` module now (manual trigger). Returns the server result. */
	async function exportPy() {
		try {
			const res = await fetch('/api/notebooks/export-py', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'export', path })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'export failed');
			return body as { written: boolean; target: string | null; count: number; reason?: 'no-target' | 'no-cells' | 'unchanged' };
		} catch {
			return null;
		}
	}

	// ---- Cut / copy / paste / undo-delete ------------------------------------
	// The clipboard is shared across notebooks (`cellClipboard`); the undo stack is
	// per-notebook and local: it records the cells THIS user deleted here, so `z`
	// can never resurrect a cell an agent (or another tab) deliberately removed.
	const UNDO_LIMIT = 20;
	let deletedCells: (ClipboardCell & { index: number })[] = [];

	/** A cell as the clipboard and the undo stack store it: live source, no outputs. */
	function snapshotCell(cell: UICell): ClipboardCell {
		return {
			cell_type: cell.cell_type,
			source: cellApis[cell.id]?.currentSource?.() ?? cell.source,
			output_scrolled: cell.metadata?.cellar?.output_scrolled
		};
	}

	/**
	 * Insert a cell carrying `spec`'s type + source at `index`, and return it.
	 * The caller selects it: paste selects the last pasted cell, undo the restored
	 * one.
	 */
	async function insertCellAt(index: number, spec: ClipboardCell): Promise<UICell> {
		const at = Math.max(0, Math.min(index, cells.length));
		const afterId = at > 0 ? cells[at - 1]?.id : null;
		// The add API can only insert *after* an id, so an insert at the very top
		// appends and then hoists (one extra persist, identical clean-on-save result).
		const created = await addCell(afterId ?? cells.at(-1)?.id, spec.cell_type, spec.source);
		if (!afterId && cells.length > 1) await moveCellToIndex(created.id, 0);
		if (spec.output_scrolled !== undefined) await setScrolled(created.id, spec.output_scrolled);
		return created;
	}

	/**
	 * Append a code cell carrying `source` and run it. The entry point for the
	 * sidebar's Databricks table preview: point-and-click, but what lands in the
	 * notebook is an ordinary cell holding ordinary code the user can edit, re-run,
	 * and commit.
	 *
	 * Deliberately does NOT touch `activeId`. Selection and DOM focus must move
	 * together (the keyboard dispatcher reads a keystroke's mode off the focused
	 * element), and the user's focus is in the sidebar right now - selecting the new
	 * cell without focusing it would leave the next `j`/`k` acting on a cell the
	 * caret is nowhere near. So we scroll it into view and leave the selection be.
	 */
	async function insertAndRunCode(source: string) {
		const created = await insertCellAt(cells.length, { cell_type: 'code', source });
		await tick();
		scrollCellIntoView(created.id);
		await runCell(created.id, source);
		return created.id;
	}

	function copyActive() {
		const cell = findCell(activeId);
		if (cell) cellClipboard.copy([snapshotCell(cell)]);
	}

	function cutActive() {
		const cell = findCell(activeId);
		// A lone cell can't be deleted (below), so it can't be cut either: half a cut
		// - copied but still there - would be worse than doing nothing.
		if (!cell || cells.length <= 1) return;
		cellClipboard.copy([snapshotCell(cell)]);
		deleteCell(cell.id);
	}

	async function pasteCells(where: 'above' | 'below') {
		const entries = cellClipboard.read();
		if (!entries.length) return;
		const i = cells.findIndex((c) => c.id === activeId);
		// No selection (an empty notebook) → paste at the end.
		let index = i < 0 ? cells.length : where === 'above' ? i : i + 1;
		let last: UICell | null = null;
		for (const entry of entries) {
			last = await insertCellAt(index, entry);
			index++;
		}
		if (last) await selectAndFocus(last.id);
	}

	async function undoDelete() {
		const record = deletedCells.pop();
		if (!record) return;
		const restored = await insertCellAt(record.index, record);
		await selectAndFocus(restored.id);
	}

	async function deleteCell(id: string) {
		const i = cells.findIndex((c) => c.id === id);
		const cell = cells[i];
		// A notebook always keeps at least one cell - the same invariant the toolbar's
		// delete button enforces by disabling itself at one cell - so there is always
		// somewhere to type. `dd` and cut honor it rather than quietly diverging.
		if (!cell || cells.length <= 1) return;
		deletedCells.push({ index: i, ...snapshotCell(cell) });
		if (deletedCells.length > UNDO_LIMIT) deletedCells.shift();
		cells = cells.filter((c) => c.id !== id);
		// Keep a cell selected: command mode acts on the selection, so deleting the
		// selected cell must hand the selection to its neighbor, not drop it. Focus
		// follows, because the delete button that had it is gone with the cell.
		if (activeId === id) selectAfterRemoval(i, { focus: true });
		await fetch(`/api/cells/${id}?nb=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}`, { method: 'DELETE' });
		scheduleStaleness();
	}

	/**
	 * After removing the cell at `index`, select whatever slid into its place.
	 * Only a local delete takes focus with it: an agent (or other-tab) delete must
	 * not yank the caret out of a cell this user is typing in.
	 */
	function selectAfterRemoval(index: number, { focus = false }: { focus?: boolean } = {}) {
		const id = cells[Math.min(Math.max(index, 0), cells.length - 1)]?.id ?? null;
		activeId = id;
		if (focus && id) selectAndFocus(id);
	}

	// The optimistic half of the imports cell's pin: the server applies the very
	// same `clampMoveIndex`, so a refused move is refused here too rather than
	// being rendered and then silently reverted by the next refetch.
	async function moveCell(id: string, dir: 'up' | 'down') {
		const i = cells.findIndex((c) => c.id === id);
		const j = dir === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= cells.length) return;
		if (clampMoveIndex(cells, i, j) !== j) return;
		const next = [...cells];
		[next[i], next[j]] = [next[j], next[i]];
		cells = next;
		await fetch(`/api/cells/${id}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ dir, nb: path, originId })
		});
		scheduleStaleness(); // reordering changes the preceding-definer graph
	}

	// Drag-to-reorder: move a cell to an absolute index. Reuses the server's
	// `moveCellTo` (via the move route's `toIndex`) so a drag persists exactly
	// like a keyboard/toolbar move and stays git-clean on save.
	async function moveCellToIndex(id: string, toIndex: number) {
		const from = cells.findIndex((c) => c.id === id);
		if (from < 0) return;
		const allowed = clampMoveIndex(cells, from, toIndex);
		if (allowed < 0) return; // the pinned imports cell never moves
		const to = Math.max(0, Math.min(allowed, cells.length - 1));
		if (to === from) return;
		const next = [...cells];
		const [cell] = next.splice(from, 1);
		next.splice(to, 0, cell);
		cells = next;
		await fetch(`/api/cells/${id}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ toIndex: cells.findIndex((c) => c.id === id), nb: path, originId })
		});
		scheduleStaleness(); // reordering changes the preceding-definer graph
	}

	// Persist a cell's "scroll outputs" choice (undefined = auto height, true =
	// force scrolled, false = force full) in the `cellar` metadata namespace.
	async function setScrolled(id: string, scrolled: boolean | null | undefined) {
		const cell = findCell(id);
		if (cell) {
			cell.metadata = cell.metadata ?? {};
			cell.metadata.cellar = cell.metadata.cellar ?? {};
			if (scrolled === null || scrolled === undefined) delete cell.metadata.cellar.output_scrolled;
			else cell.metadata.cellar.output_scrolled = scrolled;
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scrolled: scrolled ?? null, nb: path })
		});
	}

	// `source` seeds the new cell server-side, so a paste / split / undo-delete is
	// one request, one persist and one `cell:added` event carrying the real text.
	async function addCell(afterId: string | null | undefined, cellType: CellType = 'code', source = ''): Promise<UICell> {
		const res = await fetch('/api/cells', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ afterId, cellType, source, nb: path, originId })
		});
		const { cell } = await res.json();
		const view: UICell = { id: cell.id, cell_type: cell.cell_type, source: cell.source, outputs: cell.outputs, metadata: cell.metadata ?? {} };
		if (afterId) {
			const i = cells.findIndex((c) => c.id === afterId);
			cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
		} else {
			cells = [...cells, view];
		}
		scheduleStaleness();
		return view;
	}

	// Shift+Enter: run in place, then advance, identically for code and markdown
	// (a markdown cell "runs" by rendering, and `Cell.doRun` has already switched it
	// to its rendered view by the time we get here). From edit mode we focus the
	// next cell's editor (keep typing); from command mode we move the selection and
	// its focus. Either way focus lands on the next cell, never back in the cell
	// that just ran. Creates a fresh cell when run on the last one.
	async function runAndAdvance(id: string, source: string, { focusNext = true }: { focusNext?: boolean } = {}) {
		runCell(id, source); // fire; advancing shouldn't wait for completion
		const i = cells.findIndex((c) => c.id === id);
		let nextId: string | null = i >= 0 && i < cells.length - 1 ? cells[i + 1].id : null;
		if (!nextId) {
			const created = await addCell(id);
			nextId = created.id;
		}
		if (!focusNext) {
			await selectAndFocus(nextId);
			return;
		}
		setActive(nextId);
		await tick();
		// `focus()` lands on the next cell's editor, or on the cell itself when that
		// cell is rendered markdown (whose editor is display:none and unfocusable).
		apiOf(nextId)?.focus();
		scrollCellIntoView(nextId);
	}

	// ---- Modal keyboard ------------------------------------------------------
	// Every notebook shortcut lives in the registry (`shortcuts.svelte.js`) and is
	// dispatched here, in one capture-phase handler, so it wins over CodeMirror's
	// own keymap and the browser default. Registered only while this notebook is
	// the active tab. The action map below is the other half of the registry: an
	// entry with no action is inert, and an action with no entry is unreachable.

	// Cells the user can actually select: the ones a folded heading isn't hiding.
	const selectable = $derived(cells.filter((c) => !folding.hidden.has(c.id)));

	function scrollCellIntoView(id: string | null) {
		if (!id) return;
		// Scope to this notebook: several notebooks stay mounted (hidden), and a
		// cell id is only unique *within* a document.
		const el = rootEl?.querySelector(`[data-cell-id="${CSS.escape(id)}"]`);
		// Instant for keyboard selection: the smallest movement to reveal the cell,
		// with no animation lag, is what makes arrow-key nav feel immediate. (The
		// deliberate run-reframe uses the tween in `scrollElementIntoView`.)
		el?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
	}

	/**
	 * Select `id` and give it DOM focus (command mode). The dispatcher decides both
	 * a keystroke's mode and its target from the focused element, so a selection the
	 * focus doesn't follow is a selection the next keystroke doesn't act on: the
	 * next key would instead reach whatever button or rendered cell the user last
	 * clicked. Awaits `tick()` so a just-created cell has registered its API.
	 */
	async function selectAndFocus(id: string | null) {
		if (!id) return;
		setActive(id);
		await tick();
		cellApis[id]?.focusCell();
		scrollCellIntoView(id);
	}

	function selectRelative(delta: number) {
		const list = selectable;
		if (!list.length) return;
		const i = list.findIndex((c) => c.id === activeId);
		const next = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta))];
		selectAndFocus(next.id);
	}

	// Fold/unfold act on the selected cell only when it is a markdown header, and
	// reuse the same `toggleFold` the chevron button calls (one fold API).
	function setFolded(id: string | null, folded: boolean) {
		if (!id || headerLevel(findCell(id)) == null) return;
		if (foldedIds.has(id) !== folded) toggleFold(id);
	}

	async function insertCell(where: 'above' | 'below') {
		const i = cells.findIndex((c) => c.id === activeId);
		if (where === 'below' || i < 0) {
			const created = await addCell(activeId ?? cells.at(-1)?.id);
			await selectAndFocus(created.id);
			return;
		}
		if (i > 0) {
			const created = await addCell(cells[i - 1].id);
			await selectAndFocus(created.id);
			return;
		}
		// Above the first cell: the API can only insert *after* an id, so append
		// and move it to the top (one extra persist, same clean-on-save result).
		const created = await addCell(cells.at(-1)?.id);
		await moveCellToIndex(created.id, 0);
		await selectAndFocus(created.id);
	}

	// Reordering moves the cell's DOM node and drops focus; restore it onto the
	// editor (edit mode) or onto the cell (command mode), so moves chain.
	async function moveActive(dir: 'up' | 'down', mode: KeyMode) {
		const id = activeId;
		if (!id) return;
		moveCell(id, dir);
		await tick();
		if (mode === 'edit') apiOf(id)?.focus();
		else await selectAndFocus(id);
	}

	// Alt+Enter: run in place, then insert a fresh cell below and start typing in
	// it (Jupyter lands in edit mode there, whichever mode the run came from).
	async function runAndInsertBelow() {
		const id = activeId;
		if (!id) return;
		apiOf(id)?.run(false); // fire; the insert shouldn't wait for the kernel
		const created = await addCell(id);
		setActive(created.id);
		await tick();
		cellApis[created.id]?.enterEdit();
		scrollCellIntoView(created.id);
	}

	// Ctrl+Shift+-: split the focused cell at the cursor. The text above the cursor
	// stays, the text below moves into a new cell of the same type, and (Jupyter)
	// the lower cell becomes the selected one, still in edit mode.
	async function splitActiveCell() {
		const id = activeId;
		const cell = findCell(id);
		const api = apiOf(id);
		if (!cell || !api || !id) return;
		const source = api.currentSource();
		const at = api.cursorOffset();
		api.replaceSource(source.slice(0, at));
		await editCell(id, source.slice(0, at));
		const created = await addCell(id, cell.cell_type, source.slice(at));
		setActive(created.id);
		await tick();
		// `enterEdit`, not `focus`: a markdown cell created with text mounts in its
		// rendered view, whose editor is `display:none` and cannot take the caret.
		cellApis[created.id]?.enterEdit();
		scrollCellIntoView(created.id);
	}

	// 1-6: make the selected cell a markdown heading of that level, converting a
	// code cell on the way (Jupyter). An existing heading prefix is replaced, so
	// pressing 2 after 1 demotes the heading rather than nesting a second one.
	async function setHeadingLevel(level: number) {
		const id = activeId;
		const cell = findCell(id);
		if (!cell || !id) return;
		if (cell.cell_type !== 'markdown') await setType(id, 'markdown');
		const api = apiOf(id);
		const source = api?.currentSource?.() ?? cell.source;
		const next = withHeadingLevel(source, level);
		if (next === source) return;
		api?.replaceSource(next);
		await editCell(id, next);
	}

	/** shortcut id → what it does. `mode` is the mode the keystroke fired in. */
	const actions: Record<string, (mode: KeyMode) => void> = {
		'command-mode': () => apiOf(activeId)?.blur(),
		'edit-mode': () => apiOf(activeId)?.enterEdit(),
		'run-cell': () => apiOf(activeId)?.run(false),
		'run-advance': (mode) => apiOf(activeId)?.run(true, { focusNext: mode === 'edit' }),
		'select-prev': () => selectRelative(-1),
		'select-next': () => selectRelative(1),
		'fold-section': () => setFolded(activeId, true),
		'unfold-section': () => setFolded(activeId, false),
		'collapse-all-headings': () => setAllFolded(true),
		'expand-all-headings': () => setAllFolded(false),
		'move-cell-up': (mode) => moveActive('up', mode),
		'move-cell-down': (mode) => moveActive('down', mode),
		'insert-above': () => insertCell('above'),
		'insert-below': () => insertCell('below'),
		'to-markdown': () => activeId && setType(activeId, 'markdown'),
		'to-code': () => activeId && setType(activeId, 'code'),
		'run-insert-below': () => runAndInsertBelow(),
		'delete-cell': () => activeId && deleteCell(activeId),
		'undo-delete': () => undoDelete(),
		'cut-cell': () => cutActive(),
		'copy-cell': () => copyActive(),
		'paste-below': () => pasteCells('below'),
		'paste-above': () => pasteCells('above'),
		'split-cell': () => splitActiveCell(),
		...Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [`heading-${level}`, () => setHeadingLevel(level)]))
	};

	// The command palette dispatches a registry shortcut by id into the same action
	// the keyboard runs, always in command mode (the palette isn't a cell editor).
	// An unknown id is a harmless no-op.
	function dispatchCommand(shortcutId: string) {
		actions[shortcutId]?.('command');
	}

	// Run every code cell top-to-bottom. Fire without awaiting: the shared kernel's
	// server-side FIFO serializes them in submission order, and `runCell` uses each
	// cell's live editor text. Palette "Run all cells".
	function runAll() {
		for (const c of cells) {
			if (c.cell_type === 'code') runCell(c.id, cellApis[c.id]?.currentSource?.() ?? c.source);
		}
	}

	// Clear every cell's outputs. Palette "Clear all outputs".
	async function clearAll() {
		for (const c of cells) {
			if (c.outputs?.length) await clearCell(c.id);
		}
	}

	// ---- Key sequences (`d d`) -----------------------------------------------
	// A binding may be several chords long. The leading chords are held here as a
	// pending prefix until the sequence completes, a foreign key ends it, or it
	// times out - so a lone `d` does nothing at all.
	let pendingChords: string[] = [];
	let pendingMode: ShortcutMode | null = null; // the mode the prefix was typed in
	let pendingTimer: ReturnType<typeof setTimeout>;

	function clearPending() {
		clearTimeout(pendingTimer);
		pendingChords = [];
		pendingMode = null;
	}

	function armPending(chords: string[], mode: ShortcutMode) {
		clearTimeout(pendingTimer);
		pendingChords = chords;
		pendingMode = mode;
		pendingTimer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
	}

	/**
	 * What `chord` means, given any prefix already pending: the shortcut to fire,
	 * or the prefix to keep waiting on. Always consumes the pending prefix - a
	 * prefix typed in command mode can never combine with a keystroke in an editor,
	 * which is what keeps `d` from leaking into typing.
	 */
	function resolveChord(mode: ShortcutMode, chord: string): { shortcut?: EffectiveShortcut; prefix?: string[] } {
		const seq = pendingMode === mode ? [...pendingChords, chord] : [chord];
		clearPending();
		const shortcut = shortcuts.lookup(mode, seq.join(' '));
		if (shortcut) return { shortcut };
		if (shortcuts.isPrefix(mode, seq)) return { prefix: seq };
		// The sequence dead-ends (`d` then `j`): let this keystroke stand on its own.
		if (seq.length > 1) return resolveChord(mode, chord);
		return {};
	}

	function onKeydown(e: KeyboardEvent) {
		// A modal (settings, delete-confirm) owns the keyboard while it is open.
		if (document.querySelector('.modal-open')) return;
		const chord = chordFromEvent(e);
		if (!chord) return;

		const t = e.target as HTMLElement | null;
		// CodeMirror's own panels (the search/replace bar) are its keyboard, not
		// ours: they live inside `.cm-editor`, so the `inEditor` test alone would
		// hand their Enter and Mod-Enter to the notebook.
		if (t?.closest?.('.cm-panel')) return;
		const inEditor = !!t?.closest?.('.cm-editor');
		// The keystroke's mode is read off the DOM, not off `keyMode`: whatever has
		// focus decides. That is what guarantees a command-mode letter (`j`, `a`)
		// can never fire while the user is typing in an editor.
		if (!inEditor && t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
		// Only keystrokes aimed at this notebook (or at no element at all, which is
		// where focus lands after Escape) are ours; the sidebar keeps its own keys.
		if (!(t === document.body || rootEl?.contains(t))) return;
		const mode = inEditor ? 'edit' : 'command';
		// Let a focused control keep its native activation keys.
		if (mode === 'command' && (chord === 'Enter' || chord === 'Space') && t?.closest?.('button, a, [role="button"]')) return;
		// Escape belongs to CodeMirror while CodeMirror has something to close (its
		// completion tooltip, its search panel). That is Jupyter's behavior, and
		// preempting it would strand the tooltip on screen. Only once the editor has
		// nothing of its own open does Escape leave for command mode. Keyed off the
		// *focused* cell rather than `activeId`, which is the same cell in edit mode
		// but need not be if a focus event is still in flight.
		if (mode === 'edit' && chord === 'Escape') {
			const focusedId = (t?.closest('[data-cell-id]') as HTMLElement | null)?.dataset.cellId;
			if (apiOf(focusedId)?.editorOverlayOpen?.()) return;
		}

		const { shortcut, prefix } = resolveChord(mode, chord);
		// The first chord of a sequence is swallowed while we wait for the rest. It
		// only ever reaches here in a mode where it isn't a character being typed.
		if (prefix) {
			e.preventDefault();
			e.stopPropagation();
			armPending(prefix, mode);
			return;
		}
		const action = shortcut && actions[shortcut.id];
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		action(mode);
	}
</script>

{#if loadError}
	<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6">
		<div class="p-4 text-sm text-error" data-testid="notebook-load-error">
			Could not open <code class="font-mono">{path}</code>: {loadError}
		</div>
	</div>
{:else if fetching}
	<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6">
		<p class="px-2 text-sm text-base-content/40">loading…</p>
	</div>
{:else}
	<!-- `rootEl` scopes the modal-keyboard handler, the typing guard and cell
	     lookups to THIS notebook: several notebooks stay mounted (hidden) and a
	     cell id is only unique within one document. It also takes focus when the
	     tab activates, so it is a real box, not `display:contents`. The scroll
	     pane is the shell's `overflow-y-auto` ancestor, so this stays layout-neutral. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div bind:this={rootEl} tabindex="-1" class="outline-none" data-testid="notebook-root">
		<Notebook
			{cells}
			runningId={runningId}
			{queued}
			{activeId}
			{keyMode}
			{staleness}
			hidden={folding.hidden}
			foldedIds={foldedIds}
			hiddenSegs={folding.segs}
			hiddenCounts={folding.counts}
			gitStatus={gitChanges.status}
			gitRemovedBefore={gitChanges.removedBefore}
			gitRemovedAtEnd={gitChanges.removedAtEnd}
			onToggleFold={toggleFold}
			onRun={runCell}
			onRunAdvance={runAndAdvance}
			onInterrupt={onInterruptKernel}
			onClear={clearCell}
			onDelete={deleteCell}
			onMove={moveCell}
			onMoveToIndex={moveCellToIndex}
			onEdit={editCell}
			onSetType={setType}
			onSetRole={setRole}
			onSetExport={setExport}
			exportTarget={exportTarget}
			exportCount={exportCount}
			onSetExportTarget={setExportTargetValue}
			onExportPy={exportPy}
			onSetScrolled={setScrolled}
			editorCollapsed={editorCollapsed}
			onSetEditorCollapsed={setEditorCollapsed}
			onActivate={setActive}
			onRegister={registerCell}
			onEditorFocus={onEditorFocus}
			onEditorBlur={onEditorBlur}
			onAddCell={addCell}
		/>
	</div>
{/if}
