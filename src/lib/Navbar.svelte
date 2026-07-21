<script lang="ts">
	import { iconSvg } from '$lib/fileIcons';
	import { kernelBadgeClass, kernelStatusLabel, formatMemory } from '$lib/kernelBadge';
	import type { KernelInfo } from '$lib/kernelBadge';

	// The tab fields the navbar renders. The shell (+page) holds richer tab
	// objects (path/kind/…); structural typing lets it pass those here.
	interface Tab {
		id: string;
		title: string;
		preview?: boolean;
		dirty?: boolean;
		closable?: boolean;
	}

	interface Props {
		tabs: Tab[];
		activeTabId: string | null;
		/** Per-tab run indicator, keyed by tab id: 'running' or 'queued' (background runs included). */
		tabRunState?: Record<string, 'running' | 'queued'>;
		sidebarOpen: boolean;
		kernelInfo: KernelInfo | null;
		canConsolidateImports?: boolean;
		consolidating?: boolean;
		canSaveAsPy?: boolean;
		canConvertToIpynb?: boolean;
		converting?: boolean;
		canExportHtml?: boolean;
		canRunActions?: boolean;
		canCheckpoint?: boolean;
		/** A notebook is active, so the notebook-wide hide-code toggle has a target. */
		canHideCode?: boolean;
		/** Whether the active notebook's "hide all code" (report view) is on. */
		hideAllCode?: boolean;
		/** Whether "follow the running cell" is on (a global viewer preference). */
		followRunningCell?: boolean;
		onSelectTab: (id: string) => void;
		/** Click the tab's run/queue indicator: jump to that notebook's running cell. */
		onJumpToRunningCell?: (id: string) => void;
		onCloseTab: (id: string) => void;
		onPromoteTab?: (id: string) => void;
		onToggleSidebar: () => void;
		onConsolidateImports: () => void;
		onExportPy: () => void;
		onSaveAsPy: () => void;
		onConvertToIpynb: () => void;
		onExportHtml: () => void;
		onRunStale: () => void;
		onRunAbove: () => void;
		onRunBelow: () => void;
		onCheckpointNow: () => void;
		onUndoAgent: () => void;
		/** Toggle the active notebook's notebook-wide "hide all code" (report view). */
		onToggleHideAllCode: () => void;
		/** Toggle the global "follow the running cell" viewer preference. */
		onToggleFollowRunningCell: () => void;
		onOpenSettings: () => void;
	}

	let {
		tabs,
		activeTabId,
		tabRunState = {},
		sidebarOpen,
		kernelInfo,
		canConsolidateImports = false, // a notebook is active, so the sweep has a target
		consolidating = false,
		canSaveAsPy = false, // a notebook is active → it can be exported to a .py
		canConvertToIpynb = false, // the active notebook is a .py → it can be run into an .ipynb
		converting = false,
		canExportHtml = false, // a notebook is active, so there's something to export
		canRunActions = false, // a notebook is active, so the bulk-run actions have a target
		canCheckpoint = false, // a notebook is active, so it can be snapshotted / reverted
		canHideCode = false, // a notebook is active, so hide-all-code has a target
		hideAllCode = false, // the active notebook's report-view state
		followRunningCell = true, // global viewer preference (default on)
		onSelectTab,
		onJumpToRunningCell,
		onCloseTab,
		onPromoteTab,
		onToggleSidebar,
		onConsolidateImports,
		onExportPy,
		onSaveAsPy,
		onConvertToIpynb,
		onExportHtml,
		onRunStale,
		onRunAbove,
		onRunBelow,
		onCheckpointNow,
		onUndoAgent,
		onToggleHideAllCode,
		onToggleFollowRunningCell,
		onOpenSettings
	}: Props = $props();

	// Reflect the real kernel state, not a phantom: no kernel started → a neutral
	// "not started", never a green idle badge.
	const kernelLabel = $derived(kernelStatusLabel(kernelInfo));
	const kernelBadge = $derived(kernelBadgeClass(kernelInfo));
	// Live resident memory of the active kernel; null (hidden) when no kernel / unread.
	const kernelMemory = $derived(kernelInfo?.started ? formatMemory(kernelInfo.memoryRss) : null);
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
			<ul tabindex="0" class="menu dropdown-content z-50 mt-1 w-60 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
				<li class="menu-title text-[11px]">Options</li>
				<li>
					<button
						onclick={onSaveAsPy}
						disabled={!canSaveAsPy}
						title="Export this notebook to a jupytext .py file (Databricks or percent format)"
						data-testid="save-as-py"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
						Save as .py…
					</button>
				</li>
				<li>
					<button
						onclick={onConvertToIpynb}
						disabled={!canConvertToIpynb || converting}
						title="Run every cell of this .py notebook and write an .ipynb with the outputs beside it"
						data-testid="convert-to-ipynb"
					>
						{#if converting}
							<span class="loading loading-spinner loading-xs"></span>
						{:else}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
						{/if}
						Convert to .ipynb…
					</button>
				</li>
				<li>
					<button
						onclick={onExportHtml}
						disabled={!canExportHtml}
						title="Export this notebook as a single self-contained HTML file (rendered markdown, code, and its saved outputs) you can share with anyone"
						data-testid="export-html"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></svg>
						Export to HTML
					</button>
				</li>
				<li>
					<button
						onclick={onConsolidateImports}
						disabled={!canConsolidateImports || consolidating}
						title="Move every top-level import into one pinned cell at the top of the notebook, and run it"
						data-testid="consolidate-imports"
					>
						{#if consolidating}
							<span class="loading loading-spinner loading-xs"></span>
						{:else}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
						{/if}
						Consolidate imports
					</button>
				</li>
				<li>
					<button
						onclick={onExportPy}
						disabled={!canConsolidateImports}
						title="Write the cells marked for export to the notebook's .py module (nbdev-style). Mark cells and set the target from the bar at the top of the notebook."
						data-testid="export-py-menu"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
						Export to .py
					</button>
				</li>
				<div class="divider my-1"></div>
				<li class="menu-title text-[11px]">View</li>
				<li>
					<button
						onclick={onToggleHideAllCode}
						disabled={!canHideCode}
						title="Hide every code cell's input for a clean, output-only report view. A cell's own show/hide choice still wins; reveal any one from its 'show code' bar."
						data-testid="toggle-hide-all-code"
						aria-pressed={hideAllCode}
					>
						{#if hideAllCode}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
							Show all code
						{:else}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
							Hide all code
						{/if}
					</button>
				</li>
				<li>
					<button
						onclick={onToggleFollowRunningCell}
						title="Scroll the running cell into view while you're viewing the notebook that's executing. Runs in a notebook you're not looking at (e.g. an agent working in the background) never move your view."
						data-testid="toggle-follow-running-cell"
						aria-pressed={followRunningCell}
					>
						{#if followRunningCell}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 5v2" /><path d="M12 17v2" /><path d="M5 12h2" /><path d="M17 12h2" /></svg>
							Stop following runs
						{:else}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 5v2" /><path d="M12 17v2" /><path d="M5 12h2" /><path d="M17 12h2" /><line x1="3" y1="3" x2="21" y2="21" /></svg>
							Follow running cell
						{/if}
					</button>
				</li>
				<div class="divider my-1"></div>
				<li class="menu-title text-[11px]">Run</li>
				<li>
					<button
						onclick={onRunStale}
						disabled={!canRunActions}
						title="Re-run every cell whose result is out of date (a cell it depends on changed since it ran), in dependency order"
						data-testid="run-stale"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
						Run stale cells
					</button>
				</li>
				<li>
					<button
						onclick={onRunAbove}
						disabled={!canRunActions}
						title="Run every code cell above the selected cell"
						data-testid="run-above"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
						Run cells above
					</button>
				</li>
				<li>
					<button
						onclick={onRunBelow}
						disabled={!canRunActions}
						title="Run the selected cell and every code cell below it"
						data-testid="run-below"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
						Run cells below
					</button>
				</li>
				<div class="divider my-1"></div>
				<li class="menu-title text-[11px]">History</li>
				<li>
					<button
						onclick={onCheckpointNow}
						disabled={!canCheckpoint}
						title="Snapshot this notebook (cells + outputs) to a restorable checkpoint"
						data-testid="menu-checkpoint-now"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></svg>
						Checkpoint now
					</button>
				</li>
				<li>
					<button
						onclick={onUndoAgent}
						disabled={!canCheckpoint}
						title="Restore this notebook to just before the last agent action"
						data-testid="menu-undo-agent"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" /></svg>
						Undo last agent action
					</button>
				</li>
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
			{@const runState = tabRunState[tab.id]}
			<div
				class="group flex max-w-[220px] shrink-0 items-center gap-1.5 border-b border-r border-base-300 px-3 text-sm {tab.id === activeTabId ? 'bg-base-200 text-base-content' : 'bg-base-100 text-base-content/60 hover:bg-base-200/50'}"
				data-testid="tab"
				data-tab-id={tab.id}
				data-active={tab.id === activeTabId}
				data-preview={tab.preview || undefined}
				data-run-state={runState || undefined}
				ondblclick={() => tab.preview && onPromoteTab?.(tab.id)}
			>
				<!-- While this notebook is executing/queueing a cell, the icon slot shows a
				     run indicator instead of the file icon (background runs included), so a
				     glance at the tab strip tells you which notebooks are busy. When shown,
				     it's a distinct button: clicking it jumps to that notebook's running
				     cell (activating the tab first if it isn't the viewed one), while a
				     click anywhere else on the tab still just selects it. The click is
				     stopped from bubbling so a spinner-click is never an ambiguous tab
				     select. -->
				{#if runState}
					<button
						type="button"
						class="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-base-300/70"
						title="Jump to running cell"
						aria-label="Jump to running cell"
						data-testid="tab-jump-running"
						onclick={(e) => {
							e.stopPropagation();
							onJumpToRunningCell?.(tab.id);
						}}
					>
						{#if runState === 'running'}
							<span class="loading loading-spinner h-3.5 w-3.5 text-warning" data-testid="tab-running"></span>
						{:else}
							<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-warning/70" data-testid="tab-queued"></span>
						{/if}
					</button>
				{/if}
				<button class="flex min-w-0 items-center gap-1.5 py-2" onclick={() => onSelectTab(tab.id)}>
					{#if !runState}
						<span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
							{@html iconSvg(tab.title, { dir: false })}
						</span>
					{/if}
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

	<!-- Right cluster: kernel status + live resident memory -->
	<div class="flex items-center gap-2 border-l border-base-300 px-3 text-xs text-base-content/60">
		<span>kernel</span>
		<span class="badge badge-sm gap-1.5 badge-soft {kernelBadge}" data-testid="kernel-status">
			<span class="inline-block h-1.5 w-1.5 rounded-full bg-current"></span>
			{kernelLabel}
		</span>
		{#if kernelMemory}
			<span class="tabular-nums text-base-content/45" title="Kernel resident memory (RSS)" data-testid="kernel-memory">
				{kernelMemory}
			</span>
		{/if}
	</div>
</header>
