<script module>
	import { EditorView } from '@codemirror/view';
	import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { tags as t } from '@lezer/highlight';
	import { oneDark } from '@codemirror/theme-one-dark';

	// Cellar's app themes (persisted to `localStorage['cellar-theme']`, applied as
	// `<html data-theme>`): 'dim' is dark, 'nord' is light. The code editor must
	// follow suit — a dark editor on a light page (and vice-versa) reads as a bug.
	const LIGHT_THEMES = new Set(['nord']);

	// Light editor palette = pygments "default" (the standard Jupyter light syntax
	// scheme), on the card's own light background (no editor background of its own).
	const jupyterLightHighlight = HighlightStyle.define([
		{ tag: [t.comment, t.lineComment, t.blockComment], color: '#408080', fontStyle: 'italic' },
		{ tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: '#008000', fontWeight: 'bold' },
		{ tag: [t.string, t.special(t.string), t.regexp], color: '#ba2121' },
		{ tag: [t.number, t.integer, t.float], color: '#666666' },
		{ tag: [t.bool, t.null, t.atom], color: '#008000', fontWeight: 'bold' },
		{ tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: '#0000ff' },
		{ tag: [t.definition(t.variableName)], color: '#19177c' },
		{ tag: [t.className, t.typeName, t.namespace], color: '#0000ff', fontWeight: 'bold' },
		{ tag: [t.standard(t.variableName), t.self], color: '#008000' },
		{ tag: [t.operator], color: '#666666' },
		{ tag: [t.meta], color: '#aa22ff' },
		{ tag: [t.heading], color: '#000080', fontWeight: 'bold' },
		{ tag: [t.link, t.url], color: '#0000ff', textDecoration: 'underline' },
		{ tag: [t.emphasis], fontStyle: 'italic' },
		{ tag: [t.strong], fontWeight: 'bold' }
	]);
	const jupyterLightTheme = EditorView.theme(
		{
			'&': { color: '#1a1a1a' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1a1a1a' },
			'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#d7d4f0' },
			'.cm-activeLine': { backgroundColor: 'rgba(0, 0, 0, 0.035)' },
			'.cm-activeLineGutter': { backgroundColor: 'transparent' },
			'.cm-lineNumbers .cm-gutterElement': { color: '#b8b8c0' },
			'.cm-matchingBracket': { backgroundColor: '#c2f0c2', color: 'inherit' }
		},
		{ dark: false }
	);

	// Editor theme extensions for the current app theme: bundled oneDark for dark
	// themes, the Jupyter light scheme for light ones.
	function editorThemeExtensions(appTheme) {
		return LIGHT_THEMES.has(appTheme) ? [jupyterLightTheme, syntaxHighlighting(jupyterLightHighlight)] : [oneDark];
	}
</script>

<script>
	import { onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { keymap } from '@codemirror/view';
	import { EditorState, Prec, Compartment } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import MarkdownIt from 'markdown-it';
	import DOMPurify from 'dompurify';

	let { cell, index, count, running, theme = 'dim', onRun, onRunAdvance, onClear, onDelete, onMove, onEdit, onSetType, onReady } = $props();

	let editorEl;
	let view;
	let editTimer;

	const isMarkdown = $derived(cell.cell_type === 'markdown');

	// Markdown cells render to HTML by default; double-click / edit → raw source.
	let mode = $state(cell.cell_type === 'markdown' && cell.source.trim() ? 'rendered' : 'edit');
	let liveSource = $state(cell.source);

	// markdown-it in safe mode (html:false escapes raw HTML) + DOMPurify (client
	// only) so notebook content can't inject script.
	const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
	function renderMarkdown(src) {
		return DOMPurify.sanitize(md.render(src || ''));
	}
	const renderedHtml = $derived(isMarkdown && browser ? renderMarkdown(liveSource) : '');

	// Running indicator: only reveal after a short delay so fast cells never
	// flash it (avoids the flicker the play-button spinner had).
	let showRunning = $state(false);
	let runIndicatorTimer;
	$effect(() => {
		if (running) {
			runIndicatorTimer = setTimeout(() => (showRunning = true), 180);
		} else {
			clearTimeout(runIndicatorTimer);
			showRunning = false;
		}
		return () => clearTimeout(runIndicatorTimer);
	});

	// Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks.
	const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
	const stripAnsi = (s) => s.replace(ANSI, '');
	const asText = (s) => (Array.isArray(s) ? s.join('') : (s ?? ''));

	// Map an nbformat output object to a renderable line {tone, text}.
	function renderOutput(o) {
		switch (o.output_type) {
			case 'stream':
				return { tone: o.name === 'stderr' ? 'stderr' : 'stdout', text: asText(o.text) };
			case 'execute_result':
			case 'display_data': {
				const d = o.data || {};
				if (d['text/plain']) return { tone: 'result', text: asText(d['text/plain']) };
				const img = Object.keys(d).find((k) => k.startsWith('image/'));
				return { tone: 'result', text: img ? `[${img} output]` : '[rich output]' };
			}
			case 'error':
				return { tone: 'error', text: stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n')) };
			default:
				return { tone: 'stdout', text: '' };
		}
	}
	const outputs = $derived((cell.outputs || []).map(renderOutput));

	const toneClass = {
		stdout: 'text-base-content border-transparent',
		stderr: 'text-warning border-warning/40',
		result: 'text-success font-semibold border-success/40',
		error: 'text-error border-error bg-error/10'
	};

	function currentSource() {
		return view ? view.state.doc.toString() : cell.source;
	}

	// Run/render. For markdown this just renders (parent persists source, no
	// kernel); for code the parent runs it on the kernel.
	function doRun(advance) {
		const src = currentSource();
		liveSource = src;
		if (isMarkdown) mode = 'rendered';
		(advance ? onRunAdvance : onRun)(cell.id, src);
	}

	async function enterEdit() {
		mode = 'edit';
		await tick();
		view?.focus();
	}

	const language = new Compartment();
	const editorTheme = new Compartment();
	const langFor = (type) => (type === 'markdown' ? markdown() : python());

	// Reconfigure the editor language when the cell type toggles; after a manual
	// toggle, drop into edit mode so the user sees the source.
	let prevType = cell.cell_type;
	$effect(() => {
		const type = cell.cell_type;
		if (view) view.dispatch({ effects: language.reconfigure(langFor(type)) });
		if (type !== prevType) {
			prevType = type;
			mode = 'edit';
		}
	});

	// Follow the app's light/dark theme so the editor never renders dark-on-light.
	$effect(() => {
		if (view) view.dispatch({ effects: editorTheme.reconfigure(editorThemeExtensions(theme)) });
	});

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: cell.source,
				extensions: [
					basicSetup,
					language.of(langFor(cell.cell_type)),
					editorTheme.of(editorThemeExtensions(theme)),
					// ⌘/Ctrl+Enter runs/renders in place; Shift+Enter runs and advances.
					Prec.highest(
						keymap.of([
							{ key: 'Mod-Enter', run: () => (doRun(false), true) },
							{ key: 'Shift-Enter', run: () => (doRun(true), true) }
						])
					),
					EditorView.updateListener.of((v) => {
						if (!v.docChanged) return;
						liveSource = v.state.doc.toString();
						clearTimeout(editTimer);
						editTimer = setTimeout(() => onEdit(cell.id, liveSource), 500);
					}),
					EditorView.theme({
						'&': { backgroundColor: 'transparent', fontSize: '13.5px' },
						'.cm-content': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', padding: '10px 0' },
						'.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
						'&.cm-focused': { outline: 'none' }
					})
				]
			})
		});
		if (import.meta.env.DEV) (window.cellarViews ??= {})[cell.id] = view;
		onReady?.(cell.id, () => view.focus());
		return () => {
			clearTimeout(editTimer);
			onReady?.(cell.id, null);
			view?.destroy();
		};
	});
</script>

<div class="card border border-base-300 bg-base-100 shadow-sm" data-testid="cell" data-cell-id={cell.id} data-cell-type={cell.cell_type}>
	<div class="card-body gap-0 p-0">
		<!-- Cell toolbar -->
		<div class="flex items-center justify-between border-b border-base-300 px-2 py-1">
			<div class="flex items-center gap-0.5">
				<button
					class="btn btn-ghost btn-xs btn-square text-success"
					onclick={() => doRun(false)}
					disabled={running}
					title={isMarkdown ? 'Render (⌘/Ctrl+Enter · Shift+Enter to advance)' : 'Run cell (⌘/Ctrl+Enter · Shift+Enter to advance)'}
					aria-label={isMarkdown ? 'Render cell' : 'Run cell'}
					data-testid="run"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
				</button>
				{#if isMarkdown}
					{#if mode === 'rendered'}
						<button class="btn btn-ghost btn-xs btn-square text-base-content/60" onclick={enterEdit} title="Edit markdown" aria-label="Edit markdown" data-testid="edit-md">
							<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
						</button>
					{/if}
				{:else}
					<button class="btn btn-ghost btn-xs btn-square text-base-content/60" onclick={() => onClear(cell.id)} title="Clear output" aria-label="Clear output" data-testid="clear">
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.3-9.3a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" />
						</svg>
					</button>
				{/if}
				<span class="ml-1.5 font-mono text-xs text-base-content/50" title={cell.id}>cell <span class="text-base-content/70">#{cell.id.slice(0, 8)}</span></span>
			</div>
			<div class="flex items-center gap-1">
				<button class="btn btn-ghost btn-xs btn-square" onclick={() => onMove(cell.id, 'up')} disabled={index === 0} title="Move up" aria-label="Move cell up" data-testid="move-up">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
				</button>
				<button class="btn btn-ghost btn-xs btn-square" onclick={() => onMove(cell.id, 'down')} disabled={index === count - 1} title="Move down" aria-label="Move cell down" data-testid="move-down">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
				</button>
				<button class="btn btn-ghost btn-xs btn-square text-error/70 hover:text-error" onclick={() => onDelete(cell.id)} disabled={count === 1} title="Delete cell" aria-label="Delete cell" data-testid="delete">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6" /></svg>
				</button>
				<!-- Far-right slot: running indicator (code) or the cell-type toggle. -->
				<span class="ml-1 flex min-w-[76px] justify-end">
					{#if showRunning}
						<span class="flex items-center gap-1 text-[11px] text-warning" data-testid="running-indicator">
							<span class="loading loading-spinner loading-xs"></span> running
						</span>
					{:else}
						<button
							class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 font-mono text-[11px] font-normal text-base-content/40 hover:text-base-content/80"
							onclick={() => onSetType(cell.id, isMarkdown ? 'code' : 'markdown')}
							title={isMarkdown ? 'Convert to code cell' : 'Convert to Markdown cell'}
							data-testid="type-toggle"
						>
							{isMarkdown ? 'markdown' : 'python3'}
						</button>
					{/if}
				</span>
			</div>
		</div>

		<!-- Rendered markdown (double-click or the edit button to edit) -->
		{#if isMarkdown && mode === 'rendered'}
			<div
				class="cellar-md px-4 py-3 text-sm leading-relaxed"
				data-testid="markdown-rendered"
				role="button"
				tabindex="0"
				title="Double-click to edit"
				ondblclick={enterEdit}
				onkeydown={(e) => (e.key === 'Enter' ? enterEdit() : null)}
			>
				{#if renderedHtml.trim()}
					{@html renderedHtml}
				{:else}
					<span class="text-base-content/30">Empty markdown cell — double-click to edit</span>
				{/if}
			</div>
		{/if}

		<!-- Editor (hidden while a markdown cell shows its rendered view) -->
		<div
			bind:this={editorEl}
			aria-label="cell source"
			class="max-h-96 overflow-auto px-3 {isMarkdown && mode === 'rendered' ? 'hidden' : ''}"
		></div>

		<!-- Output (code cells only) -->
		{#if !isMarkdown && outputs.length}
			<div class="space-y-0.5 border-t border-base-300 py-2" data-testid="output">
				{#each outputs as o}
					<pre class="overflow-x-auto whitespace-pre-wrap break-words border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{o.text}</pre>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	:global(.cellar-md > *:first-child) {
		margin-top: 0;
	}
	:global(.cellar-md > *:last-child) {
		margin-bottom: 0;
	}
	:global(.cellar-md h1) {
		font-size: 1.5em;
		font-weight: 700;
		margin: 0.5em 0 0.3em;
		border-bottom: 1px solid #313244;
		padding-bottom: 0.2em;
	}
	:global(.cellar-md h2) {
		font-size: 1.3em;
		font-weight: 700;
		margin: 0.5em 0 0.3em;
		border-bottom: 1px solid #313244;
		padding-bottom: 0.2em;
	}
	:global(.cellar-md h3) {
		font-size: 1.1em;
		font-weight: 600;
		margin: 0.5em 0 0.3em;
	}
	:global(.cellar-md p) {
		margin: 0.5em 0;
	}
	:global(.cellar-md ul) {
		list-style: disc;
		padding-left: 1.5em;
		margin: 0.5em 0;
	}
	:global(.cellar-md ol) {
		list-style: decimal;
		padding-left: 1.5em;
		margin: 0.5em 0;
	}
	:global(.cellar-md li) {
		margin: 0.2em 0;
	}
	:global(.cellar-md a) {
		color: #89b4fa;
		text-decoration: underline;
	}
	:global(.cellar-md code) {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 0.9em;
		background: rgba(127, 127, 127, 0.2);
		padding: 0.1em 0.35em;
		border-radius: 0.25em;
	}
	:global(.cellar-md pre) {
		background: #11111b;
		padding: 0.75em 1em;
		border-radius: 0.4em;
		overflow-x: auto;
		margin: 0.6em 0;
	}
	:global(.cellar-md pre code) {
		background: none;
		padding: 0;
	}
	:global(.cellar-md blockquote) {
		border-left: 3px solid #45475a;
		padding-left: 1em;
		color: #a6adc8;
		margin: 0.6em 0;
	}
	:global(.cellar-md table) {
		border-collapse: collapse;
		margin: 0.6em 0;
	}
	:global(.cellar-md th),
	:global(.cellar-md td) {
		border: 1px solid #45475a;
		padding: 0.3em 0.6em;
	}
</style>
