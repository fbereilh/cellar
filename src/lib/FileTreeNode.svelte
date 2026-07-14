<script module lang="ts">
	// VS Code-style git decoration colors, shared by every tree node.
	// U/A = green, M/R = gold, D/C = red. Each token resolves per color-scheme in
	// `app.css` - VS Code's dark decoration hues are far too light to read against
	// a light background, so light and dark carry different values.
	export function gitColor(letter: string): string {
		if (letter === 'U' || letter === 'A') return 'var(--cellar-git-tree-added)';
		if (letter === 'D' || letter === 'C') return 'var(--cellar-git-tree-deleted)';
		if (letter) return 'var(--cellar-git-tree-modified)'; // M, R, T
		return '';
	}
	// Precedence for rolling child statuses up to a collapsed folder.
	const RANK: Record<string, number> = { C: 5, D: 4, M: 3, R: 3, T: 3, A: 2, U: 1 };
	export function rollupStatus(gitFiles: Record<string, string>, dirPath: string): string {
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

<script lang="ts">
	import Self from '$lib/FileTreeNode.svelte';
	import { iconSvg } from '$lib/fileIcons';
	import { getContext } from 'svelte';
	import TreeEntryInput from '$lib/TreeEntryInput.svelte';
	import type { TreeNode } from '$lib/server/fstree';
	import type { GitStatusLetter } from '$lib/server/git';
	import type { CellarFileOps, FileDescriptor } from '$lib/fileOps';

	interface Props {
		node: TreeNode;
		depth?: number;
		/** Single-click a file → preview it. */
		onOpen: (path: string) => void;
		/** Double-click a file → pin it as a permanent tab. */
		onOpenPermanent?: (path: string) => void;
		/** Workspace-relative path → git status letter. */
		gitFiles?: Record<string, GitStatusLetter>;
		/** Predicate: is this workspace-relative path git-ignored? (greys the row.) */
		ignoredMatcher?: (path: string) => boolean;
		activePath?: string | null;
	}

	// One node of the workspace file tree. Directories toggle open/closed
	// (collapsed by default so only the root level shows on open); files invoke
	// onOpen(path) to preview and onOpenPermanent(path) to pin (double-click).
	// File-management state (context menu, clipboard, inline rename/new) flows
	// via the shared `cellarFileOps` context so it need not drill through the
	// recursive tree.
	let { node, depth = 0, onOpen, onOpenPermanent, gitFiles = {}, ignoredMatcher, activePath = null }: Props = $props();
	let open = $state(false); // folders start collapsed

	const ops = getContext<CellarFileOps>('cellarFileOps');

	const status = $derived(node.type === 'dir' ? rollupStatus(gitFiles, node.path) : gitFiles[node.path] || '');
	const color = $derived(gitColor(status));
	// VS Code-style greying for git-ignored entries. Git status wins: a
	// force-added ignored file that carries a status keeps its full-strength color.
	const dimmed = $derived(!status && !!ignoredMatcher?.(node.path));
	const isActive = $derived(node.type === 'file' && node.path === activePath);
	const isSelected = $derived(ops?.selectedPath === node.path);
	// Dim a cut entry (and, for a cut folder, everything under it) until pasted.
	const isCut = $derived.by(() => {
		const c = ops?.clipboard;
		if (!c || c.op !== 'cut') return false;
		return node.path === c.path || node.path.startsWith(c.path + '/');
	});
	const isRenaming = $derived(ops?.renaming === node.path);
	// This folder is the target of a pending "new file/folder" input.
	const isNewTarget = $derived(node.type === 'dir' && ops?.newEntry?.parentPath === node.path);
	const showChildren = $derived(open || isNewTarget);

	// Keep a folder expanded once it becomes (or was) the new-entry target so the
	// freshly created child stays visible after the tree refreshes.
	$effect(() => {
		if (isNewTarget) open = true;
	});

	const descriptor: FileDescriptor = $derived({ type: node.type, path: node.path, name: node.name });

	function onContext(e: MouseEvent) {
		if (!ops) return;
		e.preventDefault();
		e.stopPropagation();
		ops.openMenu(e, descriptor);
	}
</script>

{#if node.type === 'dir'}
	{#if isRenaming}
		<TreeEntryInput
			{depth}
			initial={node.name}
			icon={iconSvg(node.name, { dir: true, open })}
			onSubmit={(name: string) => ops.submitRename(node.path, name)}
			onCancel={() => ops.cancelRename()}
		/>
	{:else}
		<button
			class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/60 {isSelected ? 'bg-base-300/70' : ''} {isCut ? 'opacity-40' : ''} {dimmed ? 'opacity-50' : ''}"
			style="padding-left: {depth * 12 + 4}px{color ? `; color: ${color}` : ''}"
			onclick={() => { ops?.select(descriptor); open = !open; }}
			oncontextmenu={onContext}
			data-testid="tree-dir"
			data-path={node.path}
			data-git={status || undefined}
			data-git-ignored={dimmed || undefined}
		>
			<svg class="h-3 w-3 shrink-0 text-base-content/50 transition-transform {open ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
			<span class="shrink-0">{@html iconSvg(node.name, { dir: true, open })}</span>
			<span class="truncate">{node.name}</span>
			{#if status}
				<span class="ml-auto mr-1 h-1.5 w-1.5 shrink-0 rounded-full" style="background: {color}" data-testid="tree-git-dot" title="contains changes"></span>
			{/if}
		</button>
	{/if}
	{#if showChildren}
		{#if isNewTarget}
			<TreeEntryInput
				depth={depth + 1}
				kind={ops.newEntry?.kind}
				onSubmit={(name: string) => ops.submitNew(name)}
				onCancel={() => ops.cancelNew()}
			/>
		{/if}
		{#each node.children ?? [] as child (child.path)}
			<Self node={child} depth={depth + 1} {onOpen} {onOpenPermanent} {gitFiles} {ignoredMatcher} {activePath} />
		{/each}
	{/if}
{:else if isRenaming}
	<TreeEntryInput
		{depth}
		initial={node.name}
		icon={iconSvg(node.name)}
		onSubmit={(name: string) => ops.submitRename(node.path, name)}
		onCancel={() => ops.cancelRename()}
	/>
{:else}
	<button
		class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-base-300/60 {isActive || isSelected ? 'bg-base-300/70' : ''} {isCut ? 'opacity-40' : ''} {dimmed ? 'opacity-50' : ''}"
		style="padding-left: {depth * 12 + 4}px{color ? `; color: ${color}` : ''}"
		class:text-base-content={!color}
		onclick={() => { ops?.select(descriptor); onOpen(node.path); }}
		ondblclick={() => onOpenPermanent?.(node.path)}
		oncontextmenu={onContext}
		data-testid="tree-file"
		data-path={node.path}
		data-git={status || undefined}
		data-git-ignored={dimmed || undefined}
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
