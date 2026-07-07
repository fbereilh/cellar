<script>
	import { tick } from 'svelte';
	import Cell from '$lib/Cell.svelte';

	let { data } = $props();

	let cells = $state(data.notebook.cells);
	const workspace = data.notebook.workspace;
	const path = data.notebook.path;

	let kernelState = $state('idle');
	let runningId = $state(null); // single kernel → one cell runs at a time
	const kernelReady = $derived(kernelState === 'idle' || kernelState === 'kernel ready');

	// Each Cell registers a focus fn (by id) so Shift+Enter can advance focus.
	const focusers = {};
	function registerFocus(id, fn) {
		if (fn) focusers[id] = fn;
		else delete focusers[id];
	}

	function findCell(id) {
		return cells.find((c) => c.id === id);
	}

	async function runCell(id, source) {
		const cell = findCell(id);
		if (!cell) return;
		// Markdown "runs" by rendering client-side (in the Cell) — no kernel.
		// Just persist the source.
		if (cell.cell_type === 'markdown') {
			await editCell(id, source);
			return;
		}
		if (runningId) return;
		runningId = id;
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

	async function setType(id, cellType) {
		const cell = findCell(id);
		if (cell) {
			cell.cell_type = cellType;
			if (cellType === 'markdown') cell.outputs = [];
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cell_type: cellType })
		});
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

	async function addCell(afterId, cellType = 'code') {
		const res = await fetch('/api/cells', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ afterId, cellType })
		});
		const { cell } = await res.json();
		const view = { id: cell.id, cell_type: cell.cell_type, source: cell.source, outputs: cell.outputs };
		if (afterId) {
			const i = cells.findIndex((c) => c.id === afterId);
			cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
		} else {
			cells = [...cells, view];
		}
		return view;
	}

	// Shift+Enter: run in place, then move focus to the next cell (creating and
	// focusing a fresh empty cell if this is the last one) — Jupyter behavior.
	async function runAndAdvance(id, source) {
		runCell(id, source); // fire; advancing focus shouldn't wait for completion
		const i = cells.findIndex((c) => c.id === id);
		let nextId = i >= 0 && i < cells.length - 1 ? cells[i + 1].id : null;
		if (!nextId) {
			const created = await addCell(id);
			nextId = created.id;
		}
		await tick(); // let the (possibly new) cell mount + register its focuser
		focusers[nextId]?.();
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
					onRunAdvance={runAndAdvance}
					onClear={clearCell}
					onDelete={deleteCell}
					onMove={moveCell}
					onEdit={editCell}
					onSetType={setType}
					onReady={registerFocus}
				/>
			{/each}
		</div>

		<div class="mt-4 flex justify-center gap-2">
			<button class="btn btn-ghost btn-sm gap-1" onclick={() => addCell(cells.at(-1)?.id, 'code')} data-testid="add-cell">
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Code
			</button>
			<button class="btn btn-ghost btn-sm gap-1" onclick={() => addCell(cells.at(-1)?.id, 'markdown')} data-testid="add-markdown">
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Markdown
			</button>
		</div>

		<p class="mt-6 text-center text-xs text-base-content/30">workspace: {workspace}</p>
	</div>
</div>
