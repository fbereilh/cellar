<script>
	import { onMount, tick } from 'svelte';
	import Navbar from '$lib/Navbar.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	import LiveNotebook from '$lib/LiveNotebook.svelte';
	import FileTab from '$lib/FileTab.svelte';
	import Settings from '$lib/Settings.svelte';

	let { data } = $props();

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

	// Single shared kernel → at most one cell runs at a time across ALL notebooks.
	let runBusy = $state(false);
	function onRunStart() {
		runBusy = true;
	}
	function onRunEnd() {
		runBusy = false;
		// A run may have created/changed kernel variables → refresh sidebar.
		refreshKernel();
		refreshVariables();
	}

	// ---- Shell state ---------------------------------------------------------
	let sidebarOpen = $state(true);
	let settingsOpen = $state(false);
	let theme = $state('dim');
	const mcp = data.mcp;

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
	const activeFilePath = $derived(activeTab && activeTab.kind === 'file' ? activeTab.path : null);

	// Which notebook the sidebar (outline / search / variables) reflects: the
	// active notebook tab, else the default when a plain file / nothing is active.
	const activeNotebookPath = $derived(
		activeTab?.kind === 'notebook' ? canonicalNotebookRel : activeTab?.kind === 'ipynb' ? activeTab.path : canonicalNotebookRel
	);
	const activeCells = $derived(notebooksCells[activeNotebookPath] ?? []);

	function tabIdFor(path) {
		return path === canonicalNotebookRel ? 'notebook' : 'file:' + path;
	}
	function makeTab(path, preview) {
		if (path === canonicalNotebookRel) {
			return { id: 'notebook', kind: 'notebook', title: notebookName, path, closable: true, dirty: false, preview };
		}
		const kind = /\.ipynb$/i.test(path) ? 'ipynb' : 'file';
		return { id: 'file:' + path, kind, title: path.split('/').pop(), path, closable: true, dirty: false, preview };
	}

	function selectTab(id) {
		activeTabId = id;
	}

	// Single-click a tree file → open in the single shared preview slot. If a tab
	// for it already exists (preview or pinned) just focus it; otherwise reuse the
	// existing preview tab's slot, or append one.
	function openFile(path) {
		const id = tabIdFor(path);
		if (tabs.find((t) => t.id === id)) {
			activeTabId = id;
			return;
		}
		const tab = makeTab(path, true);
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
	function openFilePermanent(path) {
		const id = tabIdFor(path);
		const existing = tabs.find((t) => t.id === id);
		if (existing) {
			if (existing.preview) tabs = tabs.map((t) => (t.id === id ? { ...t, preview: false } : t));
			activeTabId = id;
			return;
		}
		tabs = [...tabs, makeTab(path, false)];
		activeTabId = id;
	}

	function promoteTab(id) {
		tabs = tabs.map((t) => (t.id === id ? { ...t, preview: false } : t));
	}

	function openNotebook() {
		openFilePermanent(canonicalNotebookRel);
	}

	function closeTab(id) {
		const idx = tabs.findIndex((t) => t.id === id);
		tabs = tabs.filter((t) => t.id !== id);
		if (activeTabId === id) {
			activeTabId = (tabs[idx - 1] ?? tabs[0] ?? null)?.id ?? null;
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
		let saved = null;
		try {
			saved = localStorage.getItem(TABS_KEY);
		} catch {}
		if (saved == null) {
			// First-ever open of this workspace → empty state, no tabs.
			tabs = [];
			activeTabId = null;
		} else {
			try {
				const parsed = JSON.parse(saved);
				tabs = (parsed.tabs ?? []).map((t) => makeTab(t.path, !!t.preview));
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
		const snapshot = JSON.stringify({
			tabs: tabs.map((t) => ({ path: t.path, preview: t.preview })),
			activeTabId
		});
		try {
			localStorage.setItem(TABS_KEY, snapshot);
		} catch {}
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
			try {
				localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
			} catch {}
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}

	// Bump to make the sidebar re-read the file tree + git status (after saves).
	let fsRefreshSignal = $state(0);

	async function scrollToCell(id) {
		// Open + focus the notebook the outline currently reflects, then scroll.
		if (activeNotebookPath === canonicalNotebookRel) openNotebook();
		else openFilePermanent(activeNotebookPath);
		await tick();
		// Multiple notebooks stay mounted (hidden); pick the visible cell.
		const els = document.querySelectorAll(`[data-cell-id="${id}"]`);
		const el = [...els].find((e) => e.offsetParent !== null) ?? els[0];
		if (!el) return;
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('cellar-flash');
		setTimeout(() => el.classList.remove('cellar-flash'), 1200);
	}

	// ---- Kernel + variables (sidebar) ---------------------------------------
	let kernelInfo = $state({ started: false, id: null, name: 'python3', status: 'not started' });
	let variables = $state([]);
	let varsLoading = $state(false);
	let varsError = $state('');

	const displayKernel = $derived(runBusy ? { ...kernelInfo, started: true, status: 'busy' } : kernelInfo);

	async function refreshKernel() {
		try {
			const res = await fetch('/api/kernel');
			if (res.ok) kernelInfo = await res.json();
		} catch {}
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
	function applyTheme(t) {
		theme = t;
		if (typeof document !== 'undefined') document.documentElement.dataset.theme = t;
		try {
			localStorage.setItem('cellar-theme', t);
		} catch {}
	}

	onMount(() => {
		const saved = (() => {
			try {
				return localStorage.getItem('cellar-theme');
			} catch {
				return null;
			}
		})();
		applyTheme(saved || document.documentElement.dataset.theme || 'dim');
		// Restore per-workspace tab session + sidebar width.
		restoreTabs();
		try {
			const w = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
			if (w) sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
		} catch {}
		// Restore live kernel + variables after a reload — but only inspect if a
		// kernel already exists, so a fresh page load never boots one on its own.
		refreshKernel().then(() => {
			if (kernelInfo.started) refreshVariables();
		});
	});
</script>

<div class="flex h-screen flex-col overflow-hidden bg-base-200 text-base-content">
	<Navbar
		{tabs}
		{activeTabId}
		{sidebarOpen}
		kernelInfo={displayKernel}
		onSelectTab={selectTab}
		onCloseTab={closeTab}
		onPromoteTab={promoteTab}
		onToggleSidebar={() => (sidebarOpen = !sidebarOpen)}
		onOpenSettings={() => (settingsOpen = true)}
	/>

	<div class="flex min-h-0 flex-1">
		{#if sidebarOpen}
			<div class="shrink-0 border-r border-base-300" style="width: {sidebarWidth}px">
				<Sidebar
					cells={activeCells}
					{mcp}
					kernelInfo={displayKernel}
					{kernelBusy}
					{notebookName}
					{variables}
					{varsLoading}
					{varsError}
					{activeFilePath}
					{fsRefreshSignal}
					onRefreshVars={refreshVariables}
					onRefreshKernel={refreshKernel}
					onInterruptKernel={interruptKernel}
					onRestartKernel={restartKernel}
					onOpenFile={openFile}
					onOpenFilePermanent={openFilePermanent}
					onOpenNotebook={openNotebook}
					onScrollToCell={scrollToCell}
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
						busy={runBusy}
						{theme}
						onCellsChange={handleCellsChange}
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
						busy={runBusy}
						{theme}
						onCellsChange={handleCellsChange}
						onRunStart={onRunStart}
						onRunEnd={onRunEnd}
					/>
				</div>
			{/each}

			{#each fileTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<FileTab path={tab.path} onDirty={onFileDirty} />
				</div>
			{/each}

			{#if tabsRestored && !activeTab}
				<!-- Empty state: no tab open (first-ever open, or all tabs closed). -->
				<div class="flex h-full flex-col items-center justify-center gap-4 text-center" data-testid="empty-state">
					<div class="text-5xl opacity-30">🍷</div>
					<div class="text-sm text-base-content/50">No open files</div>
					<p class="max-w-xs text-xs text-base-content/40">Open a file from the sidebar, or open this workspace's notebook.</p>
					<button class="btn btn-sm btn-primary" onclick={openNotebook} data-testid="empty-open-notebook">Open notebook</button>
				</div>
			{/if}
		</main>
	</div>

	<footer class="flex items-center justify-between border-t border-base-300 bg-base-100 px-3 py-1 text-[11px] text-base-content/40">
		<span class="truncate">workspace: <span class="font-mono">{workspace}</span></span>
		<span class="font-mono">{activeCells.length} cells</span>
	</footer>
</div>

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
