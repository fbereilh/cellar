<script>
	import { onMount } from 'svelte';
	import { EditorView, keymap } from '@codemirror/view';
	import { EditorState, Prec } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { oneDark } from '@codemirror/theme-one-dark';

	// Stable per-cell id (nbformat-4.5-style) — the addressing spine in the full
	// product. Owned by the server (see +page.server.js) so it stays fixed
	// across page refreshes.
	let { data } = $props();
	const cellId = data.cellId;

	let code = $state("print('hello')\n6 * 7");
	let outputs = $state([]); // {kind, text, tone}
	let running = $state(false);
	let kernelState = $state('idle');
	let workspace = $state('');

	// CodeMirror editor (Python syntax highlighting) — the editor the real
	// product will use too (JupyterLab is built on CodeMirror).
	let editorEl;
	let view;

	// Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks.
	const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
	const stripAnsi = (s) => s.replace(ANSI, '');

	// When true, the next write replaces the previous run's output. Deferring the
	// clear until output actually arrives avoids a flash of the empty state.
	let freshRun = false;

	function push(kind, text, tone) {
		if (freshRun) {
			outputs = [];
			freshRun = false;
		}
		outputs = [...outputs, { kind, text, tone }];
	}

	$effect(() => {
		workspace = new URLSearchParams(location.search).get('ws') || '';
	});

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: code,
				extensions: [
					basicSetup,
					python(),
					oneDark,
					// ⌘/Ctrl+Enter runs the cell; take precedence over defaults.
					Prec.highest(
						keymap.of([{ key: 'Mod-Enter', run: () => (run(), true) }])
					),
					EditorView.updateListener.of((v) => {
						if (v.docChanged) code = v.state.doc.toString();
					}),
					// Blend the editor into the DaisyUI card while keeping oneDark colors.
					EditorView.theme({
						'&': { backgroundColor: 'transparent', fontSize: '13.5px' },
						'.cm-content': {
							fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
							padding: '10px 0'
						},
						'.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
						'&.cm-focused': { outline: 'none' }
					})
				]
			})
		});
		if (import.meta.env.DEV) window.cellarView = view; // spike test aid
		return () => view?.destroy();
	});

	const kernelReady = $derived(kernelState === 'idle' || kernelState === 'kernel ready');

	function handle(ev) {
		switch (ev.type) {
			case 'kernel':
				kernelState = 'kernel ready';
				break;
			case 'status':
				kernelState = ev.execution_state;
				break;
			case 'stream':
				push('stream', ev.text, ev.name === 'stderr' ? 'stderr' : 'stdout');
				break;
			case 'execute_result':
				push('result', ev.text, 'result');
				break;
			case 'display_data':
				push('display', ev.text, 'result');
				break;
			case 'error':
				push('error', stripAnsi((ev.traceback || [ev.ename + ': ' + ev.evalue]).join('\n')), 'error');
				break;
			case 'done':
				// A run that produced no output (e.g. a bare assignment) clears
				// the previous output only now, at the end.
				if (freshRun) {
					outputs = [];
					freshRun = false;
				}
				break;
		}
	}

	async function run() {
		if (running) return;
		running = true;
		freshRun = true; // replace the previous run's output when new output arrives
		try {
			const res = await fetch('/api/execute', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code })
			});
			// Read the NDJSON stream incrementally so outputs appear live.
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl;
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line) handle(JSON.parse(line));
				}
			}
		} catch (err) {
			push('error', 'Request failed: ' + err, 'error');
		} finally {
			running = false;
		}
	}

	function clearOutput() {
		outputs = [];
	}

	const toneClass = {
		stdout: 'text-base-content border-transparent',
		stderr: 'text-warning border-warning/40',
		result: 'text-success font-semibold border-success/40',
		error: 'text-error border-error bg-error/10'
	};
</script>

<div class="min-h-screen bg-base-200 text-base-content">
	<div class="mx-auto max-w-3xl px-4 py-8">
		<!-- Header -->
		<header class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-base-300 pb-4">
			<h1 class="flex items-center gap-2 text-xl font-semibold">
				<span>🍷 Cellar</span>
				<span class="badge badge-warning badge-sm">spike</span>
			</h1>
			<div class="flex flex-wrap items-center gap-4 text-xs text-base-content/60">
				<span class="flex items-center gap-1.5">
					kernel
					<span class="badge badge-sm gap-1.5 badge-soft {kernelReady ? 'badge-success' : 'badge-error'}">
						<span class="inline-block h-1.5 w-1.5 rounded-full {kernelReady ? 'bg-success' : 'bg-error'}"></span>
						{kernelState}
					</span>
				</span>
				{#if workspace}
					<span>workspace <code class="rounded bg-base-300 px-1.5 py-0.5 font-mono">{workspace}</code></span>
				{/if}
			</div>
		</header>

		<!-- Code cell -->
		<div class="card border border-base-300 bg-base-100 shadow-sm">
			<div class="card-body gap-0 p-0">
				<div class="flex items-center justify-between border-b border-base-300 px-2 py-1">
					<div class="flex items-center gap-0.5">
						<button
							class="btn btn-ghost btn-xs btn-square text-success"
							onclick={run}
							disabled={running}
							title="Run cell (⌘/Ctrl+Enter)"
							aria-label="Run cell"
							data-testid="run"
						>
							{#if running}
								<span class="loading loading-spinner loading-xs"></span>
							{:else}
								<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
									<path d="M8 5v14l11-7z" />
								</svg>
							{/if}
						</button>
						<button
							class="btn btn-ghost btn-xs btn-square text-base-content/60"
							onclick={clearOutput}
							title="Clear output"
							aria-label="Clear output"
							data-testid="clear"
						>
							<svg
								class="h-3.5 w-3.5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.3-9.3a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21" />
								<path d="M22 21H7" />
								<path d="m5 11 9 9" />
							</svg>
						</button>
						<span class="ml-1.5 font-mono text-xs text-base-content/50">cell <span class="text-base-content/70">#{cellId}</span></span>
					</div>
					<span class="font-mono text-[11px] text-base-content/30">python3</span>
				</div>
				<div
					bind:this={editorEl}
					aria-label="code cell"
					class="max-h-96 overflow-auto px-3"
				></div>
			</div>
		</div>

		<!-- Output -->
		<section class="mt-6" data-testid="output">
			{#if outputs.length === 0}
				<p class="text-sm text-base-content/40">No output yet. Type some Python and hit Run.</p>
			{:else}
				<div class="space-y-0.5">
					{#each outputs as o}
						<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{o.text}</pre>
					{/each}
				</div>
			{/if}
		</section>
	</div>
</div>
