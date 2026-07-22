<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import Navbar from '$lib/Navbar.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	import LiveNotebook from '$lib/LiveNotebook.svelte';
	import FileTab from '$lib/FileTab.svelte';
	import ImageTab from '$lib/ImageTab.svelte';
	import { isImagePath } from '$lib/imagePath';
	import Settings from '$lib/Settings.svelte';
	import CommandPalette from '$lib/CommandPalette.svelte';
	import FindBar from '$lib/FindBar.svelte';
	import type { Match } from '$lib/search';
	import { buildCommands } from '$lib/commands';
	import { shortcuts, chordFromEvent } from '$lib/shortcuts.svelte';
	import LogsPanel from '$lib/LogsPanel.svelte';
	import { subscribeEvents, originId } from '$lib/events-client';
	import type { ClientEvent } from '$lib/events-client';
	import { hydrateUiState, getUi, setUi } from '$lib/uiState';
	import { relativeTimeLong } from '$lib/relativeTime';
	import type { PageData } from './$types';
	import type { Cell } from '$lib/server/types';
	import type { UICell, FoldRegistryHandle, NumberingRegistryHandle, NotebookApiHandle } from '$lib/types';
	import type { SearchCache } from '$lib/search';
	import type { Folding } from '$lib/headings';
	import type { KernelInfo, KernelListEntry, KernelCard } from '$lib/kernelBadge';
	import type { BlameLine } from '$lib/server/git';

	/** Kind of an open tab: the canonical notebook, an opened `.ipynb`/`.py`, a rendered image, or a text file. */
	type TabKind = 'notebook' | 'ipynb' | 'image' | 'file';
	/** An open tab in the shell. Structurally a superset of what Navbar renders. */
	interface Tab {
		id: string;
		kind: TabKind;
		title: string;
		path: string;
		closable: boolean;
		dirty: boolean;
		preview: boolean;
	}
	/** A tab-impacting workspace change reported up from the sidebar file tree. */
	interface FsChange {
		type: 'rename' | 'move' | 'delete';
		from?: string;
		path: string;
	}
	/** A kernel-namespace variable row (from the inspector probe). */
	interface VariableInfo {
		name: string;
		type?: string;
		shape?: string;
		preview?: string;
	}

	const isPyPath = (p: string) => /\.py$/i.test(p);

	let { data }: { data: PageData } = $props();

	// Seed the per-project UI-preference cache from SSR before any child reads a
	// preference (this runs during init, ahead of every onMount). Port-independent:
	// this is what survives the dynamic app port that empties `localStorage`.
	hydrateUiState(data.uiState);

	const EMPTY_FOLDS = new Set<string>(); // no notebook active → the Outline folds nothing
	const EMPTY_QUEUED: Record<string, number> = {}; // no notebook active → nothing queued
	const EMPTY_NUMBERS: Record<string, string> = {}; // no notebook active → no heading numbers
	const EMPTY_LEVELS: number[] = []; // no notebook active → no numbered levels

	const workspace = data.notebook.workspace;
	const notebookPath = data.notebook.path;
	const notebookName = notebookPath.split('/').pop() ?? notebookPath;

	// Workspace-relative path of the canonical (default) notebook. Opening it from
	// the file tree routes to the live notebook tab (id 'notebook').
	const canonicalNotebookRel = notebookPath.startsWith(workspace)
		? notebookPath.slice(workspace.length).replace(/^[/\\]+/, '')
		: notebookName;

	// Live cells per open notebook (path → the notebook's reactive cell array),
	// reported up by each LiveNotebook so the sidebar (outline / search) can read
	// whichever notebook is active. Seeded with the default notebook's SSR cells
	// so the sidebar reflects it even before its tab is mounted.
	let notebooksCells = $state<Record<string, Cell[]>>({ [canonicalNotebookRel]: data.notebook.cells });
	function handleCellsChange(path: string, cells: UICell[]) {
		notebooksCells[path] = cells;
	}

	// Collapsible-heading state per open notebook, reported up by each LiveNotebook
	// (which owns it and persists it). The sidebar Outline renders its chevrons from
	// exactly this state and toggles it through the notebook's own `toggleFold`, so
	// outline and notebook are one fold state, not two that must be kept in step.
	// Assign into the key, never rebuild the map: a spread would *read* this state
	// inside the reporting effect that writes it, and Svelte would loop forever.
	let notebooksFolds = $state<Record<string, { foldedIds: Set<string>; folding: Folding }>>({}); // path → { foldedIds, folding }
	function handleFoldsChange(path: string, foldedIds: Set<string>, folding: Folding) {
		notebooksFolds[path] = { foldedIds, folding };
	}

	// Display-only heading auto-numbering per open notebook, reported up by each
	// LiveNotebook (which owns the setting + derives the numbers). The sidebar
	// Outline shows the same numbers the cells render, and its per-level toggle
	// drives the numbers through the notebook's own setter. Assign into the key
	// (never rebuild the map) for the same loop-avoidance reason as `notebooksFolds`.
	let notebooksNumbering = $state<Record<string, { numbers: Record<string, string>; levels: number[] }>>({});
	function handleNumberingChange(path: string, numbers: Record<string, string>, levels: number[]) {
		notebooksNumbering[path] = { numbers, levels };
	}
	// path → whether that notebook's notebook-wide "hide all code" (report view) is
	// on, published up from each LiveNotebook so the navbar's toggle reflects the
	// active notebook. Assign into the key (never rebuild the map), like above.
	let notebooksHideAll = $state<Record<string, boolean>>({});
	function handleHideAllCodeChange(path: string, hidden: boolean) {
		notebooksHideAll[path] = hidden;
	}
	// Imperative, not reactive: path → the notebook's numbering setter. The Outline's
	// per-level checkboxes drive numbering through this, same shape as `foldTogglers`.
	const numberingTogglers = new Map<string, NumberingRegistryHandle>();
	function registerNumbering(path: string, api: NumberingRegistryHandle | null) {
		if (api) numberingTogglers.set(path, api);
		else numberingTogglers.delete(path);
	}
	function toggleActiveNumberingLevel(level: number, on: boolean) {
		if (activeNotebookPath) numberingTogglers.get(activeNotebookPath)?.setLevel(level, on);
	}

	// Live run/queue state per open notebook, reported up by each LiveNotebook from
	// the shared kernel's `queue:changed` snapshot. The sidebar Outline maps it onto
	// heading sections (running spinner / queued badge). Assign into the key (never
	// rebuild the map) for the same loop-avoidance reason as `notebooksFolds`.
	let notebooksRunState = $state<Record<string, { runningId: string | null; queued: Record<string, number> }>>({});
	function handleRunStateChange(path: string, runningId: string | null, queued: Record<string, number>) {
		notebooksRunState[path] = { runningId, queued };
	}
	// Imperative, not reactive: a plain map of path → the notebook's fold API
	// ({toggle, collapseAll, expandAll}). The Outline drives every fold through this.
	const foldTogglers = new Map<string, FoldRegistryHandle>();
	function registerFolds(path: string, api: FoldRegistryHandle | null) {
		if (api) foldTogglers.set(path, api);
		else foldTogglers.delete(path);
	}
	function toggleActiveFold(key: string) {
		if (activeNotebookPath) foldTogglers.get(activeNotebookPath)?.toggle(key);
	}
	function collapseAllActiveFolds() {
		if (activeNotebookPath) foldTogglers.get(activeNotebookPath)?.collapseAll();
	}
	function expandAllActiveFolds() {
		if (activeNotebookPath) foldTogglers.get(activeNotebookPath)?.expandAll();
	}

	// Imperative handles from each mounted LiveNotebook, same shape as `foldTogglers`.
	// The Databricks data browser reaches the active notebook through this.
	const notebookApis = new Map<string, NotebookApiHandle>();
	function registerNotebookApi(path: string, api: NotebookApiHandle | null) {
		if (api) notebookApis.set(path, api);
		else notebookApis.delete(path);
	}

	// Each mounted LiveNotebook's per-cell search-text cache, keyed by path. Reactive
	// (unlike `notebookApis`) so the sidebar Search re-derives when the active notebook
	// changes; the cache itself is owned by its notebook and self-invalidates on edit/run.
	let searchCaches = $state<Record<string, SearchCache>>({});
	function registerSearchCache(path: string, cache: SearchCache | null) {
		if (cache) searchCaches[path] = cache;
		else delete searchCaches[path];
	}

	/**
	 * Append a code cell to the active notebook and run it - the sidebar's
	 * point-and-click table preview. Focus the notebook's tab first: a hidden pane
	 * is `display:none`, so it has no geometry and the new cell could not be
	 * scrolled into view.
	 */
	async function insertAndRunInActiveNotebook(code: string) {
		const path = activeNotebookPath;
		const api = path ? notebookApis.get(path) : null;
		if (!api || !path) return; // no notebook open (or one still mounting)
		if (path === canonicalNotebookRel) openNotebook();
		else openFilePermanent(path);
		await tick();
		await api.insertAndRunCode(code);
	}

	// Null disables the sidebar's preview affordance rather than minting a tab
	// behind the user's back. `notebookApis` is a plain Map (not reactive), so the
	// gate reads `activeNotebookPath`, which is - the api is looked up at call time.
	const canInsertAndRun = $derived.by(() => (activeNotebookPath ? insertAndRunInActiveNotebook : null));

	// Single shared kernel → at most one cell runs at a time across ALL notebooks.
	// Serializing them is the SERVER's job (`run-queue.js`): a run requested while
	// the kernel is busy is queued, not dropped, so this is no longer a gate — it
	// is a count of runs this browser has in flight (a queued one included), used
	// only to keep the kernel badge reading "busy" while they resolve. A count,
	// not a boolean, because several runs can now legitimately overlap here.
	let runsInFlight = $state(0);
	const runBusy = $derived(runsInFlight > 0);
	function onRunStart() {
		runsInFlight += 1;
		// A run implies a live kernel, and the first run is what boots it (`/api/kernel`
		// only reads, never boots). Record that optimistically so the kernel card and
		// navbar badge stay truthful once the runs drain, without waiting on a status
		// round-trip. This also supersedes any `/api/kernel` read still in flight
		// - notably the mount-time one, which legitimately answers "not started".
		markKernelStarted();
	}
	function onRunEnd() {
		runsInFlight = Math.max(0, runsInFlight - 1);
		// A run may have booted the kernel or changed variables → refresh the sidebar
		// in the background; neither is on the critical path for the next run.
		refreshKernel();
		refreshVariables();
	}

	// ---- Shell state ---------------------------------------------------------
	let sidebarOpen = $state(true);
	let settingsOpen = $state(false);
	let paletteOpen = $state(false);
	// The floating find-in-page bar (Search P3). Opened from a non-Ctrl entry point
	// (the sidebar Search button, or the `open-find` shortcut) - Ctrl+F interception
	// is P5. `findSeed` holds the text selection captured at open time; the bar
	// seeds its query from it only on the closed->open transition.
	let findOpen = $state(false);
	let findSeed = $state('');
	// Transient, dismissable status line (jupytext env not ready, convert result, …).
	let notice = $state('');
	let theme = $state('dim');
	// Follow-the-running-cell preference (default on). A viewer preference, not a
	// notebook document property, so it lives in the per-project UI-state store
	// (survives the dynamic port) like theme/sidebar-width — never in the `.ipynb`.
	// `hydrateUiState` has already run (init, above), so this read is synchronous.
	const FOLLOW_KEY = 'cellar-follow-running-cell';
	let followRunningCell = $state(getUi<boolean>(FOLLOW_KEY, true));
	function toggleFollowRunningCell() {
		followRunningCell = !followRunningCell;
		setUi(FOLLOW_KEY, followRunningCell);
	}
	// Cell virtualization (windowed rendering) — ships OFF by default. This phase
	// (P2) lands the windowing itself behind the flag; a later phase (P5) will
	// enable it automatically above a cell-count threshold. Until then an explicit
	// `?virtualize=1` opt-in turns it on (the e2e harness + anyone trying it). Read
	// once at init; URL params don't change within a session.
	const virtualizeCells =
		typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('virtualize') === '1';
	const mcp = data.mcp;
	// Soft cap on live kernels; past it the Kernels sidebar warns (warn-only).
	const maxKernels = data.maxKernels ?? 8;

	// ---- Logs drawer (bottom console) ---------------------------------------
	const LOGS_OPEN_KEY = 'cellar-logs-open';
	const LOGS_HEIGHT_KEY = 'cellar-logs-height';
	const LOGS_MIN = 120;
	const LOGS_MAX = 640;
	let logsOpen = $state(false);
	let logsHeight = $state(220);
	let logsResizing = $state(false);
	// Errors that streamed in while the drawer was closed → a red dot on the toggle.
	let logsUnseenErrors = $state(0);
	function toggleLogs() {
		logsOpen = !logsOpen;
		if (logsOpen) logsUnseenErrors = 0;
		setUi(LOGS_OPEN_KEY, logsOpen ? '1' : '0');
	}
	function startLogsResize(e: PointerEvent) {
		logsResizing = true;
		const startY = e.clientY;
		const startH = logsHeight;
		e.preventDefault();
		function onMove(ev: PointerEvent) {
			// Drag up (smaller clientY) grows the drawer.
			logsHeight = Math.min(LOGS_MAX, Math.max(LOGS_MIN, startH + (startY - ev.clientY)));
		}
		function onUp() {
			logsResizing = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			setUi(LOGS_HEIGHT_KEY, String(logsHeight));
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// Tabs are restored from per-workspace session memory on mount; a first-ever
	// open starts empty (no tab → empty state). Each tab may be a transient
	// `preview` (VS Code single-click) until promoted (double-click / edit).
	let tabs = $state<Tab[]>([]);
	let activeTabId = $state<string | null>(null);
	let tabsRestored = $state(false);
	const fileTabs = $derived(tabs.filter((t) => t.kind === 'file'));
	const imageTabs = $derived(tabs.filter((t) => t.kind === 'image'));
	const ipynbTabs = $derived(tabs.filter((t) => t.kind === 'ipynb'));
	const notebookOpen = $derived(tabs.some((t) => t.kind === 'notebook'));
	const activeTab = $derived(tabs.find((t) => t.id === activeTabId) ?? null);
	const activeFilePath = $derived(activeTab && activeTab.kind !== 'notebook' ? activeTab.path : null);

	// Which notebook the sidebar (outline / search / Kernels dot) reflects: the
	// active notebook tab, else the default - but only while the default actually
	// has an open tab. `notebooksCells` is seeded with the default notebook's SSR
	// cells, so falling back to it unconditionally would let a *closed* notebook's
	// stale snapshot fill the outline while a plain file tab holds focus. Null
	// means "no notebook is active": the outline and search render empty and the
	// Kernels list dots nothing, so every sidebar section agrees.
	const activeNotebookPath = $derived(
		activeTab?.kind === 'notebook'
			? canonicalNotebookRel
			: activeTab?.kind === 'ipynb'
				? activeTab.path
				: notebookOpen
					? canonicalNotebookRel
					: null
	);
	const activeCells = $derived((activeNotebookPath && notebooksCells[activeNotebookPath]) || []);
	// The active notebook's search-text cache (registered by its LiveNotebook),
	// handed to the sidebar Search so it runs the shared engine over it.
	const activeSearchCache = $derived(
		(activeNotebookPath && searchCaches[activeNotebookPath]) || undefined
	);
	const activeFolds = $derived((activeNotebookPath && notebooksFolds[activeNotebookPath]) || null);
	const activeNumbering = $derived((activeNotebookPath && notebooksNumbering[activeNotebookPath]) || null);
	const activeHideAllCode = $derived(!!(activeNotebookPath && notebooksHideAll[activeNotebookPath]));
	const activeRunState = $derived((activeNotebookPath && notebooksRunState[activeNotebookPath]) || null);

	// Per-tab run indicator for the tab strip: 'running' (a cell is executing in that
	// notebook) or 'queued' (a cell is waiting), keyed by tab id. `notebooksRunState`
	// is reported by every mounted LiveNotebook regardless of `active`, so a BACKGROUND
	// notebook (one the user isn't viewing) still lights up its tab. Keyed by tab.path,
	// which equals the run-state key for both the default and opened `.ipynb` tabs.
	const tabRunState = $derived.by<Record<string, 'running' | 'queued'>>(() => {
		const out: Record<string, 'running' | 'queued'> = {};
		for (const t of tabs) {
			if (t.kind !== 'notebook' && t.kind !== 'ipynb') continue;
			const rs = notebooksRunState[t.path];
			if (!rs) continue;
			if (rs.runningId != null) out[t.id] = 'running';
			else if (Object.keys(rs.queued).length > 0) out[t.id] = 'queued';
		}
		return out;
	});

	// Git blame shown in the bottom status bar. A FileTab reports its cursor line's
	// record; a LiveNotebook reports its FOCUSED CELL's record (per-cell blame) — both
	// through the same `handleBlame`, keyed by workspace path. The footer reads the
	// active tab's, whether that's a file or a notebook. An untracked/non-git target
	// reports null and the bar hides gracefully.
	let blameByPath = $state<Record<string, BlameLine | null>>({});
	function handleBlame(path: string, record: BlameLine | null) {
		blameByPath = { ...blameByPath, [path]: record };
	}
	const activeBlame = $derived(
		(activeFilePath && blameByPath[activeFilePath]) ||
			(activeNotebookPath && blameByPath[activeNotebookPath]) ||
			null
	);

	// One card per notebook's kernel in the Kernels sidebar. Cellar runs one kernel
	// PER notebook (lazy, started on that notebook's first run). The card set is:
	//   1. every LIVE kernel (`kernels`, from the server via `/api/kernel` + the
	//      `kernel:status` SSE snapshot) — a notebook whose tab was CLOSED but whose
	//      kernel is still alive keeps its card (its state is still in memory);
	//   2. the ACTIVE notebook, even with no kernel yet — so a just-opened notebook
	//      shows a "not started" card you can watch start on first run.
	// So shutting down a non-active notebook's kernel drops its card (nothing left
	// to control), while the notebook you are looking at always has a card. A tab is
	// matched by path to carry `open` (focus its tab) + `active` (dot it).
	const notebookTabFor = (p: string) =>
		tabs.find((t) => (t.kind === 'notebook' || t.kind === 'ipynb') && t.path === p);
	const kernelCards = $derived.by<KernelCard[]>(() => {
		const byPath = new Map<string, KernelCard>();
		for (const k of kernels) {
			const tab = notebookTabFor(k.path);
			byPath.set(k.path, {
				id: tab?.id ?? k.path,
				path: k.path,
				name: tab?.title || k.name,
				open: !!tab,
				active: k.path === activeNotebookPath,
				hasKernel: true,
				info: {
					started: k.started,
					id: k.id,
					name: k.name,
					status: k.status,
					session_id: k.session_id,
					memoryRss: k.memoryRss
				}
			});
		}
		if (activeNotebookPath && !byPath.has(activeNotebookPath)) {
			const tab = notebookTabFor(activeNotebookPath);
			byPath.set(activeNotebookPath, {
				id: tab?.id ?? activeNotebookPath,
				path: activeNotebookPath,
				name: tab?.title || activeNotebookPath,
				open: !!tab,
				active: true,
				hasKernel: false,
				info: {
					started: false,
					id: null,
					name: 'python3',
					status: 'not started',
					session_id: null,
					memoryRss: null
				}
			});
		}
		return [...byPath.values()];
	});

	function tabIdFor(path: string) {
		return path === canonicalNotebookRel ? 'notebook' : 'file:' + path;
	}
	// A `.py` is a live notebook only when content-detection says so; the kind is
	// resolved once (server GET) and cached so it survives tab restore without a
	// re-probe. `.ipynb` is always a notebook; everything else opens as text.
	const pyKindCache = new Map<string, TabKind>(); // rel path → 'ipynb' | 'file'
	function baseKindFor(path: string): TabKind {
		if (/\.ipynb$/i.test(path)) return 'ipynb';
		// Check images early so a binary image can never fall through to a text kind.
		if (isImagePath(path)) return 'image';
		if (isPyPath(path)) return pyKindCache.get(path) ?? 'file';
		return 'file';
	}
	async function resolveTabKind(path: string): Promise<TabKind> {
		if (!isPyPath(path)) return baseKindFor(path);
		if (pyKindCache.has(path)) return pyKindCache.get(path)!;
		let kind: TabKind = 'file';
		try {
			const res = await fetch('/api/notebooks/jupytext?path=' + encodeURIComponent(path));
			if (res.ok) {
				const b = await res.json();
				kind = b.notebook && b.ready ? 'ipynb' : 'file';
				if (b.notebook && !b.ready && b.message) {
					notice = `Open as notebook needs jupytext: ${b.message}`;
				}
			}
		} catch {}
		pyKindCache.set(path, kind);
		return kind;
	}
	function makeTab(path: string, preview: boolean, kind?: TabKind): Tab {
		if (path === canonicalNotebookRel) {
			return { id: 'notebook', kind: 'notebook', title: notebookName, path, closable: true, dirty: false, preview };
		}
		return { id: 'file:' + path, kind: kind ?? baseKindFor(path), title: path.split('/').pop() ?? path, path, closable: true, dirty: false, preview };
	}

	function selectTab(id: string) {
		activeTabId = id;
	}

	// Click on a tab's run/queue indicator: activate that notebook (if it isn't the
	// viewed one) and scroll its running (or queued) cell into view. Reuses the
	// notebook's own reveal/scroll mechanism via its imperative API, so folds are
	// opened and the follow-cell viewport conventions are honored - an explicit
	// jump, so it ignores the `follow` preference the automatic effect obeys.
	async function jumpToRunningCell(tabId: string) {
		const tab = tabs.find((t) => t.id === tabId);
		if (!tab) return;
		if (activeTabId !== tabId) activeTabId = tabId;
		await tick(); // a background notebook's pane has no geometry until it's active
		notebookApis.get(tab.path)?.revealRunning();
	}

	// Single-click a tree file → open in the single shared preview slot. If a tab
	// for it already exists (preview or pinned) just focus it; otherwise reuse the
	// existing preview tab's slot, or append one. A `.py` is content-probed first
	// (async) so it opens as a live notebook or as text, per detection.
	async function openFile(path: string) {
		const id = tabIdFor(path);
		if (tabs.find((t) => t.id === id)) {
			activeTabId = id;
			return;
		}
		const kind = await resolveTabKind(path);
		if (tabs.find((t) => t.id === id)) {
			activeTabId = id;
			return;
		}
		const tab = makeTab(path, true, kind);
		const pv = tabs.findIndex((t) => t.preview);
		if (pv >= 0) {
			const next = [...tabs];
			next[pv] = tab;
			tabs = next;
		} else {
			tabs = [...tabs, tab];
		}
		activeTabId = id;
	}

	// Double-click / edit → open (or promote) as a permanent (pinned) tab.
	async function openFilePermanent(path: string) {
		const id = tabIdFor(path);
		const existing = tabs.find((t) => t.id === id);
		if (existing) {
			if (existing.preview) tabs = tabs.map((t) => (t.id === id ? { ...t, preview: false } : t));
			activeTabId = id;
			return;
		}
		const kind = await resolveTabKind(path);
		if (tabs.find((t) => t.id === id)) {
			activeTabId = id;
			return;
		}
		tabs = [...tabs, makeTab(path, false, kind)];
		activeTabId = id;
	}

	// Surface a notebook as an AVAILABLE tab without stealing the user's focus —
	// the browser side of an agent declaring its working notebook (a
	// `notebook:opened` with focus:false). Opens (or promotes) a permanent tab so
	// the notebook's live edits stream into it, but never changes activeTabId —
	// unless the user has no active tab to lose (empty workspace), in which case
	// there is no focus to steal and showing it is the friendly default.
	async function surfaceFilePermanent(path: string) {
		const id = tabIdFor(path);
		const existing = tabs.find((t) => t.id === id);
		if (existing) {
			if (existing.preview) tabs = tabs.map((t) => (t.id === id ? { ...t, preview: false } : t));
		} else {
			const kind = await resolveTabKind(path);
			if (!tabs.find((t) => t.id === id)) tabs = [...tabs, makeTab(path, false, kind)];
		}
		if (!tabs.some((t) => t.id === activeTabId)) activeTabId = id;
	}

	function promoteTab(id: string) {
		tabs = tabs.map((t) => (t.id === id ? { ...t, preview: false } : t));
	}

	function openNotebook() {
		openFilePermanent(canonicalNotebookRel);
	}

	// Explicitly create (or open) the workspace's default notebook. On a fresh
	// workspace the file isn't on disk yet (startup never writes one); this POST
	// materializes it, then opens its live tab. If it already exists it is opened
	// untouched. We pass our `originId` so the `notebook:opened` broadcast the
	// server emits is dropped as our own echo (we open the tab here directly).
	async function newNotebook() {
		try {
			await fetch('/api/notebooks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: canonicalNotebookRel, create: true, originId })
			});
		} catch {}
		openNotebook();
		fsRefreshSignal++; // a new file on disk → refresh the tree + git decorations
	}

	function closeTab(id: string) {
		const idx = tabs.findIndex((t) => t.id === id);
		tabs = tabs.filter((t) => t.id !== id);
		if (activeTabId === id) {
			activeTabId = (tabs[idx - 1] ?? tabs[0] ?? null)?.id ?? null;
			// If no notebook tab is active now (a file tab, or nothing), no
			// LiveNotebook `active` effect fires to move the server active pointer,
			// so the agent-facing MCP tools would keep defaulting to the just-closed
			// notebook. Reset the active notebook to the canonical default.
			const nextTab = tabs.find((t) => t.id === activeTabId) ?? null;
			if (nextTab?.kind !== 'notebook' && nextTab?.kind !== 'ipynb') {
				fetch('/api/notebooks', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path: canonicalNotebookRel })
				}).catch(() => {});
			}
		}
	}

	// A file-management op in the sidebar tree changed the workspace. Keep open
	// tabs consistent: close tabs pointing at a deleted path (or anything under a
	// deleted folder), and remap tabs when a file/folder is renamed or moved so no
	// tab is left dangling at a gone path.
	function remapRel(p: string, from: string, to: string): string | null {
		if (p === from) return to;
		if (p.startsWith(from + '/')) return to + p.slice(from.length);
		return null;
	}
	function handleFsChange(change: FsChange) {
		if (change.type === 'delete') {
			const gone = tabs.filter((t) => t.path === change.path || t.path.startsWith(change.path + '/'));
			for (const t of gone) closeTab(t.id);
			return;
		}
		if (change.type === 'rename' || change.type === 'move') {
			const from = change.from;
			if (from == null) return;
			let nextActive = activeTabId;
			tabs = tabs.map((t) => {
				const np = remapRel(t.path, from, change.path);
				if (np == null) return t;
				// Preserve the tab's kind across a rename (a `.py` notebook stays a
				// notebook); seed the cache at the new path so a later re-open matches.
				if (isPyPath(np) && (t.kind === 'ipynb' || t.kind === 'file')) pyKindCache.set(np, t.kind);
				const nt = makeTab(np, t.preview, t.kind === 'notebook' ? undefined : t.kind);
				nt.dirty = t.dirty;
				if (activeTabId === t.id) nextActive = nt.id;
				return nt;
			});
			activeTabId = nextActive;
		}
	}

	function onFileDirty(path: string, dirty: boolean) {
		const id = 'file:' + path;
		// Editing a previewed file promotes it to a permanent tab, like VS Code.
		tabs = tabs.map((t) => (t.id === id ? { ...t, dirty, preview: dirty ? false : t.preview } : t));
		// A save (dirty→false) may change git status → refresh decorations.
		if (!dirty) fsRefreshSignal++;
	}

	// ---- Tab session memory (per workspace) ---------------------------------
	const TABS_KEY = 'cellar-tabs:' + workspace;
	/** The persisted tab-session shape. */
	interface SavedTab {
		path: string;
		preview?: boolean;
		kind?: TabKind;
	}
	interface SavedTabs {
		tabs?: SavedTab[];
		activeTabId?: string | null;
	}
	function restoreTabs() {
		const parsed = getUi<SavedTabs | null>(TABS_KEY, null);
		if (parsed == null) {
			// First-ever open of this workspace → empty state, no tabs.
			tabs = [];
			activeTabId = null;
		} else {
			try {
				// Seed the `.py` kind cache from the saved kind so restore is synchronous
				// and a re-open matches — a `.py` opened as a notebook stays one.
				for (const t of parsed.tabs ?? []) {
					if (t.kind && isPyPath(t.path)) pyKindCache.set(t.path, t.kind === 'ipynb' ? 'ipynb' : 'file');
				}
				tabs = (parsed.tabs ?? []).map((t) => makeTab(t.path, !!t.preview, t.kind));
				const ids = new Set(tabs.map((t) => t.id));
				const savedActive = parsed.activeTabId;
				activeTabId = savedActive && ids.has(savedActive) ? savedActive : (tabs[0]?.id ?? null);
			} catch {
				tabs = [];
				activeTabId = null;
			}
		}
		tabsRestored = true;
	}
	$effect(() => {
		if (!tabsRestored) return;
		setUi(TABS_KEY, {
			tabs: tabs.map((t) => ({ path: t.path, preview: t.preview, kind: t.kind })),
			activeTabId
		});
	});

	// ---- Resizable sidebar (persisted width) --------------------------------
	const SIDEBAR_WIDTH_KEY = 'cellar-sidebar-width';
	const SIDEBAR_MIN = 180;
	const SIDEBAR_MAX = 560;
	let sidebarWidth = $state(256);
	let resizing = $state(false);
	function startResize(e: PointerEvent) {
		resizing = true;
		const startX = e.clientX;
		const startW = sidebarWidth;
		e.preventDefault();
		function onMove(ev: PointerEvent) {
			const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX)));
			sidebarWidth = w;
		}
		function onUp() {
			resizing = false;
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			setUi(SIDEBAR_WIDTH_KEY, sidebarWidth);
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// Bump to make the sidebar re-read the file tree + git status (after saves).
	let fsRefreshSignal = $state(0);

	// ---- Consolidate imports --------------------------------------------------
	// Sweep the active notebook's module-level imports into one pinned cell at the
	// top and run it. The server does the whole sweep and broadcasts the resulting
	// `cell:*` events with NO originId, so this tab renders it exactly as any other
	// tab does - there is nothing to apply locally.
	let consolidating = $state(false);

	async function consolidateImports() {
		if (!activeNotebookPath || consolidating) return;
		consolidating = true;
		try {
			await fetch('/api/notebooks/imports', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: activeNotebookPath })
			});
		} catch {}
		consolidating = false;
	}

	// ---- nbdev-style export to a .py module -----------------------------------
	// Delegate to the active notebook (it owns the target + the marked cells) and
	// surface the result as a transient notice. The module also regenerates
	// automatically on every save; this is the manual trigger.
	async function exportPy() {
		const api = activeNotebookApi();
		if (!api) return;
		notice = '';
		const r = await api.exportPy();
		if (!r) notice = 'Export to .py failed.';
		else if (r.reason === 'no-target') notice = 'Set a target .py path at the top of the notebook first.';
		else if (r.reason === 'no-cells') notice = 'No cells are marked for export - use a cell’s ⋮ menu.';
		else {
			fsRefreshSignal++; // a new/updated .py on disk → refresh the tree + git decorations
			notice = `Exported ${r.count} ${r.count === 1 ? 'cell' : 'cells'} → ${r.target}.`;
		}
	}

	// Toggle the active notebook's notebook-wide "hide all code" (report view).
	// Delegates to the notebook's own setter (which persists + broadcasts); the
	// navbar's label reflects `activeHideAllCode`, published back up per notebook.
	function toggleHideAllCode() {
		activeNotebookApi()?.toggleHideAllCode();
	}

	// ---- jupytext: save as .py / convert .py → .ipynb -------------------------
	// The active notebook (the one the sidebar reflects), and whether it is a `.py`
	// text notebook (the only source a "Convert to .ipynb" makes sense for).
	const activeNotebookIsPy = $derived(activeTab?.kind === 'ipynb' && isPyPath(activeTab.path));

	let saveAsPyOpen = $state(false);
	let saveAsPyFormat = $state('databricks');
	let saveAsPyName = $state('');
	let saveAsPyBusy = $state(false);
	let converting = $state(false);

	function openSaveAsPy() {
		if (!activeNotebookPath) return;
		// Default the target to <notebook-basename>.py beside the source.
		const base = activeNotebookPath.replace(/\.(ipynb|py)$/i, '');
		saveAsPyName = base + '.py';
		saveAsPyFormat = 'databricks';
		saveAsPyOpen = true;
	}

	async function doSaveAsPy() {
		if (saveAsPyBusy || !activeNotebookPath) return;
		saveAsPyBusy = true;
		notice = '';
		try {
			const res = await fetch('/api/notebooks/jupytext', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'export', source: activeNotebookPath, target: saveAsPyName, format: saveAsPyFormat })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'export failed');
			saveAsPyOpen = false;
			fsRefreshSignal++; // a new file on disk → refresh the tree + git decorations
			notice = `Saved ${body.path} (${body.format}).`;
		} catch (err) {
			notice = `Save as .py failed: ${(err as Error)?.message ?? err}`;
		} finally {
			saveAsPyBusy = false;
		}
	}

	// Convert the active `.py` notebook to an `.ipynb` with outputs: the server runs
	// every cell then writes <base>.ipynb, which we then open as a live notebook.
	async function convertToIpynb() {
		if (converting || !activeNotebookIsPy || !activeTab) return;
		const source = activeTab.path;
		const target = source.replace(/\.py$/i, '.ipynb');
		converting = true;
		notice = 'Converting: running all cells…';
		try {
			const res = await fetch('/api/notebooks/jupytext', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'convert', source, target, originId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'convert failed');
			fsRefreshSignal++;
			const r = body.ran ?? {};
			notice = `Converted to ${body.path} — ran ${r.ok ?? 0}/${r.total ?? 0} cells${r.errors ? `, ${r.errors} with errors` : ''}.`;
			await openFilePermanent(body.path);
		} catch (err) {
			notice = `Convert failed: ${(err as Error)?.message ?? err}`;
		} finally {
			converting = false;
		}
	}

	// Download the active notebook as a single self-contained HTML file. The server
	// route renders the notebook model + its persisted outputs and returns an
	// attachment; a hidden <a download> click saves it next to the user's choosing.
	function exportHtml() {
		if (!activeNotebookPath) return;
		const a = document.createElement('a');
		a.href = '/api/notebooks/export?path=' + encodeURIComponent(activeNotebookPath);
		a.download = '';
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	// ---- Checkpoints (navbar) ------------------------------------------------
	// Snapshot / undo for the active notebook. The sidebar History panel owns the
	// full list + restore UI; these two navbar entries are the quick paths. The
	// server broadcasts `notebook:restored` on an undo, so every tab refetches.
	async function checkpointNow() {
		if (!activeNotebookPath) return;
		try {
			const res = await fetch('/api/checkpoints', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: activeNotebookPath, action: 'create' })
			});
			const body = await res.json().catch(() => ({}));
			notice = res.ok ? 'Checkpoint saved.' : `Checkpoint failed: ${body?.message ?? ''}`;
		} catch (err) {
			notice = `Checkpoint failed: ${(err as Error)?.message ?? err}`;
		}
	}

	async function undoLastAgentAction() {
		if (!activeNotebookPath) return;
		try {
			const res = await fetch('/api/checkpoints', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: activeNotebookPath, action: 'undo-agent', originId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) notice = `Undo failed: ${body?.message ?? ''}`;
			else if (body.ok) notice = 'Reverted to the last automatic checkpoint.';
			else notice = 'Nothing to undo - no agent action has been checkpointed yet.';
		} catch (err) {
			notice = `Undo failed: ${(err as Error)?.message ?? err}`;
		}
	}

	// ---- Bulk run actions (navbar) -------------------------------------------
	// Delegate to the active notebook's registered API (the same `notebookApis`
	// registry the Databricks preview uses). Run above/below act on that notebook's
	// own selected cell; run-stale re-runs everything its dependency graph marks
	// stale, in order. The notebook must be focused first: a hidden pane has no
	// geometry, so a scrolled-into-view running cell would have nowhere to land.
	function runNotebookAction(name: 'runStale' | 'runAbove' | 'runBelow') {
		const path = activeNotebookPath;
		const api = path ? notebookApis.get(path) : null;
		if (!api?.[name] || !path) return;
		if (path === canonicalNotebookRel) openNotebook();
		else openFilePermanent(path);
		api[name]();
	}
	const runStaleActive = () => runNotebookAction('runStale');
	const runAboveActive = () => runNotebookAction('runAbove');
	const runBelowActive = () => runNotebookAction('runBelow');

	async function scrollToCell(id: string, foldKey: string | null = null) {
		// Open + focus the notebook the outline currently reflects, then scroll. With
		// no active notebook the outline and search are empty, so there is no row to
		// click - but never let a null path mint a tab if one ever gets here.
		if (!activeNotebookPath) return;
		if (activeNotebookPath === canonicalNotebookRel) openNotebook();
		else openFilePermanent(activeNotebookPath);
		await tick();
		// Multiple notebooks stay mounted (hidden); pick the visible cell.
		const els = document.querySelectorAll(`[data-cell-id="${id}"]`);
		const el = [...els].find((e) => (e as HTMLElement).offsetParent !== null) ?? els[0];
		if (!el) return;
		// An outline row addresses a heading, and a cell can hold several - scroll to
		// the heading itself when we know which, but flash the whole cell.
		const target = (foldKey && el.querySelector(`[data-fold-key="${CSS.escape(foldKey)}"]`)?.closest('[data-testid="heading-row"]')) || el;
		target.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('cellar-flash');
		setTimeout(() => el.classList.remove('cellar-flash'), 1200);
	}

	// ---- Find-in-page (floating find bar, Search P3) ------------------------
	// Open the bar, seeding its query from the current text selection (native find
	// behavior). Capturing the selection here - before focus moves to the find
	// input - is what makes the seed reliable.
	function openFindBar() {
		findSeed = (typeof window !== 'undefined' && window.getSelection?.()?.toString().trim()) || '';
		findOpen = true;
	}
	function closeFindBar() {
		findOpen = false;
		// Return keyboard focus to the notebook so command-mode keys work again.
		activeNotebookApi()?.focusRoot();
	}
	// Route a match jump to the ACTIVE notebook's `jumpToCell`, which awaits
	// `ensureCellMounted` first - so a match in a cell windowed out by
	// virtualization mounts before it scrolls (the crucial cooperation).
	function jumpToMatch(match: Match) {
		void activeNotebookApi()?.jumpToCell(match.cellId, match);
	}

	// ---- Kernel + variables (sidebar) ---------------------------------------
	// `kernelInfo` is the ACTIVE notebook's kernel (navbar badge, variable inspector,
	// Databricks panel — all follow the focused notebook). `kernels` is the full
	// per-notebook list driving the Kernels sidebar cards; it stays live via the
	// `kernel:status` SSE snapshot as kernels start / go busy / restart / shut down.
	let kernelInfo = $state<KernelInfo>({
		started: false,
		id: null,
		name: 'python3',
		status: 'not started',
		session_id: null,
		memoryRss: null
	});
	let kernels = $state<KernelListEntry[]>([]);
	let variables = $state<VariableInfo[]>([]);
	let varsLoading = $state(false);
	let varsError = $state('');

	// The active notebook's live RSS, read from the per-notebook `kernels` list (where
	// the memory poller writes, kept live by the `kernel:status` SSE snapshot). Strictly
	// scoped to the active notebook's OWN entry — no fallback to `kernelInfo.memoryRss`,
	// which lags behind tab focus and would briefly leak another notebook's figure next
	// to a "not started" badge. A notebook with no live kernel simply has no entry → null
	// → the navbar hides the figure (the badge already reads "not started").
	const activeKernelMemory = $derived.by<number | null>(() =>
		activeNotebookPath ? (kernels.find((k) => k.path === activeNotebookPath)?.memoryRss ?? null) : null
	);

	const displayKernel = $derived<KernelInfo>({
		...(runBusy ? { ...kernelInfo, started: true, status: 'busy' } : kernelInfo),
		memoryRss: activeKernelMemory
	});

	// Monotonic generation for writes to `kernelInfo`. A fetched status is applied
	// only while it is still the newest word on the kernel's state: any newer read,
	// or a newer local write, supersedes an in-flight response. Without this, a
	// `/api/kernel` read issued before the kernel booted can resolve *after* the run
	// began and clobber the live state back to "not started" - the responses are
	// unordered, so the last one to land, not the last one issued, would win.
	let kernelReqSeq = 0;

	// A run proves the kernel is up; assert it locally and invalidate stale reads.
	function markKernelStarted() {
		kernelReqSeq++;
		kernelInfo = { ...kernelInfo, started: true, status: 'busy' };
	}

	async function refreshKernel() {
		const seq = ++kernelReqSeq;
		try {
			const res = await fetch('/api/kernel');
			if (!res.ok) return;
			const { kernels: list, ...info } = await res.json();
			if (seq !== kernelReqSeq) return; // superseded while in flight → drop it
			kernelInfo = info;
			// A full snapshot, so overwriting an SSE update with an equally-fresh fetch
			// (or vice-versa) is always safe; the newest snapshot wins and self-heals.
			kernels = list ?? [];
		} catch {}
	}

	/**
	 * A Databricks connect/disconnect ran code in the kernel: it may have booted it,
	 * and it binds or unbinds `spark` + `w`. Refresh both sidebar views of the
	 * kernel so the badge and the variable inspector agree with what just happened.
	 */
	function onDatabricksSessionChange() {
		refreshKernel();
		refreshVariables();
	}

	async function refreshVariables() {
		varsLoading = true;
		varsError = '';
		try {
			const res = await fetch('/api/kernel/variables');
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'inspect failed');
			// `busy` means the kernel was running a cell, so the server skipped the probe
			// (an internal probe must never queue behind a run). Keep the variables we
			// already show rather than clearing them; the next idle refresh updates them.
			if (!body.busy) variables = body.variables;
		} catch (err) {
			varsError = String((err as Error)?.message ?? err);
		} finally {
			varsLoading = false;
		}
	}

	// Per-notebook kernel controls. Each targets ONE notebook's kernel (by its
	// workspace-relative `path`) and reuses the exact kernel.js paths the MCP agent
	// interface proved: restart keeps the same session (document intact) while
	// clearing that notebook's namespace — the "wipe from memory" affordance — and
	// shutdown terminates the process and drops the card. Other notebooks' kernels
	// are untouched. The Kernels sidebar owns per-card in-flight/disabled state and
	// awaits these promises. A restart/shutdown of the ACTIVE notebook cleared its
	// namespace, so drop the now-stale inspector rows.
	const kernelJson = { method: 'POST', headers: { 'content-type': 'application/json' } };
	async function interruptKernel(path: string) {
		// Abort this notebook's queued/held run fetches FIRST (synchronous, no network):
		// they hold the streaming connections that would otherwise starve the interrupt
		// request out of the browser's HTTP/1.1 connection pool, so without this the
		// interrupt can't reach the server until the running cell finishes on its own -
		// and the queue drains meanwhile. This also cancels the queued runs; the
		// server's own `clearRunQueue` on interrupt is the backstop for any that raced in.
		notebookApis.get(path)?.cancelQueuedRuns?.();
		try {
			await fetch('/api/kernel/interrupt', { ...kernelJson, body: JSON.stringify({ path }) });
		} catch {}
		refreshKernel();
	}
	async function restartKernel(path: string) {
		try {
			await fetch('/api/kernel/restart', { ...kernelJson, body: JSON.stringify({ path }) });
			if (path === activeNotebookPath) variables = [];
		} catch {}
		refreshKernel();
	}
	async function shutdownKernel(path: string) {
		try {
			await fetch('/api/kernel/shutdown', { ...kernelJson, body: JSON.stringify({ path }) });
			if (path === activeNotebookPath) variables = [];
		} catch {}
		refreshKernel();
	}
	// Wipe a notebook's user variables from its kernel to free memory, keeping the
	// kernel alive (no restart, same session): the process, epoch, imports, defs and
	// any live Databricks session all survive. The active notebook's inspector is
	// refetched so it shows the now-empty namespace (staleness updates via the
	// `kernel:variables-wiped` SSE event the server publishes). No kernel status
	// change (still the same running session), so no refreshKernel() is needed.
	async function wipeKernel(path: string) {
		try {
			await fetch('/api/kernel/wipe', { ...kernelJson, body: JSON.stringify({ path }) });
			if (path === activeNotebookPath) refreshVariables();
		} catch {}
	}

	// ---- Theme ---------------------------------------------------------------
	// Setting `data-theme` is the whole toggle: daisyUI restyles the app and, via
	// the `color-scheme` it puts on `<html>`, every `light-dark()` token in
	// `app.css` (git decorations, notebook surfaces, the CodeMirror palette)
	// re-resolves. Nothing is dispatched into any editor - see `editorTheme.js`.
	//
	// `data-color-scheme` mirrors the *resolved* scheme for the few theme values
	// `light-dark()` cannot carry, because they are not colors (the syntax
	// palette's font weights and styles). It is read back off `color-scheme`
	// rather than derived from the theme's name, so a new theme needs no change
	// here.
	function applyTheme(t: string) {
		// `nord` was the light theme before the color-theory pass; map any persisted
		// value forward so a returning user lands on the new `cellar-light`.
		if (t === 'nord') t = 'cellar-light';
		theme = t;
		if (typeof document !== 'undefined') {
			const root = document.documentElement;
			root.dataset.theme = t;
			root.dataset.colorScheme = getComputedStyle(root).colorScheme === 'light' ? 'light' : 'dark';
		}
		setUi('cellar-theme', t);
	}

	onMount(() => {
		const saved = getUi('cellar-theme', null);
		applyTheme(saved || document.documentElement.dataset.theme || 'dim');
		// Restore per-workspace tab session + sidebar width.
		restoreTabs();
		const w = Number(getUi(SIDEBAR_WIDTH_KEY, 0));
		if (w) sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
		// Restore the logs drawer (open state + height) from the same
		// port-independent UI-state store as every other layout preference.
		logsOpen = getUi<string>(LOGS_OPEN_KEY, '0') === '1';
		const h = Number(getUi(LOGS_HEIGHT_KEY, 0));
		if (h) logsHeight = Math.min(LOGS_MAX, Math.max(LOGS_MIN, h));
		// Restore live kernel + variables after a reload — but only inspect if a
		// kernel already exists, so a fresh page load never boots one on its own.
		refreshKernel().then(() => {
			if (kernelInfo.started) refreshVariables();
		});
	});

	// Surface an agent-created / newly-active notebook live: when the MCP
	// `use_notebook` tool runs, the server broadcasts `notebook:opened` so we
	// open (or focus) a permanent tab for it with no reload. Our own actions carry
	// this tab's `originId` and are skipped. `openFilePermanent` maps the default
	// notebook's relative path to the canonical 'notebook' tab and any other
	// `.ipynb` to a live `ipynb` tab — the same paths a tree double-click uses.
	onMount(() =>
		subscribeEvents((ev: ClientEvent) => {
			// Flag errors that arrive while the logs drawer is closed, so the status-bar
			// toggle can show a red dot the user can act on.
			if (ev.type === 'log' && (ev.entry as { level?: string } | undefined)?.level === 'error' && !logsOpen) {
				logsUnseenErrors += 1;
			}
			// The live per-notebook kernel list — a full snapshot published on every
			// kernel start / busy-idle flip / restart / shutdown. Drives the Kernels
			// sidebar cards with no reload (two notebooks running show two busy cards).
			if (ev.type === 'kernel:status') {
				kernels = (ev.kernels as KernelListEntry[] | undefined) ?? [];
				return;
			}
			// A run this tab did NOT initiate (an agent, or another tab) may load a
			// notebook into the kernel for the first time. Our own runs already refresh
			// via `onRunEnd`; this keeps the ACTIVE-notebook badge/inspector live too.
			if (ev.type === 'run:end' && ev.originId !== originId) {
				refreshKernel();
			}
			if (ev.type !== 'notebook:opened') return;
			if (ev.originId && ev.originId === originId) return;
			if (!ev.relPath) return;
			// focus:false is an AGENT declaring its working notebook — surface it as an
			// available tab, but never yank the user off the tab they are on. A human's
			// own open/create (focus:true, or the field absent on older events) focuses.
			if (ev.focus === false) surfaceFilePermanent(ev.relPath as string);
			else openFilePermanent(ev.relPath as string);
		})
	);

	// ---- Command palette (Cmd/Ctrl+K) ---------------------------------------
	// The palette invokes notebook commands through the active notebook's
	// registered api (`dispatch` runs the same action the keyboard runs) and
	// app/kernel commands through these shell handlers. Notebook commands are
	// disabled while no notebook tab is active; the api is resolved at call time
	// (`notebookApis` is a plain Map, so the reactive gate is `activeNotebookPath`).
	function toggleTheme() {
		applyTheme(theme === 'dim' ? 'cellar-light' : 'dim');
	}
	function activeNotebookApi() {
		return (activeNotebookPath && notebookApis.get(activeNotebookPath)) || null;
	}
	const notebookCommandHandle = $derived(
		activeNotebookPath
			? {
					dispatch: (id: string) => activeNotebookApi()?.dispatch(id),
					runAll: () => activeNotebookApi()?.runAll(),
					clearAll: () => activeNotebookApi()?.clearAll()
				}
			: null
	);
	const paletteCommands = $derived(
		buildCommands({
			notebook: notebookCommandHandle,
			app: {
				toggleTheme,
				toggleSidebar: () => (sidebarOpen = !sidebarOpen),
				openSettings: () => (settingsOpen = true),
				// The command palette acts on the ACTIVE notebook's kernel (empty path →
				// the server resolves to the active notebook).
				interruptKernel: () => interruptKernel(activeNotebookPath ?? ''),
				restartKernel: () => restartKernel(activeNotebookPath ?? ''),
				newNotebook,
				consolidateImports
			}
		})
	);

	// Open (toggle) the palette on the registry's `command-palette` binding, from
	// anywhere in the app. Handled here, not in LiveNotebook, because the palette is
	// shell-level and must open even with no notebook focused. Capture phase so it
	// beats CodeMirror; it defers to another open modal (e.g. Settings) which owns
	// the keyboard while up.
	onMount(() => {
		const bindsFor = (id: string) => shortcuts.list.find((s) => s.id === id)?.keys ?? [];
		function onKey(e: KeyboardEvent) {
			const chord = chordFromEvent(e);
			if (!chord) return;
			// Cmd/Ctrl+S saves the active notebook instead of Chrome's "Save page as…".
			// Shell-level (like the palette) so it fires even with focus inside a
			// CodeMirror editor — capture phase runs before the editor's own keymap.
			// Only when a notebook is active: a plain file tab keeps FileTab's own
			// Mod-s save, and a modal owns the keyboard while up.
			if (bindsFor('save-notebook').includes(chord)) {
				if (!activeNotebookPath || document.querySelector('.modal-open')) return;
				e.preventDefault();
				e.stopPropagation();
				saveActiveNotebook();
				return;
			}
			// Open the find bar (temporary non-Ctrl entry point; Ctrl+F is P5). Shell-
			// level so it fires with focus inside an editor, and only when a notebook is
			// active - a plain file tab has nothing to find across cells. A modal owns
			// the keyboard while up.
			if (bindsFor('open-find').includes(chord)) {
				if (!activeNotebookPath || document.querySelector('.modal-open')) return;
				e.preventDefault();
				e.stopPropagation();
				openFindBar();
				return;
			}
			if (!bindsFor('command-palette').includes(chord)) return;
			if (!paletteOpen && document.querySelector('.modal-open')) return; // another modal owns the keyboard
			e.preventDefault();
			e.stopPropagation();
			paletteOpen = !paletteOpen;
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});

	// Brief "Saved" confirmation for a Cmd/Ctrl+S save. Fades out on its own.
	let savedToast = $state(false);
	let savedTimer: ReturnType<typeof setTimeout>;
	function showSavedToast() {
		savedToast = true;
		clearTimeout(savedTimer);
		savedTimer = setTimeout(() => (savedToast = false), 1400);
	}
	async function saveActiveNotebook() {
		const api = activeNotebookApi();
		if (!api) return;
		await api.save();
		showSavedToast();
	}
</script>

<div class="flex h-screen flex-col overflow-hidden bg-base-200 text-base-content">
	<Navbar
		{tabs}
		{activeTabId}
		{tabRunState}
		{sidebarOpen}
		kernelInfo={displayKernel}
		canConsolidateImports={!!activeNotebookPath}
		{consolidating}
		canSaveAsPy={!!activeNotebookPath}
		canConvertToIpynb={activeNotebookIsPy}
		{converting}
		canExportHtml={!!activeNotebookPath}
		canRunActions={!!activeNotebookPath}
		canCheckpoint={!!activeNotebookPath}
		canHideCode={!!activeNotebookPath}
		hideAllCode={activeHideAllCode}
		followRunningCell={followRunningCell}
		onSelectTab={selectTab}
		onJumpToRunningCell={jumpToRunningCell}
		onCloseTab={closeTab}
		onPromoteTab={promoteTab}
		onToggleSidebar={() => (sidebarOpen = !sidebarOpen)}
		onConsolidateImports={consolidateImports}
		onExportPy={exportPy}
		onSaveAsPy={openSaveAsPy}
		onConvertToIpynb={convertToIpynb}
		onExportHtml={exportHtml}
		onRunStale={runStaleActive}
		onRunAbove={runAboveActive}
		onRunBelow={runBelowActive}
		onCheckpointNow={checkpointNow}
		onUndoAgent={undoLastAgentAction}
		onToggleHideAllCode={toggleHideAllCode}
		onToggleFollowRunningCell={toggleFollowRunningCell}
		onOpenSettings={() => (settingsOpen = true)}
	/>

	<div class="flex min-h-0 flex-1">
		{#if sidebarOpen}
			<div class="shrink-0 border-r border-base-300" style="width: {sidebarWidth}px">
				<Sidebar
					cells={activeCells}
					searchCache={activeSearchCache}
					foldedIds={activeFolds?.foldedIds ?? EMPTY_FOLDS}
					foldCounts={activeFolds?.folding?.counts ?? {}}
					runningId={activeRunState?.runningId ?? null}
					queued={activeRunState?.queued ?? EMPTY_QUEUED}
					onToggleFold={toggleActiveFold}
					onCollapseAllFolds={collapseAllActiveFolds}
					onExpandAllFolds={expandAllActiveFolds}
					headingNumbers={activeNumbering?.numbers ?? EMPTY_NUMBERS}
					numberingLevels={activeNumbering?.levels ?? EMPTY_LEVELS}
					onToggleNumberingLevel={toggleActiveNumberingLevel}
					{mcp}
					kernelInfo={displayKernel}
					{kernelCards}
					{maxKernels}
					{variables}
					{varsLoading}
					{varsError}
					{activeFilePath}
					{activeNotebookPath}
					{fsRefreshSignal}
					onRefreshVars={refreshVariables}
					onRefreshKernel={refreshKernel}
					onInterruptKernel={interruptKernel}
					onRestartKernel={restartKernel}
					onShutdownKernel={shutdownKernel}
					onWipeKernel={wipeKernel}
					onInsertAndRun={canInsertAndRun}
					onDatabricksSessionChange={onDatabricksSessionChange}
					onOpenFile={openFile}
					onOpenFilePermanent={openFilePermanent}
					onFocusNotebook={selectTab}
					onScrollToCell={scrollToCell}
					onOpenFindBar={openFindBar}
					onFsChange={handleFsChange}
				/>
			</div>
			<!-- Drag handle to resize the sidebar (persisted width). -->
			<div
				class="relative w-1 shrink-0 cursor-col-resize bg-base-300/40 hover:bg-primary/50 {resizing ? 'bg-primary/60' : ''}"
				onpointerdown={startResize}
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize sidebar"
				data-testid="sidebar-resizer"
			></div>
		{/if}

		<main class="relative min-w-0 flex-1 overflow-hidden">
			<!-- Floating find-in-page bar over the active notebook pane (Search P3).
			     Reads the active notebook's cells + shared search cache; every jump
			     routes to the active notebook's `jumpToCell` (mounts a windowed-out
			     match before scrolling). -->
			<FindBar
				open={findOpen}
				cells={activeCells}
				searchCache={activeSearchCache}
				seed={findSeed}
				onClose={closeFindBar}
				onJump={jumpToMatch}
			/>
			<!-- Every open notebook stays mounted (editor + run state preserved),
			     just hidden. The default notebook and opened `.ipynb` files use the
			     same live component; each persists to its own file. -->
			{#if notebookOpen}
				<div class="h-full overflow-y-auto {activeTabId === 'notebook' ? '' : 'hidden'}">
					<LiveNotebook
						path={canonicalNotebookRel}
						virtualize={virtualizeCells}
						active={activeTabId === 'notebook'}
						follow={followRunningCell}
						gitRefresh={fsRefreshSignal}
						onCellsChange={handleCellsChange}
						onFoldsChange={handleFoldsChange}
						onNumberingChange={handleNumberingChange}
						onHideAllCodeChange={handleHideAllCodeChange}
						onRunStateChange={handleRunStateChange}
						onRegisterFolds={registerFolds}
						onRegisterNumbering={registerNumbering}
						onRegisterApi={registerNotebookApi}
						onRegisterSearchCache={registerSearchCache}
						onRunStart={onRunStart}
						onRunEnd={onRunEnd}
						onInterruptKernel={() => interruptKernel(canonicalNotebookRel)}
						onBlame={handleBlame}
					/>
				</div>
			{/if}

			{#each ipynbTabs as tab (tab.id)}
				<div class="h-full overflow-y-auto {activeTabId === tab.id ? '' : 'hidden'}">
					<LiveNotebook
						path={tab.path}
						virtualize={virtualizeCells}
						active={activeTabId === tab.id}
						follow={followRunningCell}
						gitRefresh={fsRefreshSignal}
						onCellsChange={handleCellsChange}
						onFoldsChange={handleFoldsChange}
						onNumberingChange={handleNumberingChange}
						onHideAllCodeChange={handleHideAllCodeChange}
						onRunStateChange={handleRunStateChange}
						onRegisterFolds={registerFolds}
						onRegisterNumbering={registerNumbering}
						onRegisterApi={registerNotebookApi}
						onRegisterSearchCache={registerSearchCache}
						onRunStart={onRunStart}
						onRunEnd={onRunEnd}
						onInterruptKernel={() => interruptKernel(tab.path)}
						onBlame={handleBlame}
					/>
				</div>
			{/each}

			{#each fileTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<FileTab path={tab.path} onDirty={onFileDirty} gitRefresh={fsRefreshSignal} onBlame={handleBlame} />
				</div>
			{/each}

			{#each imageTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<ImageTab path={tab.path} />
				</div>
			{/each}

			{#if tabsRestored && !activeTab}
				<!-- Empty state: no tab open (first-ever open, or all tabs closed). -->
				<div class="flex h-full flex-col items-center justify-center gap-4 text-center" data-testid="empty-state">
					<div class="text-5xl opacity-30">🍷</div>
					<div class="text-sm text-base-content/50">No notebook open</div>
					<p class="max-w-xs text-xs text-base-content/40">Open a file from the sidebar, or create a notebook for this workspace.</p>
					<button class="btn btn-sm btn-primary" onclick={newNotebook} data-testid="empty-open-notebook">New notebook</button>
				</div>
			{/if}
		</main>
	</div>

	<!-- Logs drawer: a resizable bottom console streaming server-side log lines. -->
	{#if logsOpen}
		<div
			class="h-1 shrink-0 cursor-row-resize bg-base-300/40 hover:bg-primary/50 {logsResizing ? 'bg-primary/60' : ''}"
			onpointerdown={startLogsResize}
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize logs"
			data-testid="logs-resizer"
		></div>
		<div class="shrink-0" style="height: {logsHeight}px">
			<LogsPanel open={logsOpen} onClose={toggleLogs} />
		</div>
	{/if}

	<footer class="flex items-center justify-between border-t border-base-300 bg-base-100 px-3 py-1 text-[11px] text-base-content/40">
		<div class="flex items-center gap-3">
			<button
				class="flex items-center gap-1 rounded px-1 hover:bg-base-300/50 hover:text-base-content/70 {logsOpen ? 'text-base-content/70' : ''}"
				onclick={toggleLogs}
				data-testid="logs-toggle"
				title="Toggle logs console"
			>
				<span>Logs</span>
				{#if logsUnseenErrors > 0}
					<span class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-error px-1 text-[9px] font-semibold leading-none text-error-content" data-testid="logs-unseen">{logsUnseenErrors > 99 ? '99+' : logsUnseenErrors}</span>
				{/if}
			</button>
			<span class="truncate">workspace: <span class="font-mono">{workspace}</span></span>
		</div>

		<!-- Git blame for the active tab (GitLens-style): a file's cursor line, or a
		     notebook's FOCUSED CELL; who last touched it and when, commit summary +
		     short SHA on hover. Hidden when there's no blame (no focused cell,
		     untracked file/notebook, or non-git). -->
		{#if activeBlame}
			<span
				class="flex min-w-0 items-center gap-1 truncate text-base-content/55"
				title={activeBlame.notCommitted
					? 'Not committed yet'
					: `${activeBlame.shortSha} · ${activeBlame.summary}`}
				data-testid="blame-status"
			>
				<svg class="h-3 w-3 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><line x1="1.5" y1="12" x2="8" y2="12" /><line x1="16" y1="12" x2="22.5" y2="12" /></svg>
				<span class="truncate">
					{#if activeBlame.notCommitted}
						You, uncommitted
					{:else}
						{activeBlame.author}, {relativeTimeLong(activeBlame.authorTime)}
					{/if}
				</span>
			</span>
		{/if}

		<span class="font-mono">{activeCells.length} cells</span>
	</footer>
</div>

<CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => (paletteOpen = false)} />

{#if savedToast}
	<div
		class="pointer-events-none fixed bottom-5 right-5 z-[60]"
		transition:fade={{ duration: 180 }}
		data-testid="saved-toast"
	>
		<div
			class="flex items-center gap-2 rounded-lg border border-base-300 bg-base-100 px-3 py-2 text-sm text-base-content shadow-lg"
		>
			<svg class="h-4 w-4 text-success" viewBox="0 0 20 20" fill="none" aria-hidden="true">
				<path
					d="M5 10.5l3.5 3.5L15 6.5"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			Saved
		</div>
	</div>
{/if}

<Settings
	open={settingsOpen}
	{theme}
	onClose={() => (settingsOpen = false)}
	onSetTheme={applyTheme}
	onVenvRebound={() => {
		// New interpreter → namespace is empty; drop stale inspector rows and refresh status.
		variables = [];
		refreshKernel();
	}}
/>

<!-- Save as .py — jupytext/Databricks export with a format picker (Databricks default). -->
{#if saveAsPyOpen}
	<div class="modal modal-open" data-testid="save-as-py-modal">
		<div class="modal-box max-w-md">
			<h3 class="text-base font-semibold">Save notebook as .py</h3>
			<p class="mt-1 text-xs text-base-content/50">A jupytext text notebook — source only, no outputs. Ideal for git and Databricks.</p>

			<label class="mt-4 block text-xs font-medium text-base-content/70" for="save-as-py-format">Format</label>
			<select id="save-as-py-format" class="select select-bordered select-sm mt-1 w-full" bind:value={saveAsPyFormat} data-testid="save-as-py-format">
				<option value="databricks">Databricks source (# COMMAND / # MAGIC)</option>
				<option value="percent">Percent (# %%)</option>
			</select>

			<label class="mt-3 block text-xs font-medium text-base-content/70" for="save-as-py-name">File path</label>
			<input id="save-as-py-name" class="input input-bordered input-sm mt-1 w-full font-mono" bind:value={saveAsPyName} spellcheck="false" data-testid="save-as-py-name" />

			<div class="modal-action mt-5">
				<button class="btn btn-sm btn-ghost" onclick={() => (saveAsPyOpen = false)} disabled={saveAsPyBusy}>Cancel</button>
				<button class="btn btn-sm btn-primary" onclick={doSaveAsPy} disabled={saveAsPyBusy || !saveAsPyName.trim()} data-testid="save-as-py-confirm">
					{#if saveAsPyBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
					Save
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (saveAsPyOpen = false)} aria-label="Close">close</button>
	</div>
{/if}

<!-- Transient status line for jupytext actions (dismissable). -->
{#if notice}
	<div class="toast toast-end toast-bottom z-[100]" data-testid="jupytext-notice">
		<div class="alert alert-info max-w-md text-sm shadow-lg">
			<span class="min-w-0 break-words">{notice}</span>
			<button class="btn btn-ghost btn-xs btn-square" onclick={() => (notice = '')} aria-label="Dismiss">✕</button>
		</div>
	</div>
{/if}

<style>
	:global(.cellar-flash) {
		animation: cellar-flash 1.2s ease-out;
	}
	@keyframes cellar-flash {
		0% {
			box-shadow: 0 0 0 2px var(--color-primary, #7dd3fc);
		}
		100% {
			box-shadow: 0 0 0 2px transparent;
		}
	}
</style>
