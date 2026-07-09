<script>
	import { iconSvg } from '$lib/fileIcons.js';
	import { kernelBadgeClass, kernelStatusLabel } from '$lib/kernelBadge.js';

	let {
		tabs,
		activeTabId,
		sidebarOpen,
		kernelInfo,
		onSelectTab,
		onCloseTab,
		onPromoteTab,
		onToggleSidebar,
		onOpenSettings
	} = $props();

	// Reflect the real kernel state, not a phantom: no kernel started → a neutral
	// "not started", never a green idle badge.
	const kernelLabel = $derived(kernelStatusLabel(kernelInfo));
	const kernelBadge = $derived(kernelBadgeClass(kernelInfo));
</script>

<header class="flex min-h-11 items-stretch border-b border-base-300 bg-base-100 text-base-content" data-testid="navbar">
	<!-- Left cluster: sidebar toggle, brand, app menu -->
	<div class="flex items-center gap-1 border-r border-base-300 px-2">
		<button
			class="btn btn-ghost btn-sm btn-square"
			onclick={onToggleSidebar}
			title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
			aria-label="Toggle sidebar"
			data-testid="toggle-sidebar"
		>
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
		</button>

		<div class="dropdown">
			<div tabindex="0" role="button" class="btn btn-ghost btn-sm gap-1 px-2" data-testid="app-menu">
				<span>🍷</span>
				<span class="font-semibold">Cellar</span>
				<svg class="h-3 w-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
			</div>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<ul tabindex="0" class="menu dropdown-content z-50 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
				<li class="menu-title text-[11px]">Options</li>
				<li><button class="justify-between" disabled>New notebook <kbd class="kbd kbd-xs">soon</kbd></button></li>
				<li><button class="justify-between" disabled>Export .py view <kbd class="kbd kbd-xs">soon</kbd></button></li>
				<div class="divider my-1"></div>
				<li>
					<button onclick={onOpenSettings} data-testid="open-settings">
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
						Settings
					</button>
				</li>
			</ul>
		</div>
	</div>

	<!-- Tab bar: wraps onto additional rows when the open tabs overflow. -->
	<div class="flex min-w-0 flex-1 flex-wrap content-start items-stretch" data-testid="tabbar">
		{#each tabs as tab (tab.id)}
			<div
				class="group flex max-w-[220px] shrink-0 items-center gap-1.5 border-b border-r border-base-300 px-3 text-sm {tab.id === activeTabId ? 'bg-base-200 text-base-content' : 'bg-base-100 text-base-content/60 hover:bg-base-200/50'}"
				data-testid="tab"
				data-tab-id={tab.id}
				data-active={tab.id === activeTabId}
				data-preview={tab.preview || undefined}
				ondblclick={() => tab.preview && onPromoteTab?.(tab.id)}
			>
				<button class="flex min-w-0 items-center gap-1.5 py-2" onclick={() => onSelectTab(tab.id)}>
					<span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{@html iconSvg(tab.title, { dir: false })}</span>
					<span class="truncate {tab.preview ? 'italic' : ''}">{tab.title}</span>
				</button>
				{#if tab.dirty}
					<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Unsaved changes" data-testid="tab-dirty"></span>
				{/if}
				{#if tab.closable}
					<button
						class="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-40 hover:opacity-100"
						onclick={() => onCloseTab(tab.id)}
						title="Close tab"
						aria-label="Close tab"
						data-testid="tab-close"
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
					</button>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Right cluster: kernel status -->
	<div class="flex items-center gap-2 border-l border-base-300 px-3 text-xs text-base-content/60">
		<span>kernel</span>
		<span class="badge badge-sm gap-1.5 badge-soft {kernelBadge}" data-testid="kernel-status">
			<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>
			{kernelLabel}
		</span>
	</div>
</header>
