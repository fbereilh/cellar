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

	// Which foldable sections are open. All start expanded (agent panel collapsed).
	let open = $state({ files: true, kernels: true, agent: false, outline: true, vars: true, search: false });
	function toggle(k) {
		open[k] = !open[k];
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

	// ---- Outline (markdown-header section tree, derived from cells) ---------
	const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
	const outline = $derived.by(() => {
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
		const min = items.length ? Math.min(...items.map((i) => i.level)) : 1;
		return items.map((i, idx) => ({ ...i, indent: i.level - min, key: idx }));
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

<aside class="flex h-full w-full flex-col overflow-hidden bg-base-200 text-base-content" data-testid="sidebar">
	<div class="flex-1 overflow-y-auto">
		<!-- File tree ---------------------------------------------------------->
		<section class="border-b border-base-300">
			<div class="flex items-center">
				<button class="flex flex-1 items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle('files')} data-testid="section-files">
					<svg class="h-3 w-3 transition-transform {open.files ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
					Files
				</button>
				<button class="btn btn-ghost btn-xs btn-square mr-1 text-base-content/40" onclick={refreshFiles} title="Refresh file tree" aria-label="Refresh file tree">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
				</button>
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
		</section>

		<!-- Kernels & attached notebooks --------------------------------------->
		<section class="border-b border-base-300">
			<div class="flex items-center">
				<button class="flex flex-1 items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle('kernels')} data-testid="section-kernels">
					<svg class="h-3 w-3 transition-transform {open.kernels ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
					Kernels
				</button>
				<button class="btn btn-ghost btn-xs btn-square mr-1 text-base-content/40" onclick={onRefreshKernel} title="Refresh kernel status" aria-label="Refresh kernel status">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
				</button>
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
		</section>

		<!-- Connect an agent (live MCP endpoint) ------------------------------->
		<section class="border-b border-base-300">
			<button class="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle('agent')} data-testid="section-agent">
				<svg class="h-3 w-3 transition-transform {open.agent ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
				Connect an agent
			</button>
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
		</section>

		<!-- Outline / Table of contents --------------------------------------->
		<section class="border-b border-base-300">
			<button class="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle('outline')} data-testid="section-outline">
				<svg class="h-3 w-3 transition-transform {open.outline ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
				Outline
			</button>
			{#if open.outline}
				<div class="px-2 pb-2" data-testid="outline-body">
					{#each outline as item (item.key)}
						<button
							class="block w-full truncate rounded px-1 py-0.5 text-left text-xs text-base-content/80 hover:bg-base-300/60"
							style="padding-left: {item.indent * 12 + 8}px"
							onclick={() => onScrollToCell(item.cellId)}
							data-testid="outline-item"
							title={item.text}
						>
							<span class="text-base-content/30">{'#'.repeat(item.level)}</span>
							{item.text}
						</button>
					{:else}
						<p class="px-2 text-xs text-base-content/40">no markdown headings</p>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Variable inspector ------------------------------------------------->
		<section class="border-b border-base-300">
			<div class="flex items-center">
				<button class="flex flex-1 items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle('vars')} data-testid="section-vars">
					<svg class="h-3 w-3 transition-transform {open.vars ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
					Variables
				</button>
				<button class="btn btn-ghost btn-xs btn-square mr-1 text-base-content/40" onclick={onRefreshVars} title="Refresh variables" aria-label="Refresh variables" data-testid="vars-refresh">
					{#if varsLoading}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
					{/if}
				</button>
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
		</section>

		<!-- Search ------------------------------------------------------------->
		<section>
			<button class="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-base-content/60 hover:text-base-content" onclick={() => toggle('search')} data-testid="section-search">
				<svg class="h-3 w-3 transition-transform {open.search ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
				Search
			</button>
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
		</section>
	</div>
</aside>
