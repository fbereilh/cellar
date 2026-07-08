<script>
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import MarkdownIt from 'markdown-it';
	import DOMPurify from 'dompurify';

	// Read-only rendered view of an arbitrary workspace `.ipynb` opened from the
	// file tree. Unlike the canonical notebook (live, kernel-attached, editable),
	// this just renders the committed cells + outputs so the file reads as a
	// notebook rather than raw JSON. No kernel, no mutation.
	let { path } = $props();

	let status = $state('loading'); // 'loading' | 'ready' | 'error'
	let errorMsg = $state('');
	let cells = $state([]);

	const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
	const renderMd = (src) => (browser ? DOMPurify.sanitize(md.render(src || '')) : '');

	const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
	const stripAnsi = (s) => s.replace(ANSI, '');
	const asText = (s) => (Array.isArray(s) ? s.join('') : (s ?? ''));

	// nbformat output → { tone, text } | { image } line, mirroring Cell.svelte.
	function renderOutput(o) {
		switch (o.output_type) {
			case 'stream':
				return { tone: o.name === 'stderr' ? 'stderr' : 'stdout', text: asText(o.text) };
			case 'execute_result':
			case 'display_data': {
				const d = o.data || {};
				const imgKey = Object.keys(d).find((k) => k.startsWith('image/'));
				if (imgKey === 'image/svg+xml')
					return { image: `data:image/svg+xml;utf8,${encodeURIComponent(asText(d[imgKey]))}` };
				if (imgKey) return { image: `data:${imgKey};base64,${asText(d[imgKey])}` };
				if (d['text/plain']) return { tone: 'result', text: asText(d['text/plain']) };
				return { tone: 'result', text: '[rich output]' };
			}
			case 'error':
				return { tone: 'error', text: stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n')) };
			default:
				return { tone: 'stdout', text: '' };
		}
	}

	const toneClass = {
		stdout: 'text-base-content border-transparent',
		stderr: 'text-warning border-warning/40',
		result: 'text-success font-semibold border-success/40',
		error: 'text-error border-error bg-error/10'
	};

	onMount(async () => {
		try {
			const res = await fetch(`/api/fs/notebook?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'could not open notebook');
			cells = body.cells;
			status = 'ready';
		} catch (err) {
			status = 'error';
			errorMsg = String(err?.message ?? err);
		}
	});
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6" data-testid="notebook-file-view">
		<div class="mb-4 flex items-center gap-2 text-xs text-base-content/50">
			<span class="badge badge-sm badge-ghost">read-only</span>
			<span class="font-mono">{path}</span>
		</div>

		{#if status === 'loading'}
			<p class="px-2 text-sm text-base-content/40">loading…</p>
		{:else if status === 'error'}
			<div class="p-4 text-sm text-error" data-testid="notebook-file-error">Could not render <code class="font-mono">{path}</code>: {errorMsg}</div>
		{:else}
			<div class="space-y-4">
				{#each cells as cell (cell.id)}
					<div class="card border border-base-300 bg-base-100 shadow-sm" data-testid="rendered-cell" data-cell-type={cell.cell_type}>
						{#if cell.cell_type === 'markdown'}
							<div class="cellar-md px-4 py-3 text-sm leading-relaxed">
								{@html renderMd(cell.source)}
							</div>
						{:else}
							<pre class="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13.5px] leading-relaxed">{cell.source}</pre>
							{#if cell.outputs?.length}
								<div class="space-y-0.5 border-t border-base-300 py-2">
									{#each cell.outputs.map(renderOutput) as o}
										{#if o.image}
											<img src={o.image} alt="cell output" class="max-w-full px-3 py-1" />
										{:else}
											<pre class="overflow-x-auto whitespace-pre-wrap break-words border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{o.text}</pre>
										{/if}
									{/each}
								</div>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	:global(.cellar-md > *:first-child) { margin-top: 0; }
	:global(.cellar-md > *:last-child) { margin-bottom: 0; }
	:global(.cellar-md h1) { font-size: 1.5em; font-weight: 700; margin: 0.5em 0 0.3em; border-bottom: 1px solid #313244; padding-bottom: 0.2em; }
	:global(.cellar-md h2) { font-size: 1.3em; font-weight: 700; margin: 0.5em 0 0.3em; border-bottom: 1px solid #313244; padding-bottom: 0.2em; }
	:global(.cellar-md h3) { font-size: 1.1em; font-weight: 600; margin: 0.5em 0 0.3em; }
	:global(.cellar-md p) { margin: 0.5em 0; }
	:global(.cellar-md ul) { list-style: disc; padding-left: 1.5em; margin: 0.5em 0; }
	:global(.cellar-md ol) { list-style: decimal; padding-left: 1.5em; margin: 0.5em 0; }
	:global(.cellar-md li) { margin: 0.2em 0; }
	:global(.cellar-md a) { color: #89b4fa; text-decoration: underline; }
	:global(.cellar-md code) { font-family: ui-monospace, Menlo, monospace; font-size: 0.9em; background: rgba(127, 127, 127, 0.2); padding: 0.1em 0.35em; border-radius: 0.25em; }
	:global(.cellar-md pre) { background: #11111b; padding: 0.75em 1em; border-radius: 0.4em; overflow-x: auto; margin: 0.6em 0; }
	:global(.cellar-md pre code) { background: none; padding: 0; }
	:global(.cellar-md blockquote) { border-left: 3px solid #45475a; padding-left: 1em; color: #a6adc8; margin: 0.6em 0; }
	:global(.cellar-md table) { border-collapse: collapse; margin: 0.6em 0; }
	:global(.cellar-md th), :global(.cellar-md td) { border: 1px solid #45475a; padding: 0.3em 0.6em; }
</style>
