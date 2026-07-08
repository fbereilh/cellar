<script module>
	// VS Code-style git decoration colors (theme-independent hues), shared by
	// every tree node. U/A = green, M/R = gold, D/C = red.
	export function gitColor(letter) {
		if (letter === 'U' || letter === 'A') return '#73c991';
		if (letter === 'D' || letter === 'C') return '#c74e39';
		if (letter) return '#e2c08d'; // M, R, T
		return '';
	}
	// Precedence for rolling child statuses up to a collapsed folder.
	const RANK = { C: 5, D: 4, M: 3, R: 3, T: 3, A: 2, U: 1 };
	export function rollupStatus(gitFiles, dirPath) {
		const prefix = dirPath + '/';
		let best = '';
		for (const p in gitFiles) {
			if (!p.startsWith(prefix)) continue;
			const s = gitFiles[p];
			if (!best || (RANK[s] || 0) > (RANK[best] || 0)) best = s;
		}
		return best;
	}
</script>

<script>
	import Self from '$lib/FileTreeNode.svelte';
	import { iconSvg } from '$lib/fileIcons.js';

	// One node of the workspace file tree. Directories toggle open/closed
	// (collapsed by default so only the root level shows on open); files invoke
	// onOpen(path) to preview and onOpenPermanent(path) to pin (double-click).
	let { node, depth = 0, onOpen, onOpenPermanent, gitFiles = {}, activePath = null } = $props();
	let open = $state(false); // folders start collapsed

	const status = $derived(node.type === 'dir' ? rollupStatus(gitFiles, node.path) : gitFiles[node.path] || '');
	const color = $derived(gitColor(status));
	const isActive = $derived(node.type === 'file' && node.path === activePath);
</script>

{#if node.type === 'dir'}
	<button
		class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/60"
		style="padding-left: {depth * 12 + 4}px{color ? `; color: ${color}` : ''}"
		onclick={() => (open = !open)}
		data-testid="tree-dir"
		data-git={status || undefined}
	>
		<svg class="h-3 w-3 shrink-0 text-base-content/50 transition-transform {open ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
		<span class="shrink-0">{@html iconSvg(node.name, { dir: true, open })}</span>
		<span class="truncate">{node.name}</span>
		{#if status}
			<span class="ml-auto mr-1 h-1.5 w-1.5 shrink-0 rounded-full" style="background: {color}" data-testid="tree-git-dot" title="contains changes"></span>
		{/if}
	</button>
	{#if open}
		{#each node.children ?? [] as child (child.path)}
			<Self node={child} depth={depth + 1} {onOpen} {onOpenPermanent} {gitFiles} {activePath} />
		{/each}
	{/if}
{:else}
	<button
		class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/60 {isActive ? 'bg-base-300/70' : ''}"
		style="padding-left: {depth * 12 + 4}px{color ? `; color: ${color}` : ''}"
		class:text-base-content={!color}
		onclick={() => onOpen(node.path)}
		ondblclick={() => onOpenPermanent?.(node.path)}
		data-testid="tree-file"
		data-git={status || undefined}
		title={node.path}
	>
		<span class="h-3 w-3 shrink-0"></span>
		<span class="shrink-0">{@html iconSvg(node.name)}</span>
		<span class="truncate {color ? '' : 'text-base-content/80'}">{node.name}</span>
		{#if status}
			<span class="ml-auto mr-1 shrink-0 font-mono text-[10px] font-semibold" style="color: {color}" data-testid="tree-git-letter">{status}</span>
		{/if}
	</button>
{/if}
