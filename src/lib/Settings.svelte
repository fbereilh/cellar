<script>
	// Settings panel (modal): theme toggle + the project-venv (Python kernel) control.
	let { open, theme, onClose, onSetTheme, onVenvRebound } = $props();

	const THEMES = [
		{ id: 'dim', label: 'Dark', hint: 'dim' },
		{ id: 'nord', label: 'Light', hint: 'nord' }
	];

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
			venvPath = venv?.python || '';
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
			venvPath = venv?.python || path;
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
		<div class="modal-box max-w-md">
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
			</div>

			<div class="modal-action">
				<button class="btn btn-sm" onclick={onClose}>Done</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={onClose} aria-label="Close settings">close</button>
	</div>
{/if}
