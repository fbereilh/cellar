<script>
	import { onMount, tick } from 'svelte';
	import Navbar from '$lib/Navbar.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	import Notebook from '$lib/Notebook.svelte';
	import FileTab from '$lib/FileTab.svelte';
	import Settings from '$lib/Settings.svelte';

	let { data } = $props();

	// ---- Notebook state (owned here so the sidebar can read the same cells) --
	let cells = $state(data.notebook.cells);
	const workspace = data.notebook.workspace;
	const notebookPath = data.notebook.path;
	const notebookName = notebookPath.split('/').pop();

	let kernelState = $state('idle');
	let runningId = $state(null); // single kernel → one cell runs at a time

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
			// A run may have created/changed kernel variables → refresh sidebar.
			refreshKernel();
			refreshVariables();
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
		await tick();
		focusers[nextId]?.();
	}

	// ---- Shell state ---------------------------------------------------------
	let sidebarOpen = $state(true);
	let settingsOpen = $state(false);
	let theme = $state('dim');

	let tabs = $state([{ id: 'notebook', kind: 'notebook', title: notebookName, closable: false, dirty: false }]);
	let activeTabId = $state('notebook');
	const fileTabs = $derived(tabs.filter((t) => t.kind === 'file'));

	function selectTab(id) {
		activeTabId = id;
	}

	function openFile(path) {
		const id = 'file:' + path;
		if (!tabs.find((t) => t.id === id)) {
			tabs = [...tabs, { id, kind: 'file', title: path.split('/').pop(), path, closable: true, dirty: false }];
		}
		activeTabId = id;
	}

	function closeTab(id) {
		const idx = tabs.findIndex((t) => t.id === id);
		tabs = tabs.filter((t) => t.id !== id);
		if (activeTabId === id) {
			activeTabId = (tabs[idx - 1] ?? tabs[0] ?? { id: 'notebook' }).id;
		}
	}

	function onFileDirty(path, dirty) {
		const id = 'file:' + path;
		tabs = tabs.map((t) => (t.id === id ? { ...t, dirty } : t));
	}

	async function scrollToCell(id) {
		activeTabId = 'notebook';
		await tick();
		const el = document.querySelector(`[data-cell-id="${id}"]`);
		if (!el) return;
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('cellar-flash');
		setTimeout(() => el.classList.remove('cellar-flash'), 1200);
	}

	// ---- Kernel + variables (sidebar) ---------------------------------------
	let kernelInfo = $state({ started: false, id: null, name: 'python3', status: 'not started' });
	let variables = $state([]);
	let varsLoading = $state(false);
	let varsError = $state('');

	const displayKernel = $derived(runningId ? { ...kernelInfo, started: true, status: 'busy' } : kernelInfo);

	async function refreshKernel() {
		try {
			const res = await fetch('/api/kernel');
			if (res.ok) kernelInfo = await res.json();
		} catch {}
	}

	async function refreshVariables() {
		varsLoading = true;
		varsError = '';
		try {
			const res = await fetch('/api/kernel/variables');
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'inspect failed');
			variables = body.variables;
		} catch (err) {
			varsError = String(err?.message ?? err);
		} finally {
			varsLoading = false;
		}
	}

	// ---- Theme ---------------------------------------------------------------
	function applyTheme(t) {
		theme = t;
		if (typeof document !== 'undefined') document.documentElement.dataset.theme = t;
		try {
			localStorage.setItem('cellar-theme', t);
		} catch {}
	}

	onMount(() => {
		const saved = (() => {
			try {
				return localStorage.getItem('cellar-theme');
			} catch {
				return null;
			}
		})();
		applyTheme(saved || document.documentElement.dataset.theme || 'dim');
		// Restore live kernel + variables after a reload — but only inspect if a
		// kernel already exists, so a fresh page load never boots one on its own.
		refreshKernel().then(() => {
			if (kernelInfo.started) refreshVariables();
		});
	});
</script>

<div class="flex h-screen flex-col overflow-hidden bg-base-200 text-base-content">
	<Navbar
		{tabs}
		{activeTabId}
		{sidebarOpen}
		kernelInfo={displayKernel}
		onSelectTab={selectTab}
		onCloseTab={closeTab}
		onToggleSidebar={() => (sidebarOpen = !sidebarOpen)}
		onOpenSettings={() => (settingsOpen = true)}
	/>

	<div class="flex min-h-0 flex-1">
		{#if sidebarOpen}
			<div class="w-64 shrink-0 border-r border-base-300">
				<Sidebar
					{cells}
					kernelInfo={displayKernel}
					{notebookName}
					{variables}
					{varsLoading}
					{varsError}
					onRefreshVars={refreshVariables}
					onRefreshKernel={refreshKernel}
					onOpenFile={openFile}
					onScrollToCell={scrollToCell}
				/>
			</div>
		{/if}

		<main class="min-w-0 flex-1 overflow-hidden">
			<!-- Notebook stays mounted (editor + run state preserved) — just hidden. -->
			<div class="h-full overflow-y-auto {activeTabId === 'notebook' ? '' : 'hidden'}">
				<Notebook
					{cells}
					{runningId}
					onRun={runCell}
					onRunAdvance={runAndAdvance}
					onClear={clearCell}
					onDelete={deleteCell}
					onMove={moveCell}
					onEdit={editCell}
					onSetType={setType}
					onReady={registerFocus}
					onAddCell={addCell}
				/>
			</div>

			{#each fileTabs as tab (tab.id)}
				<div class="h-full {activeTabId === tab.id ? '' : 'hidden'}">
					<FileTab path={tab.path} onDirty={onFileDirty} />
				</div>
			{/each}
		</main>
	</div>

	<footer class="flex items-center justify-between border-t border-base-300 bg-base-100 px-3 py-1 text-[11px] text-base-content/40">
		<span class="truncate">workspace: <span class="font-mono">{workspace}</span></span>
		<span class="font-mono">{cells.length} cells</span>
	</footer>
</div>

<Settings open={settingsOpen} {theme} onClose={() => (settingsOpen = false)} onSetTheme={applyTheme} />

<style>
	:global(.cellar-flash) {
		animation: cellar-flash 1.2s ease-out;
	}
	@keyframes cellar-flash {
		0% {
			box-shadow: 0 0 0 2px var(--color-primary, #7dd3fc);
		}
		100% {
			box-shadow: 0 0 0 2px transparent;
		}
	}
</style>
