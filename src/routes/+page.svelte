<script>
	import Cell from '$lib/Cell.svelte';

	let { data } = $props();

	let cells = $state(data.notebook.cells);
	const workspace = data.notebook.workspace;
	const path = data.notebook.path;

	let kernelState = $state('idle');
	let runningId = $state(null); // single kernel → one cell runs at a time
	const kernelReady = $derived(kernelState === 'idle' || kernelState === 'kernel ready');

	function findCell(id) {
		return cells.find((c) => c.id === id);
	}

	async function runCell(id, source) {
		if (runningId) return;
		runningId = id;
		const cell = findCell(id);
		cell.source = source;
		let replace = true; // replace prior output only when new output arrives (no flash)
		try {
			const res = await fetch(`/api/cells/${id}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source })
			});
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
					if (!line) continue;
					const ev = JSON.parse(line);
					if (ev.type === 'kernel') kernelState = 'kernel ready';
					else if (ev.type === 'status') kernelState = ev.execution_state;
					else if (ev.type === 'output') {
						if (replace) {
							cell.outputs = [ev.output];
							replace = false;
						} else {
							cell.outputs = [...cell.outputs, ev.output];
						}
					}
				}
			}
		} catch (err) {
			cell.outputs = [{ output_type: 'error', ename: 'CellarError', evalue: String(err), traceback: [String(err)] }];
			replace = false;
		} finally {
			if (replace) cell.outputs = []; // ran with no output → clear
			runningId = null;
		}
	}

	async function editCell(id, source) {
		const cell = findCell(id);
		if (cell) cell.source = source;
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source })
		});
	}

	async function clearCell(id) {
		const cell = findCell(id);
		if (cell) cell.outputs = [];
		await fetch(`/api/cells/${id}/clear`, { method: 'POST' });
	}

	async function deleteCell(id) {
		cells = cells.filter((c) => c.id !== id);
		await fetch(`/api/cells/${id}`, { method: 'DELETE' });
	}

	async function moveCell(id, dir) {
		const i = cells.findIndex((c) => c.id === id);
		const j = dir === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= cells.length) return;
		const next = [...cells];
		[next[i], next[j]] = [next[j], next[i]];
		cells = next;
		await fetch(`/api/cells/${id}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ dir })
		});
	}

	async function addCell(afterId) {
		const res = await fetch('/api/cells', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ afterId })
		});
		const { cell } = await res.json();
		const view = { id: cell.id, cell_type: cell.cell_type, source: cell.source, outputs: cell.outputs };
		if (afterId) {
			const i = cells.findIndex((c) => c.id === afterId);
			cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
		} else {
			cells = [...cells, view];
		}
	}
</script>

<div class="min-h-screen bg-base-200 text-base-content">
	<div class="mx-auto max-w-3xl px-4 py-8">
		<!-- Header -->
		<header class="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-base-300 pb-4">
			<h1 class="flex items-center gap-2 text-xl font-semibold">
				<span>🍷 Cellar</span>
				<span class="badge badge-warning badge-sm">MVP</span>
			</h1>
			<div class="flex flex-wrap items-center gap-4 text-xs text-base-content/60">
				<span class="flex items-center gap-1.5">
					kernel
					<span class="badge badge-sm gap-1.5 badge-soft {kernelReady ? 'badge-success' : 'badge-error'}">
						<span class="inline-block h-1.5 w-1.5 rounded-full {kernelReady ? 'bg-success' : 'bg-error'}"></span>
						{kernelState}
					</span>
				</span>
				<span class="truncate">notebook <code class="rounded bg-base-300 px-1.5 py-0.5 font-mono">{path}</code></span>
			</div>
		</header>

		<!-- Notebook -->
		<div class="space-y-4">
			{#each cells as cell, i (cell.id)}
				<Cell
					{cell}
					index={i}
					count={cells.length}
					running={runningId === cell.id}
					onRun={runCell}
					onClear={clearCell}
					onDelete={deleteCell}
					onMove={moveCell}
					onEdit={editCell}
				/>
			{/each}
		</div>

		<div class="mt-4 flex justify-center">
			<button class="btn btn-ghost btn-sm gap-1" onclick={() => addCell(cells.at(-1)?.id)} data-testid="add-cell">
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Add cell
			</button>
		</div>

		<p class="mt-6 text-center text-xs text-base-content/30">workspace: {workspace}</p>
	</div>
</div>
