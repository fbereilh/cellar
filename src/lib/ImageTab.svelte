<script lang="ts">
	/**
	 * Cellar — image viewer tab (VS Code-style). Renders a workspace image file
	 * fetched as raw bytes from `/api/fs/raw`, centered on a neutral checkerboard
	 * backdrop so transparency reads clearly, with a status line (name, pixel
	 * dimensions, file size) and a fit ⇄ actual-size toggle.
	 *
	 * The image is loaded via `fetch` → blob → object URL (not a bare `<img src>`
	 * to the route) so one request yields both the bytes AND the byte size
	 * (Content-Length), and a 404/broken file surfaces as a graceful message
	 * instead of a silent broken-image glyph. SVG rides through the same `<img>`,
	 * so embedded script can never execute.
	 */
	interface Props {
		path: string;
	}
	let { path }: Props = $props();

	const name = $derived(path.split(/[/\\]/).pop() ?? path);
	const src = $derived('/api/fs/raw?path=' + encodeURIComponent(path));

	let objectUrl = $state<string | null>(null);
	let byteSize = $state<number | null>(null);
	let natW = $state<number | null>(null);
	let natH = $state<number | null>(null);
	let status = $state<'loading' | 'ok' | 'error'>('loading');
	let errorMsg = $state('');
	let actualSize = $state(false);

	function humanSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB'];
		let v = bytes / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
	}

	// Load (and reload on path change) via fetch so we learn the byte size and can
	// report a real error. Revoke the previous object URL first to avoid a leak.
	$effect(() => {
		const url = src;
		let cancelled = false;
		let created: string | null = null;
		status = 'loading';
		errorMsg = '';
		natW = natH = null;
		byteSize = null;
		(async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				const len = res.headers.get('Content-Length');
				const blob = await res.blob();
				if (cancelled) return;
				byteSize = len ? Number(len) : blob.size;
				created = URL.createObjectURL(blob);
				objectUrl = created;
				status = 'loading'; // the <img> onload flips to 'ok'
			} catch (e) {
				if (cancelled) return;
				errorMsg = e instanceof Error ? e.message : String(e);
				status = 'error';
			}
		})();
		return () => {
			cancelled = true;
			if (created) URL.revokeObjectURL(created);
			if (objectUrl === created) objectUrl = null;
		};
	});

	function onImgLoad(e: Event) {
		const img = e.currentTarget as HTMLImageElement;
		natW = img.naturalWidth;
		natH = img.naturalHeight;
		status = 'ok';
	}
	function onImgError() {
		status = 'error';
		if (!errorMsg) errorMsg = 'Could not decode image';
	}
</script>

<div class="flex h-full flex-col">
	<!-- Status bar: filename, dimensions, size, fit toggle. -->
	<div
		class="flex items-center justify-between gap-3 border-b border-base-300 bg-base-100 px-4 py-1.5 text-xs"
	>
		<div class="flex min-w-0 items-center gap-3 text-base-content/70">
			<span class="truncate font-medium" title={path}>{name}</span>
			{#if natW && natH}
				<span class="shrink-0 tabular-nums text-base-content/50">{natW} × {natH}</span>
			{/if}
			{#if byteSize != null}
				<span class="shrink-0 tabular-nums text-base-content/50">{humanSize(byteSize)}</span>
			{/if}
		</div>
		{#if status === 'ok'}
			<button
				class="btn btn-ghost btn-xs shrink-0"
				onclick={() => (actualSize = !actualSize)}
				data-testid="image-fit-toggle"
			>
				{actualSize ? 'Fit' : 'Actual size'}
			</button>
		{/if}
	</div>

	<!-- Image stage on a neutral checkerboard so transparency reads clearly. -->
	<div class="cellar-image-stage min-h-0 flex-1 {actualSize ? 'overflow-auto' : 'overflow-hidden'}">
		{#if status === 'error'}
			<div class="flex h-full flex-col items-center justify-center gap-2 text-center">
				<div class="text-4xl opacity-30">🖼️</div>
				<div class="text-sm text-base-content/60">Could not open image</div>
				<div class="max-w-md break-all font-mono text-xs text-base-content/40">
					{name}{errorMsg ? ` — ${errorMsg}` : ''}
				</div>
			</div>
		{:else}
			<div
				class="flex min-h-full w-full items-center justify-center p-6 {actualSize ? '' : 'h-full'}"
			>
				{#if objectUrl}
					<!-- svelte-ignore a11y_img_redundant_alt -->
					<img
						src={objectUrl}
						alt="{name} image"
						data-testid="image-view"
						class="cellar-image {actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}"
						onload={onImgLoad}
						onerror={onImgError}
					/>
				{/if}
			</div>
			{#if status === 'loading'}
				<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
					<span class="loading loading-spinner loading-md text-base-content/40"></span>
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	/* Neutral checkerboard behind the image so transparent PNGs are legible in
	   either theme. The two greys are theme-aware via `light-dark()` against the
	   resolved color-scheme daisyUI sets on <html>, the same source of truth the
	   editor + git decorations use — so a new theme needs no work here. */
	.cellar-image-stage {
		position: relative;
		--cellar-checker-a: light-dark(#e9eaee, #23262c);
		--cellar-checker-b: light-dark(#f4f5f7, #2b2f36);
		background-color: var(--cellar-checker-b);
		background-image:
			linear-gradient(45deg, var(--cellar-checker-a) 25%, transparent 25%),
			linear-gradient(-45deg, var(--cellar-checker-a) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--cellar-checker-a) 75%),
			linear-gradient(-45deg, transparent 75%, var(--cellar-checker-a) 75%);
		background-size: 20px 20px;
		background-position:
			0 0,
			0 10px,
			10px -10px,
			-10px 0;
	}
	/* A soft shadow lifts the image off the checkerboard as a distinct plane. */
	.cellar-image {
		box-shadow: 0 1px 12px light-dark(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.5));
		border-radius: 2px;
	}
</style>
