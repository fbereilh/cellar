<script>
	import { onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { EditorView } from '@codemirror/view';
	import { EditorState, Compartment } from '@codemirror/state';
	import { completionStatus } from '@codemirror/autocomplete';
	import { searchPanelOpen } from '@codemirror/search';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import MarkdownIt from 'markdown-it';
	import DOMPurify from 'dompurify';
	import { EDITOR_THEME } from '$lib/editorTheme.js';
	import { foldKey, splitHeadingSegments } from '$lib/headings.js';
	import { relativeTime, formatDuration } from '$lib/relativeTime.js';

	const NO_SEGS_HIDDEN = { headings: new Set(), bodies: new Set() };

	let {
		cell,
		index,
		count,
		running,
		queuedPosition = null, // 1-based place in the kernel's run queue, or null
		active = false,
		keyMode = 'command', // notebook mode ('command' | 'edit'); only meaningful while `active`
		dragging = false,
		foldedIds = new Set(), // fold keys of every collapsed heading in the notebook
		segHidden = NO_SEGS_HIDDEN, // segment indices of THIS cell an outer fold hides
		foldCounts = {}, // fold key → whole cells that fold hides (the "N cells hidden" hint)
		onToggleFold,
		onRun,
		onRunAdvance,
		onClear,
		onDelete,
		onMove,
		onEdit,
		onSetType,
		onSetScrolled,
		editorCollapsed, // per-cell code-editor collapse choice (undefined = auto / true / false)
		onSetEditorCollapsed,
		onActivate,
		onRegister, // (id, api|null): hands the notebook this cell's imperative API
		onEditorFocus,
		onEditorBlur,
		onDragStart,
		onDragEnd
	} = $props();

	let cardEl; // the cell's outer card: what holds focus in command mode
	let editorEl;
	let view;
	let editorResizeObserver;
	let editTimer;
	// True while the user has uncommitted local typing (a debounced save pending).
	// Together with editor focus this gates whether a remote source edit may
	// overwrite the editor (the editor-safety rule).
	let editPending = false;
	// True only while WE programmatically replace the doc (applying a remote
	// edit); the update listener checks it so a remote apply is never echoed back
	// to the server as a local edit.
	let applyingRemote = false;
	// Last source already handed to `onEdit`. Lets us flush a pending debounced
	// edit immediately on blur / page unload, so an edit is never lost in the
	// sub-debounce window when the tab or the whole app closes.
	let savedSource = cell.source;

	/**
	 * Persist any pending edit right now, cancelling the debounce. Called on
	 * editor blur (focus leaves the cell) and on page unload (`pagehide`), so a
	 * cell edit is saved without requiring a run and survives closing Cellar.
	 * `keepalive` is only set from the unload path (the browser caps a keepalive
	 * request body at ~64KB, so normal page-alive saves must not use it).
	 */
	function flushEdit({ keepalive = false } = {}) {
		clearTimeout(editTimer);
		if (view && liveSource !== savedSource) {
			savedSource = liveSource;
			editPending = false;
			onEdit(cell.id, liveSource, { keepalive });
		}
	}

	const isMarkdown = $derived(cell.cell_type === 'markdown');

	// A remote (agent / other-tab) source edit that arrived while the user was
	// editing this cell, held until they choose to load it (the affordance below).
	let remoteChanged = $state(false);
	let pendingRemoteSource = null;
	let appliedRemote = null; // the last cell.remoteEdit object we processed

	// Markdown cells render to HTML by default; double-click / edit → raw source.
	let mode = $state(cell.cell_type === 'markdown' && cell.source.trim() ? 'rendered' : 'edit');
	let liveSource = $state(cell.source);

	// markdown-it in safe mode (html:false escapes raw HTML) + DOMPurify (client
	// only) so notebook content can't inject script.
	const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
	function renderMarkdown(src) {
		return DOMPurify.sanitize(md.render(src || ''));
	}
	// A markdown cell renders one block per heading segment rather than one blob,
	// because each heading is independently foldable (a cell may hold several) and
	// a fold hides the heading's body while leaving the heading itself in view.
	const hasMarkdown = $derived(isMarkdown && liveSource.trim().length > 0);
	const segments = $derived(
		isMarkdown && browser
			? splitHeadingSegments(liveSource).map((s) => ({
					...s,
					key: foldKey(cell.id, s.index),
					headingHtml: s.level != null ? renderMarkdown(s.heading) : '',
					bodyHtml: s.body.trim() ? renderMarkdown(s.body) : ''
				}))
			: []
	);

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

	// Queued = submitted, waiting for the shared kernel to free. Deliberately a
	// *quieter* sibling of the running affordance (same `warning` hue, no pulse,
	// no spinner): the eye should still land on the one cell that is executing.
	// A run that starts before its queue event lands would otherwise show both.
	const isQueued = $derived(queuedPosition != null && !running);

	// ---- Per-cell run metadata badge ("ran 2m ago · 1.2s · agent") ----------
	// Runtime-only `{ at, durationMs, actor }` stamped by both run paths, stripped
	// from disk by clean.js. `now` ticks so the relative time stays fresh.
	const lastRun = $derived(cell.metadata?.cellar?.lastRun);
	let now = $state(Date.now());
	$effect(() => {
		if (!lastRun) return;
		const t = setInterval(() => (now = Date.now()), 15000);
		return () => clearInterval(t);
	});
	const ranText = $derived(lastRun ? `ran ${relativeTime(lastRun.at, now)} · ${formatDuration(lastRun.durationMs)}` : '');
	const isAgentRun = $derived(lastRun?.actor === 'agent');

	// Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks.
	const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
	const stripAnsi = (s) => s.replace(ANSI, '');
	const asText = (s) => (Array.isArray(s) ? s.join('') : (s ?? ''));

	// Build a data: URL for an nbformat image bundle. Raster mimes (png/jpeg/gif)
	// carry base64 text; image/svg+xml carries raw XML, so it is URI-encoded.
	function imageDataUrl(mime, payload) {
		const data = asText(payload);
		if (mime === 'image/svg+xml') return `data:image/svg+xml;utf8,${encodeURIComponent(data)}`;
		return `data:${mime};base64,${data.replace(/\s+/g, '')}`;
	}

	// A markdown-table separator row: pipes, dashes, colons, spaces, ≥1 dash.
	const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
	const isTableRow = (l) => l.includes('|') && l.trim() !== '';
	// Split plain text into segments: contiguous markdown tables (header row +
	// separator row + body rows) become {type:'table'}; everything else stays
	// {type:'text'}. A table needs a header line immediately followed by a
	// separator line, so ordinary pipe-containing text is left untouched.
	function textSegments(text) {
		const lines = text.split('\n');
		const segs = [];
		let buf = [];
		const flush = () => {
			if (buf.length) segs.push({ type: 'text', text: buf.join('\n') });
			buf = [];
		};
		for (let i = 0; i < lines.length; i++) {
			if (isTableRow(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')) {
				let j = i + 2;
				while (j < lines.length && isTableRow(lines[j])) j++;
				flush();
				segs.push({ type: 'table', html: renderTable(lines.slice(i, j).join('\n')) });
				i = j - 1;
			} else {
				buf.push(lines[i]);
			}
		}
		flush();
		return segs;
	}
	// Render a markdown table to sanitized HTML, then apply daisyUI table classes.
	function renderTable(src) {
		if (!browser) return '';
		const html = DOMPurify.sanitize(md.render(src));
		return html.replace(/<table>/g, '<table class="table table-zebra table-xs">');
	}

	// Map an nbformat output object to a renderable {tone, text, segments}. Text
	// outputs (stdout / stderr / result) carry parsed segments so embedded
	// markdown tables render as real tables; errors stay raw monospace.
	function renderOutput(o) {
		let tone, text;
		switch (o.output_type) {
			case 'stream':
				tone = o.name === 'stderr' ? 'stderr' : 'stdout';
				text = asText(o.text);
				break;
			case 'execute_result':
			case 'display_data': {
				const d = o.data || {};
				// Prefer a rich image over the text/plain repr: a matplotlib figure
				// emits BOTH an image/png and its `<Figure … with N Axes>` text repr,
				// and (like Jupyter) we show the image, not the placeholder text.
				const imgMime = Object.keys(d).find((k) => k.startsWith('image/'));
				if (imgMime) {
					return { tone: 'result', image: imageDataUrl(imgMime, d[imgMime]), segments: null };
				}
				if (d['text/plain']) {
					tone = 'result';
					text = asText(d['text/plain']);
				} else {
					return { tone: 'result', text: '[rich output]', segments: null };
				}
				break;
			}
			case 'error':
				return { tone: 'error', text: stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n')), segments: null };
			default:
				return { tone: 'stdout', text: '', segments: null };
		}
		const segments = textSegments(text);
		// Only keep segment rendering when a table was actually found; otherwise a
		// single plain-text segment renders identically to the old monospace pre.
		return { tone, text, segments: segments.some((s) => s.type === 'table') ? segments : null };
	}
	const outputs = $derived((cell.outputs || []).map(renderOutput));

	// ---- Scrollable / contracted outputs ------------------------------------
	// Per-cell choice persisted in `cell.metadata.cellar.output_scrolled`
	// (undefined = auto, true = force scrolled, false = force full). Above a
	// height threshold we auto-scroll unless the user set an explicit choice.
	const SCROLL_THRESHOLD = 360; // px of output beyond which we contract by default
	let outputInner = $state(null);
	let outputTall = $state(false);
	const explicitScrolled = $derived(cell.metadata?.cellar?.output_scrolled);
	const scrolled = $derived(explicitScrolled ?? outputTall);
	$effect(() => {
		cell.outputs; // re-measure whenever outputs change
		if (outputInner) outputTall = outputInner.scrollHeight > SCROLL_THRESHOLD;
	});
	function toggleScrolled() {
		onSetScrolled?.(cell.id, !scrolled);
	}

	// ---- Collapsible / scrollable code editor -------------------------------
	// Mirrors the scrollable-outputs UX: a tall code editor can be contracted to
	// a fixed-height scroll box instead of growing the cell. The per-cell choice
	// is a tri-state (undefined = auto, true = force collapsed, false = force
	// full) persisted runtime-only by LiveNotebook (localStorage, git-clean) via
	// `onSetEditorCollapsed` — never written to the `.ipynb`, the deliberate
	// contrast with `output_scrolled`. Above the cap we auto-collapse unless the
	// user set an explicit choice.
	const EDITOR_MAX_PX = 576; // px (= max-h-[36rem]); 50% taller than the former 384 cap
	let editorTall = $state(false);
	const collapsed = $derived(!isMarkdown && (editorCollapsed ?? editorTall));
	// Only surface the toggle once there's something to collapse (a tall editor)
	// or an explicit choice already exists — short cells stay uncluttered.
	const canCollapse = $derived(!isMarkdown && (editorTall || editorCollapsed != null));
	// scrollHeight is the full content height regardless of the max-height clamp,
	// so this reads true whether or not the box is currently contracted.
	function measureEditor() {
		if (editorEl) editorTall = editorEl.scrollHeight > EDITOR_MAX_PX;
	}
	function toggleEditorCollapsed() {
		onSetEditorCollapsed?.(cell.id, !collapsed);
	}

	// ---- Modal selection emphasis --------------------------------------------
	// Jupyter's convention: the selected cell carries a colored gutter bar whose
	// hue says which mode you are in. Mapped onto the app's semantic palette
	// rather than hardcoded hues, so any theme stays coherent: `info` for command,
	// `success` for edit. (Both are distinct from `error` in every shipped theme.)
	const editing = $derived(active && keyMode === 'edit');
	const shellClass = $derived(
		!active
			? 'border-base-300'
			: editing
				? 'border-success ring-1 ring-success/50'
				: 'border-info ring-1 ring-info/60'
	);

	const toneClass = {
		stdout: 'text-base-content border-transparent',
		stderr: 'text-warning border-warning/40',
		result: 'text-success font-semibold border-success/40',
		error: 'text-error border-error bg-error/10'
	};

	function currentSource() {
		return view ? view.state.doc.toString() : cell.source;
	}

	// Replace the editor's whole document with `src` without echoing it back to
	// the server as a local edit (the update listener honors `applyingRemote`).
	function applySourceToEditor(src) {
		if (!view) return;
		applyingRemote = true;
		try {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } });
		} finally {
			applyingRemote = false;
		}
		liveSource = src;
		cell.source = src;
		// A remote apply IS already the server's source, so treat it as saved: this
		// keeps flushEdit (blur / unload) from re-PATCHing the identical content back
		// as a spurious local edit (and echoing a needless cell:edited to other tabs).
		savedSource = src;
	}

	// The editor-safety rule (report §3.4): a remote source edit updates the
	// editor in place ONLY when the user isn't actively editing this cell
	// (unfocused and no pending local change). Otherwise we stash it and surface a
	// subtle "changed on server" affordance so the user's typing is never clobbered.
	$effect(() => {
		const re = cell.remoteEdit;
		if (!re || re === appliedRemote) return;
		appliedRemote = re;
		const editing = (view && view.hasFocus) || editPending;
		if (view && !editing) {
			applySourceToEditor(re.source);
			remoteChanged = false;
			pendingRemoteSource = null;
			if (isMarkdown && mode === 'rendered') liveSource = re.source; // refresh the rendered view
		} else {
			pendingRemoteSource = re.source;
			remoteChanged = true;
		}
	});

	/**
	 * Replace the editor's text with a deliberate *local* rewrite (a heading
	 * toggle, the upper half of a split). Cancels any pending debounce, because
	 * the caller persists the new source itself, and reuses the remote-apply path
	 * so the update listener doesn't echo the same text back as a second save.
	 */
	function replaceSource(src) {
		clearTimeout(editTimer);
		editPending = false;
		applySourceToEditor(src);
	}

	function loadRemote() {
		if (pendingRemoteSource != null && pendingRemoteSource !== currentSource()) {
			applySourceToEditor(pendingRemoteSource);
		}
		remoteChanged = false;
		pendingRemoteSource = null;
	}

	// Run/render. For markdown this just renders (parent persists source, no
	// kernel); for code the parent runs it on the kernel. `focusNext` lets a
	// command-mode Shift+Enter advance the *selection* without dropping into the
	// next cell's editor, while an edit-mode one keeps typing there (Jupyter).
	function doRun(advance, { focusNext = true } = {}) {
		const src = currentSource();
		liveSource = src;
		savedSource = src;
		if (isMarkdown) mode = 'rendered';
		if (advance) onRunAdvance(cell.id, src, { focusNext });
		else onRun(cell.id, src);
	}

	async function enterEdit() {
		mode = 'edit';
		await tick();
		view?.focus();
	}

	/**
	 * Put DOM focus on the cell itself (command mode). Jupyter keeps focus on the
	 * selected cell, and so must we: the notebook's dispatcher reads a keystroke's
	 * mode (and its target) off the focused element, so a selection the focus
	 * doesn't follow means the next key acts on whatever the user last clicked.
	 */
	function focusCell() {
		cardEl?.focus({ preventScroll: true });
	}

	/**
	 * Focus for "advance to this cell": its editor, unless it is a markdown cell
	 * showing rendered HTML: that editor is `display:none` and cannot take focus,
	 * so the cell itself does (which is command mode, as Jupyter does it).
	 */
	function focusEditorOrCell() {
		if (isMarkdown && mode === 'rendered') focusCell();
		else view?.focus();
	}

	/**
	 * True while CodeMirror has an overlay of its own open: the completion tooltip
	 * or the search panel. Escape belongs to whichever of those is showing (Jupyter
	 * parity: Escape only drops you back to command mode once the editor has
	 * nothing of its own left to close).
	 */
	function editorOverlayOpen() {
		if (!view) return false;
		return completionStatus(view.state) != null || searchPanelOpen(view.state);
	}

	const language = new Compartment();
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

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: cell.source,
				extensions: [
					basicSetup,
					language.of(langFor(cell.cell_type)),
					EDITOR_THEME,
					// No run/escape keymap here on purpose: every notebook shortcut,
					// edit-mode ones included, is declared in `shortcuts.svelte.js` and
					// dispatched by LiveNotebook's capture-phase handler (which runs
					// before CodeMirror sees the key). One source of truth.
					EditorView.updateListener.of((v) => {
						if (!v.docChanged) return;
						liveSource = v.state.doc.toString();
						if (applyingRemote) return; // programmatic remote apply → don't save/echo
						// A genuine local edit supersedes any stashed remote snapshot: drop
						// it (and the banner) once the buffer diverges, so Load can never
						// clobber newer local content with a now-stale remote source.
						if (remoteChanged && liveSource !== pendingRemoteSource) {
							remoteChanged = false;
							pendingRemoteSource = null;
						}
						editPending = true;
						clearTimeout(editTimer);
						editTimer = setTimeout(() => {
							editPending = false;
							savedSource = liveSource;
							onEdit(cell.id, liveSource);
						}, 500);
					}),
					// Leaving the editor flushes any pending edit at once, so a save
					// never waits on the debounce when focus moves away. Focus/blur also
					// drive the notebook's edit-vs-command mode: the editor holding
					// focus *is* edit mode, so the indicator can never drift from reality.
					EditorView.domEventHandlers({
						focus: () => (onEditorFocus?.(cell.id), false),
						blur: () => (flushEdit(), onEditorBlur?.(cell.id), false)
					}),
					EditorView.theme({
						'&': { fontSize: '13.5px' },
						'.cm-content': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', padding: '10px 0' },
						'&.cm-focused': { outline: 'none' }
					})
				]
			})
		});
		if (import.meta.env.DEV) (window.cellarViews ??= {})[cell.id] = view;
		// The imperative surface the notebook's shortcut actions drive. `run` goes
		// through `doRun` so it always uses the editor's *live* text, even when the
		// 500ms edit debounce has not fired yet.
		onRegister?.(cell.id, {
			focus: focusEditorOrCell,
			focusCell,
			// Leaving the editor hands focus to the cell, not to `document.body`:
			// command mode keeps acting on the cell you just left.
			blur: () => {
				view?.contentDOM.blur();
				focusCell();
			},
			enterEdit,
			editorOverlayOpen,
			run: doRun,
			isMarkdown: () => isMarkdown,
			// Primitives the notebook's cut/copy, heading and split actions compose.
			// `currentSource` is the editor's live text (never the debounced
			// `cell.source`), and `cursorOffset` is where a split divides it.
			currentSource,
			cursorOffset: () => (view ? view.state.selection.main.head : 0),
			replaceSource
		});
		// Measure editor content height so a tall code cell auto-collapses. A
		// ResizeObserver re-measures on content growth AND on the hidden→visible
		// transition (a background tab measures 0 until shown), so the auto-cap
		// applies whenever the editor is actually laid out. `measureEditor` reads
		// scrollHeight (unclamped) and only assigns when the value changes, so the
		// clamp it may trigger doesn't feed back into a loop.
		if (typeof ResizeObserver !== 'undefined' && editorEl) {
			editorResizeObserver = new ResizeObserver(() => measureEditor());
			editorResizeObserver.observe(editorEl);
		}
		measureEditor();
		// Closing the tab/window can fire before the 500ms debounce; flush on
		// `pagehide` so an in-progress edit is persisted (the PATCH uses
		// `keepalive` so it survives unload).
		const flushOnUnload = () => flushEdit({ keepalive: true });
		window.addEventListener('pagehide', flushOnUnload);
		return () => {
			flushEdit();
			editorResizeObserver?.disconnect();
			window.removeEventListener('pagehide', flushOnUnload);
			onRegister?.(cell.id, null);
			view?.destroy();
		};
	});
</script>

<!-- `tabindex="-1"` makes the cell itself focusable: in command mode the selected
     cell holds focus, so the notebook's key dispatcher always sees a keystroke
     aimed at the cell it is about to act on. Its own ring already marks the
     selection, so the browser's focus outline is suppressed. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={cardEl}
	tabindex="-1"
	class="card relative overflow-hidden border bg-(--cellar-surface-cell) shadow-sm outline-none transition-colors {showRunning
		? 'border-warning/60 ring-1 ring-warning/40'
		: isQueued
			? 'border-warning/30'
			: active
				? 'border-primary/50 ring-1 ring-primary/40'
				: 'border-base-300'} {dragging ? 'opacity-40' : ''}"
	data-testid="cell"
	data-cell-id={cell.id}
	data-cell-type={cell.cell_type}
	data-active={active ? 'true' : undefined}
	data-running={showRunning ? 'true' : undefined}
	data-queued={isQueued ? 'true' : undefined}
	role="presentation"
	onfocusin={() => onActivate?.(cell.id)}
	onpointerdown={() => onActivate?.(cell.id)}
>
	<!-- Left accent bar (VS Code / Jupyter style); no layout shift. The running
	     accent deliberately outranks the selection accent and uses `warning` (the
	     same hue as the running indicator) so "what is executing" is never confused
	     with "what is selected" - the cue that makes an agent's run legible. A
	     queued cell gets the same hue at a fraction of the opacity and without the
	     pulse: same story ("the kernel"), lower voice. All three are daisyUI
	     semantic tokens, so light and dark themes stay coherent for free. -->
	{#if showRunning}
		<div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-1 animate-pulse bg-warning" data-testid="running-bar"></div>
	{:else if isQueued}
		<div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-1 bg-warning/50" data-testid="queued-bar"></div>
	{:else if active}
		<div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-1 bg-primary" data-testid="active-bar"></div>
	{/if}
	<div class="card-body gap-0 p-0">
		<!-- Cell toolbar -->
		<div class="flex items-center justify-between border-b border-base-300 px-2 py-1">
			<div class="flex items-center gap-0.5">
				<button
					class="btn btn-ghost btn-xs btn-square cursor-grab text-base-content/30 hover:text-base-content/70 active:cursor-grabbing"
					draggable="true"
					ondragstart={(e) => onDragStart?.(e, cell.id)}
					ondragend={onDragEnd}
					title="Drag to reorder cell"
					aria-label="Drag to reorder cell"
					data-testid="drag-handle"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
				</button>
				<button
					class="btn btn-ghost btn-xs btn-square text-success"
					onclick={() => doRun(false)}
					disabled={running || isQueued}
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
				{#if !isMarkdown && lastRun && !showRunning}
					<span
						class="ml-2 flex items-center gap-1 text-[11px] text-base-content/45"
						data-testid="run-meta"
						title={`${ranText} · ${isAgentRun ? 'run by an agent (MCP)' : 'run by you (UI)'}`}
					>
						<span>{ranText}</span>
						<span class="opacity-50">·</span>
						<span
							class="inline-flex items-center gap-0.5 font-medium {isAgentRun ? 'text-secondary' : 'text-info'}"
							data-testid="run-actor"
							data-actor={lastRun.actor}
						>
							{#if isAgentRun}
								<!-- agent: sparkle -->
								<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9l-4.6 1.7L12 16l-2.9-5.3L4.5 9l5.6-1.4L12 2z" /></svg>
								agent
							{:else}
								<!-- user: person -->
								<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
								user
							{/if}
						</span>
					</span>
				{/if}
			</div>
			<div class="flex items-center gap-1">
				<!-- Mode indicator for the selected cell: pencil = edit, dot = command. -->
				{#if active}
					<span
						class="mr-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide {editing ? 'text-success' : 'text-info'}"
						data-testid="cell-mode"
						data-mode={keyMode}
						title={editing ? 'Edit mode - Esc for command mode' : 'Command mode - Enter to edit'}
					>
						{#if editing}
							<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
							edit
						{:else}
							<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6" /></svg>
							cmd
						{/if}
					</span>
				{/if}
				<button class="btn btn-ghost btn-xs btn-square" onclick={() => onMove(cell.id, 'up')} disabled={index === 0} title="Move up" aria-label="Move cell up" data-testid="move-up">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
				</button>
				<button class="btn btn-ghost btn-xs btn-square" onclick={() => onMove(cell.id, 'down')} disabled={index === count - 1} title="Move down" aria-label="Move cell down" data-testid="move-down">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
				</button>
				<button class="btn btn-ghost btn-xs btn-square text-error/70 hover:text-error" onclick={() => onDelete(cell.id)} disabled={count === 1} title="Delete cell" aria-label="Delete cell" data-testid="delete">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6" /></svg>
				</button>
				<!-- Far-right slot: running indicator, queue position (code), or the
				     cell-type toggle. -->
				<span class="ml-1 flex min-w-[76px] justify-end">
					{#if showRunning}
						<span class="flex items-center gap-1 text-[11px] text-warning" data-testid="running-indicator">
							<span class="loading loading-spinner loading-xs"></span> running
						</span>
					{:else if isQueued}
						<!-- Two-tone, like the run-meta badge beside it: the clock carries the
						     kernel's `warning` hue (tying it to the running indicator), the label
						     stays on `base-content` so it is legible on a light theme, where a
						     dimmed `warning` washes out to nearly nothing. -->
						<span
							class="flex items-center gap-1 text-[11px] text-base-content/70"
							data-testid="queued-indicator"
							data-queue-position={queuedPosition}
							title={`Waiting for the shared kernel — ${queuedPosition === 1 ? 'next to run' : `${queuedPosition - 1} run${queuedPosition === 2 ? '' : 's'} ahead`}`}
						>
							<!-- clock: waiting, not working -->
							<svg class="h-3 w-3 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
							queued · {queuedPosition}
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

		<!-- Rendered markdown (double-click or the edit button to edit). Every heading
		     carries its own fold chevron - a cell may hold several headings, and each
		     one owns the section that runs until the next same-or-higher heading,
		     wherever that lives. A folded heading keeps its own line (tinted, with a
		     hidden-cell count) so a collapsed section reads as collapsed at a glance;
		     its body and everything under it disappears. `segHidden` is what an OUTER
		     fold hides inside this cell. -->
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
				{#if hasMarkdown}
					{#each segments as seg (seg.index)}
						{#if seg.level != null && !segHidden.headings.has(seg.index)}
							{@const folded = foldedIds.has(seg.key)}
							{@const hiddenCount = foldCounts[seg.key] ?? 0}
							<div
								class="md-heading -mx-1.5 flex items-center gap-1 rounded px-1.5 {folded ? 'bg-base-200/80 ring-1 ring-base-300' : ''}"
								data-testid="heading-row"
								data-folded={folded ? 'true' : undefined}
							>
								<button
									class="shrink-0 text-base-content/40 hover:text-base-content"
									onclick={(e) => {
										e.stopPropagation();
										onToggleFold?.(seg.key);
									}}
									ondblclick={(e) => e.stopPropagation()}
									title={folded ? 'Expand section' : 'Collapse section'}
									aria-label={folded ? 'Expand section' : 'Collapse section'}
									aria-expanded={!folded}
									data-testid="fold-toggle"
									data-fold-key={seg.key}
									data-folded={folded ? 'true' : undefined}
								>
									<svg class="h-3.5 w-3.5 transition-transform {folded ? '-rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
								</button>
								<div class="min-w-0 flex-1">{@html seg.headingHtml}</div>
								{#if folded}
									<span class="shrink-0 whitespace-nowrap rounded bg-base-300/70 px-1.5 py-0.5 text-[11px] font-normal text-base-content/60" data-testid="fold-hidden-count">
										…{hiddenCount > 0 ? ` ${hiddenCount} ${hiddenCount === 1 ? 'cell' : 'cells'} hidden` : ''}
									</span>
								{/if}
							</div>
						{/if}
						{#if seg.bodyHtml && !segHidden.bodies.has(seg.index)}
							<div class="md-body">{@html seg.bodyHtml}</div>
						{/if}
					{/each}
				{:else}
					<span class="text-base-content/30">Empty markdown cell - double-click to edit</span>
				{/if}
			</div>
		{/if}

		<!-- "Changed on server" affordance: a remote (agent / other-tab) edit
		     arrived while you were editing this cell, so it was held back rather
		     than clobbering your typing. Load applies it to the editor. -->
		{#if remoteChanged}
			<div class="flex items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1 text-[11px] text-warning" data-testid="remote-changed">
				<span>Changed on server while you were editing.</span>
				<button class="btn btn-ghost btn-xs h-5 min-h-0 px-2 text-warning hover:bg-warning/20" onclick={loadRemote} data-testid="remote-changed-load">Load</button>
			</div>
		{/if}

		<!-- Editor (hidden while a markdown cell shows its rendered view). A code
		     editor can be collapsed to a fixed-height scroll box (mirrors the
		     scrollable-outputs toggle); the choice is persisted runtime-only. A
		     markdown edit view keeps its original cap unchanged. -->
		<div class="relative {isMarkdown && mode === 'rendered' ? 'hidden' : ''}">
			{#if canCollapse}
				<!-- Collapse-editor toggle (mirrors the "Enable Scrolling for Outputs" control). -->
				<button
					class="btn btn-ghost btn-xs absolute right-1 top-1 z-10 h-5 min-h-0 gap-1 px-1.5 text-[10px] font-normal text-base-content/40 hover:text-base-content/80"
					onclick={toggleEditorCollapsed}
					title={collapsed ? 'Expand editor (show full height)' : 'Collapse editor (contract to a fixed height)'}
					data-testid="editor-collapse-toggle"
					aria-pressed={collapsed}
				>
					{#if collapsed}
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 15l5 5 5-5M7 9l5-5 5 5" /></svg>
						expand
					{:else}
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 8l-5-5-5 5M17 16l-5 5-5-5" /></svg>
						collapse
					{/if}
				</button>
			{/if}
			<div
				bind:this={editorEl}
				aria-label="cell source"
				class="overflow-auto px-3 {isMarkdown ? 'max-h-96' : collapsed ? 'max-h-[36rem]' : ''}"
				data-testid="editor-scroll"
				data-collapsed={collapsed ? 'true' : undefined}
			></div>
		</div>

		<!-- Output (code cells only) -->
		{#if !isMarkdown && outputs.length}
			<div class="relative border-t border-base-300 bg-(--cellar-surface-output)" data-testid="output">
				<!-- Scroll-outputs toggle (Jupyter "Enable Scrolling for Outputs"). -->
				<button
					class="btn btn-ghost btn-xs absolute right-1 top-1 z-10 h-5 min-h-0 gap-1 px-1.5 text-[10px] font-normal text-base-content/40 hover:text-base-content/80"
					onclick={toggleScrolled}
					title={scrolled ? 'Expand output (show full height)' : 'Scroll output (contract to a fixed height)'}
					data-testid="output-scroll-toggle"
					aria-pressed={scrolled}
				>
					{#if scrolled}
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 15l5 5 5-5M7 9l5-5 5 5" /></svg>
						expand
					{:else}
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 8l-5-5-5 5M17 16l-5 5-5-5" /></svg>
						scroll
					{/if}
				</button>
				<div class="{scrolled ? 'max-h-[22rem] overflow-y-auto' : ''}" data-testid="output-scroll" data-scrolled={scrolled ? 'true' : undefined}>
					<div bind:this={outputInner} class="space-y-0.5 py-2">
						{#each outputs as o}
							{#if o.image}
								<img
									class="max-w-full px-3 py-1"
									src={o.image}
									alt="cell image output"
									data-testid="output-image"
								/>
							{:else if o.segments}
								{#each o.segments as seg}
									{#if seg.type === 'table'}
										<div class="cellar-output-table overflow-x-auto px-3 py-1" data-testid="output-table">{@html seg.html}</div>
									{:else if seg.text.trim()}
										<pre class="overflow-x-auto whitespace-pre-wrap break-words border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{seg.text}</pre>
									{/if}
								{/each}
							{:else}
								<pre class="overflow-x-auto whitespace-pre-wrap break-words border-l-2 py-1 pl-3 font-mono text-sm {toneClass[o.tone]}">{o.text}</pre>
							{/if}
						{/each}
					</div>
				</div>
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
	/* The heading and the body it introduces are separate blocks (each heading is
	   independently foldable), so the vertical rhythm lives on the wrappers and
	   the heading elements themselves are flush - that also keeps the fold chevron
	   centred on the heading's line. */
	:global(.cellar-md .md-heading) {
		margin: 0.6em 0 0.25em;
	}
	:global(.cellar-md .md-heading:first-child) {
		margin-top: 0;
	}
	:global(.cellar-md .md-body:last-child > *:last-child) {
		margin-bottom: 0;
	}
	:global(.cellar-md .md-heading :is(h1, h2, h3, h4, h5, h6)) {
		margin: 0;
	}
	/* Headings are plain: no rules, no underline. h1 and h2 once carried a
	   `border-bottom` in `--color-base-300`, near-invisible against `dim`'s
	   surface but a hard grey underline on any light theme - so rendered markdown
	   did not read the same in both. Size and weight carry the hierarchy. */
	:global(.cellar-md :is(h1, h2, h3, h4, h5, h6)) {
		margin: 0.5em 0 0.3em;
	}
	:global(.cellar-md h1) {
		font-size: 1.5em;
		font-weight: 700;
	}
	:global(.cellar-md h2) {
		font-size: 1.3em;
		font-weight: 700;
	}
	:global(.cellar-md h3) {
		font-size: 1.1em;
		font-weight: 600;
	}
	/* Tailwind's preflight resets h4-h6 to plain body text, leaving them
	   indistinguishable from the paragraph beneath. Weight alone separates them,
	   identically in both themes. */
	:global(.cellar-md :is(h4, h5, h6)) {
		font-size: 1em;
		font-weight: 600;
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
		color: var(--color-primary);
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
		background: var(--color-base-200);
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
		border-left: 3px solid var(--color-base-300);
		padding-left: 1em;
		color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
		margin: 0.6em 0;
	}
	:global(.cellar-md table) {
		border-collapse: collapse;
		margin: 0.6em 0;
	}
	:global(.cellar-md th),
	:global(.cellar-md td) {
		border: 1px solid var(--color-base-300);
		padding: 0.3em 0.6em;
	}
</style>
