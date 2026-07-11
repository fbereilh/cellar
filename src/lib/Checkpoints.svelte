<!--
  Sidebar → History (checkpoints). A checkpoint is a full snapshot of the active
  notebook's cells - source, outputs, and metadata - taken either manually
  ("Checkpoint now") or automatically BEFORE an agent action (so an agent's edit
  or run can be undone). Restoring reverts the notebook to that snapshot.

  Storage is a per-project file under `.cellar/` (see `server/checkpoints.js`), so
  history survives the dynamic app port but never bloats the `.ipynb`. This panel
  is a thin view over the `/api/checkpoints` routes; it refetches on mount, when
  the active notebook changes, and on the `checkpoints:changed` event an auto- or
  manual checkpoint publishes.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { subscribeEvents, originId } from '$lib/events-client';
	import { relativeTimeLong } from '$lib/relativeTime';
	import type { CheckpointMeta, CheckpointTrigger } from '$lib/server/checkpoints';

	interface Props {
		notebookPath?: string | null;
	}

	let { notebookPath = null }: Props = $props();

	let checkpoints = $state<CheckpointMeta[]>([]);
	let error = $state('');
	let loading = $state(false);
	let busy = $state(false); // a create/restore is in flight
	let confirmId = $state<string | null>(null); // the checkpoint id awaiting a restore confirmation
	let seq = 0;

	// A ticking clock so the relative timestamps ("2 minutes ago") stay current.
	let now = $state(Date.now());

	async function load() {
		if (!notebookPath) {
			checkpoints = [];
			error = '';
			return;
		}
		const mine = ++seq;
		loading = true;
		try {
			const res = await fetch(`/api/checkpoints?path=${encodeURIComponent(notebookPath)}`);
			const body = await res.json();
			if (mine !== seq) return;
			if (!res.ok) throw new Error(body?.message || 'could not load checkpoints');
			checkpoints = body.checkpoints ?? [];
			error = '';
		} catch (err) {
			if (mine !== seq) return;
			error = String((err as Error)?.message ?? err);
		} finally {
			if (mine === seq) loading = false;
		}
	}

	onMount(() => {
		load();
		const t = setInterval(() => (now = Date.now()), 15000);
		const unsub = subscribeEvents((ev) => {
			// Any checkpoint change re-lists (a cheap metadata GET); the route always
			// targets our own notebook, so an over-broad refetch is harmless.
			if (ev.type === 'checkpoints:changed') load();
		});
		return () => {
			clearInterval(t);
			unsub();
		};
	});

	// Reload whenever the active notebook changes.
	$effect(() => {
		notebookPath; // track
		load();
	});

	async function post(action: string, extra: Record<string, unknown> = {}) {
		if (!notebookPath || busy) return null;
		busy = true;
		try {
			const res = await fetch('/api/checkpoints', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: notebookPath, action, originId, ...extra })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || `${action} failed`);
			checkpoints = body.checkpoints ?? checkpoints;
			error = '';
			return body;
		} catch (err) {
			error = String((err as Error)?.message ?? err);
			return null;
		} finally {
			busy = false;
		}
	}

	// Exposed to the section header (bind:this in Sidebar).
	export function refresh() {
		load();
	}
	export function checkpointNow() {
		post('create');
	}

	async function restore(id: string) {
		confirmId = null;
		await post('restore', { id });
	}
	async function undoLastAgent() {
		await post('undo-agent');
	}

	const hasAgentCheckpoint = $derived(checkpoints.some((c) => c.trigger === 'agent'));

	function triggerLabel(t: CheckpointTrigger): string {
		if (t === 'agent') return 'agent';
		if (t === 'restore') return 'pre-restore';
		return 'manual';
	}
	function triggerBadge(t: CheckpointTrigger): string {
		if (t === 'agent') return 'badge-warning';
		if (t === 'restore') return 'badge-info';
		return 'badge-primary';
	}
</script>

<div class="px-3 pb-3" data-testid="checkpoints-body">
	{#if !notebookPath}
		<p class="px-1 py-2 text-xs text-base-content/40">Open a notebook to see its checkpoints.</p>
	{:else}
		<!-- Undo last agent action: the headline flow. Restores the newest pre-agent-run snapshot. -->
		<button
			class="btn btn-outline btn-xs w-full gap-1.5"
			onclick={undoLastAgent}
			disabled={busy || !hasAgentCheckpoint}
			title="Restore the notebook to just before the last agent action"
			data-testid="undo-agent-action"
		>
			<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" /></svg>
			Undo last agent action
		</button>

		{#if error}
			<p class="mt-2 rounded border border-error/30 bg-error/10 p-2 text-[11px] text-error" data-testid="checkpoints-error">{error}</p>
		{/if}

		<div class="mt-2 space-y-1" data-testid="checkpoints-list">
			{#if loading && !checkpoints.length}
				<div class="flex items-center gap-2 px-1 py-2 text-xs text-base-content/40">
					<span class="loading loading-spinner loading-xs"></span> loading…
				</div>
			{:else if !checkpoints.length}
				<p class="px-1 py-2 text-xs text-base-content/40">
					No checkpoints yet. Use <span class="font-medium">Checkpoint now</span> above, or one is taken automatically before an agent changes this notebook.
				</p>
			{:else}
				{#each checkpoints as cp (cp.id)}
					<div class="rounded-lg border border-base-300 bg-base-100 p-2" data-testid="checkpoint-row">
						<div class="flex items-center gap-1.5">
							<span class="badge badge-xs {triggerBadge(cp.trigger)} badge-soft shrink-0">{triggerLabel(cp.trigger)}</span>
							<span class="min-w-0 flex-1 truncate text-xs text-base-content/80" title={cp.label}>{cp.label}</span>
						</div>
						<div class="mt-1 flex items-center justify-between gap-2">
							<span class="whitespace-nowrap text-[11px] text-base-content/45" title={new Date(cp.at).toLocaleString()}>
								{relativeTimeLong(cp.at, now)} · {cp.cellCount} cell{cp.cellCount === 1 ? '' : 's'}{cp.outputsTruncated ? ' · outputs trimmed' : ''}
							</span>
							{#if confirmId === cp.id}
								<span class="flex shrink-0 items-center gap-1">
									<button class="btn btn-error btn-xs" onclick={() => restore(cp.id)} disabled={busy} data-testid="checkpoint-restore-confirm">Restore</button>
									<button class="btn btn-ghost btn-xs" onclick={() => (confirmId = null)} data-testid="checkpoint-restore-cancel">Cancel</button>
								</span>
							{:else}
								<button
									class="btn btn-ghost btn-xs shrink-0 gap-1 text-base-content/60 hover:text-base-content"
									onclick={() => (confirmId = cp.id)}
									disabled={busy}
									title="Revert the notebook to this checkpoint"
									data-testid="checkpoint-restore"
								>
									<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
									Restore
								</button>
							{/if}
						</div>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
