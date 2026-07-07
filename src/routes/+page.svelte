<script>
	let code = $state("print('hello')\n6 * 7");
	let outputs = $state([]); // {kind, text, tone}
	let running = $state(false);
	let kernelState = $state('idle');
	let workspace = $state('');

	// Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks.
	const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
	const stripAnsi = (s) => s.replace(ANSI, '');

	function push(kind, text, tone) {
		outputs = [...outputs, { kind, text, tone }];
	}

	$effect(() => {
		workspace = new URLSearchParams(location.search).get('ws') || '';
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
		}
	}

	async function run() {
		if (running) return;
		running = true;
		push('input', code, 'input');
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

	function onKeydown(e) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			run();
		}
	}

	const toneClass = {
		input: 'text-info/80 border-info/40',
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
				<textarea
					bind:value={code}
					onkeydown={onKeydown}
					spellcheck="false"
					rows="6"
					aria-label="code cell"
					class="textarea w-full resize-y rounded-b-none border-0 bg-base-100 font-mono text-sm leading-relaxed focus:outline-none"
				></textarea>
				<div class="flex items-center gap-2 border-t border-base-300 bg-base-100 px-3 py-2.5">
					<button class="btn btn-primary btn-sm gap-1" onclick={run} disabled={running} data-testid="run">
						{#if running}
							<span class="loading loading-spinner loading-xs"></span>
							Running…
						{:else}
							▶ Run
						{/if}
						<kbd class="kbd kbd-xs opacity-70">⌘/Ctrl+↵</kbd>
					</button>
					<button class="btn btn-ghost btn-sm" onclick={clearOutput}>Clear output</button>
				</div>
			</div>
		</div>

		<!-- Output -->
		<section class="mt-6" data-testid="output">
			{#if outputs.length === 0}
				<p class="text-sm text-base-content/40">No output yet. Type some Python and hit Run.</p>
			{:else}
				<div class="space-y-0.5">
					{#each outputs as o}
						{#if o.kind === 'input'}
							<pre class="mt-3 overflow-x-auto whitespace-pre-wrap break-words border-l-2 py-1 pl-3 font-mono text-sm {toneClass.input}"><span class="mr-2 select-none opacity-50">In [·]</span>{o.text}</pre>
						{:else}
							<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{o.text}</pre>
						{/if}
					{/each}
				</div>
			{/if}
		</section>
	</div>
</div>
