<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { EditorView } from '@codemirror/view';
	import { EditorState, Compartment } from '@codemirror/state';
	import { completionStatus } from '@codemirror/autocomplete';
	import { searchPanelOpen } from '@codemirror/search';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import { sql } from '@codemirror/lang-sql';
	import DOMPurify from 'dompurify';
	import { md, renderMarkdown } from '$lib/markdown';
	import { EDITOR_THEME } from '$lib/editorTheme';
	import DataFrameGrid from '$lib/DataFrameGrid.svelte';
	import PlotlyOutput from '$lib/PlotlyOutput.svelte';
	import HtmlOutput from '$lib/HtmlOutput.svelte';
	import WidgetOutput from '$lib/WidgetOutput.svelte';
	import { foldKey, splitHeadingSegments } from '$lib/headings';
	import { isImportsCell } from '$lib/importsRole';
	import { isExportCell } from '$lib/exportRole';
	import { isSqlCell, logicalCellType } from '$lib/cellLanguage';
	import { relativeTime, formatDuration } from '$lib/relativeTime';
	import type { CellOutput, LogicalCellType } from '$lib/server/types';
	import type { KeyMode, UICell, SegHidden, CellRegisterApi, RemoteEdit } from '$lib/types';
	import type { StalenessEntry } from '$lib/staleness';

	const NO_SEGS_HIDDEN: SegHidden = { headings: new Set(), bodies: new Set() };

	interface Props {
		cell: UICell;
		index: number;
		count: number;
		running: boolean;
		/** 1-based place in the kernel's run queue, or null. */
		queuedPosition?: number | null;
		active?: boolean;
		/** Notebook mode; only meaningful while `active`. */
		keyMode?: KeyMode;
		/** Staleness verdict ($lib/staleness), or null. */
		staleState?: StalenessEntry | null;
		dragging?: boolean;
		/** Fold keys of every collapsed heading in the notebook. */
		foldedIds?: Set<string>;
		/** Segment indices of THIS cell an outer fold hides. */
		segHidden?: SegHidden;
		/** Fold key → whole cells that fold hides (the "N cells hidden" hint). */
		foldCounts?: Record<string, number>;
		onToggleFold?: (key: string) => void;
		onRun: (id: string, source: string) => void;
		onRunAdvance: (id: string, source: string, opts: { focusNext: boolean }) => void;
		/** Interrupt the shared kernel (reuses the Kernels-section handler). */
		onInterrupt?: () => void;
		onClear: (id: string) => void;
		onDelete: (id: string) => void;
		onMove: (id: string, dir: 'up' | 'down') => void;
		onEdit: (id: string, source: string, opts?: { keepalive?: boolean }) => void;
		onSetType: (id: string, type: LogicalCellType) => void;
		/** Designate this cell the imports cell ('imports') or un-designate it (null). */
		onSetRole: (id: string, role: string | null) => void;
		/** Mark this code cell for nbdev-style `.py` export, or unmark it. */
		onSetExport?: (id: string, exported: boolean) => void;
		onSetScrolled?: (id: string, scrolled: boolean) => void;
		/** Per-cell code-editor collapse choice (undefined = auto / true / false). */
		editorCollapsed?: boolean;
		onSetEditorCollapsed?: (id: string, collapsed: boolean) => void;
		onActivate?: (id: string) => void;
		/** Hands the notebook this cell's imperative API (null on teardown). */
		onRegister?: (id: string, api: CellRegisterApi | null) => void;
		onEditorFocus?: (id: string) => void;
		onEditorBlur?: (id: string) => void;
		onDragStart?: (e: DragEvent, id: string) => void;
		onDragEnd?: () => void;
	}

	let {
		cell,
		index,
		count,
		running,
		queuedPosition = null,
		active = false,
		keyMode = 'command',
		staleState = null,
		dragging = false,
		foldedIds = new Set(),
		segHidden = NO_SEGS_HIDDEN,
		foldCounts = {},
		onToggleFold,
		onRun,
		onRunAdvance,
		onInterrupt,
		onClear,
		onDelete,
		onMove,
		onEdit,
		onSetType,
		onSetRole,
		onSetExport,
		onSetScrolled,
		editorCollapsed,
		onSetEditorCollapsed,
		onActivate,
		onRegister,
		onEditorFocus,
		onEditorBlur,
		onDragStart,
		onDragEnd
	}: Props = $props();

	let cardEl: HTMLDivElement | undefined; // the cell's outer card: what holds focus in command mode
	let editorEl: HTMLDivElement | undefined;
	let view: EditorView | undefined;
	let editorResizeObserver: ResizeObserver | undefined;
	let editTimer: ReturnType<typeof setTimeout>;
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
	function flushEdit({ keepalive = false }: { keepalive?: boolean } = {}) {
		clearTimeout(editTimer);
		if (view && liveSource !== savedSource) {
			savedSource = liveSource;
			editPending = false;
			onEdit(cell.id, liveSource, { keepalive });
		}
	}

	const isMarkdown = $derived(cell.cell_type === 'markdown');
	// A SQL cell: a code cell tagged cellar.language='sql'. Its source is SQL, run
	// against `spark` (see server/sql.js); the editor highlights it as SQL.
	const isSql = $derived(isSqlCell(cell));
	// The logical cell type the type menu speaks: 'code' | 'sql' | 'markdown'.
	const logicalType = $derived(logicalCellType(cell));
	const typeLabel = $derived(logicalType === 'sql' ? 'SQL' : logicalType === 'markdown' ? 'markdown' : 'python3');
	// The notebook's designated imports cell: user-choosable, marked in the toolbar
	// with the "imports" badge, and free to live at any index. Only a Python code
	// cell can hold the role, so the mark action is offered only when `canBeImports`.
	const isImports = $derived(isImportsCell(cell));
	const canBeImports = $derived(logicalType === 'code');
	// nbdev-style export: this code cell is written to the notebook's `.py` module.
	// Only a plain Python code cell can be, so the toggle rides the same `canBeImports`
	// gate (code cells only) as the cell-actions menu it lives in.
	const isExport = $derived(isExportCell(cell));

	// A remote (agent / other-tab) source edit that arrived while the user was
	// editing this cell, held until they choose to load it (the affordance below).
	let remoteChanged = $state(false);
	let pendingRemoteSource: string | null = null;
	let appliedRemote: RemoteEdit | null = null; // the last cell.remoteEdit object we processed

	// The editor's live text. Declared before `mode` because `mode` derives from it.
	let liveSource = $state(cell.source);

	// User intent to edit this markdown cell's raw source. A markdown cell with
	// content that the user has NOT opened for editing shows RENDERED by default;
	// opening it (double-click / pencil / keyboard enter-edit / a type-toggle to
	// markdown / focusing its editor) sets this and shows the raw source.
	//
	// `mode` is DERIVED from this + the live source, deliberately NOT a one-shot
	// mount-time snapshot: an agent-created markdown cell (add_cell / add_and_run /
	// run_cell) renders reliably even if the Cell mounts before its source is
	// populated or the `cell:rendered` event races the mount — the rule re-evaluates
	// as `liveSource` fills in, so it can never get stuck in `edit` the way the old
	// `$state`-init-plus-one-shot-event design did (the bug this fixes). Reopening a
	// notebook already rendered because those cells mount with source; this makes
	// live agent-created cells behave identically.
	let rawEdit = $state(false);
	const mode = $derived(
		isMarkdown && !rawEdit && liveSource.trim().length > 0 ? 'rendered' : 'edit'
	);

	// Markdown is rendered through the shared engine in `$lib/markdown.js` (safe
	// mode + DOMPurify), so cells and the file preview parse identically.
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
	let runIndicatorTimer: ReturnType<typeof setTimeout>;
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

	// ---- Click-to-copy cell id ----------------------------------------------
	// The label shows `cell #<first-8>`; a click copies exactly that short id
	// (no "cell " / "#" prefix) and briefly flips to "copied!". View-only:
	// touches neither the doc nor the kernel. Falls back to execCommand when
	// navigator.clipboard is absent (non-secure context); worst case a no-op.
	const shortId = $derived(cell.id.slice(0, 8));
	let copied = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	async function copyCellId(e: Event) {
		e.stopPropagation();
		e.preventDefault();
		let ok = false;
		try {
			if (browser && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(shortId);
				ok = true;
			} else if (browser && typeof document !== 'undefined') {
				const ta = document.createElement('textarea');
				ta.value = shortId;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				ok = document.execCommand('copy');
				document.body.removeChild(ta);
			}
		} catch {
			ok = false;
		}
		if (!ok) return;
		copied = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => (copied = false), 1000);
	}

	// ---- Staleness indicator -------------------------------------------------
	// A code cell that ran this session but whose inputs changed since is STALE:
	// its output no longer matches its current code (self-edit) or an upstream
	// cell it depends on (edited / re-run). Distinct from running/queued/selected -
	// a persistent amber chip, not a bar. A cell that ran in a PREVIOUS session
	// shows a quieter "not run" hint, but only when it looks like it has a result
	// to distrust (saved outputs, or a run badge). Suppressed while running/queued,
	// which are the louder, more immediate states.
	const staleState_ = $derived(staleState?.state ?? null);
	const isStale = $derived(!isMarkdown && staleState_ === 'stale' && !showRunning && !isQueued);
	const notRunThisSession = $derived(
		!isMarkdown && staleState_ === 'not_run' && !showRunning && !isQueued && (lastRun || (cell.outputs || []).length > 0)
	);
	const staleTitle = $derived(
		staleState?.reason ? `Stale — ${staleState.reason}. Re-run to refresh.` : 'Stale — an input changed after this cell ran. Re-run to refresh.'
	);

	// Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks.
	const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
	const stripAnsi = (s: string): string => s.replace(ANSI, '');
	const asText = (s: unknown): string => (Array.isArray(s) ? s.join('') : ((s as string) ?? ''));

	// Build a data: URL for an nbformat image bundle. Raster mimes (png/jpeg/gif)
	// carry base64 text; image/svg+xml carries raw XML, so it is URI-encoded.
	function imageDataUrl(mime: string, payload: unknown): string {
		const data = asText(payload);
		if (mime === 'image/svg+xml') return `data:image/svg+xml;utf8,${encodeURIComponent(data)}`;
		return `data:${mime};base64,${data.replace(/\s+/g, '')}`;
	}

	// A markdown-table separator row: pipes, dashes, colons, spaces, ≥1 dash.
	const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
	const isTableRow = (l: string): boolean => l.includes('|') && l.trim() !== '';

	// A parsed span of text output: plain monospace text, or a rendered md table.
	type TextSegment = { type: 'text'; text: string } | { type: 'table'; html: string };
	// Split plain text into segments: contiguous markdown tables (header row +
	// separator row + body rows) become {type:'table'}; everything else stays
	// {type:'text'}. A table needs a header line immediately followed by a
	// separator line, so ordinary pipe-containing text is left untouched.
	function textSegments(text: string): TextSegment[] {
		const lines = text.split('\n');
		const segs: TextSegment[] = [];
		let buf: string[] = [];
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
	function renderTable(src: string): string {
		if (!browser) return '';
		const html = DOMPurify.sanitize(md.render(src));
		return html.replace(/<table>/g, '<table class="table table-zebra table-xs">');
	}

	// Map an nbformat output object to a renderable {tone, text, segments}. Text
	// outputs (stdout / stderr / result) carry parsed segments so embedded
	// markdown tables render as real tables; errors stay raw monospace.
	// A renderable output. `dataframe`/`plotly` are dynamic mimebundle payloads
	// (untyped JSON from the kernel) handed straight to the typed child renderers,
	// so they are `any` at this boundary.
	interface RenderedOutput {
		tone: string;
		text?: string;
		dataframe?: any;
		plotly?: any;
		image?: string;
		html?: string;
		/** ipywidgets model id (tqdm bar) — rendered live from the widget store. */
		widget?: string;
		segments: TextSegment[] | null;
	}

	function renderOutput(o: CellOutput): RenderedOutput {
		let tone = 'stdout';
		let text = '';
		switch (o.output_type) {
			case 'stream':
				tone = o.name === 'stderr' ? 'stderr' : 'stdout';
				text = asText(o.text);
				break;
			case 'execute_result':
			case 'display_data': {
				const d = o.data || {};
				// ipywidgets view (tqdm progress bars): the mime carries only a
				// `model_id`; the live widget store holds the actual state, rendered as a
				// bar/text tree by WidgetOutput. Checked first — it never has a useful
				// rich fallback, only a `text/plain` repr like `HBox(children=…)`.
				const widgetView = d['application/vnd.jupyter.widget-view+json'] as { model_id?: string } | undefined;
				if (widgetView?.model_id) {
					return { tone: 'result', widget: widgetView.model_id, segments: null };
				}
				// Prefer Cellar's structured DataFrame payload: a pandas DataFrame emits
				// it (see kernel.js) alongside its text/plain + text/html reprs, and we
				// render it as an interactive grid instead of the static repr.
				const df = d['application/vnd.cellar.dataframe+json'];
				if (df) {
					return { tone: 'result', dataframe: df, segments: null };
				}
				// Mimetype priority mirrors Jupyter: a rich bundle usually ships a
				// text/plain fallback alongside its real payload, so the richer
				// representation is chosen first.
				//
				// Plotly figures (`fig.show()` / the default renderer) emit
				// `application/vnd.plotly.v1+json` = {data, layout, config}; render it
				// as a live interactive chart (preferred over any text/html fallback).
				const plotly = d['application/vnd.plotly.v1+json'];
				if (plotly) {
					return { tone: 'result', plotly, segments: null };
				}
				// Prefer a rich image over the text/plain repr: a matplotlib figure
				// emits BOTH an image/png and its `<Figure … with N Axes>` text repr,
				// and (like Jupyter) we show the image, not the placeholder text.
				const imgMime = Object.keys(d).find((k) => k.startsWith('image/'));
				if (imgMime) {
					return { tone: 'result', image: imageDataUrl(imgMime, d[imgMime]), segments: null };
				}
				// Rich text/html (Bokeh, Altair, folium, styled DataFrames, plotly's
				// HTML renderer, …) renders in a sandboxed iframe so its embedded JS
				// runs safely without touching the app.
				if (d['text/html']) {
					return { tone: 'result', html: asText(d['text/html']), segments: null };
				}
				if (d['text/plain']) {
					tone = 'result';
					text = asText(d['text/plain']);
				} else {
					// Last resort for a genuinely unhandled mimetype — name it so the
					// gap is visible instead of a mute "[rich output]".
					const mime = Object.keys(d)[0] || 'unknown';
					return { tone: 'result', text: `[unsupported output: ${mime}]`, segments: null };
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

	// ---- Full-size image outputs (JupyterLab double-click) -------------------
	// Double-clicking an image output toggles it between fit-to-width and its
	// natural pixel size, matching JupyterLab. In full size the image is wrapped
	// in an overflow-auto box (bounded height) so it scrolls within the output
	// area rather than widening the notebook. View-only runtime state keyed by
	// output index; a re-run rebuilds `outputs` and resets the choice, which is
	// the honest default (a new render is a fresh image), so it never touches the
	// `.ipynb`.
	let fullImages = $state<Set<number>>(new Set());
	const hasFullImage = $derived(fullImages.size > 0);
	function toggleFullImage(i: number) {
		const next = new Set(fullImages);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		fullImages = next;
	}

	// ---- Scrollable / contracted outputs ------------------------------------
	// Per-cell choice persisted in `cell.metadata.cellar.output_scrolled`
	// (undefined = auto, true = force scrolled, false = force full). Above a
	// height threshold we auto-scroll unless the user set an explicit choice.
	const SCROLL_THRESHOLD = 360; // px of output beyond which we contract by default
	let outputInner = $state<HTMLElement | null>(null);
	let outputTall = $state(false);
	// The DataFrame grid — and a full-size image — manage their own fixed height +
	// scroll, so they must not also be wrapped in the outer output-scroll box (that
	// would double-scroll and clip content). When either is present, skip
	// auto-contraction and hide the toggle entirely.
	const hasDataframe = $derived(outputs.some((o) => o.dataframe));
	// Plotly charts and sandboxed HTML iframes own their own height/scroll (the
	// chart resizes to its container, the iframe scrolls internally past its cap),
	// so they must not also sit inside the outer output-scroll box.
	const hasSelfSized = $derived(outputs.some((o) => o.plotly || o.html != null));
	const ownsScroll = $derived(hasDataframe || hasFullImage || hasSelfSized);
	const explicitScrolled = $derived(cell.metadata?.cellar?.output_scrolled);
	const scrolled = $derived(ownsScroll ? false : (explicitScrolled ?? outputTall));
	$effect(() => {
		cell.outputs; // re-measure whenever outputs change
		if (outputInner) outputTall = !ownsScroll && outputInner.scrollHeight > SCROLL_THRESHOLD;
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

	const toneClass: Record<string, string> = {
		stdout: 'text-base-content border-transparent',
		stderr: 'text-warning border-warning/40',
		result: 'text-success font-semibold border-success/40',
		error: 'text-error border-error bg-error/10'
	};

	// ---- Cell-type menu (Python / SQL / Markdown) ---------------------------
	// A native popover so the menu renders in the top layer, unclipped by the
	// card's `overflow-hidden`. Positioned under its trigger button on open.
	let typeMenuEl = $state<HTMLElement | null>(null);
	let typeBtnEl = $state<HTMLElement | null>(null);
	function openTypeMenu() {
		if (!typeMenuEl || !typeBtnEl) return;
		typeMenuEl.showPopover();
		const r = typeBtnEl.getBoundingClientRect();
		const mw = typeMenuEl.offsetWidth || 150;
		typeMenuEl.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
		typeMenuEl.style.top = r.bottom + 4 + 'px';
	}
	// The cell-type menu options (Python / SQL / Markdown).
	const TYPE_OPTIONS: { v: LogicalCellType; label: string; hint: string }[] = [
		{ v: 'code', label: 'Python', hint: 'python3' },
		{ v: 'sql', label: 'SQL', hint: 'spark.sql' },
		{ v: 'markdown', label: 'Markdown', hint: 'text' }
	];
	function chooseType(type: LogicalCellType) {
		typeMenuEl?.hidePopover();
		if (type !== logicalType) onSetType(cell.id, type);
	}

	// The cell-actions ("⋮") menu — currently the imports-cell mark/unmark toggle.
	// A popover in the top layer, like the type menu, so the card's overflow never
	// clips it. Positioned under its trigger on open.
	let roleMenuEl = $state<HTMLElement | null>(null);
	let roleBtnEl = $state<HTMLElement | null>(null);
	function openRoleMenu() {
		if (!roleMenuEl || !roleBtnEl) return;
		roleMenuEl.showPopover();
		const r = roleBtnEl.getBoundingClientRect();
		const mw = roleMenuEl.offsetWidth || 200;
		roleMenuEl.style.left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + 'px';
		roleMenuEl.style.top = r.bottom + 4 + 'px';
	}
	function toggleImportsRole() {
		roleMenuEl?.hidePopover();
		onSetRole(cell.id, isImports ? null : 'imports');
	}
	function toggleExport() {
		roleMenuEl?.hidePopover();
		onSetExport?.(cell.id, !isExport);
	}

	function currentSource() {
		return view ? view.state.doc.toString() : cell.source;
	}

	// Replace the editor's whole document with `src` without echoing it back to
	// the server as a local edit (the update listener honors `applyingRemote`).
	function applySourceToEditor(src: string) {
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
	function replaceSource(src: string) {
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
	function doRun(advance: boolean = false, { focusNext = true }: { focusNext?: boolean } = {}) {
		const src = currentSource();
		liveSource = src;
		savedSource = src;
		if (isMarkdown) rawEdit = false;
		if (advance) onRunAdvance(cell.id, src, { focusNext });
		else onRun(cell.id, src);
	}

	async function enterEdit() {
		rawEdit = true;
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
	// Editor grammar by LOGICAL type: markdown, SQL (spark queries), or python.
	function langFor() {
		if (cell.cell_type === 'markdown') return markdown();
		return isSql ? sql() : python();
	}

	// Reconfigure the editor language when the cell type OR its SQL/Python language
	// toggles; after a manual cell_type toggle, drop into edit mode so the user sees
	// the source. `isSql` is read so a code↔sql switch re-applies the grammar too.
	let prevType = cell.cell_type;
	$effect(() => {
		const type = cell.cell_type;
		isSql; // track: code↔sql keeps cell_type 'code' but changes the grammar
		if (view) view.dispatch({ effects: language.reconfigure(langFor()) });
		if (type !== prevType) {
			prevType = type;
			// A manual type toggle drops into edit mode so the user sees the source
			// (a code→markdown conversion that rendered immediately would hide it).
			rawEdit = true;
		}
	});

	onMount(() => {
		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: cell.source,
				extensions: [
					basicSetup,
					language.of(langFor()),
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
						focus: () => {
							// Focusing a visible markdown editor means the user is editing its
							// raw source; latch that so the derived `mode` can't flip to rendered
							// while they type into a fresh empty cell. A rendered markdown cell's
							// editor is display:none and unfocusable, so this only ever fires
							// when edit mode is already showing.
							if (isMarkdown) rawEdit = true;
							onEditorFocus?.(cell.id);
							return false;
						},
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
		// Dev-only debug handle; `cellarViews` is not a standard Window property.
		if (import.meta.env.DEV) ((window as any).cellarViews ??= {})[cell.id] = view;
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
			// Flip a markdown cell to its rendered view. Markdown never executes on the
			// kernel, so "running" it (agent run_cell / add_and_run) means rendering it;
			// LiveNotebook invokes this from the server's `cell:rendered` event. View-only
			// (no persist, no run) so it never touches the .ipynb. No-op for code cells.
			showRendered: () => {
				if (!isMarkdown) return;
				liveSource = currentSource();
				rawEdit = false;
			},
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
	data-stale={isStale ? 'true' : undefined}
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
				<!-- The imports cell is no longer pinned, so every cell (imports included)
				     carries the same drag handle and can be reordered freely. -->
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
				{#if isImports}
					<!-- The visual marker that THIS is the notebook's imports cell — a pin
					     glyph + label, no longer tied to the cell's position. -->
					<span
						class="badge badge-xs ml-1.5 flex items-center gap-1 badge-soft badge-primary font-medium"
						title="Imports cell — Consolidate imports, and imports an agent writes, are collected here. Use the ⋮ menu to move the designation to another cell."
						data-testid="imports-badge"
					>
						<svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
						imports
					</span>
				{/if}
				{#if isExport}
					<!-- Export marker: this code cell is written to the notebook's `.py`
					     module (nbdev's `#|export`). -->
					<span
						class="badge badge-xs ml-1.5 flex items-center gap-1 badge-soft badge-accent font-medium"
						title="Exported to the notebook's .py module. Set the target and re-export from the bar at the top; the module also regenerates on save."
						data-testid="export-badge"
					>
						<svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
						export
					</span>
				{/if}
				{#if isSql}
					<!-- SQL indicator: this code cell holds a SQL query run against `spark`. -->
					<span
						class="badge badge-xs ml-1.5 badge-soft badge-info font-medium"
						title="SQL cell - runs against the connected Databricks spark session and shows the result as a table"
						data-testid="sql-badge">SQL</span
					>
				{/if}
				<!-- Click-to-copy short cell id. Real button so it is keyboard-
				     focusable; stops propagation so copying never selects/activates
				     the cell. Flips to "copied!" for ~1s on success. -->
				<button
					type="button"
					class="ml-1.5 cursor-pointer rounded px-0.5 font-mono text-xs transition-colors hover:bg-base-content/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary {copied ? 'text-success' : 'text-base-content/50'}"
					aria-label="Copy cell id"
					title={copied ? 'Copied cell id' : 'Click to copy cell id'}
					onclick={copyCellId}
					data-testid="cell-id-copy"
				>
					{#if copied}
						<span>copied!</span>
					{:else}
						cell <span class="text-base-content/70">#{shortId}</span>
					{/if}
				</button>
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
				{#if isStale}
					<!-- Persistent amber "stale" chip: the cell ran, but an input changed
					     since. Its own token (`--cellar-stale`), not the `warning` hue the
					     transient running/queued affordances own, so the two never blur. -->
					<span
						class="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
						style="color: var(--cellar-stale); background: var(--cellar-stale-soft);"
						data-testid="stale-badge"
						data-stale-state="stale"
						title={staleTitle}
					>
						<!-- circular arrows: out of date, re-run to refresh -->
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
						stale
					</span>
				{:else if notRunThisSession}
					<!-- Quieter than stale: the cell's saved output is from a PREVIOUS
					     kernel session, so nothing it defines exists in the kernel now. -->
					<span
						class="ml-2 inline-flex items-center gap-1 text-[11px] font-medium text-base-content/40"
						data-testid="not-run-badge"
						data-stale-state="not_run"
						title="This cell has not run in the current kernel session — its saved output is from a previous session."
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
						not run
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
				<!-- Every cell — the imports cell included — moves freely now. -->
				<button class="btn btn-ghost btn-xs btn-square" onclick={() => onMove(cell.id, 'up')} disabled={index === 0} title="Move up" aria-label="Move cell up" data-testid="move-up">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
				</button>
				<button class="btn btn-ghost btn-xs btn-square" onclick={() => onMove(cell.id, 'down')} disabled={index === count - 1} title="Move down" aria-label="Move cell down" data-testid="move-down">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
				</button>
				{#if canBeImports}
					<!-- Cell-actions menu: designate this Python code cell as the notebook's
					     imports cell, or clear the designation. -->
					<button
						bind:this={roleBtnEl}
						class="btn btn-ghost btn-xs btn-square {isImports ? 'text-primary' : 'text-base-content/50 hover:text-base-content/80'}"
						onclick={openRoleMenu}
						title="Cell actions"
						aria-label="Cell actions"
						data-testid="cell-actions"
					>
						<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>
					</button>
					<div
						bind:this={roleMenuEl}
						popover="auto"
						class="m-0 rounded-box border border-base-300 bg-base-100 p-1 text-sm shadow-lg"
						style="position: fixed; inset: auto; margin: 0;"
						data-testid="cell-actions-menu"
					>
						<div class="flex w-56 flex-col gap-0.5">
							<button
								class="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-base-200 {isImports ? 'text-base-content' : 'text-primary'}"
								onclick={toggleImportsRole}
								data-testid="toggle-imports-role"
							>
								<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
								<span>{isImports ? 'Unmark as imports cell' : 'Mark as imports cell'}</span>
							</button>
							<button
								class="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-base-200 {isExport ? 'text-base-content' : 'text-accent'}"
								onclick={toggleExport}
								data-testid="toggle-export"
							>
								<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
								<span>{isExport ? 'Unmark for export' : 'Mark for export to .py'}</span>
							</button>
						</div>
					</div>
				{/if}
				<button class="btn btn-ghost btn-xs btn-square text-error/70 hover:text-error" onclick={() => onDelete(cell.id)} disabled={count === 1} title="Delete cell" aria-label="Delete cell" data-testid="delete">
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6" /></svg>
				</button>
				<!-- Far-right slot: running indicator, queue position (code), or the
				     cell-type toggle. -->
				<span class="ml-1 flex min-w-[76px] items-center justify-end gap-1">
					{#if showRunning}
						<span class="flex items-center gap-1 text-[11px] text-warning" data-testid="running-indicator">
							<span class="loading loading-spinner loading-xs"></span> running
						</span>
						<!-- Stop control: interrupts the one shared kernel (KeyboardInterrupt),
						     which halts the currently-executing cell. Same handler as the
						     Kernels sidebar's Interrupt button; shown only while running. -->
						<button
							class="btn btn-ghost btn-xs h-5 min-h-0 w-5 p-0 text-error hover:bg-error/10 hover:text-error"
							onclick={() => onInterrupt?.()}
							title="Interrupt kernel"
							aria-label="Interrupt kernel"
							data-testid="cell-interrupt"
						>
							<svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
						</button>
					{:else if isQueued}
						<!-- Two-tone, like the run-meta badge beside it: the clock carries the
						     kernel's `warning` hue (tying it to the running indicator), the label
						     stays on `base-content` so it is legible on a light theme, where a
						     dimmed `warning` washes out to nearly nothing. -->
						<span
							class="flex items-center gap-1 text-[11px] text-base-content/70"
							data-testid="queued-indicator"
							data-queue-position={queuedPosition}
							title={`Waiting for the shared kernel — ${queuedPosition === 1 ? 'next to run' : `${queuedPosition! - 1} run${queuedPosition === 2 ? '' : 's'} ahead`}`}
						>
							<!-- clock: waiting, not working -->
							<svg class="h-3 w-3 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
							queued · {queuedPosition}
						</span>
					{:else}
						<button
							bind:this={typeBtnEl}
							class="btn btn-ghost btn-xs flex h-5 min-h-0 items-center gap-0.5 px-1.5 font-mono text-[11px] font-normal text-base-content/40 hover:text-base-content/80"
							onclick={openTypeMenu}
							title="Change cell type (Python · SQL · Markdown)"
							data-testid="type-toggle"
						>
							{typeLabel}
							<svg class="h-2.5 w-2.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
						</button>
						<!-- Popover (top layer, so the card's overflow-hidden never clips it).
							 The popover element must NOT carry a `display` (no `menu`/`flex`
							 class): a `display` rule overrides the UA
							 `[popover]:not(:popover-open){display:none}` and the menu renders
							 open on every cell. Layout lives on the inner wrapper below. -->
						<div
							bind:this={typeMenuEl}
							popover="auto"
							class="m-0 rounded-box border border-base-300 bg-base-100 p-1 text-sm shadow-lg"
							style="position: fixed; inset: auto; margin: 0;"
							data-testid="type-menu"
						>
							<div class="flex w-36 flex-col gap-0.5">
								{#each TYPE_OPTIONS as opt}
									<button
										class="flex items-center justify-between rounded px-2 py-1 text-left hover:bg-base-200 {logicalType === opt.v ? 'font-semibold text-primary' : 'text-base-content'}"
										onclick={() => chooseType(opt.v)}
										data-testid="type-option-{opt.v}"
										aria-current={logicalType === opt.v}
									>
										<span>{opt.label}</span>
										<span class="font-mono text-[10px] text-base-content/40">{opt.hint}</span>
									</button>
								{/each}
							</div>
						</div>
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
				class="overflow-auto {isMarkdown ? 'max-h-96' : collapsed ? 'max-h-[36rem]' : ''}"
				data-testid="editor-scroll"
				data-collapsed={collapsed ? 'true' : undefined}
			></div>
		</div>

		<!-- Output (code cells only) -->
		{#if !isMarkdown && outputs.length}
			<div class="relative border-t border-base-300 bg-(--cellar-surface-output)" data-testid="output">
				<!-- Scroll-outputs toggle (Jupyter "Enable Scrolling for Outputs"). The
				     DataFrame grid and a full-size image own their own scroll, so the
				     toggle is hidden for them. -->
				{#if !ownsScroll}
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
				{/if}
				<div class="{scrolled ? 'max-h-[22rem] overflow-y-auto' : ''}" data-testid="output-scroll" data-scrolled={scrolled ? 'true' : undefined}>
					<div bind:this={outputInner} class="space-y-0.5 py-2">
						{#each outputs as o, i}
							{#if o.dataframe}
								<div class="px-3 py-1" data-testid="output-dataframe">
									<DataFrameGrid payload={o.dataframe} />
								</div>
							{:else if o.widget != null}
								<div class="px-3 py-1" data-testid="output-widget">
									<WidgetOutput modelId={o.widget} />
								</div>
							{:else if o.plotly}
								<div class="px-3 py-1" data-testid="output-plotly-wrap">
									<PlotlyOutput figure={o.plotly} />
								</div>
							{:else if o.html != null}
								<div class="px-3 py-1" data-testid="output-html-wrap">
									<HtmlOutput html={o.html} />
								</div>
							{:else if o.image}
								{@const full = fullImages.has(i)}
								<div
									class="px-3 py-1 {full ? 'max-h-[80vh] overflow-auto' : ''}"
									data-testid="output-image-wrap"
									data-fullsize={full ? 'true' : undefined}
								>
									<img
										class="{full ? 'max-w-none' : 'max-w-full'}"
										src={o.image}
										alt="cell image output"
										data-testid="output-image"
										title={full ? 'Double-click to fit to width' : 'Double-click for full size'}
										ondblclick={() => toggleFullImage(i)}
									/>
								</div>
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
