<!--
  Sidebar → Git. One row per OPEN notebook, naming the commit its kernel is
  actually rooted at.

  A notebook may declare a code root (`metadata.cellar.root`, normally a git
  worktree under `roots/`), and a worktree is a separate checkout: its HEAD
  legitimately differs from the workspace's. That difference is invisible
  everywhere else in the app — the file tree, the gutter decorations and the
  footer blame are all workspace-scoped by design — so a review notebook pointed
  at PR-482 looks exactly like one on `main`. This panel is the one place that
  says which is which: "running under-review @ abc1234, uncommitted changes".

  READ-ONLY, and deliberately not a VS Code Source Control panel: no change list,
  no commit box, no stage/push/pull, no branch switching. It reports where each
  kernel's code comes from; changing that is the notebook root picker's job, and
  changing the checkout is the terminal's.

  A note on the muted levels, because they are not uniform on purpose: the values
  a reader ACTS on — the notebook name, the declared root, the branch and the
  short SHA — clear WCAG AA against the card in both themes (the light theme is
  the tight one: `base-content/60` measures 3.8:1 there). Pure context — the
  commit subject, the relative date, the "workspace" default — stays at the
  sidebar's decorative level, which is what keeps the hierarchy readable at a
  glance. Do not flatten them to one opacity in either direction.

  Data comes from `/api/fs/git/roots` in one round trip (the server dedupes the
  probe by directory, so several notebooks reviewing one worktree cost one). It
  refetches on mount, when the open-notebook set changes, when any notebook's root
  changes (`notebook:root`), on the shell's file-system refresh signal, and on
  window focus — a commit made in a terminal moves HEAD with nothing to notify us.
  No timer.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { subscribeEvents } from '$lib/events-client';
	import { relativeTimeLong } from '$lib/relativeTime';
	import { nowMs, subscribeNow } from '$lib/now.svelte';
	import type { GitDirCommit } from '$lib/server/git';
	import type { NotebookRef } from '$lib/types';

	/** One notebook's row as `/api/fs/git/roots` reports it. */
	interface RootCommit {
		path: string;
		/** Declared code root (workspace-relative), or null for the workspace root. */
		root: string | null;
		/** Why the declared root is unusable — the same refusal a run of it would raise. */
		error: string | null;
		git: GitDirCommit | null;
	}

	interface Props {
		/** Open notebook tabs, in tab order (the shell's own list). */
		notebooks?: NotebookRef[];
		/** Focus a notebook's tab by tab id. */
		onFocusNotebook?: (id: string) => void;
		/** The shell's file-system change counter; a bump refetches (a new/renamed file). */
		fsRefreshSignal?: number;
	}

	let { notebooks = [], onFocusNotebook, fsRefreshSignal = 0 }: Props = $props();

	let rows = $state<RootCommit[]>([]);
	let workspaceGit = $state<GitDirCommit | null>(null);
	let error = $state('');
	let loading = $state(false);
	// Generation guard (the statusSeq / kernelReqSeq convention): focus, a root
	// change and a tab opening can each have a request in flight at once, and
	// responses are unordered — only the newest may apply.
	let seq = 0;

	/** Identity of the open-notebook set, so the reload effect tracks CONTENT, not array identity. */
	const pathsKey = $derived(notebooks.map((n) => n.path).join('\n'));

	async function load() {
		const mine = ++seq;
		loading = true;
		try {
			const q = notebooks.map((n) => `path=${encodeURIComponent(n.path)}`).join('&');
			const res = await fetch(`/api/fs/git/roots${q ? `?${q}` : ''}`);
			const body = await res.json();
			if (mine !== seq) return;
			if (!res.ok) throw new Error(body?.message || 'could not read git info');
			rows = body.notebooks ?? [];
			workspaceGit = body.workspace ?? null;
			error = '';
		} catch (err) {
			if (mine !== seq) return;
			error = String((err as Error)?.message ?? err);
		} finally {
			if (mine === seq) loading = false;
		}
	}

	onMount(() => {
		// Relative dates stay current off the app-wide shared ticker, not a local
		// interval (see $lib/now.svelte.ts).
		const untick = subscribeNow();
		const unsub = subscribeEvents((ev) => {
			// A root change repoints a kernel at a different checkout — exactly what
			// this panel reports — so any notebook's counts, not just the active one's.
			// `sse:open` covers a reconnect: `notebook:root` is not replayed to a late
			// subscriber, so a missed one would otherwise leave a stale commit up.
			if (ev.type === 'notebook:root' || ev.type === 'sse:open') load();
		});
		const onFocus = () => load();
		window.addEventListener('focus', onFocus);
		return () => {
			untick();
			unsub();
			window.removeEventListener('focus', onFocus);
		};
	});

	// Reload when the open-notebook set changes, and on the shell's fs signal (a
	// file created/renamed/deleted, which is also how a new worktree shows up).
	// `load()` reads `notebooks` synchronously, so it is UNTRACKED: the shell
	// rebuilds that array on every tab switch and every dirty-flag write, and
	// tracking its identity would refetch (three git spawns per distinct root once
	// the cache lapses) for a set that did not change. `pathsKey` is the content
	// signature that decides it.
	$effect(() => {
		pathsKey; // track
		fsRefreshSignal; // track
		untrack(() => load());
	});

	/** Exposed to the section header's refresh button (bind:this in Sidebar). */
	export function refresh() {
		load();
	}

	/** The row for a notebook, or null while the first fetch is still out. */
	function rowFor(path: string): RootCommit | null {
		return rows.find((r) => r.path === path) ?? null;
	}

	/**
	 * What to render as the checkout's ref: the branch, or the short SHA in
	 * parentheses when HEAD is detached — the same convention the file tree's
	 * branch chip uses.
	 */
	function refLabel(git: GitDirCommit): string | null {
		if (git.branch) return git.branch;
		return git.shortSha ? `(${git.shortSha})` : null;
	}
</script>

<div class="px-2 pb-2" data-testid="git-body">
	{#if error}
		<p class="mx-1 rounded border border-error/30 bg-error/10 p-2 text-[11px] text-error" data-testid="git-error">{error}</p>
	{:else if !notebooks.length}
		<p class="px-1 py-2 text-xs text-base-content/40" data-testid="git-empty">
			Open a notebook to see the commit its kernel runs against.
		</p>
	{:else if !rows.length && loading}
		<div class="flex items-center gap-2 px-1 py-2 text-xs text-base-content/40">
			<span class="loading loading-spinner loading-xs"></span> loading…
		</div>
	{:else}
		<!-- Scrolls past a handful so a long list never crowds out the rest of the
		     sidebar, matching the Kernels list. -->
		<div class="max-h-72 space-y-1 overflow-y-auto" data-testid="git-notebooks">
			{#each notebooks as nb (nb.path)}
				{@const row = rowFor(nb.path)}
				{@const git = row?.git ?? null}
				<div class="rounded-lg border border-base-300 bg-base-100 px-2 py-1.5" data-testid="git-row" data-nb-path={nb.path}>
					<!-- Line 1: which notebook, and which root it runs from. The root is the
					     notebook's own property; the commit below belongs to that checkout. -->
					<div class="flex items-center gap-1.5">
						<button
							class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs hover:text-primary"
							onclick={() => onFocusNotebook?.(nb.id)}
							title="Focus {nb.name}"
							data-testid="git-notebook"
						>
							<span class="min-w-0 truncate">{nb.name}</span>
							{#if nb.active}<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="active notebook"></span>{/if}
						</button>
						<!-- A DECLARED root is a value the reader acts on, so it is legible; the
						     "workspace" default is the absence of one, deliberately quiet, so a
						     rooted notebook stands out in a list where most are not. -->
						<span
							class="flex max-w-[52%] shrink-0 items-center gap-1 text-[11px] {row?.root ? 'text-base-content/70' : 'text-base-content/35'}"
							title={row?.root ? `Code root: ${row.root} — this notebook's kernel runs and imports from here` : 'No code root declared: the kernel runs at the workspace root'}
							data-testid="git-root"
						>
							<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z" /></svg>
							<span class="truncate">{row?.root ?? 'workspace'}</span>
						</span>
					</div>

					{#if row?.error}
						<!-- A declared root that is not a usable directory. This is the state a
						     RUN of this notebook is about to refuse, so it is reported, not hidden.
						     The ICON carries the warning hue and the words stay `base-content`:
						     amber body text measures ~2:1 on the light theme's card, far under
						     WCAG AA — the same reason the external-change banner is built this way. -->
						<div class="mt-1 flex items-start gap-1.5" data-testid="git-root-error">
							<svg class="mt-px h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
							<p class="text-[11px] leading-snug text-base-content/70">{row.error}</p>
						</div>
					{:else if !git}
						<p class="mt-1 text-[11px] text-base-content/35">loading…</p>
					{:else if !git.isRepo}
						<!-- A real directory that is simply not a git checkout: nothing to report,
						     and nothing wrong. -->
						<p class="mt-1 text-[11px] text-base-content/35" data-testid="git-no-info">no commit info</p>
					{:else}
						<!-- Line 2: the ref + the commit id. The branch is the identity-bearing
						     half, so it gets the whole line to grow into — the date lives below
						     rather than squeezing it into `pr-482-re…`. The dirty marker sits at
						     the row's right edge, where the file tree puts its status letter, so
						     it reads as a status rather than as punctuation between two values. -->
						<div class="mt-1 flex items-center gap-1.5 text-[11px]">
							<span class="flex min-w-0 flex-1 items-center gap-1 text-base-content/75" title={git.detached ? `detached HEAD @ ${git.shortSha}` : `branch: ${git.branch}`}>
								<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
								<span class="truncate" data-testid="git-branch-name">{refLabel(git) ?? 'no commits yet'}</span>
							</span>
							{#if git.shortSha}
								<span class="shrink-0 font-mono tabular-nums text-base-content/70" title={git.commit ?? undefined} data-testid="git-sha">{git.shortSha}</span>
							{/if}
							{#if git.dirty}
								<!-- VS Code's "this checkout has uncommitted work" cue, in the file
								     tree's own modified hue so it reads as the same fact it does there. -->
								<span
									class="shrink-0 text-[13px] leading-none text-(--cellar-git-tree-modified)"
									title="Uncommitted changes in this checkout"
									data-testid="git-dirty"
								>
									●<span class="sr-only">uncommitted changes</span>
								</span>
							{/if}
						</div>
						{#if git.subject || git.commitTime}
							<!-- Line 3: what that commit was and when — context, never the headline,
							     so the subject yields to the date rather than the other way round. -->
							<div class="flex items-baseline gap-2 text-[11px] text-base-content/45">
								<span class="min-w-0 flex-1 truncate" title={git.author ? `${git.subject} — ${git.author}` : (git.subject ?? undefined)} data-testid="git-subject">
									{git.subject ?? ''}
								</span>
								{#if git.commitTime}
									<span class="shrink-0 whitespace-nowrap text-base-content/40" title={new Date(git.commitTime).toLocaleString()}>
										{relativeTimeLong(git.commitTime, nowMs())}
									</span>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
		{#if workspaceGit && !workspaceGit.isRepo}
			<p class="px-1 pt-1.5 text-[11px] text-base-content/35" data-testid="git-not-a-repo">
				This workspace is not a git repository.
			</p>
		{/if}
	{/if}
</div>
