<script>
	import { onMount, tick } from 'svelte';
	import Navbar from '$lib/Navbar.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	import Notebook from '$lib/Notebook.svelte';
	import FileTab from '$lib/FileTab.svelte';
	import NotebookFileView from '$lib/NotebookFileView.svelte';
	import Settings from '$lib/Settings.svelte';

	let { data } = $props();

	// ---- Notebook state (owned here so the sidebar can read the same cells) --
	let cells = $state(data.notebook.cells);
	const workspace = data.notebook.workspace;
	const notebookPath = data.notebook.path;
	const notebookName = notebookPath.split('/').pop();

	let kernelState = $state('idle');
	let runningId = $state(null); // single kernel → one cell runs at a time

	// Each Cell registers a focus fn (by id) so Shift+Enter can advance focus.
	const focusers = {};
	function registerFocus(id, fn) {
		if (fn) focusers[id] = fn;
		else delete focusers[id];
	}

	function findCell(id) {
		return cells.find((c) => c.id === id);
	}

	async function runCell(id, source) {
		const cell = findCell(id);
		if (!cell) return;
		// Markdown "runs" by rendering client-side (in the Cell) — no kernel.
		if (cell.cell_type === 'markdown') {
			await editCell(id, source);
			return;
		}
		if (runningId) return;
		runningId = id;
		cell.source = source;
		let replace = true; // replace prior output only when new output arrives (no flash)
		try {
			const res = await fetch(`/api/cells/${id}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source })
			});
			const reader = res.body.getReader();
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
					if (ev.type === 'kernel') kernelState = 'kernel ready';
					else if (ev.type === 'status') kernelState = ev.execution_state;
					else if (ev.type === 'output') {
						if (replace) {
							cell.outputs = [ev.output];
							replace = false;
						} else {
							cell.outputs = [...cell.outputs, ev.output];
						}
					}
				}
			}
		} catch (err) {
			cell.outputs = [{ output_type: 'error', ename: 'CellarError', evalue: String(err), traceback: [String(err)] }];
			replace = false;
		} finally {
			if (replace) cell.outputs = []; // ran with no output → clear
			runningId = null;
			// A run may have created/changed kernel variables → refresh sidebar.
			refreshKernel();
			refreshVariables();
		}
	}

	async function editCell(id, source) {
		const cell = findCell(id);
		if (cell) cell.source = source;
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source })
		});
	}

	async function clearCell(id) {
		const cell = findCell(id);
		if (cell) cell.outputs = [];
		await fetch(`/api/cells/${id}/clear`, { method: 'POST' });
	}

	async function setType(id, cellType) {
		const cell = findCell(id);
		if (cell) {
			cell.cell_type = cellType;
			if (cellType === 'markdown') cell.outputs = [];
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cell_type: cellType })
		});
	}

	async function deleteCell(id) {
		cells = cells.filter((c) => c.id !== id);
		await fetch(`/api/cells/${id}`, { method: 'DELETE' });
	}

	async function moveCell(id, dir) {
		const i = cells.findIndex((c) => c.id === id);
		const j = dir === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= cells.length) return;
		const next = [...cells];
		[next[i], next[j]] = [next[j], next[i]];
		cells = next;
		await fetch(`/api/cells/${id}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ dir })
		});
	}

	async function addCell(afterId, cellType = 'code') {
		const res = await fetch('/api/cells', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ afterId, cellType })
		});
		const { cell } = await res.json();
		const view = { id: cell.id, cell_type: cell.cell_type, source: cell.source, outputs: cell.outputs };
		if (afterId) {
			const i = cells.findIndex((c) => c.id === afterId);
			cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
		} else {
			cells = [...cells, view];
		}
		return view;
	}

	// Shift+Enter: run in place, then move focus to the next cell (creating and
	// focusing a fresh empty cell if this is the last one) — Jupyter behavior.
	async function runAndAdvance(id, source) {
		runCell(id, source); // fire; advancing focus shouldn't wait for completion
		const i = cells.findIndex((c) => c.id === id);
		let nextId = i >= 0 && i < cells.length - 1 ? cells[i + 1].id : null;
		if (!nextId) {
			const created = await addCell(id);
			nextId = created.id;
		}
		await tick();
		focusers[nextId]?.();
	}

	// ---- Shell state ---------------------------------------------------------
	let sidebarOpen = $state(true);
	let settingsOpen = $state(false);
	let theme = $state('dim');
	const mcp = data.mcp;

	// Workspace-relative path of the canonical (live) notebook — opening it from
	// the file tree routes to the live notebook tab, not a read-only render.
	const canonicalNotebookRel = notebookPath.startsWith(workspace)
		? notebookPath.slice(workspace.length).replace(/^[/\\]+/, '')
		: notebookName;

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
		openNotebook();
		await tick();
		const el = document.querySelector(`[data-cell-id="${id}"]`);
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

	const displayKernel = $derived(runningId ? { ...kernelInfo, started: true, status: 'busy' } : kernelInfo);

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

	// Cmd+Shift+Arrow (Ctrl+Shift+Arrow off mac) moves the focused cell up/down.
	// Handled in the capture phase so it wins over CodeMirror's own arrow
	// bindings and the browser default before they can act.
	const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
	async function onKeydown(e) {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		const primary = isMac ? e.metaKey : e.ctrlKey;
		const other = isMac ? e.ctrlKey : e.metaKey;
		if (!primary || !e.shiftKey || e.altKey || other) return;
		// Act only on the cell that currently holds focus (its editor or chrome).
		const host = e.target?.closest?.('[data-cell-id]');
		if (!host) return;
		e.preventDefault();
		e.stopPropagation();
		const id = host.dataset.cellId;
		moveCell(id, e.key === 'ArrowUp' ? 'up' : 'down');
		// Reordering the list moves the editor's DOM node and drops focus, so
		// restore it to the same cell — this is what lets moves chain and keeps
		// the shortcut acting on "the selected cell" across repeated presses.
		await tick();
		focusers[id]?.();
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
		window.addEventListener('keydown', onKeydown, true);
		return () => window.removeEventListener('keydown', onKeydown, true);
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
					{cells}
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
			<!-- Notebook stays mounted (editor + run state preserved) — just hidden. -->
			{#if notebookOpen}
				<div class="h-full overflow-y-auto {activeTabId === 'notebook' ? '' : 'hidden'}">
					<Notebook
						{cells}
						{runningId}
						onRun={runCell}
						onRunAdvance={runAndAdvance}
						onClear={clearCell}
						onDelete={deleteCell}
						onMove={moveCell}
						onEdit={editCell}
						onSetType={setType}
						onReady={registerFocus}
						onAddCell={addCell}
					/>
				</div>
			{/if}

			{#each fileTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<FileTab path={tab.path} onDirty={onFileDirty} />
				</div>
			{/each}

			{#each ipynbTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<NotebookFileView path={tab.path} />
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
		<span class="font-mono">{cells.length} cells</span>
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
