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

  Every "nothing to report" here is a DIFFERENT fact and is rendered as one, because
  the alternative is a row asserting something nobody read: a row still in flight
  gets a neutral placeholder, a row whose DOCUMENT could not be read says so and
  withholds the root, a row the route never opened (past its path cap) says only
  "not read" with the reason stated once below the list, and a checkout with no
  commits yet keeps its branch and says so where the SHA would be.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { createCoalescedReload } from '$lib/coalescedReload';
	import { subscribeEvents } from '$lib/events-client';
	import { relativeTimeLong } from '$lib/relativeTime';
	import { agentConfigNotice } from '$lib/notebookRoot';
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
		/**
		 * The notebook's DOCUMENT could not be read at all (deleted/renamed outside
		 * Cellar with its tab still open), so nothing here knows what root it declares.
		 * A different fact from an unusable root, and the reason the root chip is
		 * withheld rather than defaulting to "workspace".
		 */
		unreadable?: boolean;
		/**
		 * The request asked about more notebooks than the route probes at once, and
		 * this one fell past the cap, so it was never opened. A THIRD kind of "nothing
		 * to report", structurally apart from a row still in flight and from an
		 * unreadable document: those two are about ONE notebook, while this one is
		 * about the request as a whole — hence the single notice below the list rather
		 * than a per-row explanation.
		 */
		notRead?: boolean;
		git: GitDirCommit | null;
	}

	/**
	 * One registered worktree of this repo, as `/api/fs/git/roots` reports it —
	 * the WORKTREES block below. A different axis from the rows above: one entry
	 * per CHECKOUT, whether or not any notebook points at it.
	 */
	interface WorktreeRow {
		/** The declaration a root would use: `roots/pr-1`, or `../sibling`. */
		path: string;
		absolute: string;
		/** Outside the workspace — labelled, because the file tree still shows the workspace. */
		external: boolean;
		/** False for a registered worktree whose directory is gone (`prunable`). */
		exists: boolean;
		branch: string | null;
		detached: boolean;
		shortSha: string | null;
		dirty: boolean;
		/**
		 * True when the request listed this checkout but did not probe its commit
		 * (too many registered worktrees). Everything else on the row came from the
		 * listing and is real; only `dirty` is unread, so the row must not draw the
		 * dirty marker — an unprobed checkout is not a clean one.
		 */
		notRead?: boolean;
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
	let worktrees = $state<WorktreeRow[]>([]);
	/** Which worktree's "Use as root" is in flight, so only that button shows it. */
	let adopting = $state('');
	/**
	 * Outcome of the last adoption. SELF-DISMISSING, the same rule its sibling
	 * surface follows (the notebook root bar's feedback line): it describes ONE
	 * action, on ONE notebook, at ONE moment — so left standing it goes on
	 * asserting "analysis.ipynb now runs in ../pr-398" over a panel that has since
	 * moved to a different notebook, which is worse than saying nothing.
	 */
	let adoptFeedback = $state('');
	let adoptFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
	/** How long the WORKTREES block keeps reporting the outcome of an adoption. */
	const ADOPT_FEEDBACK_MS = 8000;
	let workspaceGit = $state<GitDirCommit | null>(null);
	let readLimit = $state(0);
	let worktreeReadLimit = $state(0);
	let error = $state('');
	let loading = $state(false);
	// Generation guard (the statusSeq / kernelReqSeq convention): focus, a root
	// change and a tab opening can each have a request in flight at once, and
	// responses are unordered — only the newest may apply.
	let seq = 0;
	// Single-flight, keyed on the query this panel would send (the `livenessInFlight`
	// / `workspaceProbes` convention). The generation guard above only DISCARDS a
	// superseded reply; it does not stop the request being made, and the triggers
	// here genuinely overlap — the mount effect races `sse:open` on the initial
	// connect, and window focus races an `fsRefreshSignal` bump. `gitCommitAt`'s
	// server cache cannot collapse those: it writes its entry only once its three
	// spawns have finished, so concurrent callers all miss it and each re-spawns
	// three `git` processes per distinct root. Keyed rather than blanket, so a
	// request whose notebook set has since changed is never shared as this one's
	// answer — and with a trailing re-read, so a `notebook:root` landing mid-request
	// is not answered by a reply issued before the very change it announces (see
	// `coalescedReload.ts`).
	const reload = createCoalescedReload(fetchRoots);

	/** Identity of the open-notebook set, so the reload effect tracks CONTENT, not array identity. */
	const pathsKey = $derived(notebooks.map((n) => n.path).join('\n'));
	/**
	 * How many of the rows ON SCREEN the route named but never opened.
	 *
	 * Counted off the notebooks actually DRAWN joined to their row, never off the
	 * last payload: the list renders from `notebooks` (the live tab set) while `rows`
	 * is the previous answer, so between closing a tab and its refetch landing the
	 * two disagree — and the notice would say "6 above show no commit" over 5 such
	 * rows, or keep claiming a cap the closed tab just took the set back under.
	 */
	const notReadCount = $derived(notebooks.filter((n) => rowFor(n.path)?.notRead).length);

	/**
	 * Registered worktrees this request listed but did not probe. Counted off
	 * `worktrees` rather than off a separate number, because that array IS what
	 * renders — so the sentence can never name more rows than are on screen.
	 */
	const worktreeNotReadCount = $derived(worktrees.filter((w) => w.notRead).length);

	/**
	 * The order the notebooks are ASKED about — the active one first, then tab order.
	 *
	 * The route truncates by request order, so past its cap the rows it drops are
	 * whatever came last. Sending tab order verbatim made that the rightmost tabs,
	 * which can include the notebook the reader is looking at (the one row this panel
	 * marks with a dot) while 64 notebooks they are not looking at show commits. This
	 * is query order ONLY: the list is rendered straight from `notebooks`, so what is
	 * on screen stays in tab order. A tab switch deliberately does not refetch (see
	 * the reload effect), so a newly-activated row past the cap is re-prioritised at
	 * the next trigger rather than immediately.
	 */
	function queryOrder(): NotebookRef[] {
		const at = notebooks.findIndex((n) => n.active);
		if (at <= 0) return notebooks;
		return [notebooks[at], ...notebooks.filter((_, i) => i !== at)];
	}

	function load(): Promise<void> {
		// With no notebook open the template short-circuits to `git-empty` and every
		// field this would fetch is discarded, so the request is not made at all —
		// the workspace probe behind it is three `git` spawns for a payload nothing
		// reads. `seq` still advances, so a reply from a request issued while a tab
		// WAS open cannot land afterwards and repopulate the list; the reload effect
		// tracks `pathsKey`, so opening a tab resumes fetching.
		if (!notebooks.length) {
			seq++;
			reload.reset();
			rows = [];
			worktrees = [];
			workspaceGit = null;
			readLimit = 0;
			worktreeReadLimit = 0;
			error = '';
			loading = false;
			return Promise.resolve();
		}
		return reload.run(queryOrder().map((n) => `path=${encodeURIComponent(n.path)}`).join('&'));
	}

	async function fetchRoots(query: string) {
		const mine = ++seq;
		loading = true;
		try {
			const res = await fetch(`/api/fs/git/roots?${query}`);
			const body = await res.json();
			if (mine !== seq) return;
			if (!res.ok) throw new Error(body?.message || 'could not read git info');
			rows = body.notebooks ?? [];
			worktrees = body.worktrees ?? [];
			workspaceGit = body.workspace ?? null;
			readLimit = Number(body.readLimit) || 0;
			worktreeReadLimit = Number(body.worktreeReadLimit) || 0;
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
	 * What to render as the checkout's ref: the branch, or the word "detached"
	 * when HEAD is one.
	 *
	 * Deliberately NOT the file tree's parenthesised-SHA convention: that chip is
	 * the only place its row names a commit, so `(abc1234)` reads as the ref there.
	 * This row already renders the short SHA in its own chip a few pixels to the
	 * right, so borrowing it printed the same seven characters twice side by side
	 * (three times counting the tooltip). The tooltip still names the SHA, so
	 * nothing is lost by saying only what the branch slot knows: there is no branch.
	 *
	 * Null when git named neither — the branch slot then renders nothing rather than
	 * a stand-in. It deliberately does NOT answer for a checkout with no commits yet:
	 * that state keeps its branch name here (`symbolic-ref` succeeds on an unborn
	 * HEAD) and is reported once, where the SHA would go — see `unbornHead` below.
	 */
	function refLabel(git: GitDirCommit): string | null {
		if (git.branch) return git.branch;
		return git.shortSha ? 'detached' : null;
	}

	/** The branch tooltip, or nothing when there is no ref to describe. */
	function refTitle(git: GitDirCommit): string | undefined {
		if (git.detached) return `detached HEAD @ ${git.shortSha}`;
		return git.branch ? `branch: ${git.branch}` : undefined;
	}

	/**
	 * A checkout that IS a repo but holds no commit yet — a fresh `git init`, or a
	 * worktree on a branch nothing has landed on.
	 *
	 * Read off the commit, never off `refLabel` returning null: `symbolic-ref`
	 * SUCCEEDS on an unborn HEAD (only `log -1` fails), so this row carries a real
	 * branch name and used to render as a bare branch with no SHA and no subject —
	 * indistinguishable from a commit line that half-failed to load. The one place
	 * that decides it, so the marker and the missing SHA chip cannot disagree.
	 */
	function unbornHead(git: GitDirCommit): boolean {
		return git.isRepo && !git.commit;
	}

	/** The notebook a "Use as root" click applies to: the active tab. */
	const activeNotebook = $derived(notebooks.find((n) => n.active) ?? null);

	/**
	 * Show (or clear) the adoption outcome, and arm its dismissal — the ONE writer,
	 * so no path can leave a line standing with no timer behind it.
	 */
	function showAdoptFeedback(msg: string) {
		adoptFeedback = msg;
		if (adoptFeedbackTimer) clearTimeout(adoptFeedbackTimer);
		adoptFeedbackTimer = msg
			? setTimeout(() => {
					adoptFeedback = '';
					adoptFeedbackTimer = null;
				}, ADOPT_FEEDBACK_MS)
			: null;
	}

	// The message names a NOTEBOOK, so switching to another one retires it at once
	// rather than waiting out the timer: it would otherwise describe a notebook the
	// panel is no longer showing. Keyed on the PATH STRING, never on
	// `activeNotebook` itself — that derives an OBJECT out of the `notebooks` prop,
	// so any re-render of the parent's list re-fires the effect and would wipe the
	// line the click had just produced, while a string re-derives to itself.
	const activeNotebookPath = $derived(activeNotebook?.path ?? '');
	$effect(() => {
		activeNotebookPath;
		untrack(() => showAdoptFeedback(''));
	});

	$effect(() => () => {
		if (adoptFeedbackTimer) clearTimeout(adoptFeedbackTimer);
	});

	/** The root the active notebook already declares, so its own row reads as adopted. */
	const activeRoot = $derived(activeNotebook ? (rowFor(activeNotebook.path)?.root ?? null) : null);

	/**
	 * Point the ACTIVE notebook at this worktree, through the very same
	 * `POST /api/notebooks/root` the root picker uses — never a second write path,
	 * so every refusal, the `.py` refusal included, and every side effect (the
	 * kernel is freed, its namespace cleared) are identical whichever surface was
	 * clicked. The reply is authoritative: the panel says what the SERVER did.
	 */
	async function useAsRoot(w: WorktreeRow) {
		const nb = activeNotebook;
		if (!nb || adopting) return;
		adopting = w.path;
		showAdoptFeedback('');
		try {
			const res = await fetch('/api/notebooks/root', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ root: w.path, path: nb.path })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'could not set the root');
			// The same reporting rule as the notebook's own root picker, through the ONE
			// shared wording: agent config written into an adopted worktree is reported,
			// never thrown, so a write that leaves this checkout untracked-dirty must be
			// said here too rather than discarded.
			const agentNote = agentConfigNotice(body.agent_config);
			const applied = body.changed
				? `${nb.name} now runs in ${w.path}${body.namespace_cleared ? ' — variables cleared' : ''}.`
				: `${nb.name} already runs in ${w.path}.`;
			showAdoptFeedback(agentNote ? `${applied} Note: ${agentNote}` : applied);
			// The row set above is keyed on each notebook's declared root, so it must
			// be re-read for the dot and the disabled state to agree with the server.
			load();
		} catch (err) {
			showAdoptFeedback(String((err as Error)?.message ?? err));
		} finally {
			adopting = '';
		}
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
						<!-- THREE states, and the difference between the first two is a claim:
						     a row that has NOT ARRIVED yet knows nothing about this notebook, so
						     it gets a neutral dimmed placeholder — the same icon and a fixed-width
						     bar, so the slot is already occupied and the row does not jump when the
						     real chip lands — with no "workspace" text and no tooltip. A LOADED row
						     whose root is null genuinely declares none, which is worth saying, so it
						     keeps the real chip and its tooltip. `data-testid=git-root` marks the
						     REAL chip only: it is asserted on for exact text.

						     A DECLARED root is a value the reader acts on, so it is legible; the
						     "workspace" default is the absence of one, deliberately quiet, so a
						     rooted notebook stands out in a list where most are not. Withheld
						     entirely when the document could not be read: there the absence of a
						     root is unknown, not observed, and "workspace" would assert it. -->
						{#if !row}
							<span class="flex shrink-0 items-center gap-1 text-[11px] text-base-content/20" aria-hidden="true" data-testid="git-root-pending">
								<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z" /></svg>
								<span class="h-2 w-14 rounded bg-current"></span>
							</span>
						{:else if row.notRead}
							<!-- Named but never opened (the request was past the route's cap), so
							     there is no declaration to show. Withheld outright rather than
							     placeheld: unlike a row still in flight, nothing here is coming. -->
						{:else if !row.unreadable}
							<span
								class="flex max-w-[52%] shrink-0 items-center gap-1 text-[11px] {row.root ? 'text-base-content/70' : 'text-base-content/35'}"
								title={row.root ? `Code root: ${row.root} — this notebook's kernel runs and imports from here` : 'No code root declared: the kernel runs at the workspace root'}
								data-testid="git-root"
							>
								<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z" /></svg>
								<span class="truncate">{row.root ?? 'workspace'}</span>
							</span>
						{/if}
					</div>

					{#if row?.notRead}
						<!-- Never opened, so this row states only that. The REASON lives once
						     below the list, not per row: it is a fact about the request, and
						     repeating it on every dropped notebook would drown the ones that
						     were read. -->
						<p class="mt-1 text-[11px] text-base-content/35" data-testid="git-not-read">not read</p>
					{:else if row?.unreadable}
						<!-- The document itself could not be read: deleted or renamed outside
						     Cellar while its tab stayed open. Deliberately its OWN line rather
						     than the root-refusal one above, which names a root this row does
						     not have; there is no commit to report either, because we never
						     learned which checkout this notebook runs from. Same icon-carries-
						     the-hue treatment as the root refusal, for the same contrast reason. -->
						<div class="mt-1 flex items-start gap-1.5" data-testid="git-notebook-error">
							<svg class="mt-px h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
							<p class="text-[11px] leading-snug text-base-content/70">
								This notebook could not be read, so its code root is unknown. It may have been deleted or moved outside Cellar.
							</p>
						</div>
					{:else if row?.error}
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
						{@const label = refLabel(git)}
						<div class="mt-1 flex items-center gap-1.5 text-[11px]">
							<span class="flex min-w-0 flex-1 items-center gap-1 text-base-content/75" title={refTitle(git)}>
								{#if label}
									<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
									<span class="truncate" data-testid="git-branch-name">{label}</span>
								{/if}
							</span>
							{#if git.shortSha}
								<span class="shrink-0 font-mono tabular-nums text-base-content/70" title={git.commit ?? undefined} data-testid="git-sha">{git.shortSha}</span>
							{:else if unbornHead(git)}
								<!-- Where the SHA chip would be, because that is the value this
								     checkout does not have yet. Keeping the branch name in its own
								     slot beside it is what makes the row read as "this branch, no
								     commits" rather than as a commit line that failed to load. -->
								<span class="shrink-0 text-base-content/45" title="This checkout has no commits yet" data-testid="git-unborn">no commits yet</span>
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
		{#if notReadCount}
			<!-- Said ONCE, for however many rows were dropped: the cap is a property of
			     the request, not of any one notebook, and it names the remedy because
			     closing a tab is the only thing that brings those rows back. -->
			<p class="px-1 pt-1.5 text-[11px] text-base-content/45" data-testid="git-not-read-notice">
				Too many notebooks open: only the first {readLimit} are read, so {notReadCount} above show no commit. Close some to see them.
			</p>
		{/if}
		{#if worktrees.length}
			<!-- WORKTREES: one row per CHECKOUT of this repo, whether or not a notebook
			     points at it — a different axis from the rows above, which are one per
			     open notebook. A sub-block rather than a ninth sidebar section: same
			     subject ("which checkout is what"), same fetch/coalesce/refresh
			     machinery, and it renders NOTHING in a single-checkout repo, which is
			     most of them. -->
			<div class="mt-3 border-t border-base-300 pt-2" data-testid="git-worktrees">
				<p class="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">Worktrees</p>
				<div class="max-h-56 space-y-1 overflow-y-auto">
					{#each worktrees as w (w.absolute)}
						{@const adopted = activeRoot === w.path}
						<div class="rounded-lg border border-base-300 bg-base-100 px-2 py-1.5" data-testid="git-worktree" data-worktree-path={w.path}>
							<div class="flex items-center gap-1.5 text-xs">
								<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-base-content/75" title={w.absolute} data-testid="git-worktree-path">
									{w.path}
								</span>
								{#if w.external}
									<!-- Stated, not implied by the leading `../`: adopting a sibling
									     checkout while believing it sits inside the workspace is the one
									     misreading this feature can cause. -->
									<span class="shrink-0 rounded bg-base-200 px-1 text-[10px] text-base-content/60" title="Outside this workspace: the kernel runs here, but the file tree, git decorations and checkpoints stay workspace-wide" data-testid="git-worktree-external">external</span>
								{/if}
								{#if w.dirty}
									<span class="shrink-0 text-[13px] leading-none text-(--cellar-git-tree-modified)" title="Uncommitted changes in this checkout" data-testid="git-worktree-dirty">
										●<span class="sr-only">uncommitted changes</span>
									</span>
								{/if}
							</div>
							<div class="mt-0.5 flex items-center gap-1.5 text-[11px]">
								<span class="min-w-0 flex-1 truncate text-base-content/60" data-testid="git-worktree-branch">
									{w.branch ?? (w.detached ? 'detached' : '')}
								</span>
								{#if w.shortSha}
									<span class="shrink-0 font-mono tabular-nums text-base-content/60">{w.shortSha}</span>
								{/if}
								<!-- A registered-but-MISSING worktree states that and offers no button:
								     that is exactly the state a run rooted here would refuse, so an
								     enabled control would promise something the server declines. -->
								{#if !w.exists}
									<span class="shrink-0 text-base-content/45" data-testid="git-worktree-missing">missing on disk</span>
								{:else if adopted}
									<span class="shrink-0 text-base-content/45" data-testid="git-worktree-current">current root</span>
								{:else}
									<button
										class="btn btn-ghost btn-xs shrink-0 h-5 min-h-0 px-1.5 text-[11px]"
										onclick={() => useAsRoot(w)}
										disabled={!activeNotebook || !!adopting}
										title={activeNotebook
											? `Run ${activeNotebook.name}'s kernel in this checkout — its variables are cleared`
											: 'Open a notebook to point it at a checkout'}
										data-testid="git-worktree-use"
									>
										{adopting === w.path ? 'setting…' : 'Use as root'}
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				<!-- No silent caps: past the route's probe budget a row still lists its
				     path, branch and sha, but nothing read whether it has uncommitted
				     changes — so say that once, below the list, rather than letting those
				     rows read as clean. -->
				{#if worktreeNotReadCount}
					<p class="px-1 pt-1 text-[11px] text-base-content/45" data-testid="git-worktree-not-read">
						{worktreeNotReadCount} more registered {worktreeNotReadCount === 1 ? 'worktree' : 'worktrees'}: only
						{worktreeReadLimit} are checked for uncommitted changes.
					</p>
				{/if}
				{#if adoptFeedback}
					<p class="px-1 pt-1 text-[11px] text-base-content/60" data-testid="git-worktree-feedback">{adoptFeedback}</p>
				{/if}
			</div>
		{/if}
		{#if workspaceGit && !workspaceGit.isRepo}
			<p class="px-1 pt-1.5 text-[11px] text-base-content/35" data-testid="git-not-a-repo">
				This workspace is not a git repository.
			</p>
		{/if}
	{/if}
</div>
