<script>
	// Settings panel (modal): theme toggle, the project-venv (Python kernel)
	// control, and the keyboard-shortcut registry (view + rebind).
	import { shortcuts, chordFromEvent, chordTokens, formatChord, CATEGORIES, MODE_LABEL } from '$lib/shortcuts.svelte.js';

	let { open, theme, onClose, onSetTheme, onVenvRebound } = $props();

	const THEMES = [
		{ id: 'dim', label: 'Dark', hint: 'dim' },
		{ id: 'nord', label: 'Light', hint: 'nord' }
	];

	// ---- Keyboard shortcuts --------------------------------------------------
	// Rendered straight from the registry, so this list can never drift from what
	// the notebook actually listens for.
	const grouped = $derived(CATEGORIES.map((c) => ({ category: c, items: shortcuts.list.filter((s) => s.category === c) })).filter((g) => g.items.length));
	const conflicts = $derived(shortcuts.conflicts);
	const customized = $derived(shortcuts.list.some((s) => s.customized));

	// The binding slot currently listening for a new chord: `{id, index}`.
	let capturing = $state(null);
	const isCapturing = (id, i) => capturing?.id === id && capturing.index === i;

	// While capturing, swallow every keystroke and turn the first real chord into
	// the new binding. Escape cancels (its own binding is reachable via Reset).
	// LiveNotebook's handler already stands down whenever a modal is open, so the
	// notebook can't act on the keys being captured here.
	$effect(() => {
		if (!capturing) return;
		function onKey(e) {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === 'Escape') {
				capturing = null;
				return;
			}
			const chord = chordFromEvent(e);
			if (!chord) return; // a bare modifier press: keep listening
			shortcuts.rebind(capturing.id, capturing.index, chord);
			capturing = null;
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});

	// Leaving the modal must never strand the capture listener.
	$effect(() => {
		if (!open) capturing = null;
	});

	// ---- Venv control --------------------------------------------------------
	let venv = $state(null);
	let venvPath = $state('');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');

	async function loadVenv() {
		error = '';
		notice = '';
		try {
			const res = await fetch('/api/venv');
			venv = await res.json();
			venvPath = venv?.venvDir || venv?.defaultVenv || '';
		} catch (err) {
			error = String(err?.message ?? err);
		}
	}

	// Fetch fresh binding each time the modal opens.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) loadVenv();
		wasOpen = open;
	});

	async function bind({ path, create }) {
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
			const body = await res.json();
			if (!res.ok || !body.ok) throw new Error(body?.message || 'failed to bind venv');
			venv = body.info;
			venvPath = venv?.venvDir || path;
			notice = body.created
				? `Created venv and bound the kernel to it${body.installedIpykernel ? ' (installed ipykernel)' : ''}.`
				: `Bound the kernel to the selected venv${body.installedIpykernel ? ' (installed ipykernel)' : ''}.`;
			onVenvRebound?.();
		} catch (err) {
			error = String(err?.message ?? err);
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
										<li
											class="flex items-center justify-between gap-3 rounded px-1.5 py-1 hover:bg-base-200 {conflicts.has(s.id) ? 'ring-1 ring-warning/50' : ''}"
											data-testid="shortcut-row"
											data-shortcut-id={s.id}
										>
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
														onclick={() => (capturing = { id: s.id, index: i })}
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
