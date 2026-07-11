<!--
  Sidebar → Environment. The Python environment the kernel is bound to (the
  project venv): its interpreter path + version, the venv location, and every
  installed package with its version - the reproducibility surface a teammate
  needs to recreate the env.

  Read-only for v1 (view + export). Export produces a pinned `requirements.txt`,
  either copied to the clipboard or saved next to the project. Installing /
  removing packages from here is a deliberate follow-up (route through
  `venv.js` `installPackages`) - not built, to keep this section safe.

  Data comes from a server subprocess of the project venv python (never the
  kernel), so it works before the first cell runs. See
  `src/lib/server/environment.js`. Fetched on first open + manual refresh.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { EnvironmentResult } from '$lib/server/environment';

	let env = $state<EnvironmentResult | null>(null);
	let error = $state('');
	let loading = $state(false);

	// Monotonic generation: an in-flight load must not clobber a newer one.
	let seq = 0;

	async function load() {
		const mine = ++seq;
		loading = true;
		try {
			const res = await fetch('/api/environment');
			const body = await res.json();
			if (mine !== seq) return; // superseded
			if (!res.ok && !body) throw new Error('failed to read the environment');
			env = body as EnvironmentResult;
			error = '';
		} catch (err) {
			if (mine !== seq) return;
			error = String((err as Error)?.message ?? err);
		} finally {
			if (mine === seq) loading = false;
		}
	}

	onMount(load);

	// Let the section header's refresh button re-probe (bind:this in Sidebar).
	export function refresh() {
		load();
	}

	const ready = $derived(!!env?.ok);
	const packages = $derived(env?.ok ? env.packages : []);

	const requirements = $derived(
		packages
			.filter((p) => p?.name && p?.version)
			.map((p) => `${p.name}==${p.version}`)
			.join('\n')
	);

	// ---- Filter -------------------------------------------------------------
	let filter = $state('');
	const filtered = $derived(
		filter.trim()
			? packages.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
			: packages
	);

	// ---- Export -------------------------------------------------------------
	let copied = $state<'req' | 'path' | ''>(''); // 'req' | 'path' | ''
	let copyTimer: ReturnType<typeof setTimeout>;
	async function copyText(kind: 'req' | 'path', text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = kind;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = ''), 1400);
		} catch {}
	}

	let saving = $state(false);
	let savedPath = $state('');
	let saveError = $state('');
	async function saveRequirements() {
		saving = true;
		saveError = '';
		savedPath = '';
		try {
			const res = await fetch('/api/environment', { method: 'POST' });
			const body = await res.json();
			if (!res.ok || !body?.ok) throw new Error(body?.message || 'failed to save requirements.txt');
			savedPath = body.path;
		} catch (err) {
			saveError = String((err as Error)?.message ?? err);
		} finally {
			saving = false;
		}
	}

	// Show the raw requirements.txt (a "freeze" view).
	let showFreeze = $state(false);
</script>

<div class="px-3 pb-3" data-testid="environment-body">
	{#if error}
		<div class="rounded-lg border border-error/30 bg-error/10 p-2.5 text-xs text-error" data-testid="env-error">
			{error}
		</div>
	{:else if env == null && loading}
		<div class="flex items-center gap-2 px-1 py-2 text-xs text-base-content/40">
			<span class="loading loading-spinner loading-xs"></span> reading environment…
		</div>
	{:else if !env || !env.ok}
		<!-- No venv resolvable: guide the user, never blank / crash. -->
		<div class="rounded-lg border border-dashed border-base-300 bg-base-100 p-2.5" data-testid="env-no-venv">
			<p class="text-xs font-medium text-base-content/70">No Python environment bound</p>
			<p class="mt-1.5 text-[11px] leading-relaxed text-base-content/50">
				{env?.message || 'Cellar could not resolve a project virtualenv.'}
				Launch with <code class="font-mono text-[10px] text-primary">cellar</code>, or bind one in
				<span class="font-medium">Settings → Python environment</span>.
			</p>
			{#if env?.defaultVenv}
				<p class="mt-2 truncate font-mono text-[10px] text-base-content/40" title={env.defaultVenv}>
					expected: {env.defaultVenv}
				</p>
			{/if}
		</div>
	{:else if env && env.ok}
		<!-- Interpreter facts -->
		<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="env-card">
			<div class="flex items-center justify-between gap-2">
				<span class="flex min-w-0 items-center gap-1.5 text-sm font-medium">
					<svg class="h-3.5 w-3.5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></svg>
					<span class="min-w-0 break-words">{env.implementation === 'cpython' ? 'Python' : env.implementation} {env.pythonVersion}</span>
				</span>
				<span class="badge badge-sm badge-primary badge-soft shrink-0 whitespace-nowrap" data-testid="env-pkg-count">
					{packages.length} pkg{packages.length === 1 ? '' : 's'}
				</span>
			</div>

			<dl class="mt-2 space-y-1.5 border-t border-base-300 pt-2 text-[11px]">
				<div>
					<dt class="uppercase tracking-wide text-base-content/40">venv</dt>
					<dd class="truncate font-mono text-base-content/70" title={env.venvDir} data-testid="env-venv-dir">{env.venvDir}</dd>
				</div>
				<div>
					<dt class="uppercase tracking-wide text-base-content/40">interpreter</dt>
					<dd class="truncate font-mono text-base-content/70" title={env.python} data-testid="env-python">{env.python}</dd>
				</div>
				{#if env.pythonVersionFull}
					<div>
						<dt class="uppercase tracking-wide text-base-content/40">version</dt>
						<dd class="break-words font-mono text-base-content/60" title={env.pythonVersionFull}>{env.pythonVersionFull}</dd>
					</div>
				{/if}
			</dl>
		</div>

		<!-- Export -->
		<div class="mt-2 flex flex-wrap items-center gap-1.5" data-testid="env-export">
			<button
				class="btn btn-outline btn-xs gap-1"
				onclick={() => copyText('req', requirements)}
				disabled={!packages.length}
				title="Copy a pinned requirements.txt to the clipboard"
				data-testid="env-copy-requirements"
			>
				{#if copied === 'req'}
					<svg class="h-3 w-3 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
					copied
				{:else}
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
					Copy requirements
				{/if}
			</button>
			<button
				class="btn btn-outline btn-xs gap-1"
				onclick={saveRequirements}
				disabled={!packages.length || saving}
				title="Write requirements.txt into the workspace root"
				data-testid="env-save-requirements"
			>
				{#if saving}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></svg>
				{/if}
				Save file
			</button>
			<button
				class="btn btn-ghost btn-xs gap-1 text-base-content/50 hover:text-base-content"
				onclick={() => (showFreeze = !showFreeze)}
				disabled={!packages.length}
				data-testid="env-freeze-toggle"
			>
				<svg class="h-2.5 w-2.5 transition-transform {showFreeze ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
				freeze
			</button>
		</div>

		{#if savedPath}
			<p class="mt-1.5 flex items-center gap-1 text-[11px] text-success" data-testid="env-saved">
				<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
				<span class="truncate font-mono" title={savedPath}>saved {savedPath}</span>
			</p>
		{/if}
		{#if saveError}
			<p class="mt-1.5 text-[11px] text-error" data-testid="env-save-error">{saveError}</p>
		{/if}

		{#if showFreeze}
			<pre class="mt-2 max-h-56 overflow-auto rounded-lg border border-base-300 bg-base-100 p-2 font-mono text-[11px] leading-relaxed text-base-content/70" data-testid="env-freeze">{requirements || '# no packages'}</pre>
		{/if}

		<!-- Package list -->
		<div class="mt-3">
			<label class="input input-sm input-bordered flex items-center gap-2">
				<svg class="h-3.5 w-3.5 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
				<input type="text" class="grow text-xs" placeholder="filter packages…" bind:value={filter} data-testid="env-filter" />
			</label>
			<div class="mt-1.5 max-h-72 overflow-auto rounded-lg border border-base-300 bg-base-100" data-testid="env-packages">
				{#if filtered.length}
					{#each filtered as p (p.name)}
						<div class="flex items-baseline gap-2 border-b border-base-300/50 px-2 py-1 text-xs last:border-0" data-testid="env-package-row">
							<span class="min-w-0 flex-1 truncate font-mono font-medium text-primary" title={p.name}>{p.name}</span>
							<span class="shrink-0 whitespace-nowrap font-mono text-base-content/50">{p.version}</span>
						</div>
					{/each}
				{:else}
					<p class="px-2 py-2 text-xs text-base-content/40">{packages.length ? 'no match' : 'no packages installed'}</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
