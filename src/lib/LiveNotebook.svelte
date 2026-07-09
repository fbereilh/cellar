<script>
	import { onMount, tick, untrack } from 'svelte';
	import Notebook from '$lib/Notebook.svelte';
	import { subscribeEvents, originId } from '$lib/events-client.js';
	import { computeFolding } from '$lib/headings.js';

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
	let activeId = $state(null); // the selected/focused cell (visual emphasis)
	// The cell an AGENT (MCP) is currently running here, or null. Distinct from
	// `runningId` - which is set for every run, including this tab's own and other
	// tabs' user runs - because only an agent run may move the viewport (see
	// "Follow the agent" below). Never used for visuals; the running affordance
	// keys off `runningId` for all runs alike.
	let agentRunningId = $state(null);
	let rootEl = $state(null); // this notebook's DOM subtree; cell ids repeat across notebooks

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
	// ---- Follow the agent ----------------------------------------------------
	// When an agent runs a cell we bring that cell into view, so a human watching
	// can keep up with what is executing. Three rules keep it from being hostile:
	//
	//   1. Agent runs only. `run:start` already carries `actor`; a user's own run
	//      (this tab or another) never moves anyone's viewport.
	//   2. Follow-tail, not fight-the-user: we scroll only when the running cell
	//      isn't already on screen, and never while the user is typing in this
	//      notebook (a viewport jump mid-keystroke is the hostile case).
	//   3. Selection is untouched - `activeId` stays where the user left it. The
	//      running cell is marked by its own (warning-hued) accent in `Cell.svelte`.

	let followedId = null; // last agent-run cell we scrolled to (one scroll per run)
	let lastTypedAt = 0; // last keystroke inside this notebook (see `userIsTyping`)

	// Typing guard. Focus alone is too coarse - a cell keeps editor focus long
	// after the user stopped typing, and following would silently never happen.
	const TYPING_GRACE_MS = 3000;
	function userIsTyping() {
		if (Date.now() - lastTypedAt > TYPING_GRACE_MS) return false;
		const el = document.activeElement;
		return !!(el && rootEl?.contains(el));
	}

	$effect(() => {
		const el = rootEl;
		if (!el) return;
		const onType = () => (lastTypedAt = Date.now());
		el.addEventListener('keydown', onType, true);
		return () => el.removeEventListener('keydown', onType, true);
	});

	// The scrollable ancestor the notebook lives in (the shell gives each notebook
	// tab its own `overflow-y-auto` pane). Falls back to the viewport.
	function scrollParent(el) {
		for (let p = el.parentElement; p; p = p.parentElement) {
			const oy = getComputedStyle(p).overflowY;
			if (oy === 'auto' || oy === 'scroll') return p;
		}
		return null;
	}

	// "Already visible" means the cell's TOP edge is on screen with room to spare:
	// the run affordance (accent bar, spinner) lives at the top, so a tall cell
	// scrolled past its header is not actually showing the user anything.
	function cellIsVisible(el) {
		const parent = scrollParent(el);
		const view = parent ? parent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
		const r = el.getBoundingClientRect();
		return r.top >= view.top - 4 && r.top <= view.bottom - Math.min(r.height, 96);
	}

	function scrollCellIntoView(el) {
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		const behavior = reduce ? 'auto' : 'smooth';
		const parent = scrollParent(el);
		if (!parent) {
			el.scrollIntoView({ behavior, block: 'center' });
			return;
		}
		const view = parent.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const margin = 24;
		// Center a cell that fits; otherwise pin its top near the pane's top so the
		// header + first outputs are what the user sees (centering a tall cell would
		// push its top off screen).
		const delta =
			r.height + margin * 2 <= view.height
				? r.top - view.top - (view.height - r.height) / 2
				: r.top - view.top - margin;
		parent.scrollTo({ top: parent.scrollTop + delta, behavior });
	}

	// Unfold whatever collapsed sections hide `id`, so a cell the agent is running
	// is actually rendered (a `display:none` cell can neither be scrolled to nor
	// show its running accent). Fold state is runtime-only, so this costs the user
	// nothing but a re-fold. Removes exactly the folded headers whose own section
	// contains the cell - nested outer folds included, unrelated folds untouched.
	function revealCell(id) {
		if (!folding.hidden.has(id)) return;
		const next = new Set(foldedIds);
		for (const headerId of foldedIds) {
			if (computeFolding(cells, new Set([headerId])).hidden.has(id)) next.delete(headerId);
		}
		foldedIds = next;
		saveFolds();
	}

	async function followCell(id) {
		if (userIsTyping()) return;
		revealCell(id);
		await tick(); // an `add_and_run` cell (or a just-revealed one) needs its DOM node
		// Scope the lookup to THIS notebook: cell ids are unique per document, not
		// across documents, and every open notebook stays mounted (hidden).
		const el = rootEl?.querySelector(`[data-cell-id="${CSS.escape(id)}"]`);
		if (!el || cellIsVisible(el)) return;
		scrollCellIntoView(el);
	}

	// Follow on agent `run:start`, and also when the user switches to this tab
	// while an agent run is already in flight (a hidden pane has no geometry to
	// scroll). One scroll per run: `followedId` clears when the run ends.
	$effect(() => {
		const id = agentRunningId;
		const visible = active;
		if (!id) {
			followedId = null;
			return;
		}
		if (!visible || id === followedId) return;
		followedId = id;
		// `untrack`: followCell reads (and revealCell writes) fold state - tracking
		// those would re-run this effect on every cell edit, and turn the unfold
		// into a write-what-you-read loop.
		untrack(() => followCell(id));
	});

	// Cell ids awaiting the first streamed chunk of an SSE run — that chunk
	// replaces the prior output (no flash). Tracked per-cell (not one shared flag)
	// so interleaved run:start events for different cells can't consume each other's
	// replace state (MCP runs aren't serialized against UI runs on the wire).
	const sseReplace = new Set();

	function setActive(id) {
		activeId = id;
	}

	// Each Cell registers a focus fn (by id) so Shift+Enter / move can advance focus.
	const focusers = {};
	function registerFocus(id, fn) {
		if (fn) focusers[id] = fn;
		else delete focusers[id];
	}
	function findCell(id) {
		return cells.find((c) => c.id === id);
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
			loadFolds(); // restore this notebook's collapsed sections (runtime-only, per notebook)
			loadEditorCollapsed(); // restore this notebook's collapsed code editors (runtime-only)
			// This refetch is the correctness backstop (reconnect / seq gap): the
			// freshly loaded cells carry authoritative outputs, so drop any stale live
			// run state. Otherwise a lost run:end (tab disconnected while an agent run
			// finished server-side) would leave the spinner stuck and permanently block
			// this tab's own runs via the `busy || runningId` guard in runCell.
			runningId = null;
			agentRunningId = null;
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
			cells = cells.filter((c) => c.id !== ev.cellId);
			if (runningId === ev.cellId) runningId = null;
			if (agentRunningId === ev.cellId) agentRunningId = null;
			if (activeId === ev.cellId) activeId = null;
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
				// Only an agent's run earns the viewport; a user run in another tab
				// must not scroll this one.
				if (ev.actor === 'agent') agentRunningId = ev.cellId;
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
			if (agentRunningId === ev.cellId) agentRunningId = null;
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
	// (MCP) tools default to, and own the move-cell keyboard shortcut.
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
		cells = cells.filter((c) => c.id !== id);
		await fetch(`/api/cells/${id}?nb=${encodeURIComponent(path)}&originId=${encodeURIComponent(originId)}`, { method: 'DELETE' });
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

	// Cmd+Shift+Arrow (Ctrl+Shift+Arrow off mac) moves the focused cell up/down.
	// Capture phase so it wins over CodeMirror's arrow bindings + the browser
	// default. Only registered while this notebook is the active tab.
	const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
	async function onKeydown(e) {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		const primary = isMac ? e.metaKey : e.ctrlKey;
		const other = isMac ? e.ctrlKey : e.metaKey;
		if (!primary || !e.shiftKey || e.altKey || other) return;
		const host = e.target?.closest?.('[data-cell-id]');
		if (!host) return;
		e.preventDefault();
		e.stopPropagation();
		const id = host.dataset.cellId;
		setActive(id);
		moveCell(id, e.key === 'ArrowUp' ? 'up' : 'down');
		// Reordering moves the editor's DOM node and drops focus; restore it so
		// moves chain and the shortcut keeps acting on "the selected cell".
		await tick();
		focusers[id]?.();
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
	<!-- `display:contents` - a layout-neutral handle on this notebook's subtree,
	     used to scope cell lookups (ids repeat across open notebooks) and the
	     typing guard. -->
	<div class="contents" bind:this={rootEl}>
		<Notebook
			{cells}
			{theme}
			runningId={runningId}
			{activeId}
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
			onReady={registerFocus}
			onAddCell={addCell}
		/>
	</div>
{/if}
