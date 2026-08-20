<script lang="ts">
	import { iconSvg } from '$lib/fileIcons';
	import { kernelBadgeClass, kernelStatusLabel, formatMemory } from '$lib/kernelBadge';
	import type { KernelInfo } from '$lib/kernelBadge';
	import { shortcuts, chordFromEvent } from '$lib/shortcuts.svelte';
	import { dropIndexAt, exceedsDragThreshold, landingIndex, stepSlot, type TabBox } from '$lib/tabReorder';
	import { tabDomId, tabPanelDomId } from '$lib/tabIds';
	import { tick } from 'svelte';

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
		/**
		 * Whether windowed cell rendering is on (a global viewer preference, default on).
		 * The shell owns it; the Settings pane toggles the SAME state, so this is a view
		 * of one preference, never a copy of it.
		 */
		virtualizeCells?: boolean;
		/** A `?virtualize=` URL param decided it: show the state, but lock the toggle. */
		virtualizeForced?: boolean;
		onSelectTab: (id: string) => void;
		/** Click the tab's run/queue indicator: jump to that notebook's running cell. */
		onJumpToRunningCell?: (id: string) => void;
		onCloseTab: (id: string) => void;
		onPromoteTab?: (id: string) => void;
		/**
		 * Move tab `id` to insertion slot `insertAt` (0 = before the first tab,
		 * `tabs.length` = after the last). The shell owns the array and applies
		 * `$lib/tabReorder`'s `reorderTabs`, which no-ops when the slot is one the
		 * tab already occupies - so both the pointer drop and the keyboard step
		 * come through this ONE seam rather than each editing the order its own way.
		 */
		onReorderTabs?: (id: string, insertAt: number) => void;
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
		/** Toggle the global windowed-cell-rendering viewer preference. */
		onToggleVirtualizeCells?: () => void;
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
		virtualizeCells = true, // global viewer preference (windowed rendering, default on)
		virtualizeForced = false, // a ?virtualize= URL param owns this session
		onSelectTab,
		onJumpToRunningCell,
		onCloseTab,
		onPromoteTab,
		onReorderTabs,
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
		onToggleVirtualizeCells,
		onOpenSettings
	}: Props = $props();

	// Reflect the real kernel state, not a phantom: no kernel started → a neutral
	// "not started", never a green idle badge.
	const kernelLabel = $derived(kernelStatusLabel(kernelInfo));
	const kernelBadge = $derived(kernelBadgeClass(kernelInfo));
	// Live resident memory of the active kernel; null (hidden) when no kernel / unread.
	const kernelMemory = $derived(kernelInfo?.started ? formatMemory(kernelInfo.memoryRss) : null);

	// ---- Tab reordering (drag + keyboard) -----------------------------------
	//
	// A press on a tab is AMBIGUOUS until it moves: it may be a click (switch to
	// that file), a click on one of the tab's own controls, or the start of a
	// drag. `press` holds that undecided state; only travel past
	// `DRAG_THRESHOLD_PX` promotes it to a drag, at which point `dragId` is set.
	// Below the threshold nothing happens at all, so click-to-switch and
	// close-tab behave exactly as they did before tabs became draggable.
	let stripEl: HTMLElement | null = $state(null);
	let press: {
		id: string;
		/** Only the pointer that started the gesture drives it (a second finger does not). */
		pointerId: number;
		x: number;
		y: number;
		boxes: TabBox[] | null;
		/** Escape was pressed: abandon the move AND the click the release would make. */
		cancelled?: boolean;
	} | null = null;
	let dragId = $state<string | null>(null);
	let dropIndex = $state<number | null>(null);
	let dragDx = $state(0);
	let dragDy = $state(0);
	/** Announced to assistive tech after a KEYBOARD move, which has no visual drag to watch. */
	let moveAnnouncement = $state('');

	// ---- Roving tabindex ----------------------------------------------------
	//
	// The tablist pattern makes the whole strip exactly ONE Tab stop: one tab is
	// tabbable and every other is reachable from it with the arrows. So the
	// document's Tab order stays proportional to what the strip MEANS (one control
	// - "which file am I looking at") rather than growing by one stop per open
	// file, with the per-tab close buttons doubling it again.
	//
	// It follows the FOCUSED tab rather than the selected one, so tabbing away and
	// back returns to where the user was; it falls back to the selected tab, and
	// then to the first, so the strip always has exactly one stop even before it
	// has ever been focused.
	let focusedTabId = $state<string | null>(null);
	const rovingTabId = $derived.by(() => {
		const present = (id: string | null) => id != null && tabs.some((t) => t.id === id);
		if (present(focusedTabId)) return focusedTabId;
		if (present(activeTabId)) return activeTabId;
		return tabs[0]?.id ?? null;
	});
	// A closed tab must not leave a pointer behind: reopened later it would claim
	// the roving stop over the tab the user is actually looking at.
	$effect(() => {
		if (focusedTabId != null && !tabs.some((t) => t.id === focusedTabId)) focusedTabId = null;
	});

	/**
	 * The strip's laid-out geometry, in document order, snapshotted when a drag
	 * begins. Snapshotted rather than re-measured per move because the dragged tab
	 * is `translate`d away from its slot - it still occupies its original box in
	 * LAYOUT (which is what hit-testing needs), but its live rect no longer
	 * reports it. Nothing else reflows during a drag: the drop indicator is
	 * zero-width, so the snapshot stays true for the whole gesture.
	 */
	function snapshotTabBoxes(strip: Element): TabBox[] {
		return [...strip.querySelectorAll<HTMLElement>('[data-testid="tab"]')].map((el) => {
			const r = el.getBoundingClientRect();
			return { id: el.dataset.tabId ?? '', left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		});
	}

	function endDrag() {
		press = null;
		dragId = null;
		dropIndex = null;
		dragDx = 0;
		dragDy = 0;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerCancel);
		window.removeEventListener('keydown', onDragKeydown, true);
	}

	/**
	 * Swallow the `click` the browser is about to synthesise from this pointerup.
	 * Without it a drag would also select the file it dropped - the one thing
	 * reordering must never do as a side effect. Registered in the capture phase
	 * so it beats the tab's own handler, and torn down on a macrotask: the
	 * synthesised click is dispatched in the same turn as the pointerup, so a
	 * `setTimeout(0)` always runs after it and can never eat a later, real click.
	 */
	function swallowNextClick() {
		const swallow = (ev: MouseEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
		};
		window.addEventListener('click', swallow, true);
		setTimeout(() => window.removeEventListener('click', swallow, true), 0);
	}

	function onPointerMove(e: PointerEvent) {
		if (!press || e.pointerId !== press.pointerId) return;
		// A cancelled gesture stays cancelled for the REST of its life. Escape clears
		// `dragId` but deliberately leaves the gesture running (so the release is still
		// ours to swallow), and the threshold below is measured from the ORIGINAL press
		// point - which the pointer is by then far away from - so without this the very
		// next move re-crossed it and restarted a drag the user had just abandoned:
		// the tab lifted again, the indicator came back, and the drop then silently did
		// nothing.
		if (press.cancelled) return;
		const dx = e.clientX - press.x;
		const dy = e.clientY - press.y;
		if (!dragId) {
			if (!exceedsDragThreshold(dx, dy)) return;
			// Measured only once the press has become a drag, so an ordinary click on
			// a tab still costs no forced layout.
			press.boxes = stripEl ? snapshotTabBoxes(stripEl) : [];
			dragId = press.id;
			window.addEventListener('keydown', onDragKeydown, true);
		}
		dragDx = dx;
		dragDy = dy;
		dropIndex = dropIndexAt(press.boxes ?? [], e.clientX, e.clientY);
	}

	function onPointerUp(e: PointerEvent) {
		if (press && e.pointerId !== press.pointerId) return;
		const cancelled = press?.cancelled === true;
		const id = dragId;
		const slot = dropIndex;
		endDrag();
		// An abandoned drag must not select the file it was released over either -
		// which is why Escape leaves the gesture RUNNING (flagged) rather than tearing
		// it down: the release is still ours to swallow.
		if (cancelled) return swallowNextClick();
		if (id == null || slot == null) return; // never crossed the threshold: an ordinary click
		swallowNextClick();
		onReorderTabs?.(id, slot);
	}

	function onPointerCancel(e: PointerEvent) {
		if (press && e.pointerId !== press.pointerId) return;
		const dragged = dragId != null || press?.cancelled === true;
		endDrag();
		if (dragged) swallowNextClick();
	}

	/**
	 * Escape abandons a drag in flight: the tab snaps back to its slot, nothing is
	 * written, and the pointer listeners STAY so the eventual release is swallowed
	 * rather than landing as a plain click on the tab.
	 */
	function onDragKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !press) return;
		e.preventDefault();
		e.stopPropagation();
		press.cancelled = true;
		dragId = null;
		dropIndex = null;
		dragDx = 0;
		dragDy = 0;
		window.removeEventListener('keydown', onDragKeydown, true);
	}

	// A gesture must not outlive the strip: drop the window listeners on teardown.
	$effect(() => () => endDrag());

	function onTabPointerDown(e: PointerEvent, id: string) {
		if (e.button !== 0) return; // a context-menu / auxiliary press is not a drag
		// A control inside a draggable surface stays a control: a press on the
		// close or jump-to-running button must never begin a tab drag.
		if ((e.target as Element | null)?.closest('[data-tab-nodrag]')) return;
		press = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, boxes: null };
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerCancel);
	}

	/**
	 * A tab's classes, decided in ONE place so the states cannot fight.
	 *
	 * The background in particular MUST be a single choice rather than layered
	 * utilities: `hover:bg-base-200/50` out-specifies a plain `bg-base-200`, so a
	 * lifted tab - which is by definition under the pointer, and therefore hovered
	 * - rendered at 50% alpha and let the tabs it was floating over read straight
	 * through it. The hover tint is also dropped from EVERY tab while a drag is in
	 * flight: mid-drag the drop indicator should be the only thing on the strip
	 * saying where the tab is going.
	 */
	function tabClass(id: string): string {
		const active = id === activeTabId;
		const dragging = dragId === id;
		const base =
			'group flex max-w-[220px] shrink-0 select-none items-center gap-1.5 border-b border-r border-base-300 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary';
		const tone = active || dragging ? 'bg-base-200 text-base-content' : 'bg-base-100 text-base-content/60';
		const hover = dragId || active ? '' : 'hover:bg-base-200/50';
		const lift = dragging ? 'relative z-20 cursor-grabbing rounded-sm shadow-lg ring-1 ring-primary/60' : 'cursor-grab';
		return `${base} ${tone} ${hover} ${lift}`;
	}

	const bindingsFor = (id: string) => shortcuts.list.find((s) => s.id === id)?.keys ?? [];

	/**
	 * Keyboard handling for a focused tab: Enter/Space selects it, and the
	 * registry's `move-tab-left` / `move-tab-right` bindings reorder it - so
	 * reordering is reachable with no pointer, and is listed (and rebindable) in
	 * Settings beside every other shortcut.
	 *
	 * Dispatched HERE rather than in the shell's global handler because the gate
	 * is structural: the event target IS the tab, so these chords can only fire
	 * while a tab has focus and can never shadow a notebook binding.
	 */
	/** Put focus on a tab by id (it may have just moved in the DOM). */
	function focusTab(id: string | undefined) {
		if (!id) return;
		document.querySelector<HTMLElement>(`[data-testid="tab"][data-tab-id="${CSS.escape(id)}"]`)?.focus();
	}

	async function onTabKeydown(e: KeyboardEvent, id: string, index: number) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelectTab(id);
			return;
		}
		// Arrow/Home/End move FOCUS along the strip without selecting - the tablist
		// pattern's manual-activation form, so browsing the tabs with the keyboard
		// never switches files by accident. Bare keys only: the reorder chords below
		// are the same arrows with modifiers.
		const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
		if (bare && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
			e.preventDefault();
			const n = tabs.length;
			const to =
				e.key === 'Home'
					? 0
					: e.key === 'End'
						? n - 1
						: e.key === 'ArrowLeft'
							? (index - 1 + n) % n
							: (index + 1) % n;
			focusTab(tabs[to]?.id);
			return;
		}
		// Delete/Backspace close the focused tab. The close button is inside the tab
		// and is NOT in the document's Tab order (that is what the roving tabindex
		// buys), so this is the keyboard's only route to it - without it the pattern
		// would have made closing a tab pointer-only.
		if (bare && (e.key === 'Delete' || e.key === 'Backspace')) {
			e.preventDefault();
			if (!tabs[index]?.closable) return;
			// Land on the tab that takes the closed one's SLOT, else the one before it.
			// Assigned before the close so the roving stop leaves the dying tab with it;
			// closing the last tab leaves nothing to focus, and nothing pointing at a
			// node that is gone either.
			const next = tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
			focusedTabId = next;
			onCloseTab(id);
			await tick();
			focusTab(next ?? undefined);
			return;
		}
		const chord = chordFromEvent(e);
		if (!chord) return;
		// A step of one place, expressed as an INSERTION SLOT so it reaches the
		// document through the same `reorderTabs` the pointer drop does. An
		// out-of-range slot is clamped by that function onto the tab's own position,
		// so a step off either end is an honest no-op rather than a wrap-around.
		const left = bindingsFor('move-tab-left').includes(chord);
		const right = bindingsFor('move-tab-right').includes(chord);
		if (!left && !right) return;
		e.preventDefault();
		e.stopPropagation();
		const slot = stepSlot(index, left ? -1 : 1);
		const landed = landingIndex(index, Math.max(0, Math.min(tabs.length, slot)));
		if (landed === index) {
			moveAnnouncement = `${tabs[index]?.title ?? 'Tab'} is already ${left ? 'first' : 'last'}`;
			return;
		}
		onReorderTabs?.(id, slot);
		// Svelte's keyed each MOVES the node, which drops focus, so put it back on
		// the tab the user is still steering.
		await tick();
		focusTab(id);
		moveAnnouncement = `${tabs[landed]?.title ?? 'Tab'} moved to position ${landed + 1} of ${tabs.length}`;
	}
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
				<li>
					<button
						onclick={onToggleVirtualizeCells}
						disabled={virtualizeForced}
						title={virtualizeForced
							? `The ?virtualize URL parameter is controlling this session (windowed rendering ${virtualizeCells ? 'on' : 'off'}); reload without it to use this toggle.`
							: 'Render only the cells near the viewport, so a long notebook stays fast. Turn it off to keep every cell in the page at all times.'}
						data-testid="toggle-virtualize-cells"
						aria-pressed={virtualizeCells}
					>
						{#if virtualizeCells}
							<!-- offered action: un-window → every row drawn -->
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16" /><path d="M4 10h16" /><path d="M4 14h16" /><path d="M4 19h16" /></svg>
							Render all cells
						{:else}
							<!-- offered action: window → only the rows in the viewport band -->
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16" opacity="0.35" /><rect x="3" y="8.5" width="18" height="7" rx="1.5" /><path d="M4 19h16" opacity="0.35" /></svg>
							Render only visible cells
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

	<!--
		The insertion marker: where the dragged tab will land. Zero-width IN FLOW (the
		bar is absolutely positioned), so revealing it never shifts the tabs it sits
		between - an indicator that pushes the strip around as you drag is exactly the
		mush this has to avoid. `z-30` puts it above the LIFTED tab (`z-20`), which
		necessarily floats under the pointer and so would otherwise hide the very
		answer it is being asked for; the caps are what stop the bar reading as a text
		caret where it crosses the dragged tab's label.
	-->
	{#snippet dropMarker(index: number)}
		<div class="relative z-30 w-0 self-stretch" aria-hidden="true" data-testid="tab-drop-indicator" data-drop-index={index}>
			<span class="absolute inset-y-1 -left-[1.5px] w-[3px] rounded-full bg-primary shadow-[0_0_7px_var(--color-primary)]"></span>
			<span class="absolute -top-px -left-[3.5px] h-[7px] w-[7px] rotate-45 rounded-[1.5px] bg-primary"></span>
			<span class="absolute -bottom-px -left-[3.5px] h-[7px] w-[7px] rotate-45 rounded-[1.5px] bg-primary"></span>
		</div>
	{/snippet}

	<!--
		Tab bar: wraps onto additional rows when the open tabs overflow, and its
		tabs are reorderable by dragging one to a new slot (see `$lib/tabReorder`).

		The drag is POINTER-driven, not HTML5 drag-and-drop. Three things follow
		from that and are the reason for the choice: the press only becomes a drag
		past `DRAG_THRESHOLD_PX`, so an ordinary click is never misread as the
		start of one; the tab itself is what follows the pointer (a `translate`),
		rather than the browser's washed-out drag image; and the drop indicator is
		drawn from a layout snapshot we own, so it names an exact slot on the
		exact row - which a wrapped, multi-row strip needs.
	-->
	<div
		bind:this={stripEl}
		class="flex min-w-0 flex-1 flex-wrap content-start items-stretch {dragId ? 'cursor-grabbing select-none' : ''}"
		data-testid="tabbar"
		role="tablist"
		aria-label="Open files"
		aria-orientation="horizontal"
	>
		{#each tabs as tab, i (tab.id)}
			{@const runState = tabRunState[tab.id]}
			{@const dragging = dragId === tab.id}
			{#if dropIndex === i}{@render dropMarker(i)}{/if}
			<div
				class={tabClass(tab.id)}
				style={dragging ? `transform: translate(${dragDx}px, ${dragDy}px)` : undefined}
				data-testid="tab"
				data-tab-id={tab.id}
				data-active={tab.id === activeTabId}
				data-preview={tab.preview || undefined}
				data-run-state={runState || undefined}
				data-dragging={dragging || undefined}
				role="tab"
				tabindex={tab.id === rovingTabId ? 0 : -1}
				id={tabDomId(tab.id)}
				aria-controls={tabPanelDomId(tab.id)}
				aria-selected={tab.id === activeTabId}
				aria-label="{tab.title}, tab {i + 1} of {tabs.length}"
				onfocusin={() => (focusedTabId = tab.id)}
				onpointerdown={(e) => onTabPointerDown(e, tab.id)}
				onkeydown={(e) => onTabKeydown(e, tab.id, i)}
				onclick={() => onSelectTab(tab.id)}
				ondblclick={() => tab.preview && onPromoteTab?.(tab.id)}
			>
				<!-- While this notebook is executing/queueing a cell, the icon slot shows a
				     run indicator instead of the file icon (background runs included), so a
				     glance at the tab strip tells you which notebooks are busy. When shown,
				     it's a distinct button: clicking it jumps to that notebook's running
				     cell (activating the tab first if it isn't the viewed one), while a
				     click anywhere else on the tab still just selects it. The click is
				     stopped from bubbling so a spinner-click is never an ambiguous tab
				     select, and `data-tab-nodrag` keeps a press on it out of the drag
				     gesture - a control inside a draggable surface must stay a control. -->
				{#if runState}
					<button
						type="button"
						class="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-base-300/70"
						title="Jump to running cell"
						aria-label="Jump to running cell"
						data-testid="tab-jump-running"
						data-tab-nodrag
						tabindex={-1}
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
				{:else}
					<span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
						{@html iconSvg(tab.title, { dir: false })}
					</span>
				{/if}
				<span class="truncate py-2 {tab.preview ? 'italic' : ''}">{tab.title}</span>
				{#if tab.dirty}
					<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Unsaved changes" data-testid="tab-dirty"></span>
				{/if}
				{#if tab.closable}
					<button
						class="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-40 hover:opacity-100"
						onclick={(e) => {
							e.stopPropagation();
							onCloseTab(tab.id);
						}}
						title="Close tab"
						aria-label="Close tab"
						data-testid="tab-close"
						data-tab-nodrag
						tabindex={-1}
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
					</button>
				{/if}
			</div>
			{#if dropIndex === tabs.length && i === tabs.length - 1}{@render dropMarker(tabs.length)}{/if}
		{/each}
	</div>

	<!-- A keyboard reorder has no drag to watch, so its outcome is spoken instead. -->
	<span class="sr-only" role="status" aria-live="polite" data-testid="tab-move-announcement">{moveAnnouncement}</span>

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
