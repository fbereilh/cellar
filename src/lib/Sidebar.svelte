<script>
	import { onMount } from 'svelte';
	import FileTreeNode from '$lib/FileTreeNode.svelte';

	let {
		cells,
		mcp = null,
		kernelInfo,
		kernelBusy,
		notebookName,
		variables,
		varsLoading,
		varsError,
		onRefreshVars,
		onRefreshKernel,
		onInterruptKernel,
		onRestartKernel,
		onOpenFile,
		onOpenFilePermanent,
		onOpenNotebook,
		activeFilePath = null,
		fsRefreshSignal = 0,
		onScrollToCell
	} = $props();

	// ---- Persisted section collapse state -----------------------------------
	// Which foldable sections are open. All start expanded (agent panel collapsed),
	// then overridden by the persisted state on mount.
	const OPEN_KEY = 'cellar-sidebar-open';
	let open = $state({ files: true, kernels: true, agent: false, outline: true, vars: true, search: false });
	function toggle(k) {
		open[k] = !open[k];
		persist(OPEN_KEY, open);
	}

	// ---- Persisted section order (drag to reorder) --------------------------
	const ORDER_KEY = 'cellar-sidebar-order';
	const DEFAULT_ORDER = ['files', 'kernels', 'agent', 'outline', 'vars', 'search'];
	let sectionOrder = $state([...DEFAULT_ORDER]);

	function persist(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}
	onMount(() => {
		try {
			const savedOpen = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null');
			if (savedOpen) open = { ...open, ...savedOpen };
		} catch {}
		try {
			const savedOrder = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null');
			if (Array.isArray(savedOrder)) {
				// Keep known keys in the saved order, then append any new sections.
				const known = savedOrder.filter((k) => DEFAULT_ORDER.includes(k));
				sectionOrder = [...known, ...DEFAULT_ORDER.filter((k) => !known.includes(k))];
			}
		} catch {}
		try {
			const savedCollapsed = JSON.parse(localStorage.getItem(OUTLINE_KEY) || 'null');
			if (Array.isArray(savedCollapsed)) collapsed = new Set(savedCollapsed);
		} catch {}
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

	// ---- Outline (nested markdown-header tree, derived from cells) ----------
	const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
	const outlineItems = $derived.by(() => {
		const items = [];
		for (const cell of cells) {
			if (cell.cell_type !== 'markdown') continue;
			const lines = (cell.source || '').split('\n');
			let inFence = false;
			for (const line of lines) {
				if (/^\s*```/.test(line)) inFence = !inFence;
				if (inFence) continue;
				const m = HEADING.exec(line);
				if (m) items.push({ level: m[1].length, text: m[2], cellId: cell.id });
			}
		}
		return items;
	});
	// Build a nested tree from the flat heading list using header levels.
	const outlineTree = $derived.by(() => {
		const root = [];
		const stack = []; // { node, level }
		for (const it of outlineItems) {
			const node = { text: it.text, level: it.level, cellId: it.cellId, children: [] };
			while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
			if (stack.length) {
				const parent = stack[stack.length - 1].node;
				node.key = parent.key + ' / ' + it.text;
				parent.children.push(node);
			} else {
				node.key = it.text;
				root.push(node);
			}
			stack.push({ node, level: it.level });
		}
		return root;
	});
	// Collapsed outline nodes, keyed by heading path (stable across reloads).
	const OUTLINE_KEY = 'cellar-outline-collapsed';
	let collapsed = $state(new Set());
	function toggleNode(key) {
		const next = new Set(collapsed);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		collapsed = next;
		persist(OUTLINE_KEY, [...collapsed]);
	}
	// Flatten the tree to visible rows, hiding children of collapsed nodes.
	const outlineRows = $derived.by(() => {
		const rows = [];
		const walk = (nodes, depth) => {
			for (const n of nodes) {
				const isCollapsed = collapsed.has(n.key);
				rows.push({ text: n.text, level: n.level, cellId: n.cellId, key: n.key, depth, hasChildren: n.children.length > 0, collapsed: isCollapsed });
				if (n.children.length && !isCollapsed) walk(n.children, depth + 1);
			}
		};
		walk(outlineTree, 0);
		return rows;
	});

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

	// ---- Connect an agent (live MCP endpoint) -------------------------------
	// A ready-to-paste config snippet for MCP-speaking agents (Claude Code etc.).
	const mcpSnippet = $derived(
		mcp?.url
			? JSON.stringify({ mcpServers: { cellar: { type: 'http', url: mcp.url } } }, null, 2)
			: ''
	);
	let copied = $state(''); // 'url' | 'snippet' | ''
	let copyTimer;
	async function copy(kind, textVal) {
		try {
			await navigator.clipboard.writeText(textVal);
			copied = kind;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = ''), 1400);
		} catch {}
	}

	function kernelBadge(info) {
		if (!info?.started) return 'badge-ghost';
		if (info.status === 'busy' || info.status === 'starting') return 'badge-warning';
		if (info.status === 'dead') return 'badge-error';
		return 'badge-success';
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
		{@render refreshBtn(refreshFiles, 'Refresh file tree')}
	</div>
	{#if open.files}
		<div class="px-2 pb-2">
			{#if treeError}
				<p class="px-2 text-xs text-error">{treeError}</p>
			{:else if treeRoot}
				<p class="truncate px-1 pb-1 text-[11px] text-base-content/40" title={treeRoot.root}>{treeRoot.name}</p>
				{#each treeRoot.tree as node (node.path)}
					<FileTreeNode {node} onOpen={onOpenFile} onOpenPermanent={onOpenFilePermanent} {gitFiles} activePath={activeFilePath} />
				{:else}
					<p class="px-2 text-xs text-base-content/40">empty workspace</p>
				{/each}
			{:else}
				<p class="px-2 text-xs text-base-content/40">loading…</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet kernelsSection()}
	<div class="flex items-center">
		{@render header('kernels', 'Kernels', 'section-kernels')}
		{@render refreshBtn(onRefreshKernel, 'Refresh kernel status')}
	</div>
	{#if open.kernels}
		<div class="px-3 pb-3" data-testid="kernels-body">
			<div class="rounded-lg border border-base-300 bg-base-100 p-2.5">
				<div class="flex items-center justify-between gap-2">
					<span class="flex items-center gap-1.5 text-sm font-medium">
						<svg class="h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
						{kernelInfo?.name || 'python3'}
					</span>
					<span class="badge badge-sm {kernelBadge(kernelInfo)} gap-1">
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>
						{kernelInfo?.started ? kernelInfo.status : 'not started'}
					</span>
				</div>
				<div class="mt-2 border-t border-base-300 pt-2 text-xs text-base-content/60">
					<div class="mb-1 text-[11px] uppercase tracking-wide text-base-content/40">attached</div>
					<button class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-base-300/50" onclick={() => onOpenNotebook?.()} title="Open the notebook" data-testid="attached-notebook">
						<svg class="h-3.5 w-3.5 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
						<span class="truncate font-mono">{notebookName}</span>
					</button>
				</div>
				<!-- Active-kernel controls: stop a running cell / restart the process
				     (clears the namespace, keeps the session + document). -->
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
			</div>
		</div>
	{/if}
{/snippet}

{#snippet agentSection()}
	<div class="flex items-center">
		{@render header('agent', 'Connect an agent', 'section-agent')}
	</div>
	{#if open.agent}
		<div class="px-3 pb-3" data-testid="agent-body">
			{#if mcp?.url}
				<p class="pb-1.5 text-[11px] leading-relaxed text-base-content/50">
					Point an MCP-speaking agent at this Cellar instance's live endpoint:
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
			{:else}
				<p class="px-1 text-xs text-base-content/40">MCP endpoint unavailable</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet outlineSection()}
	<div class="flex items-center">
		{@render header('outline', 'Outline', 'section-outline')}
	</div>
	{#if open.outline}
		<div class="px-2 pb-2" data-testid="outline-body">
			{#each outlineRows as item (item.key)}
				<div class="flex items-center" style="padding-left: {item.depth * 12}px">
					{#if item.hasChildren}
						<button
							class="flex h-5 w-4 shrink-0 items-center justify-center text-base-content/40 hover:text-base-content"
							onclick={() => toggleNode(item.key)}
							title={item.collapsed ? 'Expand' : 'Collapse'}
							aria-label={item.collapsed ? 'Expand section' : 'Collapse section'}
							data-testid="outline-toggle"
						>
							<svg class="h-3 w-3 transition-transform {item.collapsed ? '' : 'rotate-90'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
						</button>
					{:else}
						<span class="h-5 w-4 shrink-0"></span>
					{/if}
					<button
						class="block flex-1 truncate rounded px-1 py-0.5 text-left text-xs text-base-content/80 hover:bg-base-300/60"
						onclick={() => onScrollToCell(item.cellId)}
						data-testid="outline-item"
						title={item.text}
					>
						<span class="text-base-content/30">{'#'.repeat(item.level)}</span>
						{item.text}
					</button>
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
