<script>
	let code = $state("print('hello')\n6 * 7");
	let outputs = $state([]); // {kind, text, className}
	let running = $state(false);
	let kernelState = $state('idle');
	let workspace = $state('');

	// Strip ANSI SGR color codes (ESC[m) that Jupyter puts in tracebacks.
	const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
	const stripAnsi = (s) => s.replace(ANSI, '');

	function push(kind, text, className) {
		outputs = [...outputs, { kind, text, className }];
	}

	$effect(() => {
		workspace = new URLSearchParams(location.search).get('ws') || '';
	});

	function handle(ev) {
		switch (ev.type) {
			case 'kernel':
				kernelState = 'kernel ready';
				break;
			case 'status':
				kernelState = ev.execution_state;
				break;
			case 'stream':
				push('stream', ev.text, ev.name === 'stderr' ? 'out-stderr' : 'out-stdout');
				break;
			case 'execute_result':
				push('result', ev.text, 'out-result');
				break;
			case 'display_data':
				push('display', ev.text, 'out-result');
				break;
			case 'error':
				push('error', stripAnsi((ev.traceback || [ev.ename + ': ' + ev.evalue]).join('\n')), 'out-error');
				break;
		}
	}

	async function run() {
		if (running) return;
		running = true;
		push('input', `In [·]: ${code}`, 'out-input');
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
			push('error', 'Request failed: ' + err, 'out-error');
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
</script>

<main>
	<header>
		<h1>🍷 Cellar <span class="tag">spike</span></h1>
		<div class="meta">
			<span>kernel: <b class:idle={kernelState === 'idle' || kernelState === 'kernel ready'}>{kernelState}</b></span>
			{#if workspace}<span>workspace: <code>{workspace}</code></span>{/if}
		</div>
	</header>

	<section class="cell">
		<textarea
			bind:value={code}
			onkeydown={onKeydown}
			spellcheck="false"
			rows="6"
			aria-label="code cell"
		></textarea>
		<div class="controls">
			<button onclick={run} disabled={running} data-testid="run">
				{running ? 'Running…' : '▶ Run'} <span class="hint">(⌘/Ctrl+Enter)</span>
			</button>
			<button class="ghost" onclick={clearOutput}>Clear output</button>
		</div>
	</section>

	<section class="output" data-testid="output">
		{#if outputs.length === 0}
			<p class="empty">No output yet. Type some Python and hit Run.</p>
		{:else}
			{#each outputs as o}
				<pre class={o.className}>{o.text}</pre>
			{/each}
		{/if}
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
		background: #1e1e2e;
		color: #cdd6f4;
	}
	main {
		max-width: 820px;
		margin: 0 auto;
		padding: 24px 16px 64px;
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
		border-bottom: 1px solid #313244;
		padding-bottom: 12px;
		margin-bottom: 20px;
	}
	h1 {
		font-size: 20px;
		margin: 0;
		font-weight: 600;
	}
	.tag {
		font-size: 11px;
		background: #45475a;
		color: #f9e2af;
		padding: 2px 6px;
		border-radius: 4px;
		vertical-align: middle;
	}
	.meta {
		font-size: 12px;
		color: #a6adc8;
		display: flex;
		gap: 16px;
	}
	.meta b {
		color: #f38ba8;
	}
	.meta b.idle {
		color: #a6e3a1;
	}
	.cell {
		background: #181825;
		border: 1px solid #313244;
		border-radius: 8px;
		overflow: hidden;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		border: 0;
		background: #11111b;
		color: #cdd6f4;
		font-family: ui-monospace, "SF Mono", Menlo, monospace;
		font-size: 13.5px;
		line-height: 1.5;
		padding: 12px 14px;
		resize: vertical;
		outline: none;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		background: #181825;
	}
	button {
		background: #89b4fa;
		color: #1e1e2e;
		border: 0;
		border-radius: 6px;
		padding: 7px 14px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	button.ghost {
		background: transparent;
		color: #a6adc8;
		border: 1px solid #45475a;
		font-weight: 500;
	}
	.hint {
		font-weight: 400;
		opacity: 0.7;
		font-size: 11px;
	}
	.output {
		margin-top: 20px;
	}
	.empty {
		color: #6c7086;
		font-size: 13px;
	}
	pre {
		margin: 0;
		padding: 6px 12px;
		font-family: ui-monospace, "SF Mono", Menlo, monospace;
		font-size: 13px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		border-left: 3px solid transparent;
	}
	.out-input {
		color: #74c7ec;
		border-left-color: #45475a;
		margin-top: 10px;
		opacity: 0.85;
	}
	.out-stdout {
		color: #cdd6f4;
	}
	.out-stderr {
		color: #fab387;
	}
	.out-result {
		color: #a6e3a1;
		font-weight: 600;
	}
	.out-error {
		color: #f38ba8;
		background: #2a1820;
		border-left-color: #f38ba8;
		padding: 8px 12px;
	}
</style>
