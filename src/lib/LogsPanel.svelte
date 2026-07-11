<script lang="ts">
	/**
	 * Cellar — in-app Logs panel (bottom drawer console).
	 *
	 * Streams Cellar's server-side log lines live so the user can debug issues
	 * (a failed Databricks connect, a kernel that won't start) without leaving the
	 * browser for the launching terminal. Backfills the current ring buffer over
	 * `GET /api/logs` on open, then follows new entries over the shared SSE event
	 * bus (`{ type: 'log' }` / `{ type: 'log:cleared' }`), the same transport the
	 * notebook uses for live run/structural sync.
	 *
	 * Features: level filter (all / warn+error / error), text search, tail-follow
	 * auto-scroll that pauses when the user scrolls up, copy-to-clipboard, clear.
	 * Theme-aware via daisyUI semantic tokens (error red / warn amber / info muted).
	 */
	import { onMount, tick } from 'svelte';
	import { subscribeEvents } from '$lib/events-client';

	let { open = false, onClose } = $props();

	/** Client mirror of the server ring buffer (bounded to the same cap). */
	const MAX_ENTRIES = 1000;
	let entries = $state([]);
	let bySeq = new Map(); // seq → index, so a coalesced repeat updates in place

	let levelFilter = $state('all'); // 'all' | 'warn' | 'error'
	let search = $state('');
	let autoScroll = $state(true);
	let loaded = $state(false);
	let copied = $state(false);

	let scrollEl = $state(null);

	// Level filter as an inclusion set. 'warn' means warn+error; 'error' means error.
	const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
	const filterFloor = $derived(levelFilter === 'error' ? 2 : levelFilter === 'warn' ? 1 : 0);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return entries.filter((e) => {
			if (LEVEL_RANK[e.level] < filterFloor) return false;
			if (q && !(e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q))) return false;
			return true;
		});
	});

	const counts = $derived.by(() => {
		let warn = 0;
		let error = 0;
		for (const e of entries) {
			if (e.level === 'warn') warn++;
			else if (e.level === 'error') error++;
		}
		return { total: entries.length, warn, error };
	});

	function reindex() {
		bySeq = new Map(entries.map((e, i) => [e.seq, i]));
	}

	function pushEntry(entry) {
		const existing = bySeq.get(entry.seq);
		if (existing != null) {
			// A coalesced repeat: the server re-published the same seq with a bumped count.
			entries[existing] = entry;
			return;
		}
		entries.push(entry);
		bySeq.set(entry.seq, entries.length - 1);
		if (entries.length > MAX_ENTRIES) {
			entries.shift();
			reindex();
		}
	}

	async function backfill() {
		try {
			const res = await fetch('/api/logs');
			if (res.ok) {
				const body = await res.json();
				entries = Array.isArray(body.logs) ? body.logs.slice(-MAX_ENTRIES) : [];
				reindex();
			}
		} catch {
			// Panel still works for live entries even if the backfill fails.
		} finally {
			loaded = true;
			scrollToTail();
		}
	}

	onMount(() => {
		backfill();
		const unsub = subscribeEvents((ev) => {
			if (ev.type === 'log' && ev.entry) {
				pushEntry(ev.entry);
				scrollToTail();
			} else if (ev.type === 'log:cleared') {
				entries = [];
				bySeq = new Map();
			}
		});
		return unsub;
	});

	async function scrollToTail() {
		if (!autoScroll) return;
		await tick();
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	}

	// Pause tail-follow the moment the user scrolls up; resume when they return to
	// the bottom. A small threshold keeps momentum-scroll from unpausing early.
	function onScroll() {
		if (!scrollEl) return;
		const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 24;
		autoScroll = atBottom;
	}

	// Re-follow the tail when the panel is (re)opened.
	$effect(() => {
		if (open && loaded) scrollToTail();
	});

	function fmtTime(ts) {
		const d = new Date(ts);
		const p = (n, w = 2) => String(n).padStart(w, '0');
		return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
	}

	async function copyLogs() {
		const text = filtered
			.map((e) => `${fmtTime(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}${e.count > 1 ? ` (x${e.count})` : ''}`)
			.join('\n');
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			// Clipboard denied (insecure context) — nothing else to do.
		}
	}

	async function clearLogs() {
		try {
			await fetch('/api/logs', { method: 'DELETE' });
		} catch {}
		entries = [];
		bySeq = new Map();
	}

	const levelClass = (level) =>
		level === 'error' ? 'text-error' : level === 'warn' ? 'text-warning' : 'text-base-content/70';
</script>

{#if open}
	<section
		class="flex h-full flex-col border-t border-base-300 bg-base-100"
		data-testid="logs-panel"
		aria-label="Logs"
	>
		<!-- Toolbar -->
		<header class="flex shrink-0 items-center gap-2 border-b border-base-300 px-3 py-1.5 text-xs">
			<span class="font-semibold text-base-content/80">Logs</span>
			<span class="text-base-content/40" data-testid="logs-count">
				{counts.total}
				{#if counts.error}<span class="ml-1 text-error">· {counts.error} err</span>{/if}
				{#if counts.warn}<span class="ml-1 text-warning">· {counts.warn} warn</span>{/if}
			</span>

			<!-- Level filter -->
			<div class="join ml-2">
				{#each [['all', 'All'], ['warn', 'Warn+'], ['error', 'Error']] as [val, label]}
					<button
						class="btn btn-xs join-item {levelFilter === val ? 'btn-active btn-neutral' : 'btn-ghost'}"
						onclick={() => (levelFilter = val)}
						data-testid="logs-level-{val}"
					>
						{label}
					</button>
				{/each}
			</div>

			<!-- Text search -->
			<input
				type="text"
				class="input input-xs input-bordered ml-1 w-40"
				placeholder="Filter…"
				bind:value={search}
				data-testid="logs-search"
			/>

			<div class="ml-auto flex items-center gap-1">
				{#if !autoScroll}
					<button
						class="btn btn-xs btn-ghost text-base-content/60"
						onclick={() => { autoScroll = true; scrollToTail(); }}
						title="Follow tail"
						data-testid="logs-follow"
					>
						↓ Follow
					</button>
				{/if}
				<button class="btn btn-xs btn-ghost" onclick={copyLogs} data-testid="logs-copy">
					{copied ? 'Copied' : 'Copy'}
				</button>
				<button class="btn btn-xs btn-ghost" onclick={clearLogs} data-testid="logs-clear">Clear</button>
				<button class="btn btn-xs btn-ghost btn-square" onclick={() => onClose?.()} title="Close" data-testid="logs-close" aria-label="Close logs">✕</button>
			</div>
		</header>

		<!-- Log lines -->
		<div
			class="min-h-0 flex-1 overflow-y-auto bg-(--cellar-surface-page) px-3 py-1.5 font-mono text-[11.5px] leading-relaxed"
			bind:this={scrollEl}
			onscroll={onScroll}
			data-testid="logs-scroll"
		>
			{#if !loaded}
				<div class="py-6 text-center text-base-content/40">Loading…</div>
			{:else if filtered.length === 0}
				<div class="py-6 text-center text-base-content/40" data-testid="logs-empty">
					{entries.length === 0 ? 'No logs yet.' : 'No logs match the current filter.'}
				</div>
			{:else}
				{#each filtered as e (e.seq)}
					<div class="flex gap-2 whitespace-pre-wrap break-words py-px" data-testid="log-line" data-level={e.level}>
						<span class="shrink-0 text-base-content/40 tabular-nums">{fmtTime(e.ts)}</span>
						<span class="shrink-0 uppercase {levelClass(e.level)}" style="width: 3.2rem">{e.level}</span>
						<span class="shrink-0 text-base-content/50">[{e.source}]</span>
						<span class="{e.level === 'error' ? 'text-error' : e.level === 'warn' ? 'text-warning' : 'text-base-content/90'}">{e.message}{#if e.count > 1}<span class="ml-1 text-base-content/40">(×{e.count})</span>{/if}</span>
					</div>
				{/each}
			{/if}
		</div>
	</section>
{/if}
