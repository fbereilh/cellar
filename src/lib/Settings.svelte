<script>
	// Settings panel (modal). Theme toggle now; a placeholder for future settings.
	let { open, theme, onClose, onSetTheme } = $props();

	const THEMES = [
		{ id: 'dim', label: 'Dark', hint: 'dim' },
		{ id: 'nord', label: 'Light', hint: 'nord' }
	];
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

				<div class="text-sm text-base-content/50">
					<div class="mb-1 font-medium text-base-content/70">More settings</div>
					<p>Kernel selection, editor preferences, and agent visibility defaults will live here in a later step.</p>
				</div>
			</div>

			<div class="modal-action">
				<button class="btn btn-sm" onclick={onClose}>Done</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={onClose} aria-label="Close settings">close</button>
	</div>
{/if}
