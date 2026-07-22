<script lang="ts">
	// The floating find-in-page bar (Search P3). A small widget over the top-right
	// of the active notebook pane: a query box, a live `i / N` match count,
	// prev/next chevrons, and case (`Aa`) / whole-word (`\b`) toggle chips.
	//
	// It runs queries through the SAME shared engine + per-cell cache as the
	// sidebar Search (`$lib/search`), so the two views can never disagree, and it
	// searches the always-complete client model (never the DOM) - so a match in a
	// cell windowed out by virtualization still counts and still navigates.
	//
	// Navigation routes every jump through ONE `onJump(match)` callback, wired in
	// the shell to the active notebook's `jumpToCell` (which `await`s
	// `ensureCellMounted` first, so an off-screen match mounts before it scrolls).
	//
	// This is deliberately NOT the Ctrl+F surface yet (that is P5): it opens from
	// a non-Ctrl entry point (the sidebar Search button, or the app shortcut) so
	// it can ship and be dogfooded before it owns the browser's find key.
	import { tick } from 'svelte';
	import {
		searchNotebook,
		dedupeMatchesForDisplay,
		DEFAULT_SEARCH_OPTS,
		createSearchCache
	} from '$lib/search';
	import type { Match, SearchCache, SearchOpts } from '$lib/search';
	import type { Cell } from '$lib/server/types';

	interface Props {
		open: boolean;
		/** The active notebook's cells (the authoritative model, not the DOM). */
		cells: readonly Cell[];
		/** The active notebook's per-cell search cache (shared with the sidebar). */
		searchCache?: SearchCache;
		/** Seed the query from this text when the bar opens (native-find behavior). */
		seed?: string;
		onClose: () => void;
		/** Navigate to a match: the shell routes this to the active notebook's `jumpToCell`. */
		onJump: (match: Match) => void | Promise<void>;
	}
	let { open, cells, searchCache, seed = '', onClose, onJump }: Props = $props();

	let query = $state('');
	let debouncedQuery = $state('');
	let caseSensitive = $state(false);
	let wholeWord = $state(false);
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	const opts = $derived<SearchOpts>({
		...DEFAULT_SEARCH_OPTS,
		caseSensitive,
		wholeWord
	});

	// A private fallback cache for when the active tab has no live notebook cache
	// registered (e.g. a plain file tab is focused). The engine self-invalidates
	// each entry on content change, so a stale cache is never a correctness risk.
	const fallbackCache = createSearchCache();

	// Debounce the query (~120ms), but clear instantly when emptied - the
	// find-in-page feel: the count and highlight vanish the moment the box is
	// cleared, and only settled input triggers a scan.
	$effect(() => {
		const q = query.trim();
		if (!q) {
			debouncedQuery = '';
			return;
		}
		const t = setTimeout(() => (debouncedQuery = q), 120);
		return () => clearTimeout(t);
	});

	// The navigable match list, in document order. Deduped for display (a markdown
	// cell is scanned in both raw source and rendered markdown for later
	// per-surface highlighting; to a user that is one visible occurrence), so the
	// count and next/prev step through visible occurrences - what a user expects.
	const matches = $derived<Match[]>(
		open && debouncedQuery
			? dedupeMatchesForDisplay(
					searchNotebook(cells, debouncedQuery, opts, searchCache ?? fallbackCache)
				)
			: []
	);
	const total = $derived(matches.length);

	// When the query or the match options settle to something NEW, jump to the
	// first match (native find scrolls to the first hit as you type). Keyed on the
	// query+opts signature so an unrelated cell edit that merely re-derives
	// `matches` does not re-scroll the user. Reading `matches[0]` here subscribes
	// to `matches`, but the key guard early-returns on any non-query change, so at
	// most one extra (no-op) run follows an edit.
	let lastNavKey = '';
	$effect(() => {
		if (!open) {
			lastNavKey = '';
			return;
		}
		const key = JSON.stringify([debouncedQuery, caseSensitive, wholeWord]);
		if (key === lastNavKey) return;
		lastNavKey = key;
		activeIndex = 0;
		const first = matches[0];
		if (first) void onJump(first);
	});

	// Keep the active index in range as the result set shrinks under it.
	$effect(() => {
		if (activeIndex > total - 1) activeIndex = Math.max(0, total - 1);
	});

	// Seed + focus on the open transition. Reading the current selection is a
	// browser concern kept here (the shell captures nothing); if there is a
	// selection it replaces the query (native-find seeds from the selection),
	// otherwise the last query is kept. The input text is selected so typing
	// replaces it.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			const sel = seed?.trim() || (typeof window !== 'undefined' ? window.getSelection?.()?.toString().trim() : '') || '';
			if (sel) {
				query = sel;
				debouncedQuery = sel; // apply immediately - a deliberate open, not typing
			}
			tick().then(() => {
				inputEl?.focus();
				inputEl?.select();
			});
		} else if (!open && wasOpen) {
			debouncedQuery = ''; // stop scanning when closed; a re-open starts clean
		}
		wasOpen = open;
	});

	function goTo(index: number) {
		if (!total) return;
		activeIndex = ((index % total) + total) % total;
		const m = matches[activeIndex];
		if (m) void onJump(m);
	}
	function next() {
		goTo(activeIndex + 1);
	}
	function prev() {
		goTo(activeIndex - 1);
	}
	function close() {
		onClose();
	}

	// Keys on the input: Enter = next, Shift+Enter = prev, Escape = close. F3 /
	// Shift+F3 are handled by the window listener below so they work with focus
	// anywhere on the page (native find behavior).
	function onInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) prev();
			else next();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	}

	// While open, F3 / Shift+F3 step through matches regardless of where focus is
	// (capture phase, and we `preventDefault` so the browser's own find never
	// opens). Escape is deliberately NOT handled here: it stays the notebook's
	// command-mode key unless focus is in the find box (handled above).
	$effect(() => {
		if (!open || typeof window === 'undefined') return;
		function onKey(e: KeyboardEvent) {
			if (e.key === 'F3') {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) prev();
				else next();
			}
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});
</script>

{#if open}
	<div
		class="absolute right-4 top-3 z-40 flex items-center gap-1.5 rounded-lg border border-base-300 bg-base-100 px-2 py-1.5 shadow-lg"
		data-testid="find-bar"
		role="search"
		aria-label="Find in notebook"
	>
		<svg class="h-3.5 w-3.5 shrink-0 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
		<input
			bind:this={inputEl}
			bind:value={query}
			onkeydown={onInputKeydown}
			type="text"
			class="w-44 bg-transparent text-xs outline-none placeholder:text-base-content/40"
			placeholder="Find in notebook…"
			spellcheck="false"
			autocomplete="off"
			aria-label="Find query"
			data-testid="find-input"
		/>
		<span
			class="min-w-[3.5rem] shrink-0 text-right text-[11px] tabular-nums {debouncedQuery && !total ? 'text-error/70' : 'text-base-content/45'}"
			data-testid="find-count"
			aria-live="polite"
		>
			{#if debouncedQuery}
				{total ? activeIndex + 1 : 0}/{total}
			{:else}
				&nbsp;
			{/if}
		</span>

		<div class="flex items-center gap-0.5">
			<button
				class="btn btn-ghost btn-xs px-1.5 {caseSensitive ? 'btn-active text-primary' : 'text-base-content/50'}"
				aria-pressed={caseSensitive}
				title="Match case"
				onclick={() => (caseSensitive = !caseSensitive)}
				data-testid="find-case">Aa</button
			>
			<button
				class="btn btn-ghost btn-xs px-1.5 font-mono {wholeWord ? 'btn-active text-primary' : 'text-base-content/50'}"
				aria-pressed={wholeWord}
				title="Whole word"
				onclick={() => (wholeWord = !wholeWord)}
				data-testid="find-word">\b</button
			>
		</div>

		<div class="flex items-center gap-0.5 border-l border-base-300 pl-1">
			<button
				class="btn btn-ghost btn-xs px-1"
				title="Previous match (Shift+Enter)"
				aria-label="Previous match"
				disabled={!total}
				onclick={prev}
				data-testid="find-prev"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
			</button>
			<button
				class="btn btn-ghost btn-xs px-1"
				title="Next match (Enter)"
				aria-label="Next match"
				disabled={!total}
				onclick={next}
				data-testid="find-next"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
			</button>
			<button
				class="btn btn-ghost btn-xs px-1"
				title="Close (Esc)"
				aria-label="Close find"
				onclick={close}
				data-testid="find-close"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
			</button>
		</div>
	</div>
{/if}
