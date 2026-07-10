<script>
	import { onMount, tick } from 'svelte';
	import Navbar from '$lib/Navbar.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	import LiveNotebook from '$lib/LiveNotebook.svelte';
	import FileTab from '$lib/FileTab.svelte';
	import Settings from '$lib/Settings.svelte';
	import CommandPalette from '$lib/CommandPalette.svelte';
	import { buildCommands } from '$lib/commands.js';
	import { shortcuts, chordFromEvent } from '$lib/shortcuts.svelte.js';
	import LogsPanel from '$lib/LogsPanel.svelte';
	import { subscribeEvents, originId } from '$lib/events-client.js';
	import { hydrateUiState, getUi, setUi } from '$lib/uiState.js';

	const isPyPath = (p) => /\.py$/i.test(p);

	let { data } = $props();

	// Seed the per-project UI-preference cache from SSR before any child reads a
	// preference (this runs during init, ahead of every onMount). Port-independent:
	// this is what survives the dynamic app port that empties `localStorage`.
	hydrateUiState(data.uiState);

	const EMPTY_FOLDS = new Set(); // no notebook active → the Outline folds nothing

	const workspace = data.notebook.workspace;
	const notebookPath = data.notebook.path;
	const notebookName = notebookPath.split('/').pop();

	// Workspace-relative path of the canonical (default) notebook. Opening it from
	// the file tree routes to the live notebook tab (id 'notebook').
	const canonicalNotebookRel = notebookPath.startsWith(workspace)
		? notebookPath.slice(workspace.length).replace(/^[/\\]+/, '')
		: notebookName;

	// Live cells per open notebook (path → the notebook's reactive cell array),
	// reported up by each LiveNotebook so the sidebar (outline / search) can read
	// whichever notebook is active. Seeded with the default notebook's SSR cells
	// so the sidebar reflects it even before its tab is mounted.
	let notebooksCells = $state({ [canonicalNotebookRel]: data.notebook.cells });
	function handleCellsChange(path, cells) {
		notebooksCells[path] = cells;
	}

	// Collapsible-heading state per open notebook, reported up by each LiveNotebook
	// (which owns it and persists it). The sidebar Outline renders its chevrons from
	// exactly this state and toggles it through the notebook's own `toggleFold`, so
	// outline and notebook are one fold state, not two that must be kept in step.
	// Assign into the key, never rebuild the map: a spread would *read* this state
	// inside the reporting effect that writes it, and Svelte would loop forever.
	let notebooksFolds = $state({}); // path → { foldedIds, folding }
	function handleFoldsChange(path, foldedIds, folding) {
		notebooksFolds[path] = { foldedIds, folding };
	}
	// Imperative, not reactive: a plain map of path → the notebook's fold API
	// ({toggle, collapseAll, expandAll}). The Outline drives every fold through this.
	const foldTogglers = new Map();
	function registerFolds(path, api) {
		if (api) foldTogglers.set(path, api);
		else foldTogglers.delete(path);
	}
	function toggleActiveFold(key) {
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
	const notebookApis = new Map();
	function registerNotebookApi(path, api) {
		if (api) notebookApis.set(path, api);
		else notebookApis.delete(path);
	}

	/**
	 * Append a code cell to the active notebook and run it - the sidebar's
	 * point-and-click table preview. Focus the notebook's tab first: a hidden pane
	 * is `display:none`, so it has no geometry and the new cell could not be
	 * scrolled into view.
	 */
	async function insertAndRunInActiveNotebook(code) {
		const path = activeNotebookPath;
		const api = path && notebookApis.get(path);
		if (!api) return; // no notebook open (or one still mounting)
		if (path === canonicalNotebookRel) openNotebook();
		else openFilePermanent(path);
		await tick();
		await api.insertAndRunCode(code);
	}

	// Null disables the sidebar's preview affordance rather than minting a tab
	// behind the user's back. `notebookApis` is a plain Map (not reactive), so the
	// gate reads `activeNotebookPath`, which is - the api is looked up at call time.
	const canInsertAndRun = $derived(activeNotebookPath ? insertAndRunInActiveNotebook : null);

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
	// Transient, dismissable status line (jupytext env not ready, convert result, …).
	let notice = $state('');
	let theme = $state('dim');
	const mcp = data.mcp;

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
	function startLogsResize(e) {
		logsResizing = true;
		const startY = e.clientY;
		const startH = logsHeight;
		e.preventDefault();
		function onMove(ev) {
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
	let tabs = $state([]);
	let activeTabId = $state(null);
	let tabsRestored = $state(false);
	const fileTabs = $derived(tabs.filter((t) => t.kind === 'file'));
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
	const activeFolds = $derived((activeNotebookPath && notebooksFolds[activeNotebookPath]) || null);

	// Notebooks currently open in the shell (the default notebook tab + every
	// opened `.ipynb`). With the single-shared-kernel model these are exactly the
	// notebooks loaded against that one kernel, so the sidebar Kernels section
	// lists them under it. Derived from tabs → updates live as notebooks open/close.
	// The dot reads `activeNotebookPath`, the same source of truth the outline and
	// search sections use, so every sidebar section agrees on which notebook is
	// active - including agreeing on "none" while a plain file tab holds focus and
	// no notebook tab is open.
	const openNotebooks = $derived(
		tabs
			.filter((t) => t.kind === 'notebook' || t.kind === 'ipynb')
			.map((t) => ({ id: t.id, path: t.path, name: t.title, active: t.path === activeNotebookPath }))
	);

	function tabIdFor(path) {
		return path === canonicalNotebookRel ? 'notebook' : 'file:' + path;
	}
	// A `.py` is a live notebook only when content-detection says so; the kind is
	// resolved once (server GET) and cached so it survives tab restore without a
	// re-probe. `.ipynb` is always a notebook; everything else opens as text.
	const pyKindCache = new Map(); // rel path → 'ipynb' | 'file'
	function baseKindFor(path) {
		if (/\.ipynb$/i.test(path)) return 'ipynb';
		if (isPyPath(path)) return pyKindCache.get(path) ?? 'file';
		return 'file';
	}
	async function resolveTabKind(path) {
		if (!isPyPath(path)) return baseKindFor(path);
		if (pyKindCache.has(path)) return pyKindCache.get(path);
		let kind = 'file';
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
	function makeTab(path, preview, kind) {
		if (path === canonicalNotebookRel) {
			return { id: 'notebook', kind: 'notebook', title: notebookName, path, closable: true, dirty: false, preview };
		}
		return { id: 'file:' + path, kind: kind ?? baseKindFor(path), title: path.split('/').pop(), path, closable: true, dirty: false, preview };
	}

	function selectTab(id) {
		activeTabId = id;
	}

	// Single-click a tree file → open in the single shared preview slot. If a tab
	// for it already exists (preview or pinned) just focus it; otherwise reuse the
	// existing preview tab's slot, or append one. A `.py` is content-probed first
	// (async) so it opens as a live notebook or as text, per detection.
	async function openFile(path) {
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
	async function openFilePermanent(path) {
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

	function promoteTab(id) {
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

	function closeTab(id) {
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
	function remapRel(p, from, to) {
		if (p === from) return to;
		if (p.startsWith(from + '/')) return to + p.slice(from.length);
		return null;
	}
	function handleFsChange(change) {
		if (change.type === 'delete') {
			const gone = tabs.filter((t) => t.path === change.path || t.path.startsWith(change.path + '/'));
			for (const t of gone) closeTab(t.id);
			return;
		}
		if (change.type === 'rename' || change.type === 'move') {
			let nextActive = activeTabId;
			tabs = tabs.map((t) => {
				const np = remapRel(t.path, change.from, change.path);
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

	function onFileDirty(path, dirty) {
		const id = 'file:' + path;
		// Editing a previewed file promotes it to a permanent tab, like VS Code.
		tabs = tabs.map((t) => (t.id === id ? { ...t, dirty, preview: dirty ? false : t.preview } : t));
		// A save (dirty→false) may change git status → refresh decorations.
		if (!dirty) fsRefreshSignal++;
	}

	// ---- Tab session memory (per workspace) ---------------------------------
	const TABS_KEY = 'cellar-tabs:' + workspace;
	function restoreTabs() {
		const parsed = getUi(TABS_KEY, null);
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
				activeTabId = ids.has(parsed.activeTabId) ? parsed.activeTabId : (tabs[0]?.id ?? null);
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
	function startResize(e) {
		resizing = true;
		const startX = e.clientX;
		const startW = sidebarWidth;
		e.preventDefault();
		function onMove(ev) {
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
			notice = `Save as .py failed: ${err?.message ?? err}`;
		} finally {
			saveAsPyBusy = false;
		}
	}

	// Convert the active `.py` notebook to an `.ipynb` with outputs: the server runs
	// every cell then writes <base>.ipynb, which we then open as a live notebook.
	async function convertToIpynb() {
		if (converting || !activeNotebookIsPy) return;
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
			notice = `Convert failed: ${err?.message ?? err}`;
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

	// ---- Bulk run actions (navbar) -------------------------------------------
	// Delegate to the active notebook's registered API (the same `notebookApis`
	// registry the Databricks preview uses). Run above/below act on that notebook's
	// own selected cell; run-stale re-runs everything its dependency graph marks
	// stale, in order. The notebook must be focused first: a hidden pane has no
	// geometry, so a scrolled-into-view running cell would have nowhere to land.
	function runNotebookAction(name) {
		const path = activeNotebookPath;
		const api = path && notebookApis.get(path);
		if (!api?.[name]) return;
		if (path === canonicalNotebookRel) openNotebook();
		else openFilePermanent(path);
		api[name]();
	}
	const runStaleActive = () => runNotebookAction('runStale');
	const runAboveActive = () => runNotebookAction('runAbove');
	const runBelowActive = () => runNotebookAction('runBelow');

	async function scrollToCell(id, foldKey = null) {
		// Open + focus the notebook the outline currently reflects, then scroll. With
		// no active notebook the outline and search are empty, so there is no row to
		// click - but never let a null path mint a tab if one ever gets here.
		if (!activeNotebookPath) return;
		if (activeNotebookPath === canonicalNotebookRel) openNotebook();
		else openFilePermanent(activeNotebookPath);
		await tick();
		// Multiple notebooks stay mounted (hidden); pick the visible cell.
		const els = document.querySelectorAll(`[data-cell-id="${id}"]`);
		const el = [...els].find((e) => e.offsetParent !== null) ?? els[0];
		if (!el) return;
		// An outline row addresses a heading, and a cell can hold several - scroll to
		// the heading itself when we know which, but flash the whole cell.
		const target = (foldKey && el.querySelector(`[data-fold-key="${CSS.escape(foldKey)}"]`)?.closest('[data-testid="heading-row"]')) || el;
		target.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('cellar-flash');
		setTimeout(() => el.classList.remove('cellar-flash'), 1200);
	}

	// ---- Kernel + variables (sidebar) ---------------------------------------
	let kernelInfo = $state({ started: false, id: null, name: 'python3', status: 'not started' });
	let variables = $state([]);
	let varsLoading = $state(false);
	let varsError = $state('');

	const displayKernel = $derived(runBusy ? { ...kernelInfo, started: true, status: 'busy' } : kernelInfo);

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
			const info = await res.json();
			if (seq !== kernelReqSeq) return; // superseded while in flight → drop it
			kernelInfo = info;
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
			variables = body.variables;
		} catch (err) {
			varsError = String(err?.message ?? err);
		} finally {
			varsLoading = false;
		}
	}

	// Interrupt / restart the active kernel. Both reuse the exact kernel.js path
	// the MCP agent interface proved: restart keeps the same session (document
	// intact) while clearing the namespace.
	let kernelBusy = $state(false);
	async function interruptKernel() {
		if (kernelBusy) return;
		kernelBusy = true;
		try {
			await fetch('/api/kernel/interrupt', { method: 'POST' });
		} catch {}
		finally {
			kernelBusy = false;
			refreshKernel();
		}
	}
	async function restartKernel() {
		if (kernelBusy) return;
		kernelBusy = true;
		try {
			await fetch('/api/kernel/restart', { method: 'POST' });
			// Namespace is cleared on restart — drop the now-stale inspector rows.
			variables = [];
		} catch {}
		finally {
			kernelBusy = false;
			refreshKernel();
		}
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
	function applyTheme(t) {
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
		logsOpen = getUi(LOGS_OPEN_KEY, '0') === '1';
		const h = Number(getUi(LOGS_HEIGHT_KEY, 0));
		if (h) logsHeight = Math.min(LOGS_MAX, Math.max(LOGS_MIN, h));
		// Restore live kernel + variables after a reload — but only inspect if a
		// kernel already exists, so a fresh page load never boots one on its own.
		refreshKernel().then(() => {
			if (kernelInfo.started) refreshVariables();
		});
	});

	// Surface an agent-created / newly-active notebook live: when the MCP
	// `create_notebook` tool runs, the server broadcasts `notebook:opened` so we
	// open (or focus) a permanent tab for it with no reload. Our own actions carry
	// this tab's `originId` and are skipped. `openFilePermanent` maps the default
	// notebook's relative path to the canonical 'notebook' tab and any other
	// `.ipynb` to a live `ipynb` tab — the same paths a tree double-click uses.
	onMount(() =>
		subscribeEvents((ev) => {
			// Flag errors that arrive while the logs drawer is closed, so the status-bar
			// toggle can show a red dot the user can act on.
			if (ev.type === 'log' && ev.entry?.level === 'error' && !logsOpen) {
				logsUnseenErrors += 1;
			}
			if (ev.type !== 'notebook:opened') return;
			if (ev.originId && ev.originId === originId) return;
			if (!ev.relPath) return;
			openFilePermanent(ev.relPath);
		})
	);

	// ---- Command palette (Cmd/Ctrl+K) ---------------------------------------
	// The palette invokes notebook commands through the active notebook's
	// registered api (`dispatch` runs the same action the keyboard runs) and
	// app/kernel commands through these shell handlers. Notebook commands are
	// disabled while no notebook tab is active; the api is resolved at call time
	// (`notebookApis` is a plain Map, so the reactive gate is `activeNotebookPath`).
	function toggleTheme() {
		applyTheme(theme === 'dim' ? 'nord' : 'dim');
	}
	function activeNotebookApi() {
		return (activeNotebookPath && notebookApis.get(activeNotebookPath)) || null;
	}
	const notebookCommandHandle = $derived(
		activeNotebookPath
			? {
					dispatch: (id) => activeNotebookApi()?.dispatch(id),
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
				interruptKernel,
				restartKernel,
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
		function onKey(e) {
			const chord = chordFromEvent(e);
			if (!chord) return;
			const keys = shortcuts.list.find((s) => s.id === 'command-palette')?.keys ?? [];
			if (!keys.includes(chord)) return;
			if (!paletteOpen && document.querySelector('.modal-open')) return; // another modal owns the keyboard
			e.preventDefault();
			e.stopPropagation();
			paletteOpen = !paletteOpen;
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});
</script>

<div class="flex h-screen flex-col overflow-hidden bg-base-200 text-base-content">
	<Navbar
		{tabs}
		{activeTabId}
		{sidebarOpen}
		kernelInfo={displayKernel}
		canConsolidateImports={!!activeNotebookPath}
		{consolidating}
		canSaveAsPy={!!activeNotebookPath}
		canConvertToIpynb={activeNotebookIsPy}
		{converting}
		canExportHtml={!!activeNotebookPath}
		canRunActions={!!activeNotebookPath}
		onSelectTab={selectTab}
		onCloseTab={closeTab}
		onPromoteTab={promoteTab}
		onToggleSidebar={() => (sidebarOpen = !sidebarOpen)}
		onConsolidateImports={consolidateImports}
		onSaveAsPy={openSaveAsPy}
		onConvertToIpynb={convertToIpynb}
		onExportHtml={exportHtml}
		onRunStale={runStaleActive}
		onRunAbove={runAboveActive}
		onRunBelow={runBelowActive}
		onOpenSettings={() => (settingsOpen = true)}
	/>

	<div class="flex min-h-0 flex-1">
		{#if sidebarOpen}
			<div class="shrink-0 border-r border-base-300" style="width: {sidebarWidth}px">
				<Sidebar
					cells={activeCells}
					foldedIds={activeFolds?.foldedIds ?? EMPTY_FOLDS}
					foldCounts={activeFolds?.folding?.counts ?? {}}
					onToggleFold={toggleActiveFold}
					onCollapseAllFolds={collapseAllActiveFolds}
					onExpandAllFolds={expandAllActiveFolds}
					{mcp}
					kernelInfo={displayKernel}
					{kernelBusy}
					{openNotebooks}
					{variables}
					{varsLoading}
					{varsError}
					{activeFilePath}
					{fsRefreshSignal}
					onRefreshVars={refreshVariables}
					onRefreshKernel={refreshKernel}
					onInterruptKernel={interruptKernel}
					onRestartKernel={restartKernel}
					onInsertAndRun={canInsertAndRun}
					onDatabricksSessionChange={onDatabricksSessionChange}
					onOpenFile={openFile}
					onOpenFilePermanent={openFilePermanent}
					onFocusNotebook={selectTab}
					onScrollToCell={scrollToCell}
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
			<!-- Every open notebook stays mounted (editor + run state preserved),
			     just hidden. The default notebook and opened `.ipynb` files use the
			     same live component; each persists to its own file. -->
			{#if notebookOpen}
				<div class="h-full overflow-y-auto {activeTabId === 'notebook' ? '' : 'hidden'}">
					<LiveNotebook
						path={canonicalNotebookRel}
						active={activeTabId === 'notebook'}
						gitRefresh={fsRefreshSignal}
						onCellsChange={handleCellsChange}
						onFoldsChange={handleFoldsChange}
						onRegisterFolds={registerFolds}
						onRegisterApi={registerNotebookApi}
						onRunStart={onRunStart}
						onRunEnd={onRunEnd}
					/>
				</div>
			{/if}

			{#each ipynbTabs as tab (tab.id)}
				<div class="h-full overflow-y-auto {activeTabId === tab.id ? '' : 'hidden'}">
					<LiveNotebook
						path={tab.path}
						active={activeTabId === tab.id}
						gitRefresh={fsRefreshSignal}
						onCellsChange={handleCellsChange}
						onFoldsChange={handleFoldsChange}
						onRegisterFolds={registerFolds}
						onRegisterApi={registerNotebookApi}
						onRunStart={onRunStart}
						onRunEnd={onRunEnd}
					/>
				</div>
			{/each}

			{#each fileTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<FileTab path={tab.path} onDirty={onFileDirty} gitRefresh={fsRefreshSignal} />
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
		<span class="font-mono">{activeCells.length} cells</span>
	</footer>
</div>

<CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => (paletteOpen = false)} />

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
