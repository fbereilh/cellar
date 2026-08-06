<script lang="ts">
	// Settings panel (modal): theme toggle, the windowed-rendering opt-out, the
	// project-venv (Python kernel) control, and the keyboard-shortcut registry
	// (view + rebind).
	import { shortcuts, chordFromEvent, chordTokens, formatChord, typesACharacter, typingHazards, CATEGORIES, MODE_LABEL } from '$lib/shortcuts.svelte';
	import type { VenvInfo } from '$lib/server/venv-bind';
	import { getUserSetting, setUserSetting } from '$lib/userSettings';
	import { UPLOAD_PREFIX_DEFAULT_KEY, UPLOAD_POSTFIX_DEFAULT_KEY } from '$lib/uploadDefaults';
	import {
		UPLOAD_DATE_TOKENS,
		expandDateTokens,
		insertUploadToken,
		resolveUploadName,
		unknownAffixTokens
	} from '$lib/databricksUploadName';

	interface Props {
		open: boolean;
		theme: string;
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
		onClose?: () => void;
		onSetTheme: (id: string) => void;
		onToggleVirtualizeCells?: () => void;
		onVenvRebound?: () => void;
	}
	let {
		open,
		theme,
		virtualizeCells = true,
		virtualizeForced = false,
		onClose,
		onSetTheme,
		onToggleVirtualizeCells,
		onVenvRebound
	}: Props = $props();

	const THEMES = [
		{ id: 'dim', label: 'Dark', hint: 'dim' },
		{ id: 'cellar-light', label: 'Light', hint: 'cellar-light' }
	];

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
		uploadPrefixDefault = getUserSetting<string>(UPLOAD_PREFIX_DEFAULT_KEY, '');
		uploadPostfixDefault = getUserSetting<string>(UPLOAD_POSTFIX_DEFAULT_KEY, '');
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
	const defaultsWarning = $derived(
		defaultsUnknown.length === 0
			? ''
			: `${defaultsUnknown.map((t) => `"${t}"`).join(' and ')} ${
					defaultsUnknown.length === 1 ? 'is not a date token' : 'are not date tokens'
				} - ${defaultsUnknown.length === 1 ? 'it uploads' : 'they upload'} exactly as written.`
	);

	// Which default field a token button writes into, and the elements themselves -
	// the insertion point is the caret, which only the DOM node knows. Mirrors the
	// sidebar's own token buttons; the shared rule is `insertUploadToken`.
	let prefixDefaultEl = $state<HTMLInputElement | null>(null);
	let postfixDefaultEl = $state<HTMLInputElement | null>(null);
	let defaultTokenTarget = $state<'prefix' | 'postfix'>('prefix');

	function insertDefaultToken(token: string) {
		const which = defaultTokenTarget;
		const el = which === 'prefix' ? prefixDefaultEl : postfixDefaultEl;
		const current = which === 'prefix' ? uploadPrefixDefault : uploadPostfixDefault;
		const { value, caret } = insertUploadToken(current, token, el?.selectionStart, el?.selectionEnd);
		setUploadDefault(which, value);
		if (!el) return;
		el.value = value;
		el.focus();
		el.setSelectionRange(caret, caret);
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

				<!-- Default Databricks upload name. A cross-PROJECT pattern, which is why it
				     is here and not only in the sidebar: it is about how this PERSON names
				     uploads, so it belongs beside the other person-level settings. Every
				     affordance the sidebar's fields grew is repeated because this is where
				     the pattern is authored - the token buttons and the not-a-token warning
				     are worth more here than anywhere. -->
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
