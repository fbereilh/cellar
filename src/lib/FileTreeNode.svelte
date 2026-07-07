<script>
	import Self from '$lib/FileTreeNode.svelte';

	// One node of the workspace file tree. Directories toggle open/closed;
	// files invoke onOpen(path) to open into an editor tab.
	let { node, depth = 0, onOpen } = $props();
	let open = $state(depth < 1); // top-level dirs start expanded
</script>

{#if node.type === 'dir'}
	<button
		class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/60"
		style="padding-left: {depth * 12 + 4}px"
		onclick={() => (open = !open)}
		data-testid="tree-dir"
	>
		<svg class="h-3 w-3 shrink-0 text-base-content/50 transition-transform {open ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
		<svg class="h-3.5 w-3.5 shrink-0 text-warning/70" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" /></svg>
		<span class="truncate">{node.name}</span>
	</button>
	{#if open}
		{#each node.children ?? [] as child (child.path)}
			<Self node={child} depth={depth + 1} {onOpen} />
		{/each}
	{/if}
{:else}
	<button
		class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-base-content/80 hover:bg-base-300/60"
		style="padding-left: {depth * 12 + 4}px"
		onclick={() => onOpen(node.path)}
		data-testid="tree-file"
		title={node.path}
	>
		<span class="h-3 w-3 shrink-0"></span>
		<svg class="h-3.5 w-3.5 shrink-0 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
		<span class="truncate">{node.name}</span>
	</button>
{/if}
