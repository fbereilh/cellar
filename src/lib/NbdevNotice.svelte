<script lang="ts">
	/**
	 * DETECT AND OFFER for the nbdev metadata hazard.
	 *
	 * Renders NOTHING unless there is something to say (`nbdevNotice` is the one
	 * rule; see `$lib/nbdev`), so a project that is not nbdev's - or one already
	 * carrying the allowlist keys - pays no chrome and is never re-offered.
	 *
	 * It sits above the sidebar's sections rather than inside one because the
	 * hazard is a fact about the WORKSPACE, not about any notebook or panel, and
	 * because a warning behind a collapsed section is a warning nobody reads.
	 *
	 * The write is a click, never a side effect of the read: `pyproject.toml` is a
	 * file the user owns and may have under review, so the absolute path is on
	 * screen before the button is. The remedy lines are shown either way, so a
	 * refusal (a shape Cellar will not edit) is still actionable.
	 */
	import { nbdevNotice, REMEDY_LINES, type NbdevState } from '$lib/nbdev';

	let {
		initial,
		fsRefreshSignal = 0
	}: {
		/** SSR-seeded state, so the card paints with the first frame. */
		initial: NbdevState;
		/** Bumped by file-tree changes; also re-read on window focus. */
		fsRefreshSignal?: number;
	} = $props();

	// svelte-ignore state_referenced_locally
	let project = $state<NbdevState>(initial);
	let busy = $state(false);
	let failure = $state('');
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout>;

	const notice = $derived(nbdevNotice(project));
	const remedy = REMEDY_LINES.join('\n');

	/**
	 * Re-read on the same signals git decorations use: a change in the tree, and
	 * the window regaining focus after an edit made in a terminal. Generation-
	 * guarded (the `statusSeq` convention) because focus and a tree bump can be in
	 * flight at once and responses are unordered - an older reply must not restore
	 * a state the user has already fixed.
	 */
	let seq = 0;
	async function reload() {
		const mine = ++seq;
		try {
			const res = await fetch('/api/nbdev');
			if (!res.ok) return;
			const body = await res.json();
			if (mine === seq && body?.state) project = body.state;
		} catch {
			/* a failed re-read keeps what we have; the next signal tries again */
		}
	}

	$effect(() => {
		fsRefreshSignal; // track
		reload();
	});

	$effect(() => {
		const onFocus = () => reload();
		window.addEventListener('focus', onFocus);
		return () => {
			window.removeEventListener('focus', onFocus);
			clearTimeout(copyTimer);
		};
	});

	async function protect() {
		if (busy) return;
		busy = true;
		failure = '';
		const mine = ++seq;
		try {
			const res = await fetch('/api/nbdev', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'protect' })
			});
			const body = await res.json().catch(() => null);
			// The reply carries the state AFTER the attempt, so the card corrects
			// itself whatever happened - including a refusal, whose reason is the state.
			if (body?.state && mine === seq) project = body.state;
			// Honest about failure: never claim the protection is in place. A refusal
			// already explains itself through the new state, so only a genuinely failed
			// WRITE (or an unreachable server) adds a line of its own.
			if (!body) failure = 'the server could not be reached';
			else if (body.status === 'failed') failure = body.error || 'the file could not be written';
		} catch {
			failure = 'the server could not be reached';
		} finally {
			busy = false;
		}
	}

	async function copyRemedy() {
		try {
			await navigator.clipboard.writeText(remedy);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1400);
		} catch {
			/* a denied clipboard permission must not break the card */
		}
	}
</script>

{#if notice}
	<!-- Warning TINT on the icon, `base-content` copy: amber body text measures
	     ~2:1 on the light card, so the icon carries the signal and the words stay
	     readable - the same rule the external-change banner follows. -->
	<div
		class="border-b border-base-300 bg-warning/5 px-3 py-2.5"
		data-testid="nbdev-notice"
		data-kind={project.kind}
	>
		<div class="flex items-start gap-2">
			<svg class="mt-px h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
			</svg>
			<div class="min-w-0 flex-1">
				<p class="text-[11px] font-semibold leading-snug text-base-content" data-testid="nbdev-notice-title">
					{notice.title}
				</p>
				<p class="mt-1 text-[11px] leading-relaxed text-base-content/80" data-testid="nbdev-notice-body">
					{notice.body}
				</p>
				<p class="mt-1 font-mono text-[10px] leading-snug text-base-content/60 [overflow-wrap:break-word]" title={notice.path} data-testid="nbdev-notice-path">
					{notice.path}
				</p>

				<div class="mt-1.5 flex items-start gap-1 rounded-md border border-base-300 bg-base-100 p-1">
					<code class="min-w-0 flex-1 whitespace-pre px-1 py-0.5 font-mono text-[10px] leading-snug text-primary" data-testid="nbdev-notice-remedy">{remedy}</code>
					<button
						class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content"
						onclick={copyRemedy}
						title="Copy these lines"
						aria-label="Copy these lines"
						data-testid="nbdev-notice-copy"
					>
						{#if copied}
							<svg class="h-3.5 w-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
						{:else}
							<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
						{/if}
					</button>
				</div>

				{#if notice.canWrite}
					<button
						class="btn btn-xs mt-2 w-full"
						onclick={protect}
						disabled={busy}
						data-testid="nbdev-notice-apply"
					>
						{busy ? 'Adding…' : 'Add these keys to pyproject.toml'}
					</button>
				{:else}
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/70" data-testid="nbdev-notice-hint">
						Cellar will not change this file - {notice.hint}.
					</p>
				{/if}

				{#if failure}
					<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/80" data-testid="nbdev-notice-failure">
						Not written: {failure}. The file is unchanged.
					</p>
				{/if}
			</div>
		</div>
	</div>
{/if}
