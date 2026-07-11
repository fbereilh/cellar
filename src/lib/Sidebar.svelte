<script>
	import { onMount, setContext } from 'svelte';
	import Databricks from '$lib/Databricks.svelte';
	import Environment from '$lib/Environment.svelte';
	import FileTreeNode from '$lib/FileTreeNode.svelte';
	import TreeEntryInput from '$lib/TreeEntryInput.svelte';
	import { kernelBadgeClass, kernelStatusLabel } from '$lib/kernelBadge.js';
	import { DEFAULT_SECTION_ORDER, reconcileSectionOrder } from '$lib/sidebarSections.js';
	import { outlineRows as buildOutlineRows } from '$lib/headings.js';
	import { getUi, setUi } from '$lib/uiState.js';

	let {
		cells,
		// The active notebook's collapsible-heading state, owned by its LiveNotebook.
		// The Outline is a second view of it, never a second copy: a chevron here
		// calls straight into the notebook's `toggleFold`.
		foldedIds = new Set(),
		foldCounts = {},
		onToggleFold,
		// Collapse/expand every heading section at once (the Outline header buttons).
		// Same shared fold state as `onToggleFold`, driven through the notebook.
		onCollapseAllFolds,
		onExpandAllFolds,
		mcp = null,
		kernelInfo,
		kernelBusy,
		loadedNotebooks = [],
		variables,
		varsLoading,
		varsError,
		onRefreshVars,
		onRefreshKernel,
		onInterruptKernel,
		onRestartKernel,
		// Databricks: `spark` lives in the kernel, so a new kernel session epoch means
		// the session is gone. `onInsertAndRun` is null when no notebook is open.
		onInsertAndRun = null,
		onDatabricksSessionChange,
		onOpenFile,
		onOpenFilePermanent,
		onFocusNotebook,
		activeFilePath = null,
		fsRefreshSignal = 0,
		onScrollToCell,
		onFsChange
	} = $props();

	// ---- Persisted section collapse state -----------------------------------
	// Which foldable sections are open. All start expanded (agent panel collapsed),
	// then overridden by the persisted state on mount.
	const OPEN_KEY = 'cellar-sidebar-open';
	let open = $state({ files: true, kernels: true, databricks: false, environment: false, agent: false, outline: true, vars: true, search: false });
	function toggle(k) {
		open[k] = !open[k];
		persist(OPEN_KEY, open);
	}

	// The Databricks panel mounts the first time its section is opened and stays
	// mounted from then on (see `databricksSection`). A latch, never un-set.
	let databricksMounted = $state(false);
	$effect(() => {
		if (open.databricks) databricksMounted = true;
	});

	// Same lazy-mount latch for the Environment panel: it spawns a python
	// subprocess to list packages, so a user who never opens it never pays for it.
	let environmentMounted = $state(false);
	let environmentComp = $state(null);
	$effect(() => {
		if (open.environment) environmentMounted = true;
	});

	const notebooksLabel = $derived(
		loadedNotebooks.length ? `loaded notebooks · ${loadedNotebooks.length}` : 'loaded notebooks'
	);

	// ---- Persisted section order (drag to reorder) --------------------------
	const ORDER_KEY = 'cellar-sidebar-order';
	let sectionOrder = $state([...DEFAULT_SECTION_ORDER]);

	// Persisted in the per-project UI-state store (port-independent), not
	// `localStorage` - see `$lib/uiState.js`.
	function persist(key, value) {
		setUi(key, value);
	}
	onMount(() => {
		const savedOpen = getUi(OPEN_KEY, null);
		if (savedOpen && typeof savedOpen === 'object') open = { ...open, ...savedOpen };
		sectionOrder = reconcileSectionOrder(getUi(ORDER_KEY, null));
	});

	// Native HTML5 drag-and-drop to reorder sections (no external library).
	let dragKey = $state(null);
	let dropKey = $state(null);
	let dropAfter = $state(false);
	function onSecDragStart(e, key) {
		dragKey = key;
		e.dataTransfer.effectAllowed = 'move';
		try {
			e.dataTransfer.setData('text/plain', key);
		} catch {}
	}
	function onSecDragOver(e, key) {
		if (dragKey == null) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		const r = e.currentTarget.getBoundingClientRect();
		dropKey = key;
		dropAfter = e.clientY > r.top + r.height / 2;
	}
	function onSecDrop(e, key) {
		if (dragKey == null) return;
		e.preventDefault();
		reorderSection(dragKey, key, dropAfter);
		endSecDrag();
	}
	function endSecDrag() {
		dragKey = null;
		dropKey = null;
		dropAfter = false;
	}
	function reorderSection(from, to, after) {
		if (from === to) return;
		const arr = sectionOrder.filter((k) => k !== from);
		let idx = arr.indexOf(to);
		if (after) idx++;
		arr.splice(idx, 0, from);
		sectionOrder = arr;
		persist(ORDER_KEY, sectionOrder);
	}

	// ---- File tree ----------------------------------------------------------
	let treeRoot = $state(null);
	let treeError = $state('');
	// Per-file git status (VS Code-style decorations); {} when not a git repo.
	let gitFiles = $state({});
	async function loadTree() {
		try {
			const res = await fetch('/api/fs/tree');
			if (!res.ok) throw new Error('failed to list workspace');
			treeRoot = await res.json();
			treeError = '';
		} catch (err) {
			treeError = String(err?.message ?? err);
		}
	}
	async function loadGit() {
		try {
			const res = await fetch('/api/fs/git');
			if (!res.ok) return;
			const body = await res.json();
			gitFiles = body.isRepo ? body.files : {};
		} catch {
			gitFiles = {}; // degrade silently in a non-git workspace
		}
	}
	function refreshFiles() {
		loadTree();
		loadGit();
	}
	// Refresh git decorations on: mount, manual refresh, saves (parent bumps
	// fsRefreshSignal), and window focus — matches how VS Code re-reads status.
	onMount(() => {
		refreshFiles();
		const onFocus = () => loadGit();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});
	let firstSignal = true;
	$effect(() => {
		fsRefreshSignal; // track
		if (firstSignal) {
			firstSignal = false;
			return;
		}
		refreshFiles();
	});

	// ---- File management (context menu, clipboard, inline rename/new) -------
	// A VS Code-style file explorer over the workspace tree. All mutations go
	// through the path-guarded /api/fs/op route; the tree + git decorations are
	// refreshed after each op, and tab impact (rename/move/delete) is reported up
	// via onFsChange so no tab is left pointing at a gone/moved file.
	let clipboard = $state(null); // { op: 'cut' | 'copy', path }
	let renaming = $state(null); // relPath being renamed inline
	let newEntry = $state(null); // { parentPath, kind: 'file' | 'dir' }
	let selectedNode = $state(null); // { type, path, name }
	let ctxMenu = $state(null); // { x, y, node }
	let deleteTarget = $state(null); // { type, path, name }
	let opError = $state('');

	function parentDir(p) {
		const i = p.lastIndexOf('/');
		return i >= 0 ? p.slice(0, i) : '';
	}
	// The folder a "new" / "paste" targets: a dir uses itself, a file its parent,
	// the tree root the workspace root ('').
	function targetDirFor(node) {
		if (!node || node.type === 'root') return '';
		return node.type === 'dir' ? node.path : parentDir(node.path);
	}

	async function runOp(payload) {
		opError = '';
		try {
			const res = await fetch('/api/fs/op', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'operation failed');
			refreshFiles();
			return body;
		} catch (err) {
			opError = String(err?.message ?? err);
			return null;
		}
	}

	function openMenu(e, node) {
		selectedNode = node;
		ctxMenu = { x: e.clientX, y: e.clientY, node };
	}
	function closeMenu() {
		ctxMenu = null;
	}
	// Escape dismisses the open context menu (click / scroll dismiss via backdrop).
	$effect(() => {
		if (!ctxMenu) return;
		const onKey = (e) => {
			if (e.key === 'Escape') closeMenu();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
	function onRootContext(e) {
		e.preventDefault();
		openMenu(e, { type: 'root', path: '', name: treeRoot?.name ?? '' });
	}

	function startNew(kind, node) {
		closeMenu();
		renaming = null;
		newEntry = { parentPath: targetDirFor(node), kind };
	}
	function cancelNew() {
		newEntry = null;
	}
	async function submitNew(name) {
		const entry = newEntry;
		newEntry = null;
		if (!entry) return;
		await runOp({ op: 'create', parent: entry.parentPath, name, kind: entry.kind });
	}

	function startRename(node) {
		closeMenu();
		newEntry = null;
		renaming = node.path;
	}
	function cancelRename() {
		renaming = null;
	}
	async function submitRename(path, name) {
		renaming = null;
		const res = await runOp({ op: 'rename', path, name });
		if (res?.path && res.path !== path) onFsChange?.({ type: 'rename', from: path, path: res.path });
	}

	function cutEntry(node) {
		closeMenu();
		clipboard = { op: 'cut', path: node.path };
	}
	function copyEntry(node) {
		closeMenu();
		clipboard = { op: 'copy', path: node.path };
	}
	async function pasteEntry(node) {
		closeMenu();
		if (!clipboard) return;
		const dest = targetDirFor(node);
		const op = clipboard.op === 'cut' ? 'move' : 'copy';
		const from = clipboard.path;
		const res = await runOp({ op, path: from, dest });
		if (res && op === 'move') {
			onFsChange?.({ type: 'move', from, path: res.path });
			clipboard = null; // a cut is consumed; a copy stays for repeat pastes
		}
	}

	function askDelete(node) {
		closeMenu();
		deleteTarget = { type: node.type, path: node.path, name: node.name };
	}
	async function doDelete() {
		const t = deleteTarget;
		deleteTarget = null;
		if (!t) return;
		const res = await runOp({ op: 'delete', path: t.path });
		if (res) onFsChange?.({ type: 'delete', path: t.path });
	}

	// Keyboard shortcuts while a tree node is focused/selected (ignored while an
	// inline rename/new input is being typed into).
	function onFilesKeydown(e) {
		if (e.target?.tagName === 'INPUT') return;
		const n = selectedNode;
		if (!n || n.type === 'root') return;
		const meta = e.metaKey || e.ctrlKey;
		if (e.key === 'F2') {
			e.preventDefault();
			startRename(n);
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			askDelete(n);
		} else if (meta && (e.key === 'c' || e.key === 'C')) {
			copyEntry(n);
		} else if (meta && (e.key === 'x' || e.key === 'X')) {
			cutEntry(n);
		} else if (meta && (e.key === 'v' || e.key === 'V') && clipboard && (n.type === 'dir' || n.type === 'root')) {
			pasteEntry(n);
		}
	}

	// Shared file-ops surface for the recursive tree nodes (avoids prop-drilling
	// through FileTreeNode). Getters forward reactive $state so nodes stay live.
	setContext('cellarFileOps', {
		get clipboard() {
			return clipboard;
		},
		get renaming() {
			return renaming;
		},
		get newEntry() {
			return newEntry;
		},
		get selectedPath() {
			return selectedNode?.path ?? null;
		},
		openMenu,
		select: (node) => (selectedNode = node),
		submitRename,
		cancelRename,
		submitNew,
		cancelNew
	});

	// ---- Outline (the notebook's headings, nested by level) ------------------
	// Rows come from the same `headings.js` model the notebook renders from, and
	// carry the same fold keys - so every heading level gets a chevron here exactly
	// as it does in the notebook, a folded heading hides its subtree in both, and
	// the two can never disagree about what is collapsed.
	const outlineRows = $derived(buildOutlineRows(cells, foldedIds, foldCounts));

	// ---- Search (over cell content) -----------------------------------------
	let query = $state('');
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out = [];
		for (const cell of cells) {
			const src = cell.source || '';
			if (!src.toLowerCase().includes(q)) continue;
			const line = src.split('\n').find((l) => l.toLowerCase().includes(q)) || src.split('\n')[0] || '';
			out.push({ cellId: cell.id, cellType: cell.cell_type, snippet: line.trim().slice(0, 80) });
		}
		return out;
	});

	// ---- Connect an agent (zero-config MCP) ---------------------------------
	// The recommended path is zero-config: `cellar` writes a project `.mcp.json`
	// so an agent opened in this repo auto-connects over the `cellar mcp` stdio
	// bridge (the port is discovered at runtime, never hardcoded). The one-time
	// manual registration and the raw Streamable-HTTP endpoint are secondary.
	const addCommand = 'claude mcp add cellar -- cellar mcp';
	// Config snippet for a generic MCP client pointed straight at the raw HTTP
	// endpoint (MCP Inspector, a custom SDK client). Demoted under "Advanced".
	const mcpSnippet = $derived(
		mcp?.url
			? JSON.stringify({ mcpServers: { cellar: { type: 'http', url: mcp.url } } }, null, 2)
			: ''
	);
	let advancedOpen = $state(false);
	let copied = $state(''); // 'add' | 'url' | 'snippet' | ''
	let copyTimer;
	async function copy(kind, textVal) {
		try {
			await navigator.clipboard.writeText(textVal);
			copied = kind;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = ''), 1400);
		} catch {}
	}
</script>

<!-- Section drag handle + collapse header, shared by every section. -->
{#snippet header(key, label, testid)}
	<button
		class="flex shrink-0 cursor-grab items-center px-1.5 py-2 text-base-content/25 hover:text-base-content/60 active:cursor-grabbing"
		draggable="true"
		ondragstart={(e) => onSecDragStart(e, key)}
		ondragend={endSecDrag}
		title="Drag to reorder section"
		aria-label="Drag to reorder section"
		data-testid="section-drag-{key}"
	>
		<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
	</button>
	<button class="flex flex-1 items-center gap-1.5 py-2 pr-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle(key)} data-testid={testid}>
		<svg class="h-3 w-3 transition-transform {open[key] ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
		{label}
	</button>
{/snippet}

{#snippet refreshBtn(onClick, title, loading = false, testid = undefined)}
	<button class="btn btn-ghost btn-xs btn-square mr-1 text-base-content/40" onclick={onClick} {title} aria-label={title} data-testid={testid}>
		{#if loading}
			<span class="loading loading-spinner loading-xs"></span>
		{:else}
			<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
		{/if}
	</button>
{/snippet}

<!-- ==== Section bodies ==================================================== -->

{#snippet filesSection()}
	<div class="flex items-center">
		{@render header('files', 'Files', 'section-files')}
		<button
			class="btn btn-ghost btn-xs btn-square text-base-content/40"
			onclick={() => startNew('file', { type: 'root', path: '' })}
			title="New file"
			aria-label="New file"
			data-testid="files-new-file"
		>
			<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 12v6M9 15h6" /></svg>
		</button>
		<button
			class="btn btn-ghost btn-xs btn-square mr-1 text-base-content/40"
			onclick={() => startNew('dir', { type: 'root', path: '' })}
			title="New folder"
			aria-label="New folder"
			data-testid="files-new-folder"
		>
			<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" /><path d="M12 11v6M9 14h6" /></svg>
		</button>
		{@render refreshBtn(refreshFiles, 'Refresh file tree')}
	</div>
	{#if open.files}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="px-2 pb-2" oncontextmenu={onRootContext} onkeydown={onFilesKeydown} data-testid="files-body">
			{#if treeError}
				<p class="px-2 text-xs text-error">{treeError}</p>
			{:else if treeRoot}
				<p class="truncate px-1 pb-1 text-[11px] text-base-content/40" title={treeRoot.root}>{treeRoot.name}</p>
				{#if newEntry?.parentPath === ''}
					<TreeEntryInput depth={0} kind={newEntry.kind} onSubmit={submitNew} onCancel={cancelNew} />
				{/if}
				{#each treeRoot.tree as node (node.path)}
					<FileTreeNode {node} onOpen={onOpenFile} onOpenPermanent={onOpenFilePermanent} {gitFiles} activePath={activeFilePath} />
				{:else}
					{#if newEntry?.parentPath !== ''}
						<p class="px-2 text-xs text-base-content/40">empty workspace</p>
					{/if}
				{/each}
			{:else}
				<p class="px-2 text-xs text-base-content/40">loading…</p>
			{/if}
			{#if opError}
				<p class="mt-1 px-2 text-xs text-error" data-testid="files-op-error">{opError}</p>
			{/if}
		</div>
	{/if}
{/snippet}

<!-- One open notebook loaded against the shared kernel. Clicking only focuses
     its existing tab - a preview tab stays a preview, so the file tree's single-
     click slot is untouched. The active notebook is marked with a primary dot. -->
<!-- One loaded notebook. If its tab is still open the row focuses that tab and the
     active one is dotted; if the tab was closed the notebook is still loaded in the
     kernel (its state lives in the shared namespace), so it shows as a dimmed,
     non-clickable row tagged "closed". -->
{#snippet notebookRow(nb)}
	{#if nb.open}
		<button class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/50 {nb.active ? 'text-base-content' : 'text-base-content/60'}" onclick={() => onFocusNotebook?.(nb.id)} title="Focus {nb.name}" data-testid="kernel-notebook">
			<svg class="h-3.5 w-3.5 shrink-0 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
			<span class="truncate font-mono">{nb.name}</span>
			{#if nb.active}<span class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="active notebook"></span>{/if}
		</button>
	{:else}
		<div class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-base-content/45" title="{nb.name} — loaded in the kernel (tab closed)" data-testid="kernel-notebook">
			<svg class="h-3.5 w-3.5 shrink-0 text-base-content/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
			<span class="truncate font-mono">{nb.name}</span>
			<span class="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-base-content/30">closed</span>
		</div>
	{/if}
{/snippet}

<!-- Card header: title on the left, live status badge on the right. Shared by the
     started and not-started cards so both read their badge from `kernelBadge.js`.
     The badge never wraps; at narrow sidebar widths the title gives way instead. -->
{#snippet kernelHeader(title, muted)}
	<div class="flex items-center justify-between gap-2">
		<span class="flex min-w-0 items-center gap-1.5 text-sm font-medium {muted ? 'text-base-content/50' : ''}">
			<svg class="h-3.5 w-3.5 shrink-0 {muted ? 'text-base-content/40' : 'text-primary'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
			<span class="min-w-0 break-words">{title}</span>
		</span>
		<span class="badge badge-sm shrink-0 whitespace-nowrap {kernelBadgeClass(kernelInfo)} gap-1" data-testid="kernel-card-status">
			<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>
			{kernelStatusLabel(kernelInfo)}
		</span>
	</div>
{/snippet}

<!-- The notebooks loaded in the shared kernel (ran >=1 cell this session). Only
     the started card renders this — nothing is loaded before the first run. -->
{#snippet notebookList(label)}
	<div class="mt-2 border-t border-base-300 pt-2">
		<div class="mb-1 text-[11px] uppercase tracking-wide text-base-content/40" data-testid="kernel-notebooks-label">
			{label}
		</div>
		{#each loadedNotebooks as nb (nb.id)}
			{@render notebookRow(nb)}
		{:else}
			<p class="px-1 text-xs text-base-content/40">no notebooks loaded</p>
		{/each}
	</div>
{/snippet}

<!-- Interrupt / restart the shared kernel; disabled until it is started (and
     while a control is already in flight). -->
{#snippet kernelControls()}
	<div class="mt-2 flex gap-1.5 border-t border-base-300 pt-2" data-testid="kernel-controls">
		<button
			class="btn btn-outline btn-xs flex-1 gap-1"
			onclick={onInterruptKernel}
			disabled={!kernelInfo?.started || kernelBusy}
			title="Interrupt the kernel (stop the running cell)"
			data-testid="kernel-interrupt"
		>
			<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
			Interrupt
		</button>
		<button
			class="btn btn-outline btn-xs flex-1 gap-1"
			onclick={onRestartKernel}
			disabled={!kernelInfo?.started || kernelBusy}
			title="Restart the kernel (clear the namespace, keep the notebook)"
			data-testid="kernel-restart"
		>
			<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
			Restart
		</button>
	</div>
{/snippet}

{#snippet kernelsSection()}
	<div class="flex items-center">
		{@render header('kernels', 'Kernels', 'section-kernels')}
		{@render refreshBtn(onRefreshKernel, 'Refresh kernel status')}
	</div>
	{#if open.kernels}
		<!-- Cellar runs ONE shared kernel across every notebook. So the live picture
		     is: at most one kernel (started only after the first run), with every
		     notebook LOADED in it listed under it (ran >=1 cell this session — server
		     tracked, so a closed-tab notebook still shows, an unrun one does not).
		     Before the first run there is no kernel — show that, not a phantom
		     `python3`. -->
		<div class="px-3 pb-3" data-testid="kernels-body">
			{#if kernelInfo?.started}
				<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="kernel-card">
					{@render kernelHeader(kernelInfo.name || 'python3', false)}
					{@render notebookList(notebooksLabel)}
					{@render kernelControls()}
				</div>
			{:else}
				<div class="rounded-lg border border-dashed border-base-300 bg-base-100 p-2.5" data-testid="kernel-card">
					{@render kernelHeader('No kernel running', true)}
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/40">
						Run a cell to start the <span class="font-mono">{kernelInfo?.name || 'python3'}</span> kernel.
						Notebooks appear here once they run a cell.
					</p>
					{@render kernelControls()}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet databricksSection()}
	<div class="flex items-center">
		{@render header('databricks', 'Databricks', 'section-databricks')}
	</div>
	<!-- Mounted lazily on first open, then kept mounted (hidden) so collapsing the
	     section does not throw away the connection state, the cluster list, or a
	     half-expanded catalog tree. Until then it costs nothing: its status probe
	     spawns a python subprocess, which a user who never opens this should not pay. -->
	{#if databricksMounted}
		<div class:hidden={!open.databricks}>
			<Databricks kernelSessionId={kernelInfo?.session_id ?? null} {onInsertAndRun} onSessionChange={onDatabricksSessionChange} />
		</div>
	{/if}
{/snippet}

{#snippet environmentSection()}
	<div class="flex items-center">
		{@render header('environment', 'Environment', 'section-environment')}
		{@render refreshBtn(() => environmentComp?.refresh?.(), 'Refresh environment')}
	</div>
	<!-- Mounted lazily on first open, then kept mounted (hidden) so collapsing the
	     section does not throw away the loaded package list. Its data comes from a
	     python subprocess, which a user who never opens this should not pay for. -->
	{#if environmentMounted}
		<div class:hidden={!open.environment}>
			<Environment bind:this={environmentComp} />
		</div>
	{/if}
{/snippet}

{#snippet agentSection()}
	<div class="flex items-center">
		{@render header('agent', 'Connect an agent', 'section-agent')}
	</div>
	{#if open.agent}
		<div class="px-3 pb-3" data-testid="agent-body">
			<!-- Lead: zero-config. `cellar` wrote a project .mcp.json, so an agent
			     opened in this repo auto-connects with no setup. -->
			{#if mcp?.projectConfigured}
				<div class="flex items-start gap-1.5 rounded-lg border border-success/30 bg-success/10 p-2" data-testid="mcp-zeroconfig">
					<svg class="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
					<p class="text-[11px] leading-relaxed text-base-content/70">
						<span class="font-semibold text-base-content/80">This project is agent-ready.</span>
						Cellar wrote a <code class="font-mono text-[10px] text-primary">.mcp.json</code> here, so an agent
						(e.g. Claude Code) opened in this repo auto-connects - no setup.
					</p>
				</div>
			{:else}
				<div class="flex items-start gap-1.5 rounded-lg border border-base-300 bg-base-100 p-2" data-testid="mcp-zeroconfig">
					<svg class="mt-0.5 h-3.5 w-3.5 shrink-0 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
					<p class="text-[11px] leading-relaxed text-base-content/60">
						No project <code class="font-mono text-[10px]">.mcp.json</code> registers
						<code class="font-mono text-[10px]">cellar</code> here. Register the agent once with the command below.
					</p>
				</div>
			{/if}

			<!-- One-time manual registration, from any project. -->
			<p class="pt-2.5 pb-1 text-[10px] uppercase tracking-wide text-base-content/40">Register once (any project)</p>
			<div class="flex items-center gap-1 rounded-lg border border-base-300 bg-base-100 p-1.5">
				<code class="min-w-0 flex-1 truncate px-1 font-mono text-xs text-primary" title={addCommand} data-testid="mcp-add-command">{addCommand}</code>
				<button
					class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content"
					onclick={() => copy('add', addCommand)}
					title="Copy command"
					aria-label="Copy command"
					data-testid="mcp-copy-add"
				>
					{#if copied === 'add'}
						<svg class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
					{:else}
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
					{/if}
				</button>
			</div>

			<!-- Demoted: raw Streamable-HTTP endpoint for a generic MCP client. -->
			{#if mcp?.url}
				<button
					class="mt-2.5 flex w-full items-center gap-1 py-0.5 text-left text-[10px] uppercase tracking-wide text-base-content/40 hover:text-base-content/70"
					onclick={() => (advancedOpen = !advancedOpen)}
					data-testid="mcp-advanced-toggle"
				>
					<svg class="h-2.5 w-2.5 transition-transform {advancedOpen ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
					Advanced · raw endpoint
				</button>
				{#if advancedOpen}
					<div data-testid="mcp-advanced-body">
						<p class="pt-1 pb-1.5 text-[11px] leading-relaxed text-base-content/50">
							For a generic MCP client (MCP Inspector, a custom SDK client) pointed straight at
							this instance's live Streamable-HTTP endpoint. The port changes every launch.
						</p>
						<div class="flex items-center gap-1 rounded-lg border border-base-300 bg-base-100 p-1.5">
							<code class="min-w-0 flex-1 truncate px-1 font-mono text-xs text-primary" title={mcp.url} data-testid="mcp-url">{mcp.url}</code>
							<button
								class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content"
								onclick={() => copy('url', mcp.url)}
								title="Copy MCP URL"
								aria-label="Copy MCP URL"
								data-testid="mcp-copy-url"
							>
								{#if copied === 'url'}
									<svg class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
								{:else}
									<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
								{/if}
							</button>
						</div>

						<div class="mt-2 flex items-center justify-between">
							<span class="text-[10px] uppercase tracking-wide text-base-content/40">config snippet</span>
							<button class="btn btn-ghost btn-xs h-5 min-h-0 gap-1 px-1.5 text-[11px] font-normal text-base-content/50 hover:text-base-content" onclick={() => copy('snippet', mcpSnippet)} data-testid="mcp-copy-snippet">
								{copied === 'snippet' ? 'copied' : 'copy'}
							</button>
						</div>
						<pre class="mt-1 overflow-x-auto rounded-lg border border-base-300 bg-base-100 p-2 font-mono text-[11px] leading-relaxed text-base-content/70" data-testid="mcp-snippet">{mcpSnippet}</pre>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet outlineSection()}
	<div class="flex items-center">
		{@render header('outline', 'Outline', 'section-outline')}
		{#if open.outline && outlineRows.length}
			<button
				class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-base-content"
				onclick={() => onCollapseAllFolds?.()}
				title="Collapse all headings"
				aria-label="Collapse all headings"
				data-testid="outline-collapse-all"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /><path d="m18 8-6-6-6 6" /></svg>
			</button>
			<button
				class="btn btn-ghost btn-xs btn-square mr-1 text-base-content/40 hover:text-base-content"
				onclick={() => onExpandAllFolds?.()}
				title="Expand all headings"
				aria-label="Expand all headings"
				data-testid="outline-expand-all"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /><path d="m6 16 6 6 6-6" /></svg>
			</button>
		{/if}
	</div>
	{#if open.outline}
		<div class="px-2 pb-2" data-testid="outline-body">
			{#each outlineRows as item (item.key)}
				<div
					class="flex items-center rounded {item.folded ? 'bg-base-300/50' : ''}"
					style="margin-left: {item.depth * 12}px"
					data-testid="outline-row"
					data-folded={item.folded ? 'true' : undefined}
				>
					<button
						class="flex h-5 w-4 shrink-0 items-center justify-center text-base-content/40 hover:text-base-content"
						onclick={() => onToggleFold?.(item.key)}
						title={item.folded ? 'Expand section' : 'Collapse section'}
						aria-label={item.folded ? 'Expand section' : 'Collapse section'}
						aria-expanded={!item.folded}
						data-testid="outline-toggle"
						data-folded={item.folded ? 'true' : undefined}
					>
						<svg class="h-3 w-3 transition-transform {item.folded ? '' : 'rotate-90'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
					</button>
					<button
						class="block min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/60 {item.folded ? 'text-base-content/60' : 'text-base-content/80'}"
						onclick={() => onScrollToCell(item.cellId, item.key)}
						data-testid="outline-item"
						title={item.title}
					>
						<span class="text-base-content/30">{'#'.repeat(item.level)}</span>
						{item.title}
					</button>
					{#if item.folded}
						<span
							class="mr-1 shrink-0 whitespace-nowrap text-[10px] text-base-content/45"
							data-testid="outline-folded-count"
							title={item.hiddenCount > 0 ? `${item.hiddenCount} ${item.hiddenCount === 1 ? 'cell' : 'cells'} hidden` : 'section collapsed'}
						>
							…{item.hiddenCount > 0 ? ` ${item.hiddenCount}` : ''}
						</span>
					{/if}
				</div>
			{:else}
				<p class="px-2 text-xs text-base-content/40">no markdown headings</p>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet varsSection()}
	<div class="flex items-center">
		{@render header('vars', 'Variables', 'section-vars')}
		{@render refreshBtn(onRefreshVars, 'Refresh variables', varsLoading, 'vars-refresh')}
	</div>
	{#if open.vars}
		<div class="px-2 pb-2" data-testid="vars-body">
			{#if varsError}
				<p class="px-2 text-xs text-error">{varsError}</p>
			{:else if variables?.length}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-xs">
						<thead class="text-[10px] uppercase tracking-wide text-base-content/40">
							<tr>
								<th class="px-1 py-1 font-medium">name</th>
								<th class="px-1 py-1 font-medium">type</th>
								<th class="px-1 py-1 font-medium">shape</th>
							</tr>
						</thead>
						<tbody>
							{#each variables as v (v.name)}
								<tr class="border-t border-base-300/50 align-top" data-testid="var-row" title={v.preview}>
									<td class="px-1 py-1 font-mono font-medium text-primary">{v.name}</td>
									<td class="px-1 py-1 font-mono text-base-content/60">{v.type}</td>
									<td class="px-1 py-1 font-mono text-base-content/50">{v.shape}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="px-2 text-xs text-base-content/40">no variables{kernelInfo?.started ? '' : ' (run a cell first)'}</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet searchSection()}
	<div class="flex items-center">
		{@render header('search', 'Search', 'section-search')}
	</div>
	{#if open.search}
		<div class="px-3 pb-3" data-testid="search-body">
			<label class="input input-sm input-bordered flex items-center gap-2">
				<svg class="h-3.5 w-3.5 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
				<input type="text" class="grow text-xs" placeholder="search cells…" bind:value={query} data-testid="search-input" />
			</label>
			{#if query.trim()}
				<p class="px-1 pt-2 text-[11px] text-base-content/40">{matches.length} match{matches.length === 1 ? '' : 'es'}</p>
				<div class="pt-1">
					{#each matches as m (m.cellId)}
						<button class="block w-full rounded px-1.5 py-1 text-left hover:bg-base-300/60" onclick={() => onScrollToCell(m.cellId)} data-testid="search-result">
							<span class="mr-1 badge badge-xs {m.cellType === 'markdown' ? 'badge-secondary' : 'badge-primary'} badge-soft">{m.cellType === 'markdown' ? 'md' : 'py'}</span>
							<span class="font-mono text-xs text-base-content/70">{m.snippet}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet sectionBody(key)}
	{#if key === 'files'}{@render filesSection()}
	{:else if key === 'kernels'}{@render kernelsSection()}
	{:else if key === 'databricks'}{@render databricksSection()}
	{:else if key === 'environment'}{@render environmentSection()}
	{:else if key === 'agent'}{@render agentSection()}
	{:else if key === 'outline'}{@render outlineSection()}
	{:else if key === 'vars'}{@render varsSection()}
	{:else if key === 'search'}{@render searchSection()}
	{/if}
{/snippet}

<aside class="flex h-full w-full flex-col overflow-hidden bg-base-200 text-base-content" data-testid="sidebar">
	<div class="flex-1 overflow-y-auto">
		{#each sectionOrder as key (key)}
			<section
				class="relative border-b border-base-300 {dragKey === key ? 'opacity-40' : ''}"
				ondragover={(e) => onSecDragOver(e, key)}
				ondrop={(e) => onSecDrop(e, key)}
				data-testid="sidebar-section"
				data-section={key}
			>
				{#if dragKey != null && dropKey === key}
					<div class="pointer-events-none absolute left-0 right-0 z-10 h-0.5 bg-primary {dropAfter ? 'bottom-0' : 'top-0'}" data-testid="section-drop-indicator"></div>
				{/if}
				{@render sectionBody(key)}
			</section>
		{/each}
	</div>
</aside>

<!-- ==== File-tree context menu =========================================== -->
{#snippet menuItem(label, testid, action, danger = false)}
	<button
		class="flex w-full items-center px-3 py-1 text-left hover:bg-base-300/70 {danger ? 'text-error' : 'text-base-content/90'}"
		onclick={action}
		data-testid={testid}
	>
		{label}
	</button>
{/snippet}
{#snippet menuSep()}
	<div class="my-1 border-t border-base-300"></div>
{/snippet}

{#if ctxMenu}
	{@const node = ctxMenu.node}
	{@const canPaste = clipboard && (node.type === 'dir' || node.type === 'root')}
	<!-- Backdrop: any click / right-click / scroll dismisses the menu. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40"
		onclick={closeMenu}
		oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }}
		onwheel={closeMenu}
	></div>
	<div
		class="fixed z-50 min-w-44 rounded-md border border-base-300 bg-base-100 py-1 text-xs shadow-lg"
		style="left: {ctxMenu.x}px; top: {ctxMenu.y}px"
		data-testid="tree-context-menu"
	>
		{@render menuItem('New File', 'ctx-new-file', () => startNew('file', node))}
		{@render menuItem('New Folder', 'ctx-new-folder', () => startNew('dir', node))}
		{#if node.type !== 'root'}
			{@render menuSep()}
			{@render menuItem('Rename', 'ctx-rename', () => startRename(node))}
			{@render menuItem('Delete', 'ctx-delete', () => askDelete(node), true)}
			{@render menuSep()}
			{@render menuItem('Cut', 'ctx-cut', () => cutEntry(node))}
			{@render menuItem('Copy', 'ctx-copy', () => copyEntry(node))}
		{/if}
		{#if canPaste}
			{#if node.type === 'root'}{@render menuSep()}{/if}
			{@render menuItem('Paste', 'ctx-paste', () => pasteEntry(node))}
		{/if}
	</div>
{/if}

<!-- ==== Delete confirmation ============================================== -->
{#if deleteTarget}
	<div class="modal modal-open" data-testid="delete-modal">
		<div class="modal-box max-w-sm">
			<h3 class="text-sm font-semibold">Delete {deleteTarget.type === 'dir' ? 'folder' : 'file'}</h3>
			<p class="mt-2 text-sm text-base-content/70">
				Are you sure you want to delete <code class="font-mono text-primary">{deleteTarget.name}</code>{deleteTarget.type === 'dir' ? ' and all its contents' : ''}? This cannot be undone.
			</p>
			<div class="modal-action mt-4">
				<button class="btn btn-sm btn-ghost" onclick={() => (deleteTarget = null)} data-testid="delete-cancel">Cancel</button>
				<button class="btn btn-sm btn-error" onclick={doDelete} data-testid="delete-confirm">Delete</button>
			</div>
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-backdrop" onclick={() => (deleteTarget = null)}></div>
	</div>
{/if}
