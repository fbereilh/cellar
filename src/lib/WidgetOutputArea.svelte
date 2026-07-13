<script lang="ts">
	// Renders an ipywidgets `Output` widget's captured `outputs` — the list of
	// nbformat output dicts an `Output` context (and thus `interact`) fills. This is
	// what makes `interact(f, x=slider)` update live: moving the slider re-runs `f`,
	// the kernel repopulates this Output's `outputs` trait, a `widget:update` ticks
	// the store, and this repaints. A deliberately compact subset of the full cell
	// output renderer — enough for `interact` (print/repr/HTML/image) — recursing
	// into nested widget views. Both themes handled by daisyUI semantic classes.
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';
	import WidgetOutput from '$lib/WidgetOutput.svelte';

	let { outputs }: { outputs: unknown[] } = $props();

	type Out = Record<string, unknown>;

	function asText(v: unknown): string {
		return Array.isArray(v) ? v.map(String).join('') : v == null ? '' : String(v);
	}
	// eslint-disable-next-line no-control-regex
	const ANSI = /\[[0-9;]*m/g;
	function stripAnsi(s: string): string {
		return s.replace(ANSI, '');
	}
	function imageSrc(mime: string, payload: unknown): string {
		const data = asText(payload);
		if (mime === 'image/svg+xml') return `data:image/svg+xml;utf8,${encodeURIComponent(data)}`;
		return `data:${mime};base64,${data.replace(/\s+/g, '')}`;
	}
	const IMG_MIMES = ['image/png', 'image/jpeg', 'image/gif'];

	type Rendered =
		| { kind: 'stream'; tone: 'stdout' | 'stderr'; text: string }
		| { kind: 'text'; text: string }
		| { kind: 'html'; html: string }
		| { kind: 'image'; src: string }
		| { kind: 'widget'; modelId: string }
		| { kind: 'error'; text: string }
		| { kind: 'empty' };

	function render(o: Out): Rendered {
		const type = o.output_type;
		if (type === 'stream') {
			return { kind: 'stream', tone: o.name === 'stderr' ? 'stderr' : 'stdout', text: asText(o.text) };
		}
		if (type === 'error') {
			const tb = Array.isArray(o.traceback) ? o.traceback.join('\n') : String(o.evalue ?? '');
			return { kind: 'error', text: stripAnsi(tb) };
		}
		if (type === 'execute_result' || type === 'display_data') {
			const d = (o.data ?? {}) as Record<string, unknown>;
			const wv = d['application/vnd.jupyter.widget-view+json'] as { model_id?: string } | undefined;
			if (wv?.model_id) return { kind: 'widget', modelId: wv.model_id };
			const imgMime = IMG_MIMES.find((m) => d[m] != null) ?? (d['image/svg+xml'] != null ? 'image/svg+xml' : null);
			if (imgMime) return { kind: 'image', src: imageSrc(imgMime, d[imgMime]) };
			if (d['text/html'] != null) {
				const html = browser ? DOMPurify.sanitize(asText(d['text/html'])) : '';
				return { kind: 'html', html };
			}
			if (d['text/plain'] != null) return { kind: 'text', text: asText(d['text/plain']) };
		}
		return { kind: 'empty' };
	}

	const rendered = $derived(
		(Array.isArray(outputs) ? outputs : [])
			.map((o) => render((o ?? {}) as Out))
			.filter((r) => r.kind !== 'empty')
	);
</script>

<div class="cellar-widget-outputs space-y-0.5" data-testid="widget-output-area">
	{#each rendered as r (r)}
		{#if r.kind === 'stream'}
			<pre
				class="whitespace-pre-wrap font-mono text-xs {r.tone === 'stderr'
					? 'text-error'
					: 'text-base-content/80'}">{r.text}</pre>
		{:else if r.kind === 'text'}
			<pre class="whitespace-pre-wrap font-mono text-xs text-base-content/80">{r.text}</pre>
		{:else if r.kind === 'error'}
			<pre class="whitespace-pre-wrap font-mono text-xs text-error">{r.text}</pre>
		{:else if r.kind === 'html'}
			<div class="prose prose-sm max-w-none text-sm">{@html r.html}</div>
		{:else if r.kind === 'image'}
			<img src={r.src} alt="widget output" class="max-w-full" data-testid="widget-output-image" />
		{:else if r.kind === 'widget'}
			<WidgetOutput modelId={r.modelId} />
		{/if}
	{/each}
</div>
