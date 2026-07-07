<script>
	import { onMount } from 'svelte';
	import { EditorView, keymap } from '@codemirror/view';
	import { EditorState, Prec } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { oneDark } from '@codemirror/theme-one-dark';

	let { cell, index, count, running, onRun, onRunAdvance, onClear, onDelete, onMove, onEdit, onReady } = $props();

	let editorEl;
	let view;
	let editTimer;

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
	function render(o) {
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
				return {
					tone: 'error',
					text: stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n'))
				};
			default:
				return { tone: 'stdout', text: '' };
		}
	}

	const rendered = $derived((cell.outputs || []).map(render));

	const toneClass = {
		stdout: 'text-base-content border-transparent',
		stderr: 'text-warning border-warning/40',
		result: 'text-success font-semibold border-success/40',
		error: 'text-error border-error bg-error/10'
	};

	function currentSource() {
		return view ? view.state.doc.toString() : cell.source;
	}

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: cell.source,
				extensions: [
					basicSetup,
					python(),
					oneDark,
					// ⌘/Ctrl+Enter runs in place; Shift+Enter runs and advances.
					Prec.highest(
						keymap.of([
							{ key: 'Mod-Enter', run: () => (onRun(cell.id, currentSource()), true) },
							{ key: 'Shift-Enter', run: () => (onRunAdvance(cell.id, currentSource()), true) }
						])
					),
					EditorView.updateListener.of((v) => {
						if (!v.docChanged) return;
						clearTimeout(editTimer);
						const src = v.state.doc.toString();
						editTimer = setTimeout(() => onEdit(cell.id, src), 500);
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
		// Let the parent focus this cell's editor (Shift+Enter advance).
		onReady?.(cell.id, () => view.focus());
		return () => {
			clearTimeout(editTimer);
			onReady?.(cell.id, null);
			view?.destroy();
		};
	});
</script>

<div class="card border border-base-300 bg-base-100 shadow-sm" data-testid="cell" data-cell-id={cell.id}>
	<div class="card-body gap-0 p-0">
		<!-- Cell toolbar -->
		<div class="flex items-center justify-between border-b border-base-300 px-2 py-1">
			<div class="flex items-center gap-0.5">
				<button
					class="btn btn-ghost btn-xs btn-square text-success"
					onclick={() => onRun(cell.id, currentSource())}
					disabled={running}
					title="Run cell (⌘/Ctrl+Enter · Shift+Enter to advance)"
					aria-label="Run cell"
					data-testid="run"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
				</button>
				<button
					class="btn btn-ghost btn-xs btn-square text-base-content/60"
					onclick={() => onClear(cell.id)}
					title="Clear output"
					aria-label="Clear output"
					data-testid="clear"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.3-9.3a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" />
					</svg>
				</button>
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
				<!-- Fixed-width slot at the far right: reserved so toggling the running
				     indicator never shifts the toolbar layout. -->
				<span class="ml-1 flex w-[68px] justify-end">
					{#if showRunning}
						<span class="flex items-center gap-1 text-[11px] text-warning" data-testid="running-indicator">
							<span class="loading loading-spinner loading-xs"></span> running
						</span>
					{:else}
						<span class="font-mono text-[11px] text-base-content/30">python3</span>
					{/if}
				</span>
			</div>
		</div>

		<!-- Editor -->
		<div bind:this={editorEl} aria-label="code cell" class="max-h-96 overflow-auto px-3"></div>

		<!-- Output -->
		{#if rendered.length}
			<div class="space-y-0.5 border-t border-base-300 py-2" data-testid="output">
				{#each rendered as o}
					<pre class="overflow-x-auto whitespace-pre-wrap break-words border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{o.text}</pre>
				{/each}
			</div>
		{/if}
	</div>
</div>
