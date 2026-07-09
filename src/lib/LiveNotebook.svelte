<script>
	import { onMount, tick } from 'svelte';
	import Notebook from '$lib/Notebook.svelte';
	import { subscribeEvents, originId } from '$lib/events-client.js';
	import { computeFolding, headerLevel } from '$lib/headings.js';
	import { shortcuts, chordFromEvent } from '$lib/shortcuts.svelte.js';

	// A live, kernel-attached notebook document addressed by its workspace path.
	// Owns its own cell array + all cell operations (every request carries
	// `nb: path` so it mutates *this* notebook's file, not the active one). The
	// default workspace notebook and every opened `.ipynb` use this same
	// component — one code path, one behavior. Runs go through the single shared
	// kernel; the parent serializes runs across notebooks via `busy`.
	let { path, active = false, busy = false, theme = 'dim', onCellsChange, onRunStart, onRunEnd } = $props();

	let cells = $state([]);
	let fetching = $state(true); // loading the notebook's cells from the server
	let loadError = $state('');
	let runningId = $state(null); // the cell running in THIS notebook (≤1)
	let activeId = $state(null); // the selected cell (Jupyter's "selection")
	// Jupyter's modal keyboard: 'edit' means the selected cell's editor holds
	// focus and keystrokes are text; 'command' means they are notebook commands.
	// Driven purely by the editor's own focus/blur events, so it can never claim
	// a mode the DOM disagrees with.
	let keyMode = $state('command');
	let root = $state(null); // this notebook's DOM subtree (scopes key handling + scroll lookups)

	// Canonical (absolute) notebook id, learned from the server on load. The shell
	// addresses this component by a workspace-relative `path` (fine for the REST
	// API, which resolves it server-side), but SSE events are tagged with the
	// server's absolute doc key — so we filter on this, the one id both sides
	// agree on. `null` until the first load resolves; events are ignored until then
	// (the load itself is the initial sync).
	let canonicalId = null;
	let lastSeq = null; // last per-notebook `seq` seen (gap detection → refetch)

	// ---- Collapsible headings ------------------------------------------------
	// Fold state = the set of markdown-header cell ids whose section is folded.
	// Kept runtime-only (localStorage keyed by this notebook), never written to
	// the `.ipynb`, so folding a section produces zero git-diff noise. Folded
	// cells stay in `cells` (they run/persist normally); we only hide them from
	// the rendered flow. `computeFolding` decides which cells are hidden and how
	// many each folded header hides, using the shared header-level logic.
	let foldedIds = $state(new Set());
	const folding = $derived(computeFolding(cells, foldedIds));

	function foldStorageKey() {
		return canonicalId ? `cellar-folds:${canonicalId}` : null;
	}
	function loadFolds() {
		const key = foldStorageKey();
		if (!key || typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(key);
			foldedIds = new Set(raw ? JSON.parse(raw) : []);
		} catch {
			foldedIds = new Set();
		}
	}
	function saveFolds() {
		const key = foldStorageKey();
		if (!key || typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(key, JSON.stringify([...foldedIds]));
		} catch {}
	}
	function toggleFold(id) {
		const next = new Set(foldedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		foldedIds = next;
		saveFolds();
		// Command mode always acts on the selected cell, so the selection can never
		// be a cell the user cannot see: a fold that hides it hands it to the header
		// that swallowed it. (`folding` is derived, so it already reflects `next`.)
		if (activeId && folding.hidden.has(activeId)) activeId = id;
	}

	// ---- Collapsible code editors --------------------------------------------
	// Per-cell "collapse the code editor to a fixed scrollable height" choice.
	// Like the fold state above, kept runtime-only (localStorage keyed by this
	// notebook), never written to the `.ipynb` — a pure view preference with zero
	// git-diff (the deliberate contrast with `output_scrolled`, which does
	// round-trip to disk). A cell id maps to an explicit boolean (true = force
	// collapsed, false = force full height); an absent id means auto (the Cell
	// collapses it only when the editor is taller than the cap).
	let editorCollapsed = $state({});

	function editorCollapsedKey() {
		return canonicalId ? `cellar-editor-collapsed:${canonicalId}` : null;
	}
	function loadEditorCollapsed() {
		const key = editorCollapsedKey();
		if (!key || typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(key);
			editorCollapsed = raw ? JSON.parse(raw) : {};
		} catch {
			editorCollapsed = {};
		}
	}
	function saveEditorCollapsed() {
		const key = editorCollapsedKey();
		if (!key || typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(key, JSON.stringify(editorCollapsed));
		} catch {}
	}
	function setEditorCollapsed(id, collapsed) {
		const next = { ...editorCollapsed };
		if (collapsed === null || collapsed === undefined) delete next[id];
		else next[id] = collapsed;
		editorCollapsed = next;
		saveEditorCollapsed();
	}
	// Cell ids awaiting the first streamed chunk of an SSE run — that chunk
	// replaces the prior output (no flash). Tracked per-cell (not one shared flag)
	// so interleaved run:start events for different cells can't consume each other's
	// replace state (MCP runs aren't serialized against UI runs on the wire).
	const sseReplace = new Set();

	function setActive(id) {
		activeId = id;
	}

	// Each Cell registers its imperative API (by id) so the shortcut actions can
	// focus/blur its editor, enter edit mode, and run its *live* editor text.
	const cellApis = {};
	function registerCell(id, api) {
		if (api) cellApis[id] = api;
		else delete cellApis[id];
	}
	function findCell(id) {
		return cells.find((c) => c.id === id);
	}

	// The editor holding focus IS edit mode; losing it drops back to command mode.
	function onEditorFocus(id) {
		activeId = id;
		keyMode = 'edit';
	}
	function onEditorBlur(id) {
		if (activeId === id) keyMode = 'command';
	}

	// Report the live cells array (a reactive proxy) upward so the shell's
	// sidebar (outline / search / variables) reflects this notebook when active.
	// Re-runs when the array reference changes (add/delete/reorder); in-place
	// source/output edits propagate through the shared proxy without re-reporting.
	$effect(() => {
		onCellsChange?.(path, cells);
	});

	async function load() {
		fetching = true;
		try {
			const res = await fetch(`/api/notebooks?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'could not open notebook');
			cells = body.notebook.cells;
			canonicalId = body.notebook.path; // the absolute id SSE events are tagged with
			// A notebook always has a selected cell (command mode acts on it), so
			// j/k and the rest work the moment the notebook opens.
			if (!activeId || !cells.some((c) => c.id === activeId)) activeId = cells[0]?.id ?? null;
			loadFolds(); // restore this notebook's collapsed sections (runtime-only, per notebook)
			loadEditorCollapsed(); // restore this notebook's collapsed code editors (runtime-only)
			// This refetch is the correctness backstop (reconnect / seq gap): the
			// freshly loaded cells carry authoritative outputs, so drop any stale live
			// run state. Otherwise a lost run:end (tab disconnected while an agent run
			// finished server-side) would leave the spinner stuck and permanently block
			// this tab's own runs via the `busy || runningId` guard in runCell.
			runningId = null;
			sseReplace.clear();
			lastSeq = null; // reconnect refetches once here; don't also trip the seq-gap check
		} catch (err) {
			loadError = String(err?.message ?? err);
		} finally {
			fetching = false;
		}
	}
	// Load the authoritative cells from the server on mount. The server holds the
	// live doc across tab close/reopen, so a remounted tab reflects in-session
	// edits (rather than a stale snapshot), and cells are only created once the
	// real source is known — so each Cell's editor seeds with correct content.
	onMount(load);

	// Live server→client sync. Subscribe to the shared per-tab event stream and
	// apply run-lifecycle events that target THIS notebook, so an agent-driven run
	// (or a run from another tab) shows the running indicator + streaming outputs
	// with no reload. Our own UI runs are skipped here (we render them from the
	// `/run` NDJSON response) via the per-tab `originId`, so they never double-apply.
	// Apply a structural document event (agent-driven, or from another tab) as a
	// live patch to `cells`. Insert/remove/reorder/retype in place — cheap and
	// reload-free; the seq-gap backstop refetches if we ever miss one. Each patch
	// is idempotent enough to tolerate an out-of-order or duplicate delivery.
	function applyStructuralEvent(ev) {
		if (ev.type === 'cell:added') {
			if (!ev.cell || findCell(ev.cell.id)) return; // already present → no double-insert
			const view = {
				id: ev.cell.id,
				cell_type: ev.cell.cell_type,
				source: ev.cell.source,
				outputs: ev.cell.outputs ?? [],
				metadata: ev.cell.metadata ?? {}
			};
			const i = ev.afterId ? cells.findIndex((c) => c.id === ev.afterId) : -1;
			if (i >= 0) cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
			else cells = [...cells, view];
		} else if (ev.type === 'cell:deleted') {
			const i = cells.findIndex((c) => c.id === ev.cellId);
			cells = cells.filter((c) => c.id !== ev.cellId);
			if (runningId === ev.cellId) runningId = null;
			if (activeId === ev.cellId) selectAfterRemoval(i);
		} else if (ev.type === 'cell:moved') {
			const from = cells.findIndex((c) => c.id === ev.cellId);
			if (from < 0) return;
			const next = [...cells];
			const [cell] = next.splice(from, 1);
			const to = Math.max(0, Math.min(ev.toIndex, next.length));
			next.splice(to, 0, cell);
			cells = next;
		} else if (ev.type === 'cell:type') {
			const cell = findCell(ev.cellId);
			if (cell) {
				cell.cell_type = ev.cell_type;
				if (ev.cell_type === 'markdown') cell.outputs = [];
			}
		} else if (ev.type === 'cell:cleared') {
			const cell = findCell(ev.cellId);
			if (cell) cell.outputs = [];
		} else if (ev.type === 'cell:edited') {
			// Don't blindly overwrite the editor: hand the new source to the Cell,
			// which applies it only when the user isn't actively editing that cell
			// (else it surfaces a "changed on server" affordance). A fresh object
			// each time so the Cell's effect fires even on a same-source re-edit.
			const cell = findCell(ev.cellId);
			if (cell) cell.remoteEdit = { source: ev.source };
		}
	}

	function applyRunEvent(ev) {
		const cell = ev.cellId && findCell(ev.cellId);
		if (ev.type === 'run:start') {
			if (cell) {
				runningId = ev.cellId;
				sseReplace.add(ev.cellId); // first streamed chunk replaces the prior output (no flash)
			}
		} else if (ev.type === 'run:output') {
			if (cell) {
				if (sseReplace.has(ev.cellId)) {
					cell.outputs = [ev.output];
					sseReplace.delete(ev.cellId);
				} else {
					cell.outputs = [...cell.outputs, ev.output];
				}
			}
		} else if (ev.type === 'run:end') {
			if (cell && sseReplace.delete(ev.cellId)) cell.outputs = []; // ran with no output → clear stale
			stampLastRun(cell, ev); // update the run-metadata badge (agent / other-tab runs)
			if (runningId === ev.cellId) runningId = null;
		}
	}

	// Store runtime-only run metadata on a cell so `Cell.svelte` renders its badge.
	// Reassigns `metadata` (not a deep mutation) to trigger reactivity even when
	// the cell had no `cellar` namespace yet. Ignores events without `at` (older
	// run:end shapes / non-run events).
	function stampLastRun(cell, ev) {
		if (!cell || ev.at == null) return;
		const cellar = { ...(cell.metadata?.cellar ?? {}), lastRun: { at: ev.at, durationMs: ev.durationMs, actor: ev.actor } };
		cell.metadata = { ...(cell.metadata ?? {}), cellar };
	}
	onMount(() =>
		subscribeEvents((ev) => {
			// (Re)connect → refetch as the correctness backstop (covers events missed
			// while disconnected). `canonicalId` gates until the first load resolves.
			if (ev.type === 'sse:open') {
				if (canonicalId) load();
				return;
			}
			if (ev.type === 'hello') return;
			if (!canonicalId || ev.nb !== canonicalId) return;
			// A gap in this notebook's monotonic seq means we missed events → refetch.
			if (lastSeq !== null && ev.seq > lastSeq + 1) load();
			lastSeq = ev.seq; // advance even for our own echo, so it isn't seen as a gap
			if (ev.originId && ev.originId === originId) return; // our own UI action
			if (ev.type?.startsWith('cell:')) applyStructuralEvent(ev);
			else applyRunEvent(ev);
		})
	);

	// When this notebook is focused, make it the active notebook the agent-facing
	// (MCP) tools default to, and own the modal keyboard.
	$effect(() => {
		if (!active) return;
		fetch('/api/notebooks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path })
		}).catch(() => {});
		window.addEventListener('keydown', onKeydown, true);
		return () => window.removeEventListener('keydown', onKeydown, true);
	});

	// Command-mode keys only fire for keystrokes aimed at this notebook, so a
	// freshly activated notebook tab must take the keyboard: otherwise focus is
	// still on whatever opened it (a file-tree button) and `j`/`k` do nothing
	// until the user clicks a cell. Never steals focus from an editor in use.
	$effect(() => {
		if (!active || fetching || !root) return;
		if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
	});

	async function runCell(id, source) {
		const cell = findCell(id);
		if (!cell) return;
		// Markdown "runs" by rendering client-side (in the Cell) — no kernel.
		if (cell.cell_type === 'markdown') {
			await editCell(id, source);
			return;
		}
		// Single shared kernel → one cell runs at a time, app-wide. `runningId` is
		// set synchronously below so a rapid double run can't slip through before
		// `busy` (an async-propagated prop) reflects this notebook's own run.
		if (busy || runningId) return;
		runningId = id;
		onRunStart?.(path, id);
		cell.source = source;
		let replace = true; // replace prior output only when new output arrives (no flash)
		try {
			const res = await fetch(`/api/cells/${id}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source, nb: path, originId })
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
					if (ev.type === 'output') {
						if (replace) {
							cell.outputs = [ev.output];
							replace = false;
						} else {
							cell.outputs = [...cell.outputs, ev.output];
						}
					} else if (ev.type === 'run:end') {
						stampLastRun(cell, ev); // this tab's own user run → its badge
					}
				}
			}
		} catch (err) {
			cell.outputs = [{ output_type: 'error', ename: 'CellarError', evalue: String(err), traceback: [String(err)] }];
			replace = false;
		} finally {
			if (replace) cell.outputs = []; // ran with no output → clear
			if (runningId === id) runningId = null; // don't clear a spinner an overlapping run moved elsewhere
			onRunEnd?.();
		}
	}

	async function editCell(id, source, { keepalive = false } = {}) {
		const cell = findCell(id);
		if (cell) cell.source = source;
		// Only the page-unload flush opts into `keepalive`: the browser caps the
		// combined keepalive body at ~64KB and rejects past it, so normal
		// (page-alive) autosaves stay plain fetch. `.catch` keeps a rejected PATCH
		// from surfacing as an unhandled rejection either way.
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source, nb: path, originId }),
			keepalive
		}).catch(() => {});
	}

	async function clearCell(id) {
		const cell = findCell(id);
		if (cell) cell.outputs = [];
		await fetch(`/api/cells/${id}/clear?nb=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}`, { method: 'POST' });
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
			body: JSON.stringify({ cell_type: cellType, nb: path, originId })
		});
	}

	async function deleteCell(id) {
		const i = cells.findIndex((c) => c.id === id);
		cells = cells.filter((c) => c.id !== id);
		// Keep a cell selected: command mode acts on the selection, so deleting the
		// selected cell must hand the selection to its neighbor, not drop it. Focus
		// follows, because the delete button that had it is gone with the cell.
		if (activeId === id) selectAfterRemoval(i, { focus: true });
		await fetch(`/api/cells/${id}?nb=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}`, { method: 'DELETE' });
	}

	/**
	 * After removing the cell at `index`, select whatever slid into its place.
	 * Only a local delete takes focus with it: an agent (or other-tab) delete must
	 * not yank the caret out of a cell this user is typing in.
	 */
	function selectAfterRemoval(index, { focus = false } = {}) {
		const id = cells[Math.min(Math.max(index, 0), cells.length - 1)]?.id ?? null;
		activeId = id;
		if (focus && id) selectAndFocus(id);
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
			body: JSON.stringify({ dir, nb: path, originId })
		});
	}

	// Drag-to-reorder: move a cell to an absolute index. Reuses the server's
	// `moveCellTo` (via the move route's `toIndex`) so a drag persists exactly
	// like a keyboard/toolbar move and stays git-clean on save.
	async function moveCellToIndex(id, toIndex) {
		const from = cells.findIndex((c) => c.id === id);
		if (from < 0) return;
		let to = Math.max(0, Math.min(toIndex, cells.length - 1));
		if (to === from) return;
		const next = [...cells];
		const [cell] = next.splice(from, 1);
		next.splice(to, 0, cell);
		cells = next;
		await fetch(`/api/cells/${id}/move`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ toIndex: cells.findIndex((c) => c.id === id), nb: path, originId })
		});
	}

	// Persist a cell's "scroll outputs" choice (undefined = auto height, true =
	// force scrolled, false = force full) in the `cellar` metadata namespace.
	async function setScrolled(id, scrolled) {
		const cell = findCell(id);
		if (cell) {
			cell.metadata = cell.metadata ?? {};
			cell.metadata.cellar = cell.metadata.cellar ?? {};
			if (scrolled === null || scrolled === undefined) delete cell.metadata.cellar.output_scrolled;
			else cell.metadata.cellar.output_scrolled = scrolled;
		}
		await fetch(`/api/cells/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scrolled: scrolled ?? null, nb: path })
		});
	}

	async function addCell(afterId, cellType = 'code') {
		const res = await fetch('/api/cells', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ afterId, cellType, nb: path, originId })
		});
		const { cell } = await res.json();
		const view = { id: cell.id, cell_type: cell.cell_type, source: cell.source, outputs: cell.outputs, metadata: cell.metadata ?? {} };
		if (afterId) {
			const i = cells.findIndex((c) => c.id === afterId);
			cells = [...cells.slice(0, i + 1), view, ...cells.slice(i + 1)];
		} else {
			cells = [...cells, view];
		}
		return view;
	}

	// Shift+Enter: run in place, then advance, identically for code and markdown
	// (a markdown cell "runs" by rendering, and `Cell.doRun` has already switched it
	// to its rendered view by the time we get here). From edit mode we focus the
	// next cell's editor (keep typing); from command mode we move the selection and
	// its focus. Either way focus lands on the next cell, never back in the cell
	// that just ran. Creates a fresh cell when run on the last one.
	async function runAndAdvance(id, source, { focusNext = true } = {}) {
		runCell(id, source); // fire; advancing shouldn't wait for completion
		const i = cells.findIndex((c) => c.id === id);
		let nextId = i >= 0 && i < cells.length - 1 ? cells[i + 1].id : null;
		if (!nextId) {
			const created = await addCell(id);
			nextId = created.id;
		}
		if (!focusNext) {
			await selectAndFocus(nextId);
			return;
		}
		setActive(nextId);
		await tick();
		// `focus()` lands on the next cell's editor, or on the cell itself when that
		// cell is rendered markdown (whose editor is display:none and unfocusable).
		cellApis[nextId]?.focus();
		scrollCellIntoView(nextId);
	}

	// ---- Modal keyboard ------------------------------------------------------
	// Every notebook shortcut lives in the registry (`shortcuts.svelte.js`) and is
	// dispatched here, in one capture-phase handler, so it wins over CodeMirror's
	// own keymap and the browser default. Registered only while this notebook is
	// the active tab. The action map below is the other half of the registry: an
	// entry with no action is inert, and an action with no entry is unreachable.

	// Cells the user can actually select: the ones a folded heading isn't hiding.
	const selectable = $derived(cells.filter((c) => !folding.hidden.has(c.id)));

	function scrollCellIntoView(id) {
		// Scope to this notebook: several notebooks stay mounted (hidden), and a
		// cell id is only unique *within* a document.
		const el = root?.querySelector(`[data-cell-id="${CSS.escape(id)}"]`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	/**
	 * Select `id` and give it DOM focus (command mode). The dispatcher decides both
	 * a keystroke's mode and its target from the focused element, so a selection the
	 * focus doesn't follow is a selection the next keystroke doesn't act on: the
	 * next key would instead reach whatever button or rendered cell the user last
	 * clicked. Awaits `tick()` so a just-created cell has registered its API.
	 */
	async function selectAndFocus(id) {
		if (!id) return;
		setActive(id);
		await tick();
		cellApis[id]?.focusCell();
		scrollCellIntoView(id);
	}

	function selectRelative(delta) {
		const list = selectable;
		if (!list.length) return;
		const i = list.findIndex((c) => c.id === activeId);
		const next = list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta))];
		selectAndFocus(next.id);
	}

	// Fold/unfold act on the selected cell only when it is a markdown header, and
	// reuse the same `toggleFold` the chevron button calls (one fold API).
	function setFolded(id, folded) {
		if (!id || headerLevel(findCell(id)) == null) return;
		if (foldedIds.has(id) !== folded) toggleFold(id);
	}

	async function insertCell(where) {
		const i = cells.findIndex((c) => c.id === activeId);
		if (where === 'below' || i < 0) {
			const created = await addCell(activeId ?? cells.at(-1)?.id);
			await selectAndFocus(created.id);
			return;
		}
		if (i > 0) {
			const created = await addCell(cells[i - 1].id);
			await selectAndFocus(created.id);
			return;
		}
		// Above the first cell: the API can only insert *after* an id, so append
		// and move it to the top (one extra persist, same clean-on-save result).
		const created = await addCell(cells.at(-1)?.id);
		await moveCellToIndex(created.id, 0);
		await selectAndFocus(created.id);
	}

	// Reordering moves the cell's DOM node and drops focus; restore it onto the
	// editor (edit mode) or onto the cell (command mode), so moves chain.
	async function moveActive(dir, mode) {
		const id = activeId;
		if (!id) return;
		moveCell(id, dir);
		await tick();
		if (mode === 'edit') cellApis[id]?.focus();
		else await selectAndFocus(id);
	}

	/** shortcut id → what it does. `mode` is the mode the keystroke fired in. */
	const actions = {
		'command-mode': () => cellApis[activeId]?.blur(),
		'edit-mode': () => cellApis[activeId]?.enterEdit(),
		'run-cell': () => cellApis[activeId]?.run(false),
		'run-advance': (mode) => cellApis[activeId]?.run(true, { focusNext: mode === 'edit' }),
		'select-prev': () => selectRelative(-1),
		'select-next': () => selectRelative(1),
		'fold-section': () => setFolded(activeId, true),
		'unfold-section': () => setFolded(activeId, false),
		'move-cell-up': (mode) => moveActive('up', mode),
		'move-cell-down': (mode) => moveActive('down', mode),
		'insert-above': () => insertCell('above'),
		'insert-below': () => insertCell('below'),
		'to-markdown': () => activeId && setType(activeId, 'markdown'),
		'to-code': () => activeId && setType(activeId, 'code')
	};

	function onKeydown(e) {
		// A modal (settings, delete-confirm) owns the keyboard while it is open.
		if (document.querySelector('.modal-open')) return;
		const chord = chordFromEvent(e);
		if (!chord) return;

		const t = e.target;
		// CodeMirror's own panels (the search/replace bar) are its keyboard, not
		// ours: they live inside `.cm-editor`, so the `inEditor` test alone would
		// hand their Enter and Mod-Enter to the notebook.
		if (t?.closest?.('.cm-panel')) return;
		const inEditor = !!t?.closest?.('.cm-editor');
		// The keystroke's mode is read off the DOM, not off `keyMode`: whatever has
		// focus decides. That is what guarantees a command-mode letter (`j`, `a`)
		// can never fire while the user is typing in an editor.
		if (!inEditor && t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
		// Only keystrokes aimed at this notebook (or at no element at all, which is
		// where focus lands after Escape) are ours; the sidebar keeps its own keys.
		if (!(t === document.body || root?.contains(t))) return;
		const mode = inEditor ? 'edit' : 'command';
		// Let a focused control keep its native activation keys.
		if (mode === 'command' && (chord === 'Enter' || chord === 'Space') && t?.closest?.('button, a, [role="button"]')) return;
		// Escape belongs to CodeMirror while CodeMirror has something to close (its
		// completion tooltip, its search panel). That is Jupyter's behavior, and
		// preempting it would strand the tooltip on screen. Only once the editor has
		// nothing of its own open does Escape leave for command mode. Keyed off the
		// *focused* cell rather than `activeId`, which is the same cell in edit mode
		// but need not be if a focus event is still in flight.
		if (mode === 'edit' && chord === 'Escape') {
			const focusedId = t.closest('[data-cell-id]')?.dataset.cellId;
			if (cellApis[focusedId]?.editorOverlayOpen?.()) return;
		}

		const shortcut = shortcuts.lookup(mode, chord);
		const action = shortcut && actions[shortcut.id];
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		action(mode);
	}
</script>

{#if loadError}
	<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6">
		<div class="p-4 text-sm text-error" data-testid="notebook-load-error">
			Could not open <code class="font-mono">{path}</code>: {loadError}
		</div>
	</div>
{:else if fetching}
	<div class="mx-auto w-full max-w-[clamp(48rem,92%,88rem)] px-4 py-6">
		<p class="px-2 text-sm text-base-content/40">loading…</p>
	</div>
{:else}
	<!-- `root` scopes the modal-keyboard handler and cell scroll lookups to THIS
	     notebook: several notebooks stay mounted (hidden) and a cell id is only
	     unique within one document. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div bind:this={root} tabindex="-1" class="outline-none" data-testid="notebook-root">
		<Notebook
			{cells}
			{theme}
			{activeId}
			{keyMode}
			runningId={runningId}
			hidden={folding.hidden}
			foldedIds={foldedIds}
			hiddenCounts={folding.counts}
			onToggleFold={toggleFold}
			onRun={runCell}
			onRunAdvance={runAndAdvance}
			onClear={clearCell}
			onDelete={deleteCell}
			onMove={moveCell}
			onMoveToIndex={moveCellToIndex}
			onEdit={editCell}
			onSetType={setType}
			onSetScrolled={setScrolled}
			editorCollapsed={editorCollapsed}
			onSetEditorCollapsed={setEditorCollapsed}
			onActivate={setActive}
			onRegister={registerCell}
			onEditorFocus={onEditorFocus}
			onEditorBlur={onEditorBlur}
			onAddCell={addCell}
		/>
	</div>
{/if}
