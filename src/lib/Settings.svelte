<script lang="ts">
	// Settings panel (modal): theme toggle, the windowed-rendering opt-out, the
	// project-venv (Python kernel) control, and the keyboard-shortcut registry
	// (view + rebind).
	import { shortcuts, chordFromEvent, chordTokens, formatChord, typesACharacter, typingHazards, CATEGORIES, MODE_LABEL } from '$lib/shortcuts.svelte';
	import type { VenvInfo } from '$lib/server/venv-bind';
	import { getUserSettingFlag, getUserSettingText, setUserSetting, setUserSettingNow } from '$lib/userSettings';
	import { CHAT_MODEL_KEY, CHAT_MODELS, CHAT_OTHER_NOTEBOOKS_KEY, CHAT_WEB_SEARCH_KEY, CHAT_WORKSPACE_READS_KEY, normalizeChatModel } from '$lib/chatCell';
	import { UPLOAD_PREFIX_DEFAULT_KEY, UPLOAD_POSTFIX_DEFAULT_KEY } from '$lib/uploadDefaults';
	import {
		UPLOAD_DATE_TOKENS,
		expandDateTokens,
		isStorableAffix,
		resolveUploadName,
		unknownAffixTokens,
		unknownTokenWarning
	} from '$lib/databricksUploadName';
	import { insertTokenIntoField, tokenField } from '$lib/uploadTokenField';
	import { getUi, setUiNow } from '$lib/uiState';
	import { WORKTREE_AGENT_CONFIG_KEY } from '$lib/notebookRoot';

	interface Props {
		open: boolean;
		theme: string;
		/**
		 * The notebook the shell is showing, workspace-relative, or null. Threaded
		 * in (not re-read) so the chat reads-availability report below can name
		 * WHICH notebook is at fault: that verdict is per notebook, so reads can be
		 * unavailable here while working in the notebook beside it.
		 */
		activeNotebookPath?: string | null;
		/**
		 * Windowed rendering. This is the SAME shell state the navbar View-menu
		 * toggle reads and writes (`+page.svelte`, persisted once through
		 * `VIRTUALIZE_PREF_KEY` in `$lib/virtualizePref`) - deliberately threaded in
		 * rather than re-read here, so the two control surfaces cannot diverge and
		 * there is exactly one preference to persist.
		 */
		virtualizeCells?: boolean;
		/** A `?virtualize=` URL param decided it: show the state, but lock the control. */
		virtualizeForced?: boolean;
		/**
		 * Code root bar visibility - the same shell-owned, threaded-in shape as
		 * `virtualizeCells` (one `$state` in `+page.svelte`, one persisted key), so
		 * this control cannot drift from what the notebooks render. Per VIEWER, not
		 * per notebook: it is a display choice about the shell, and a notebook with a
		 * root actually DECLARED shows the bar regardless of it.
		 */
		showCodeRoot?: boolean;
		onClose?: () => void;
		onSetTheme: (id: string) => void;
		onToggleVirtualizeCells?: () => void;
		onToggleShowCodeRoot?: () => void;
		onVenvRebound?: () => void;
	}
	let {
		open,
		theme,
		virtualizeCells = true,
		virtualizeForced = false,
		showCodeRoot = false,
		onClose,
		onSetTheme,
		onToggleVirtualizeCells,
		onToggleShowCodeRoot,
		onVenvRebound,
		activeNotebookPath = null
	}: Props = $props();

	const THEMES = [
		{ id: 'dim', label: 'Dark', hint: 'dim' },
		{ id: 'cellar-light', label: 'Light', hint: 'cellar-light' }
	];

	// ---- Agent config in an adopted external worktree (default ON) ------------
	// Per-workspace, in the `.cellar/` store the server reads at adoption time; the
	// key is imported rather than mirrored, so this control and the writer cannot
	// drift. Re-seeded whenever the modal OPENS rather than once on mount, because
	// this component stays mounted for the life of the shell — a read, never a
	// write, so it cannot fight the toggle (`setUiNow` updates the client cache
	// synchronously, so re-reading returns exactly what was just set).
	let worktreeAgentConfig = $state(true);
	$effect(() => {
		if (!open) return;
		worktreeAgentConfig = getUi<boolean>(WORKTREE_AGENT_CONFIG_KEY, true);
	});
	function toggleWorktreeAgentConfig() {
		worktreeAgentConfig = !worktreeAgentConfig;
		// `setUiNow`, NOT the debounced `setUi`: the SERVER re-reads this preference
		// during a LATER user action (adopting a worktree root), so an opt-out still
		// sitting in the debounce window would let that adoption write `.mcp.json`
		// into the user's checkout — precisely what the setting exists to prevent.
		// The Databricks runtime toggle documents the same shape for the same reason.
		void setUiNow(WORKTREE_AGENT_CONFIG_KEY, worktreeAgentConfig);
	}

	// ---- Default Databricks upload name ---------------------------------------
	// A cross-PROJECT default for the sidebar's upload prefix/postfix: someone who
	// stamps every upload the same way should say so once, not once per repo. It
	// lives in the global `~/.cellar/` store (`$lib/userSettings`), because the
	// per-project `.cellar/` store cannot answer for a project it is not in and
	// `localStorage` dies with the dynamic port on every relaunch.
	//
	// Strictly a DEFAULT: the Databricks panel seeds from it only where the project
	// has no affix of its own, so editing it never rewrites naming someone already
	// set per project. What is stored is the raw pattern, tokens unexpanded.
	let uploadPrefixDefault = $state('');
	let uploadPostfixDefault = $state('');
	let defaultsHydrated = false;
	$effect(() => {
		// Seeded when the modal first opens rather than at construction: `Settings` is
		// mounted for the life of the shell, and at that point `hydrateUserSettings`
		// may not have run yet, so a read there would latch the empty pre-hydration
		// value for the whole session.
		if (!open || defaultsHydrated) return;
		defaultsHydrated = true;
		// Read as TEXT through the shared guard, exactly as the Databricks panel's
		// `storedAffix` does: the store is untyped JSON, so a non-string here would
		// reach `expandDateTokens` and throw out of a render-time `$derived`.
		uploadPrefixDefault = getUserSettingText(UPLOAD_PREFIX_DEFAULT_KEY);
		uploadPostfixDefault = getUserSettingText(UPLOAD_POSTFIX_DEFAULT_KEY);
	});

	/**
	 * The same clock the sidebar's preview uses, for the same reason: the tokens
	 * shown here would otherwise be frozen at whenever this component last
	 * re-rendered, and a settings pane left open across midnight would advertise
	 * yesterday. Only armed while the modal is open - nothing behind it is on screen.
	 */
	const DEFAULT_CLOCK_TICK_MS = 60_000;
	let defaultsNow = $state(new Date());
	$effect(() => {
		if (!open) return;
		const wake = () => (defaultsNow = new Date());
		wake();
		const tick = setInterval(wake, DEFAULT_CLOCK_TICK_MS);
		window.addEventListener('focus', wake);
		return () => {
			clearInterval(tick);
			window.removeEventListener('focus', wake);
		};
	});

	function setUploadDefault(which: 'prefix' | 'postfix', v: string) {
		if (which === 'prefix') uploadPrefixDefault = v;
		else uploadPostfixDefault = v;
		// Refused, never repaired - the same rule the upload itself follows, applied at
		// the moment the pattern is authored. The field keeps exactly what was typed and
		// the error below says why, but nothing unusable reaches the global store. The
		// BLAST RADIUS is what makes this stricter than the sidebar's own field: an
		// unusable affix there disables the upload in the one project on screen, while an
		// unusable DEFAULT disables it in every project that never set its own, under a
		// message naming a field the user never typed into there.
		//
		// Judged PER FIELD, from the affix being written and nothing else - deliberately
		// NOT through the pane's `defaultsResolved`, which is what is SHOWN below and
		// validates the PAIR. Each field is its own key, so a combined verdict silently
		// refused to store a perfectly good postfix while the prefix was invalid, and the
		// write that ran when the prefix was fixed carried only the prefix: the typed
		// postfix was never persisted by anything. `isStorableAffix` also leaves out the
		// assembled name's LENGTH, which is measured here against a placeholder stem and
		// is no fact about a default that meets a different stem in every project.
		//
		// The consequence is deliberate: a previously VALID stored default is left
		// untouched while the field holds invalid text, so a RELOAD shows the last good
		// value. Within the session the field keeps the invalid text - this component is
		// mounted for the life of the shell and seeds once, so closing and reopening the
		// modal re-reads nothing. Do NOT "fix" that by deleting the stored default - that
		// would discard a working setting over a half-typed character.
		if (!isStorableAffix(v, defaultsNow)) return;
		// An empty default is NO default, so the key is deleted rather than stored as
		// `''`. That is the opposite of the per-project field - deliberately: there,
		// empty is a real answer ("no prefix on this project") that has to outrank this
		// default; here there is nothing below to outrank.
		setUserSetting(
			which === 'prefix' ? UPLOAD_PREFIX_DEFAULT_KEY : UPLOAD_POSTFIX_DEFAULT_KEY,
			v === '' ? null : v
		);
	}

	/**
	 * What these defaults would name a notebook today, resolved through the SAME
	 * `resolveUploadName` the sidebar previews with and the server uploads with - a
	 * settings pane that showed a name built any other way would be a fourth opinion
	 * about the one thing this feature promises to agree on.
	 */
	const defaultsResolved = $derived(
		resolveUploadName(
			'notebook.ipynb',
			{ prefix: uploadPrefixDefault, postfix: uploadPostfixDefault },
			defaultsNow
		)
	);
	const defaultsError = $derived(defaultsResolved.error ?? '');
	/** Braced runs that are not tokens - the same warning the sidebar gives, in the
	 *  place the pattern is actually authored, which is where it is worth more. */
	const defaultsUnknown = $derived(
		defaultsError
			? []
			: unknownAffixTokens(
					{ prefix: uploadPrefixDefault, postfix: uploadPostfixDefault },
					defaultsNow
				)
	);
	// No remedy clause: the sidebar's copy points at the token dropdown beside each of
	// its fields, and this pane's buttons are elsewhere on screen.
	const defaultsWarning = $derived(unknownTokenWarning(defaultsUnknown));

	// Which default field a token button writes into, and the elements themselves -
	// the insertion point is the caret, which only the DOM node knows. This pane keeps
	// a row of chips writing into the field last focused, where the sidebar gives each
	// affix its own dropdown; only the control's LOOK differs, the gesture is the same
	// shared `insertTokenIntoField` glue.
	let prefixDefaultEl = $state<HTMLInputElement | null>(null);
	let postfixDefaultEl = $state<HTMLInputElement | null>(null);
	let defaultTokenTarget = $state<'prefix' | 'postfix'>('prefix');

	function insertDefaultToken(token: string) {
		const which = defaultTokenTarget;
		insertTokenIntoField(
			which === 'prefix' ? prefixDefaultEl : postfixDefaultEl,
			which === 'prefix' ? uploadPrefixDefault : uploadPostfixDefault,
			token,
			(value) => setUploadDefault(which, value)
		);
	}

	// ---- Chat cells (model + web search + workspace reads) --------------------
	// Person-scoped like the account slot beside them in the same `~/.cellar/`
	// store: which model a reply bills, whether a reply may search the web, and
	// whether it may read this machine's files are about the person's
	// subscription and their data/egress choices, not about any one project. Seeded when the modal first opens (the upload-defaults
	// hydration rule: this component is mounted for the life of the shell, so a
	// construction-time read would latch the pre-hydration empty store). Reads go
	// through the shared gates (`normalizeChatModel`, the strict `=== true` flag
	// read), so this pane and the server can never disagree about what the
	// untyped store means.
	let chatModel = $state(normalizeChatModel(undefined));
	let chatWebSearch = $state(false);
	let chatWorkspaceReads = $state(false);
	let chatOtherNotebooks = $state(false);
	let chatHydrated = false;
	$effect(() => {
		if (!open || chatHydrated) return;
		chatHydrated = true;
		chatModel = normalizeChatModel(getUserSettingText(CHAT_MODEL_KEY));
		chatWebSearch = getUserSettingFlag(CHAT_WEB_SEARCH_KEY);
		chatWorkspaceReads = getUserSettingFlag(CHAT_WORKSPACE_READS_KEY);
		chatOtherNotebooks = getUserSettingFlag(CHAT_OTHER_NOTEBOOKS_KEY);
	});

	// DETECT + REPORT (the `sdkDbutils` precedent): workspace reads fail CLOSED on a
	// workspace path or notebook name Cellar cannot express as a literal permission
	// rule, and that fallback is otherwise SILENT - the toggle stays on and the copy
	// below still promises reads, while only the model is told otherwise, so the
	// person meets a reply that merely seems broken.
	//
	// Served by its OWN route (`/api/chat/reads`), never `/api/chat/status`: that
	// one awaits `claude auth status` spawns, so riding it made opening this modal
	// spawn the CLI for everyone - including users who never touch chat cells - and
	// put the notice behind authentication latency. This verdict is a pure function
	// of two path strings and spawns nothing. It comes from the SAME character rule
	// the engine applies, so the pane can never promise what a run would refuse.
	interface ReadsVerdict {
		available: boolean;
		blocked?: { cause: string; kind: string; segment?: string; isNotebookName?: boolean };
		notebook?: string;
	}
	let chatReads = $state<ReadsVerdict | null>(null);
	// Generation guard (the `statusSeq`/`kernelReqSeq` convention): the active
	// notebook can change while a read is in flight, and this notice NAMES a
	// notebook - a late reply landing over a newer one would assert the wrong thing
	// about a healthy notebook, the exact dishonesty this surface exists to remove.
	let readsSeq = 0;
	$effect(() => {
		if (!open) return;
		const nb = activeNotebookPath;
		const seq = ++readsSeq;
		// CLEARED before the request, not merely overwritten after it: until the new
		// verdict lands there is nothing true to say, and holding the PREVIOUS one
		// would keep a sentence naming another notebook on screen.
		chatReads = null;
		const qs = nb ? `?notebook=${encodeURIComponent(nb)}` : '';
		void fetch(`/api/chat/reads${qs}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				if (seq !== readsSeq) return;
				chatReads = body ?? null;
			})
			.catch(() => {
				// A failed probe reports NOTHING rather than claiming reads are broken:
				// over-reporting would send someone chasing a problem they do not have.
				if (seq === readsSeq) chatReads = null;
			});
	});

	// The sentence the report renders. Every branch states only what was actually
	// established, and offers a remedy ONLY where one can work - this module's own
	// doctrine is that a remedy the user cannot act on is worse than none.
	const chatReadsNotice = $derived.by(() => {
		const blocked = chatReads && !chatReads.available ? chatReads.blocked : null;
		if (!blocked) return null;
		// STRUCTURAL: the `//` rule prefix is POSIX-only, so on Windows every path
		// fails this way. No rename can fix it, so none is offered.
		if (blocked.kind !== 'character')
			return 'Workspace reads are not available on this platform: Cellar can only express these permission rules for POSIX paths, so it refuses rather than granting reads it could not confine.';
		const seg = blocked.segment ? ` ("${blocked.segment}")` : '';
		if (blocked.cause === 'workspace')
			return `Reads cannot be enabled in this workspace: a folder in its path${seg} contains a character Cellar cannot express as a safe permission rule, so it refuses rather than granting reads it could not confine. Renaming that folder restores it.`;
		// The notebook cause fires for the notebook's OWN name or for an ancestor
		// directory inside the workspace - naming the wrong one would send the person
		// to rename something that cannot help.
		const what = blocked.isNotebookName ? 'this notebook' : 'that folder';
		const where = blocked.isNotebookName ? 'its name' : `a folder in its path${seg}`;
		const named = chatReads?.notebook ? ` (${chatReads.notebook})` : '';
		return `Reads cannot be enabled for the notebook you are in${named}: ${where} contains a character Cellar cannot express as a safe permission rule, so it refuses rather than granting reads whose confinement it could not prove. Other notebooks in this workspace are unaffected; renaming ${what} restores it.`;
	});

	// Both write through `setUserSettingNow`, NEVER the debounced `setUserSetting`:
	// the server re-reads these keys during a LATER user action (`run-chat.ts`
	// reads them off `getUserSettings()` when a chat cell RUNS), which is the
	// `setUiNow` rule the Databricks runtime toggle already follows. Debounced,
	// unchecking "Allow web search" and immediately running a chat cell still
	// spawned the child with `--tools`/`--allowedTools WebSearch` - the opt-out
	// silently not taking effect for the very next run is the one outcome this
	// toggle exists to prevent. Neither is awaited: the local `$state` above is
	// the optimistic view and a failed PUT leaves the user's choice on screen.

	function setChatModel(id: string) {
		// The select's options are the closed CHAT_MODELS list, but the gate runs
		// anyway - the value stored is always one the argv builder accepts.
		chatModel = normalizeChatModel(id);
		void setUserSettingNow(CHAT_MODEL_KEY, chatModel);
	}

	function toggleChatWebSearch() {
		chatWebSearch = !chatWebSearch;
		// OFF deletes the key rather than storing `false`: absent = the default =
		// today's bare session, so a store that was never opted in carries nothing.
		void setUserSettingNow(CHAT_WEB_SEARCH_KEY, chatWebSearch ? true : null);
	}

	// Its own key and its own toggle, never a mode shared with web search: the two
	// widen the session in different directions (an outbound query channel vs.
	// local file reach), so wanting one must not hand over the other. Same
	// `setUserSettingNow` rule for the same security reason - the server re-reads
	// this key when a chat cell RUNS, so an opt-OUT still sitting in a debounce
	// window would let the very next run keep its file grant.
	function toggleChatWorkspaceReads() {
		chatWorkspaceReads = !chatWorkspaceReads;
		void setUserSettingNow(CHAT_WORKSPACE_READS_KEY, chatWorkspaceReads ? true : null);
	}

	// A NARROWING of the read grant, not a capability of its own - inert while
	// reads are off, and it can never expose the notebook being chatted in, which
	// the engine denies whatever this says. Its own key and its own handler for
	// the same reason as its neighbours, and the same `setUserSettingNow` rule:
	// the server re-reads it when a chat cell RUNS, so an opt-OUT left sitting in
	// a debounce window would let the very next run still reach other notebooks.
	function toggleChatOtherNotebooks() {
		chatOtherNotebooks = !chatOtherNotebooks;
		void setUserSettingNow(CHAT_OTHER_NOTEBOOKS_KEY, chatOtherNotebooks ? true : null);
	}

	// ---- Keyboard shortcuts --------------------------------------------------
	// Rendered straight from the registry, so this list can never drift from what
	// the notebook actually listens for.
	const grouped = $derived(CATEGORIES.map((c) => ({ category: c, items: shortcuts.list.filter((s) => s.category === c) })).filter((g) => g.items.length));
	const conflicts = $derived(shortcuts.conflicts);
	const customized = $derived(shortcuts.list.some((s) => s.customized));

	// The binding slot currently listening for a new chord: `{id, index}`.
	let capturing = $state<{ id: string; index: number } | null>(null);
	const isCapturing = (id: string, i: number) => capturing?.id === id && capturing.index === i;

	// A captured chord that would shadow a typable character, held for the user to
	// confirm: `{id, index, chord}`. Binding `k` to an edit-mode or global command
	// really does make `k` untypable in every cell, so we say so in as many words,
	// and then, if they still want it, we do it. The freedom is the point; the
	// surprise is what we refuse.
	let pendingHazard = $state<{ id: string; index: number; chord: string } | null>(null);

	// While capturing, swallow every keystroke and turn the first real chord into
	// the new binding. Escape cancels (its own binding is reachable via Reset).
	// LiveNotebook's handler already stands down whenever a modal is open, so the
	// notebook can't act on the keys being captured here.
	$effect(() => {
		if (!capturing) return;
		const slot = capturing;
		function onKey(e: KeyboardEvent) {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Escape') {
				capturing = null;
				return;
			}
			const chord = chordFromEvent(e);
			if (!chord) return; // a bare modifier press: keep listening
			capturing = null;
			const target = shortcuts.list.find((s) => s.id === slot.id);
			// Outside command mode, a bare printable chord steals a character from
			// every editor. Allowed, but only once the user has seen what it costs.
			if (target && target.mode !== 'command' && typesACharacter(chord)) {
				pendingHazard = { ...slot, chord };
				return;
			}
			shortcuts.rebind(slot.id, slot.index, chord);
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});

	function confirmHazard() {
		if (pendingHazard) shortcuts.rebind(pendingHazard.id, pendingHazard.index, pendingHazard.chord);
		pendingHazard = null;
	}

	// Leaving the modal must never strand the capture listener or a half-answered
	// confirmation.
	$effect(() => {
		if (!open) {
			capturing = null;
			pendingHazard = null;
		}
	});

	// Starting a new capture supersedes any unanswered hazard confirmation, so the
	// two prompts can never be on screen at once.
	function startCapture(id: string, index: number) {
		pendingHazard = null;
		capturing = { id, index };
	}

	// ---- Venv control --------------------------------------------------------
	let venv = $state<VenvInfo | null>(null);
	let venvPath = $state('');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	async function loadVenv() {
		error = '';
		notice = '';
		try {
			const res = await fetch('/api/venv');
			venv = (await res.json()) as VenvInfo;
			venvPath = venv?.venvDir || venv?.defaultVenv || '';
		} catch (err) {
			error = String((err as Error)?.message ?? err);
		}
	}

	// Fetch fresh binding each time the modal opens.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) loadVenv();
		wasOpen = open;
	});

	// The POST /api/venv response (see the venv route): the bind result plus the
	// refreshed VenvInfo.
	interface BindResponse {
		ok?: boolean;
		message?: string;
		info?: VenvInfo;
		created?: boolean;
		installedIpykernel?: boolean;
	}

	async function bind({ path, create }: { path: string; create: boolean }) {
		if (busy) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const res = await fetch('/api/venv', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path, create })
			});
			const body = (await res.json()) as BindResponse;
			if (!res.ok || !body.ok) throw new Error(body?.message || 'failed to bind venv');
			venv = body.info ?? null;
			venvPath = venv?.venvDir || path;
			notice = body.created
				? `Created venv and bound the kernel to it${body.installedIpykernel ? ' (installed ipykernel)' : ''}.`
				: `Bound the kernel to the selected venv${body.installedIpykernel ? ' (installed ipykernel)' : ''}.`;
			onVenvRebound?.();
		} catch (err) {
			error = String((err as Error)?.message ?? err);
		} finally {
			busy = false;
		}
	}

	// A raw dir like `.venv` or `/abs/path`; the server resolves it against the workspace.
	function switchTo() {
		const path = venvPath.trim();
		if (!path) return;
		if (!confirm(`Bind the kernel to this venv?\n\n${path}\n\nMissing ipykernel will be installed via uv.`)) return;
		bind({ path, create: false });
	}

	function createHere() {
		const path = venvPath.trim() || '.venv';
		if (!confirm(`Create a new virtualenv here with uv and bind the kernel to it?\n\n  uv venv ${path}\n  uv pip install ipykernel\n\nThis writes to your project.`)) return;
		bind({ path, create: true });
	}
</script>

{#if open}
	<div class="modal modal-open" data-testid="settings-modal">
		<div class="modal-box max-w-xl">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-lg font-semibold">Settings</h3>
				<button class="btn btn-ghost btn-sm btn-square" onclick={onClose} aria-label="Close settings" data-testid="settings-close">
					<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
				</button>
			</div>

			<div class="space-y-5">
				<div>
					<div class="mb-2 text-sm font-medium">Theme</div>
					<div class="join" data-testid="theme-toggle">
						{#each THEMES as t}
							<button
								class="btn join-item btn-sm {theme === t.id ? 'btn-primary' : 'btn-outline'}"
								onclick={() => onSetTheme(t.id)}
								data-testid="theme-{t.id}"
							>
								{t.label}
							</button>
						{/each}
					</div>
				</div>

				<div class="divider my-1"></div>

				<!-- Windowed rendering. Second surface for the ONE preference the navbar
				     View menu also toggles; both call the shell's `toggleVirtualizeCells`,
				     so flipping either updates the other in-session and persists once. -->
				<div data-testid="virtualize-control">
					<!-- Locked by a URL param: the row must not offer a click it will refuse,
					     so the pointer cursor and the full-strength label go with the toggle. -->
					<label class="flex items-center justify-between gap-4 {virtualizeForced ? 'opacity-60' : 'cursor-pointer'}">
						<span class="text-sm font-medium">Windowed rendering</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={virtualizeCells}
							disabled={virtualizeForced}
							onchange={() => onToggleVirtualizeCells?.()}
							data-testid="settings-virtualize-cells"
						/>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						Renders only the cells near the viewport, so a long notebook stays fast. Turn it off to keep
						every cell in the page at all times.
					</p>
					{#if virtualizeForced}
						<p class="mt-1 text-xs text-warning" data-testid="virtualize-forced-note">
							The <span class="font-mono">?virtualize</span> URL parameter is controlling this session
							(windowed rendering {virtualizeCells ? 'on' : 'off'}); reload without it to change this.
						</p>
					{/if}
				</div>

				<div class="divider my-1"></div>

				<!-- Code root bar. Hidden by default (roots are a specialist workflow);
				     this opt-in shows the bar on every notebook. The copy states the one
				     exception up front, because it is the invariant that makes the default
				     safe: a notebook whose root IS declared always shows the bar. -->
				<div data-testid="show-code-root-control">
					<label class="flex cursor-pointer items-center justify-between gap-4">
						<span class="text-sm font-medium">Show the code root bar</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={showCodeRoot}
							onchange={() => onToggleShowCodeRoot?.()}
							data-testid="settings-show-code-root"
						/>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						Show the bar for choosing the directory a notebook's kernel runs in (a git worktree under
						<span class="font-mono">roots/</span>, or a sibling checkout). Off, the bar appears only on a
						notebook that actually has a code root declared - a set root is never hidden.
					</p>
				</div>

				<div class="divider my-1"></div>

				<!-- Agent config in an adopted external worktree. Written ONLY when a
				     notebook is actually pointed AT that worktree, never on merely
				     detecting one — and the copy states what it costs, because this puts a
				     file into a checkout the user did not open. It therefore names EVERY
				     file that can land there: the writer addresses each harness the
				     workspace allow-lists, not `.mcp.json` alone, so naming one file
				     understated what this control authorizes. -->
				<div data-testid="worktree-agent-config-control">
					<label class="flex cursor-pointer items-center justify-between gap-4">
						<span class="text-sm font-medium">Set up agents in adopted worktrees</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={worktreeAgentConfig}
							onchange={toggleWorktreeAgentConfig}
							data-testid="settings-worktree-agent-config"
						/>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						When a notebook's code root is set to a git worktree outside this workspace, write the
						Cellar config for each agent harness set up in this workspace there
						(<span class="font-mono">.mcp.json</span> for Claude Code,
						<span class="font-mono">.codex/config.toml</span> for Codex), so an agent working in that
						checkout can reach this Cellar. Each is also added to that repository's
						<span class="font-mono">.git/info/exclude</span>, so the checkout does not show them as
						untracked changes and they cannot be committed. Git keeps that file per clone rather than per
						worktree, so those entries cover the top level of every worktree of that repository and its
						main checkout - it is never committed, so no collaborator inherits them.
					</p>
				</div>

				<div class="divider my-1"></div>

				<!-- Default Databricks upload name. A cross-PROJECT pattern, which is why it
				     is here and not only in the sidebar: it is about how this PERSON names
				     uploads, so it belongs beside the other person-level settings. Every
				     affordance the sidebar's fields grew is repeated because this is where
				     the pattern is authored - the token vocabulary and the not-a-token
				     warning are worth more here than anywhere. The vocabulary stays a row of
				     chips rather than the sidebar's per-field dropdown: this pane is wide
				     enough for it, and the narrow sidebar - where seven chips wrapped to
				     three lines - is what the dropdown was for. -->
				<div data-testid="upload-defaults-control">
					<div class="mb-1 text-sm font-medium">Default Databricks upload name</div>
					<p class="mb-2 text-xs text-base-content/50">
						Used in every project that has not set its own prefix/postfix in the Databricks
						sidebar. Changing it never touches a project you have already set.
					</p>
					<div class="grid grid-cols-2 gap-2">
						<label class="flex flex-col gap-1">
							<span class="text-xs text-base-content/60">Prefix</span>
							<input
								bind:this={prefixDefaultEl}
								use:tokenField
								class="input input-sm w-full font-mono text-xs"
								value={uploadPrefixDefault}
								oninput={(e) => setUploadDefault('prefix', (e.currentTarget as HTMLInputElement).value)}
								onfocus={() => (defaultTokenTarget = 'prefix')}
								placeholder="{'{YYYY-MM-DD}'}_"
								aria-invalid={!!defaultsError}
								data-testid="settings-upload-prefix"
							/>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-xs text-base-content/60">Postfix</span>
							<input
								bind:this={postfixDefaultEl}
								use:tokenField
								class="input input-sm w-full font-mono text-xs"
								value={uploadPostfixDefault}
								oninput={(e) => setUploadDefault('postfix', (e.currentTarget as HTMLInputElement).value)}
								onfocus={() => (defaultTokenTarget = 'postfix')}
								placeholder="_{'{YYYYMMDD}'}"
								aria-invalid={!!defaultsError}
								data-testid="settings-upload-postfix"
							/>
						</label>
					</div>
					{#if defaultsError}
						<p class="mt-1 text-xs text-error" data-testid="settings-upload-error">{defaultsError}</p>
					{:else}
						<p class="mt-1 text-xs text-base-content/50">
							A notebook called <span class="font-mono">notebook.ipynb</span> would upload as
							<span class="font-mono text-base-content/70" data-testid="settings-upload-preview"
								>{defaultsResolved.name}</span
							>
						</p>
					{/if}
					{#if defaultsWarning}
						<p class="mt-1 text-xs text-warning" role="status" data-testid="settings-upload-token-warning">
							{defaultsWarning}
						</p>
					{/if}
					<div class="mt-1.5 flex flex-wrap items-center gap-1">
						<span class="text-xs text-base-content/50">Date tokens (braces needed) - click to insert:</span>
						{#each UPLOAD_DATE_TOKENS as token (token)}
							<button
								type="button"
								class="btn btn-ghost btn-xs h-5 min-h-0 rounded border border-base-300 px-1 font-mono text-[11px] font-normal text-base-content/70"
								onmousedown={(e) => e.preventDefault()}
								onclick={() => insertDefaultToken(token)}
								title="{token} → {expandDateTokens(token, defaultsNow)}"
								aria-label="Insert {token} into the default {defaultTokenTarget}, which becomes {expandDateTokens(
									token,
									defaultsNow
								)}"
								data-testid="settings-upload-token"
								data-token={token}
							>
								{token}
							</button>
						{/each}
					</div>
				</div>

				<div class="divider my-1"></div>

				<!-- Chat cells. Person-level like the upload defaults above: the model a
				     reply bills and the two capability opt-ins follow the person across
				     projects. Each toggle's copy states what turning it on actually
				     grants and what it costs - search only, queries derived from the
				     notebook; reads confined to this workspace and read-only - because
				     these are the controls deciding whether notebook-derived text can
				     reach an external service and whether a reply can read local
				     files. They are kept SEPARATE (see the handlers): the two widen
				     the session in different directions. -->
				<div data-testid="chat-settings-control">
					<div class="mb-1 text-sm font-medium">Chat cells</div>
					<label class="flex items-center justify-between gap-4">
						<span class="text-xs text-base-content/60">Model</span>
						<select
							class="select select-sm w-40 font-mono text-xs"
							value={chatModel}
							onchange={(e) => setChatModel((e.currentTarget as HTMLSelectElement).value)}
							data-testid="settings-chat-model"
						>
							{#each CHAT_MODELS as m (m.id)}
								<option value={m.id}>{m.label}</option>
							{/each}
						</select>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						The Claude model chat cells reply with. Applies from the next run; which models your
						account can use depends on its subscription.
					</p>
					<label class="mt-3 flex cursor-pointer items-center justify-between gap-4">
						<span class="text-sm font-medium">Allow web search</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={chatWebSearch}
							onchange={toggleChatWebSearch}
							data-testid="settings-chat-web-search"
						/>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						Off, a chat cell runs no web searches. On, a reply may run them - search only: it
						still cannot fetch arbitrary URLs or run code. Search queries are derived from your
						notebook's content, so text from the notebook can reach the search service.
					</p>
					<label class="mt-3 flex cursor-pointer items-center justify-between gap-4">
						<span class="text-sm font-medium">Allow reading workspace files</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={chatWorkspaceReads}
							onchange={toggleChatWorkspaceReads}
							data-testid="settings-chat-workspace-reads"
						/>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						On, a reply may browse and search the files in this workspace to answer about your code
						(read, glob and grep). Reads are confined to the workspace folder: paths outside it are
						refused, including through <code>..</code> or a symlink. It is read-only - a chat cell
						still cannot write or edit files, or run code. The notebook you are chatting in is
						never readable as a file - the reply already has it as a fresher transcript, with the
						cells you hid from the agent left out - and neither is Cellar's own
						<code>.cellar</code> folder. Turn it off if the workspace holds secrets you would
						rather a reply could not read, especially with web search also on.
					</p>
					{#if chatReadsNotice}
						<!-- DETECT + REPORT: without this the fail-closed fallback is silent -
						     the toggle above still reads on and the copy still promises reads,
						     while only the model is told otherwise. Warning ICON plus
						     base-content copy, per the contrast doctrine (amber body text on
						     the light card measures ~2:1). -->
						<p
							class="mt-1 flex gap-1.5 text-xs text-base-content/70"
							data-testid="settings-chat-reads-unavailable"
						>
							<span class="text-warning" aria-hidden="true">&#9888;</span>
							<span>{chatReadsNotice}</span>
						</p>
					{/if}
					<label class="mt-3 flex cursor-pointer items-center justify-between gap-4">
						<span class="text-sm font-medium">Allow reading other notebooks</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={chatOtherNotebooks}
							onchange={toggleChatOtherNotebooks}
							data-testid="settings-chat-other-notebooks"
						/>
					</label>
					<p class="mt-1 text-xs text-base-content/50">
						Only applies while workspace reads are on. Off, the other <code>.ipynb</code> files in
						this workspace are not readable either, so a reply still reads <code>.py</code>,
						<code>.md</code> and data files. On, it may read them - including any cells their
						authors hid from the agent. The notebook you are chatting in stays unreadable
						either way. This covers <code>.ipynb</code> files: another notebook's exported
						copies (its "Save as .py" and its exported <code>.html</code>, which are ordinary
						workspace files) and any jupytext <code>.py</code> notebook stay readable whether
						this is on or off.
					</p>
				</div>

				<div class="divider my-1"></div>

				<!-- Python venv (kernel interpreter) -->
				<div data-testid="venv-control">
					<div class="mb-1 flex items-center justify-between">
						<div class="text-sm font-medium">Python environment</div>
						{#if venv && !venv.uvAvailable}
							<span class="badge badge-warning badge-sm">uv not found</span>
						{/if}
					</div>
					<p class="mb-2 text-xs text-base-content/50">The kernel runs in this virtualenv. Change it or create a new one (via uv).</p>

					<div class="mb-1 text-xs text-base-content/60">Currently bound</div>
					<div class="mb-3 truncate rounded bg-base-200 px-2 py-1 font-mono text-xs" data-testid="venv-current" title={venv?.python || ''}>
						{venv?.python || '—'}
					</div>

					<label class="mb-1 block text-xs text-base-content/60" for="venv-path">Venv path (relative to workspace, or absolute)</label>
					<input
						id="venv-path"
						class="input input-bordered input-sm mb-2 w-full font-mono text-xs"
						placeholder=".venv"
						bind:value={venvPath}
						disabled={busy}
						data-testid="venv-path"
					/>

					<div class="flex gap-2">
						<button class="btn btn-sm btn-primary" onclick={switchTo} disabled={busy || !venv?.uvAvailable} data-testid="venv-switch">
							{busy ? 'Working…' : 'Switch'}
						</button>
						<button class="btn btn-sm btn-outline" onclick={createHere} disabled={busy || !venv?.uvAvailable} data-testid="venv-create">
							Create new
						</button>
					</div>

					{#if notice}
						<div class="mt-2 text-xs text-success" data-testid="venv-notice">{notice}</div>
					{/if}
					{#if error}
						<div class="mt-2 text-xs text-error" data-testid="venv-error">{error}</div>
					{/if}
				</div>

				<div class="divider my-1"></div>

				<!-- Keyboard shortcuts (the registry, rendered) -->
				<div data-testid="shortcuts-panel">
					<div class="mb-1 flex items-center justify-between">
						<div class="text-sm font-medium">Keyboard shortcuts</div>
						{#if customized}
							<button class="btn btn-ghost btn-xs" onclick={() => shortcuts.resetAll()} data-testid="shortcuts-reset-all">Reset all</button>
						{/if}
					</div>
					<p class="mb-2 text-xs text-base-content/50">
						The notebook is modal, like Jupyter: <span class="font-medium text-info">command mode</span> runs these keys as commands,
						<span class="font-medium text-success">edit mode</span> types into the cell. Click a key to rebind it.
					</p>

					{#if conflicts.size}
						<div class="mb-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning" data-testid="shortcuts-conflict-warning">
							Some bindings collide in the same mode. The first match in the list wins.
						</div>
					{/if}

					<div class="max-h-[46vh] space-y-4 overflow-y-auto pr-1" data-testid="shortcuts-list">
						{#each grouped as group (group.category)}
							<div>
								<div class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/40">{group.category}</div>
								<ul class="space-y-0.5">
									{#each group.items as s (s.id)}
										{@const hazards = typingHazards(s)}
										<li
											class="rounded px-1.5 py-1 hover:bg-base-200 {conflicts.has(s.id) || hazards.length ? 'ring-1 ring-warning/50' : ''}"
											data-testid="shortcut-row"
											data-shortcut-id={s.id}
										>
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<div class="truncate text-xs">{s.description}</div>
													<div class="text-[10px] text-base-content/40">{MODE_LABEL[s.mode]}</div>
												</div>
												<div class="flex shrink-0 items-center gap-1">
													{#each s.keys as chord, i (i)}
														<!-- Alternate bindings for the same command read as one run of
														     keys without this separator. -->
														{#if i > 0}
															<span class="text-[10px] text-base-content/30">or</span>
														{/if}
														<button
															class="btn btn-ghost btn-xs h-6 min-h-0 gap-0.5 px-1 {isCapturing(s.id, i) ? 'text-warning' : ''}"
															onclick={() => startCapture(s.id, i)}
															title={isCapturing(s.id, i) ? 'Press the new key combination (Esc cancels)' : `Rebind ${formatChord(chord)}`}
															data-testid="shortcut-key"
															data-chord={chord}
														>
															{#if isCapturing(s.id, i)}
																<span class="px-1 text-[11px]">Press keys…</span>
															{:else}
																{#each chordTokens(chord) as token}
																	<kbd class="kbd kbd-sm">{token}</kbd>
																{/each}
															{/if}
														</button>
													{/each}
													{#if s.customized}
														<button
															class="btn btn-ghost btn-xs btn-square h-6 min-h-0 text-base-content/40 hover:text-base-content"
															onclick={() => shortcuts.reset(s.id)}
															title="Reset to the default binding"
															aria-label="Reset {s.description} to its default binding"
															data-testid="shortcut-reset"
														>
															<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
														</button>
													{/if}
												</div>
											</div>

											<!-- Confirm a binding that shadows a typable character. Allowed, never
											     silently: the user is told exactly which character they are giving up. -->
											{#if pendingHazard?.id === s.id}
												<div class="mt-1 rounded border border-warning/50 bg-warning/10 px-2 py-1.5 text-[11px] text-warning" data-testid="shortcut-hazard-confirm">
													<div>
														<span class="font-semibold">{formatChord(pendingHazard.chord)}</span> is a key you type. This command
														fires while a cell editor has focus, so binding it here means
														<span class="font-semibold">{formatChord(pendingHazard.chord)}</span> can no longer be typed into a cell.
													</div>
													<div class="mt-1 flex gap-1">
														<button class="btn btn-warning btn-xs h-5 min-h-0" onclick={confirmHazard} data-testid="shortcut-hazard-confirm-ok">Bind anyway</button>
														<button class="btn btn-ghost btn-xs h-5 min-h-0" onclick={() => (pendingHazard = null)} data-testid="shortcut-hazard-cancel">Cancel</button>
													</div>
												</div>
											{:else if hazards.length}
												<!-- A standing warning: this binding is already shadowing a character. -->
												<div class="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-warning" data-testid="shortcut-hazard-warning">
													<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
													<span>{hazards.map(formatChord).join(', ')} can no longer be typed into a cell editor.</span>
												</div>
											{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/each}
					</div>
				</div>
			</div>

			<div class="modal-action">
				<button class="btn btn-sm" onclick={onClose}>Done</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={onClose} aria-label="Close settings">close</button>
	</div>
{/if}
