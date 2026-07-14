<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import Databricks from '$lib/Databricks.svelte';
	import Environment from '$lib/Environment.svelte';
	import Checkpoints from '$lib/Checkpoints.svelte';
	import FileTreeNode from '$lib/FileTreeNode.svelte';
	import TreeEntryInput from '$lib/TreeEntryInput.svelte';
	import { kernelBadgeClass, kernelStatusLabel } from '$lib/kernelBadge';
	import { DEFAULT_SECTION_ORDER, reconcileSectionOrder } from '$lib/sidebarSections';
	import { outlineRows as buildOutlineRows, sectionRunState, headingNumberPrefix } from '$lib/headings';
	import { getUi, setUi } from '$lib/uiState';
	import type { Cell } from '$lib/server/types';
	import type { TreeNode } from '$lib/server/fstree';
	import type { GitStatusLetter } from '$lib/server/git';
	import type { KernelInfo, KernelCard } from '$lib/kernelBadge';
	import type { CellarFileOps, FileClipboard, NewEntry, FileDescriptor } from '$lib/fileOps';

	/** A file/dir/root descriptor the context menu + selection act on. */
	type MenuNode = { type: 'file' | 'dir' | 'root'; path: string; name?: string; children?: TreeNode[] };
	/** The workspace tree payload from /api/fs/tree. */
	interface TreeRoot {
		name: string;
		root: string;
		tree: TreeNode[];
	}
	/** A kernel-namespace variable row (from the inspector probe). */
	interface VariableInfo {
		name: string;
		type?: string;
		shape?: string;
		preview?: string;
	}
	/** MCP connection info the shell load resolves. */
	interface McpInfo {
		url?: string | null;
		projectConfigured?: boolean;
	}
	/** A tab-impacting file-system change reported up to the shell. */
	interface FsChange {
		type: 'rename' | 'move' | 'delete';
		from?: string;
		path: string;
	}

	interface Props {
		cells: Cell[];
		foldedIds?: Set<string>;
		foldCounts?: Record<string, number>;
		/** The active notebook's currently-running cell (from the shared kernel), or null. */
		runningId?: string | null;
		/** The active notebook's queued cells (id → global queue position). */
		queued?: Record<string, number>;
		onToggleFold?: (key: string) => void;
		onCollapseAllFolds?: () => void;
		onExpandAllFolds?: () => void;
		/** fold key → display-only auto-number for that heading (e.g. "1", "2.3"). */
		headingNumbers?: Record<string, string>;
		/** Heading levels (1-6) currently rendered with an auto-number. */
		numberingLevels?: number[];
		/** Turn the auto-number for a heading level on or off. */
		onToggleNumberingLevel?: (level: number, on: boolean) => void;
		mcp?: McpInfo | null;
		/** The ACTIVE notebook's kernel — for the Databricks panel + variables label. */
		kernelInfo?: KernelInfo | null;
		/** One card per notebook (open tab or live kernel) for the Kernels section. */
		kernelCards?: KernelCard[];
		variables?: VariableInfo[];
		varsLoading?: boolean;
		varsError?: string;
		onRefreshVars?: () => void;
		onRefreshKernel?: () => void;
		/** Per-notebook kernel controls; each takes that notebook's workspace-rel path. */
		onInterruptKernel?: (path: string) => void | Promise<void>;
		onRestartKernel?: (path: string) => void | Promise<void>;
		onShutdownKernel?: (path: string) => void | Promise<void>;
		onInsertAndRun?: ((source: string) => void) | null;
		onDatabricksSessionChange?: () => void;
		onOpenFile: (path: string) => void;
		onOpenFilePermanent: (path: string) => void;
		onFocusNotebook?: (id: string) => void;
		activeFilePath?: string | null;
		fsRefreshSignal?: number;
		onScrollToCell: (cellId: string, key?: string) => void;
		onFsChange?: (change: FsChange) => void;
		activeNotebookPath?: string | null;
	}

	let {
		cells,
		// The active notebook's collapsible-heading state, owned by its LiveNotebook.
		// The Outline is a second view of it, never a second copy: a chevron here
		// calls straight into the notebook's `toggleFold`.
		foldedIds = new Set(),
		foldCounts = {},
		// Live run/queue state of the active notebook, mapped onto heading sections
		// below so the Outline shows which section is executing / has queued cells.
		runningId = null,
		queued = {},
		onToggleFold,
		// Collapse/expand every heading section at once (the Outline header buttons).
		// Same shared fold state as `onToggleFold`, driven through the notebook.
		onCollapseAllFolds,
		onExpandAllFolds,
		// Display-only heading auto-numbers + the enabled levels, both owned by the
		// active notebook's LiveNotebook. The Outline shows the same numbers the cells
		// render and toggles the levels through the notebook, so the two never diverge.
		headingNumbers = {},
		numberingLevels = [],
		onToggleNumberingLevel,
		mcp = null,
		kernelInfo,
		kernelCards = [],
		variables,
		varsLoading,
		varsError,
		onRefreshVars,
		onRefreshKernel,
		onInterruptKernel,
		onRestartKernel,
		onShutdownKernel,
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
		onFsChange,
		// The active notebook (workspace-relative path, or null). Drives the History
		// (checkpoints) panel, which is per-notebook.
		activeNotebookPath = null
	}: Props = $props();

	// ---- Persisted section collapse state -----------------------------------
	// Which foldable sections are open. All start expanded (agent panel collapsed),
	// then overridden by the persisted state on mount.
	const OPEN_KEY = 'cellar-sidebar-open';
	let open = $state<Record<string, boolean>>({ files: true, kernels: true, databricks: false, environment: false, agent: false, outline: true, history: false, vars: true, search: false });
	function toggle(k: string) {
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
	// Component instance handles (bind:this). Typed structurally by the exported
	// methods the header buttons call.
	let environmentComp = $state<{ refresh: () => void } | null>(null);
	// The History (checkpoints) panel component, for its header's "Checkpoint now" +
	// refresh buttons. Mounted with the section (it's cheap: one metadata GET).
	let checkpointsComp = $state<{ refresh: () => void; checkpointNow: () => void } | null>(null);
	$effect(() => {
		if (open.environment) environmentMounted = true;
	});

	// Live kernel count for the section header (feeds the §3.1 cap warning later).
	// Counts only notebooks with a running kernel, not open-but-never-run tabs.
	const kernelCount = $derived(kernelCards.filter((c) => c.hasKernel).length);
	// Per-card in-flight state so a card's controls disable + spinner while an
	// interrupt/restart/shutdown it fired is still resolving. Keyed by notebook path.
	let actingPaths = $state<Set<string>>(new Set());
	async function runKernelAction(path: string, action?: (p: string) => void | Promise<void>) {
		if (!action || actingPaths.has(path)) return;
		actingPaths = new Set(actingPaths).add(path);
		try {
			await action(path);
		} finally {
			const next = new Set(actingPaths);
			next.delete(path);
			actingPaths = next;
		}
	}

	// ---- Persisted section order (drag to reorder) --------------------------
	const ORDER_KEY = 'cellar-sidebar-order';
	let sectionOrder = $state([...DEFAULT_SECTION_ORDER]);

	// Persisted in the per-project UI-state store (port-independent), not
	// `localStorage` - see `$lib/uiState.js`.
	function persist(key: string, value: unknown) {
		setUi(key, value);
	}
	onMount(() => {
		const savedOpen = getUi<Record<string, boolean> | null>(OPEN_KEY, null);
		if (savedOpen && typeof savedOpen === 'object') open = { ...open, ...savedOpen };
		sectionOrder = reconcileSectionOrder(getUi<string[] | null>(ORDER_KEY, null));
	});

	// Native HTML5 drag-and-drop to reorder sections (no external library).
	let dragKey = $state<string | null>(null);
	let dropKey = $state<string | null>(null);
	let dropAfter = $state(false);
	function onSecDragStart(e: DragEvent, key: string) {
		dragKey = key;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			try {
				e.dataTransfer.setData('text/plain', key);
			} catch {}
		}
	}
	function onSecDragOver(e: DragEvent, key: string) {
		if (dragKey == null) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		dropKey = key;
		dropAfter = e.clientY > r.top + r.height / 2;
	}
	function onSecDrop(e: DragEvent, key: string) {
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
	function reorderSection(from: string, to: string, after: boolean) {
		if (from === to) return;
		const arr = sectionOrder.filter((k) => k !== from);
		let idx = arr.indexOf(to);
		if (after) idx++;
		arr.splice(idx, 0, from);
		sectionOrder = arr;
		persist(ORDER_KEY, sectionOrder);
	}

	// ---- File tree ----------------------------------------------------------
	let treeRoot = $state<TreeRoot | null>(null);
	let treeError = $state('');
	// Per-file git status (VS Code-style decorations); {} when not a git repo.
	let gitFiles = $state<Record<string, GitStatusLetter>>({});
	async function loadTree() {
		try {
			const res = await fetch('/api/fs/tree');
			if (!res.ok) throw new Error('failed to list workspace');
			treeRoot = await res.json();
			treeError = '';
		} catch (err) {
			treeError = String((err as Error)?.message ?? err);
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
	let clipboard = $state<FileClipboard | null>(null);
	let renaming = $state<string | null>(null); // relPath being renamed inline
	let newEntry = $state<NewEntry | null>(null);
	let selectedNode = $state<MenuNode | null>(null);
	let ctxMenu = $state<{ x: number; y: number; node: MenuNode } | null>(null);
	let deleteTarget = $state<{ type: string; path: string; name: string } | null>(null);
	let opError = $state('');

	function parentDir(p: string): string {
		const i = p.lastIndexOf('/');
		return i >= 0 ? p.slice(0, i) : '';
	}
	// The folder a "new" / "paste" targets: a dir uses itself, a file its parent,
	// the tree root the workspace root ('').
	function targetDirFor(node: MenuNode | null): string {
		if (!node || node.type === 'root') return '';
		return node.type === 'dir' ? node.path : parentDir(node.path);
	}

	async function runOp(payload: Record<string, unknown>) {
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
			return body as { path?: string };
		} catch (err) {
			opError = String((err as Error)?.message ?? err);
			return null;
		}
	}

	function openMenu(e: MouseEvent, node: MenuNode) {
		selectedNode = node;
		ctxMenu = { x: e.clientX, y: e.clientY, node };
	}
	function closeMenu() {
		ctxMenu = null;
	}
	// Escape dismisses the open context menu (click / scroll dismiss via backdrop).
	$effect(() => {
		if (!ctxMenu) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') closeMenu();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
	function onRootContext(e: MouseEvent) {
		e.preventDefault();
		openMenu(e, { type: 'root', path: '', name: treeRoot?.name ?? '' });
	}

	function startNew(kind: 'file' | 'dir', node: MenuNode | null) {
		closeMenu();
		renaming = null;
		newEntry = { parentPath: targetDirFor(node), kind };
	}
	function cancelNew() {
		newEntry = null;
	}
	async function submitNew(name: string) {
		const entry = newEntry;
		newEntry = null;
		if (!entry) return;
		await runOp({ op: 'create', parent: entry.parentPath, name, kind: entry.kind });
	}

	function startRename(node: MenuNode) {
		closeMenu();
		newEntry = null;
		renaming = node.path;
	}
	function cancelRename() {
		renaming = null;
	}
	async function submitRename(path: string, name: string) {
		renaming = null;
		const res = await runOp({ op: 'rename', path, name });
		if (res?.path && res.path !== path) onFsChange?.({ type: 'rename', from: path, path: res.path });
	}

	function cutEntry(node: MenuNode) {
		closeMenu();
		clipboard = { op: 'cut', path: node.path };
	}
	function copyEntry(node: MenuNode) {
		closeMenu();
		clipboard = { op: 'copy', path: node.path };
	}
	async function pasteEntry(node: MenuNode) {
		closeMenu();
		if (!clipboard) return;
		const dest = targetDirFor(node);
		const op = clipboard.op === 'cut' ? 'move' : 'copy';
		const from = clipboard.path;
		const res = await runOp({ op, path: from, dest });
		if (res && op === 'move' && res.path) {
			onFsChange?.({ type: 'move', from, path: res.path });
			clipboard = null; // a cut is consumed; a copy stays for repeat pastes
		}
	}

	function askDelete(node: MenuNode) {
		closeMenu();
		deleteTarget = { type: node.type, path: node.path, name: node.name ?? '' };
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
	function onFilesKeydown(e: KeyboardEvent) {
		if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
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
		} else if (meta && (e.key === 'v' || e.key === 'V') && clipboard && n.type === 'dir') {
			pasteEntry(n);
		}
	}

	// Shared file-ops surface for the recursive tree nodes (avoids prop-drilling
	// through FileTreeNode). Getters forward reactive $state so nodes stay live.
	setContext<CellarFileOps>('cellarFileOps', {
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
		select: (node: FileDescriptor) => (selectedNode = node),
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
	// Membership set for the per-level numbering toggle (H1-H6 checkboxes).
	const numberingSet = $derived(new Set(numberingLevels));
	let numberingMenuOpen = $state(false);
	// Which heading section is running / has queued cells, from the live kernel
	// run-queue. Keyed by the same foldKey as the outline rows, so a row looks up
	// its own state directly. `running` wins a row's primary indicator; a queued
	// count can still show alongside (a section may run one cell with more pending).
	const sectionRun = $derived(sectionRunState(cells, runningId, new Set(Object.keys(queued))));

	// ---- Search (over cell content) -----------------------------------------
	let query = $state('');
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const out: { cellId: string; cellType: string; snippet: string }[] = [];
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
	let copyTimer: ReturnType<typeof setTimeout>;
	async function copy(kind: string, textVal: string | null | undefined) {
		if (!textVal) return;
		try {
			await navigator.clipboard.writeText(textVal);
			copied = kind;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = ''), 1400);
		} catch {}
	}
</script>

<!-- Section drag handle + collapse header, shared by every section. -->
{#snippet header(key: string, label: string, testid: string)}
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

{#snippet refreshBtn(onClick: (() => void) | undefined, title: string, loading = false, testid: string | undefined = undefined)}
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

<!-- One kernel card: a single notebook's kernel. Cellar runs one kernel PER
     notebook, so each card carries its own status badge + Interrupt / Restart
     (=wipe namespace) / Shut down (=free the process), each acting only on THIS
     notebook. A card exists for every open notebook (so an unrun one shows "not
     started") and for every live kernel whose tab was closed (still in memory).
     The name focuses its tab when open; the active notebook is dotted. -->
{#snippet kernelCardView(card: KernelCard)}
	{@const acting = actingPaths.has(card.path)}
	{@const busy = card.info.status === 'busy'}
	<div
		class="rounded-lg border bg-base-100 p-2.5 {card.hasKernel ? 'border-base-300' : 'border-dashed border-base-300'}"
		data-testid="kernel-card"
		data-nb-path={card.path}
	>
		<div class="flex items-center justify-between gap-2">
			{#if card.open}
				<button
					class="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:text-primary"
					onclick={() => onFocusNotebook?.(card.id)}
					title="Focus {card.name}"
					data-testid="kernel-notebook"
				>
					<svg class="h-3.5 w-3.5 shrink-0 {card.hasKernel ? 'text-primary' : 'text-base-content/40'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
					<span class="min-w-0 truncate">{card.name}</span>
					{#if card.active}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="active notebook"></span>{/if}
				</button>
			{:else}
				<span
					class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-base-content/70"
					title="{card.name} — kernel running, tab closed"
					data-testid="kernel-notebook"
				>
					<svg class="h-3.5 w-3.5 shrink-0 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
					<span class="min-w-0 truncate">{card.name}</span>
					<span class="shrink-0 text-[10px] uppercase tracking-wide text-base-content/30">closed</span>
				</span>
			{/if}
			<span class="badge badge-sm shrink-0 whitespace-nowrap {kernelBadgeClass(card.info)} gap-1" data-testid="kernel-card-status">
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-current {busy ? 'animate-pulse' : ''}"></span>
				{kernelStatusLabel(card.info)}
			</span>
		</div>
		<!-- Interrupt / Restart on one row; Shut down set apart below since it removes
		     the kernel entirely (frees memory), a heavier action than a wipe. All
		     disabled until this notebook has a live kernel, or while one is acting. -->
		<div class="mt-2 border-t border-base-300 pt-2" data-testid="kernel-controls">
			<div class="flex gap-1.5">
				<button
					class="btn btn-outline btn-xs flex-1 gap-1"
					onclick={() => runKernelAction(card.path, onInterruptKernel)}
					disabled={!card.hasKernel || acting}
					title="Interrupt this notebook's kernel (stop the running cell)"
					data-testid="kernel-interrupt"
				>
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
					Interrupt
				</button>
				<button
					class="btn btn-outline btn-xs flex-1 gap-1"
					onclick={() => runKernelAction(card.path, onRestartKernel)}
					disabled={!card.hasKernel || acting}
					title="Restart this notebook's kernel — wipe its namespace from memory (keeps the notebook)"
					data-testid="kernel-restart"
				>
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
					Restart
				</button>
			</div>
			<button
				class="btn btn-ghost btn-xs mt-1.5 w-full gap-1 text-error/80 hover:bg-error/10 hover:text-error"
				onclick={() => runKernelAction(card.path, onShutdownKernel)}
				disabled={!card.hasKernel || acting}
				title="Shut down this notebook's kernel — free its memory and remove it (starts fresh on next run)"
				data-testid="kernel-shutdown"
			>
				<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></svg>
				Shut down
			</button>
		</div>
	</div>
{/snippet}

{#snippet kernelsSection()}
	<div class="flex items-center">
		{@render header('kernels', 'Kernels', 'section-kernels')}
		{#if kernelCount > 0}
			<span class="badge badge-xs badge-neutral shrink-0" title="{kernelCount} live kernel{kernelCount === 1 ? '' : 's'}" data-testid="kernel-count">{kernelCount}</span>
		{/if}
		{@render refreshBtn(onRefreshKernel, 'Refresh kernel status')}
	</div>
	{#if open.kernels}
		<!-- Cellar runs one kernel PER notebook (lazy: started on that notebook's first
		     run). One card per notebook — every open tab (an unrun one reads "not
		     started"), plus any live kernel whose tab was closed (still in memory).
		     Two notebooks running at once show two independent busy cards. -->
		<div class="space-y-2 px-3 pb-3" data-testid="kernels-body">
			{#each kernelCards as card (card.path)}
				{@render kernelCardView(card)}
			{:else}
				<div class="rounded-lg border border-dashed border-base-300 bg-base-100 p-2.5 text-[11px] leading-relaxed text-base-content/40" data-testid="kernel-empty">
					No notebooks open. Open a notebook and run a cell to start a kernel.
				</div>
			{/each}
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
			<Databricks notebookPath={activeNotebookPath} kernelSessionId={kernelInfo?.session_id ?? null} {onInsertAndRun} onSessionChange={onDatabricksSessionChange} />
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
			<!-- Per-level heading auto-numbering (display-only): a small gear opens
			     H1-H6 checkboxes. The numbers are computed from the heading structure
			     and prepended at render time, so nothing is written to any cell. -->
			<div class="relative">
				<button
					class="btn btn-ghost btn-xs btn-square {numberingLevels.length ? 'text-primary' : 'text-base-content/40'} hover:text-base-content"
					onclick={() => (numberingMenuOpen = !numberingMenuOpen)}
					title="Heading numbering"
					aria-label="Heading numbering"
					aria-expanded={numberingMenuOpen}
					data-testid="outline-numbering-toggle"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h3M4 12h3M4 17h3" /><path d="M11 6h9M11 12h9M11 18h9" /></svg>
				</button>
				{#if numberingMenuOpen}
					<!-- Click-away backdrop -->
					<button
						class="fixed inset-0 z-10 cursor-default"
						aria-label="Close heading numbering menu"
						tabindex="-1"
						onclick={() => (numberingMenuOpen = false)}
					></button>
					<div
						class="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-base-300 bg-base-100 p-2 shadow-lg"
						data-testid="outline-numbering-menu"
					>
						<p class="mb-1 px-1 text-[11px] font-semibold text-base-content/60">Auto-number headings</p>
						{#each [1, 2, 3, 4, 5, 6] as lvl}
							<label class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-base-300/50">
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={numberingSet.has(lvl)}
									onchange={(e) => onToggleNumberingLevel?.(lvl, e.currentTarget.checked)}
									data-testid="numbering-level-{lvl}"
								/>
								<span class="text-base-content/40">{'#'.repeat(lvl)}</span>
								<span>Heading {lvl}</span>
							</label>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
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
						{#if headingNumbers[item.key]}
							<span class="font-medium text-base-content/70" data-testid="outline-number">{headingNumberPrefix(headingNumbers[item.key])}</span>
						{:else}
							<span class="text-base-content/30">{'#'.repeat(item.level)}</span>
						{/if}
						{item.title}
					</button>
					{#if sectionRun.running.has(item.key)}
						<!-- A cell in this section is executing: the warning-hued spinner, tying
						     it to the in-cell running bar. Running wins the primary indicator; a
						     lingering queued count still shows beside it. -->
						<span
							class="mr-1 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-warning"
							data-testid="outline-running"
							title="Running"
						>
							<span class="loading loading-spinner loading-xs h-3 w-3"></span>
							{#if sectionRun.queued[item.key]}<span class="text-base-content/50">· {sectionRun.queued[item.key]}</span>{/if}
						</span>
					{:else if sectionRun.queued[item.key]}
						<!-- One or more cells in this section are waiting in the kernel queue:
						     the quieter sibling of the running indicator (amber clock + count). -->
						<span
							class="mr-1 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-base-content/60"
							data-testid="outline-queued"
							data-queued-count={sectionRun.queued[item.key]}
							title={`${sectionRun.queued[item.key]} ${sectionRun.queued[item.key] === 1 ? 'cell' : 'cells'} queued`}
						>
							<svg class="h-3 w-3 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
							{sectionRun.queued[item.key]}
						</span>
					{/if}
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

{#snippet checkpointsSection()}
	<div class="flex items-center">
		{@render header('history', 'History', 'section-history')}
		<button
			class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-base-content"
			onclick={() => checkpointsComp?.checkpointNow()}
			disabled={!activeNotebookPath}
			title="Snapshot the notebook now"
			aria-label="Checkpoint now"
			data-testid="checkpoint-now"
		>
			<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
		</button>
		{@render refreshBtn(() => checkpointsComp?.refresh(), 'Refresh checkpoints')}
	</div>
	{#if open.history}
		<Checkpoints bind:this={checkpointsComp} notebookPath={activeNotebookPath} />
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

{#snippet sectionBody(key: string)}
	{#if key === 'files'}{@render filesSection()}
	{:else if key === 'kernels'}{@render kernelsSection()}
	{:else if key === 'databricks'}{@render databricksSection()}
	{:else if key === 'environment'}{@render environmentSection()}
	{:else if key === 'agent'}{@render agentSection()}
	{:else if key === 'outline'}{@render outlineSection()}
	{:else if key === 'history'}{@render checkpointsSection()}
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
{#snippet menuItem(label: string, testid: string, action: () => void, danger = false)}
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
