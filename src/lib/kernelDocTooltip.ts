/**
 * Cellar - the Shift+Tab documentation tooltip, sourced from the LIVE kernel.
 *
 * Classic Jupyter's contract, and the reason this rides Jupyter's own
 * `inspect_request` rather than anything Cellar could compute: press Shift+Tab
 * with the caret anywhere inside a call's arguments and you get that callable's
 * signature and docstring; press it again and the same reply comes back one
 * `detail_level` higher, with the source. Both halves are the protocol's, so
 * neither is reimplemented here - the WHOLE cell source and the caret offset go to
 * the kernel, whose `token_at_cursor` is what finds the callable (verified against
 * a real kernel for `myfunc(1, `, `x = myfunc(1, 2, `, `print(len(` and a
 * multi-line cell).
 *
 * WHAT THIS FILE OWNS is the editor half: one `StateField` holding the tooltip,
 * the escalation, and dismissal. Dismissal follows the editor's OTHER overlays
 * rather than inventing a rule - it closes on Escape (an editor-local keymap at
 * `Prec.highest`, exactly as `completionKeymap` closes the completion tooltip), on
 * a document change, on any caret move, and on blur (`closeOnBlur`, the completion
 * default) - with the same mousedown guard the completion list uses so a click or a
 * scrollbar drag INSIDE the tooltip is not a blur at all. `docTooltipOpen` is what
 * lets `Cell.editorOverlayOpen()` yield Escape to it before the notebook's own
 * Escape takes the user to command mode.
 *
 * A refusal IS rendered here, unlike in `kernelCompletion` where it is silent. The
 * difference is that Shift+Tab is a direct question: showing nothing would read as
 * a dead key, and the honest sentence ("the kernel is busy running a cell, so it
 * was not asked") is exactly what tells the user whether to wait or to run a cell.
 */

import { StateEffect, StateField, Prec } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, showTooltip, keymap } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { refusalMessage, toCodePointOffset, type KernelIntrospectHandle } from '$lib/kernelIntrospect';

/** The tooltip element, so tests and styles can name it. */
export const DOC_TOOLTIP_CLASS = 'cm-cellar-doc';
export const DOC_TOOLTIP_TESTID = 'kernel-doc-tooltip';
/** The "press again to expand" footer - present only while more detail is available. */
export const DOC_TOOLTIP_MORE_TESTID = 'kernel-doc-more';

/** What the tooltip is showing right now. Immutable: every change replaces it. */
interface DocState {
	/** The caret this tooltip was opened at; also where it is anchored. */
	pos: number;
	/** The `detail_level` currently shown, or being fetched when `text` is null. */
	detail: 0 | 1;
	/** The kernel's documentation text, or null while the first answer is pending. */
	text: string | null;
	/** A sentence to show instead of docs (a refusal, or "nothing found"). */
	message: string | null;
	/** True while a request for this tooltip is in flight. */
	pending: boolean;
	/** Which request owns this tooltip; a stale reply is dropped by comparing it. */
	seq: number;
	/** Built once per state so CodeMirror does not rebuild the DOM every transaction. */
	tooltip: Tooltip;
}

const setDocState = StateEffect.define<DocState | null>();

/**
 * Monotonic per-request id. Module-scope rather than per-editor because it only
 * ever has to be UNEQUAL to a stale request's id, and one counter across the app
 * guarantees that for free.
 */
let nextSeq = 1;

const docField = StateField.define<DocState | null>({
	create: () => null,
	update(value, tr) {
		// Any caret move or edit invalidates the anchor AND the question, so the
		// tooltip goes - the same rule the completion tooltip follows. Checked before
		// the effects so an effect dispatched in a transaction of its own always wins.
		if (value && (tr.docChanged || tr.selection)) value = null;
		for (const e of tr.effects) if (e.is(setDocState)) value = e.value;
		return value;
	},
	provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null)
});

/**
 * True while the kernel documentation tooltip is on screen.
 *
 * This is what `Cell.editorOverlayOpen()` folds in beside the completion popup and
 * the search panel, so the notebook's window-capture keydown handler yields Escape
 * to the editor before taking the user to command mode.
 */
export function docTooltipOpen(state: EditorState): boolean {
	return !!state.field(docField, false);
}

/**
 * Close the tooltip. Returns false when there is nothing to close, which is what
 * lets Escape fall through to the notebook's own command-mode shortcut.
 */
export function closeDocTooltip(view: EditorView): boolean {
	if (!view.state.field(docField, false)) return false;
	view.dispatch({ effects: setDocState.of(null) });
	return true;
}

/**
 * One immutable tooltip state, with its `Tooltip` built ONCE.
 *
 * CodeMirror diffs tooltips by identity, so producing a fresh `Tooltip` object per
 * state read would tear the DOM down and rebuild it on every transaction - losing
 * the scroll position of a long docstring, among other things. Building it here and
 * storing it means the DOM is rebuilt exactly when the CONTENT changes.
 */
function build(state: Omit<DocState, 'tooltip'>): DocState {
	const tooltip: Tooltip = {
		pos: state.pos,
		above: true,
		// Not `strictSide`: a docstring is tall, so let CodeMirror flip it below the
		// caret rather than clip it against the top of the viewport.
		strictSide: false,
		arrow: false,
		create: () => ({ dom: renderDom(state) })
	};
	return { ...state, tooltip };
}

function renderDom(state: Omit<DocState, 'tooltip'>): HTMLElement {
	const dom = document.createElement('div');
	dom.className = DOC_TOOLTIP_CLASS;
	dom.dataset.testid = DOC_TOOLTIP_TESTID;
	// The caret stays in the editor, so nothing focuses this: `aria-live` is what
	// makes a screen reader announce an answer the user explicitly asked for.
	dom.setAttribute('role', 'tooltip');
	dom.setAttribute('aria-live', 'polite');
	// The tooltip is a 22em SCROLL BOX (`.cm-cellar-doc` sets `overflow: auto`), so a
	// mousedown inside it - dragging the scrollbar to read a long docstring - would
	// otherwise move focus off `.cm-content`, fire `blur`, and dismiss the very thing
	// being read. `@codemirror/autocomplete` guards its own list the same way
	// ("Prevent focus change when clicking the scrollbar"): cancel the default so
	// focus never leaves the editor. A genuine blur - clicking another cell, tabbing
	// away - is untouched and still closes it.
	dom.addEventListener('mousedown', (e) => e.preventDefault());
	const body = document.createElement('pre');
	body.className = `${DOC_TOOLTIP_CLASS}-body`;
	body.textContent = state.text ?? state.message ?? 'Looking up documentation…';
	dom.appendChild(body);
	// Offered only when a second press really would show more. A hint that lies is
	// worse than none, so it is absent at detail 1 and while a request is in flight.
	if (state.text != null && state.detail === 0 && !state.pending) {
		const more = document.createElement('div');
		more.className = `${DOC_TOOLTIP_CLASS}-more`;
		more.dataset.testid = DOC_TOOLTIP_MORE_TESTID;
		more.textContent = 'Shift+Tab again for the full documentation';
		dom.appendChild(more);
	}
	return dom;
}

/**
 * Shift+Tab: open the tooltip, or expand the one already open.
 *
 * Returns false ONLY when there is no kernel handle at all (a markdown, SQL, raw,
 * or chat cell, or any cell of a Mojo notebook), so the keystroke keeps its default behaviour there instead of
 * being swallowed by a feature that does not apply. Every other outcome - including
 * every refusal - is handled, because the tooltip states it.
 */
export function showKernelDocs(view: EditorView, handle: KernelIntrospectHandle | null): boolean {
	if (!handle) return false;
	const current = view.state.field(docField, false) ?? null;
	// A press while a request is in flight is a no-op rather than a second request:
	// the answer is already coming, and firing again would put two replies in a race
	// whose loser silently overwrites the winner.
	if (current?.pending) return true;
	// Already fully expanded: keep it on screen and ask nothing more. Classic Jupyter
	// escalates further here (into its pager); Cellar deliberately stops at the two
	// levels `inspect_request` itself defines.
	if (current && current.detail === 1 && current.text != null) return true;
	const detail: 0 | 1 = current && current.text != null ? 1 : 0;
	const pos = view.state.selection.main.head;
	const seq = nextSeq++;
	// Keep the text already on screen while expanding: replacing a rendered docstring
	// with "Looking up…" for the length of a round trip makes the second press feel
	// like it lost the answer rather than adding to it.
	const shown = build({
		pos,
		detail,
		text: detail === 1 ? (current?.text ?? null) : null,
		message: null,
		pending: true,
		seq
	});
	view.dispatch({ effects: setDocState.of(shown) });

	const code = view.state.doc.toString();
	// Code points, not UTF-16 units - see `toCodePointOffset`.
	void handle
		.inspect(code, toCodePointOffset(code, pos), detail)
		.then((outcome) => {
			if (!outcome.ok) return finish(view, seq, pos, detail, null, refusalMessage(outcome.reason));
			if (!outcome.found || !outcome.text.trim())
				return finish(view, seq, pos, detail, null, 'No documentation found for the object at the cursor.');
			finish(view, seq, pos, outcome.detail, outcome.text.replace(/\s+$/, ''), null);
		})
		.catch((err: unknown) => finish(view, seq, pos, detail, null, transportMessage(err)));
	return true;
}

/**
 * The sentence for a request that never reached the server at all.
 *
 * Distinct from every `IntrospectRefusal`, which is a verdict the SERVER reached:
 * here nothing was observed about the kernel, so nothing may be claimed about it -
 * the same rule the notebook's other "no verdict" paths follow.
 */
function transportMessage(err: unknown): string {
	return err instanceof DOMException && err.name === 'AbortError'
		? 'The lookup was cancelled.'
		: 'Cellar could not reach the server to ask the kernel.';
}

/**
 * Apply a reply, but only while it still owns the tooltip. The field is nulled by
 * any caret move or edit, and a newer press takes a newer `seq`, so a slow reply
 * arriving after either can never repaint a tooltip that has moved on.
 */
function finish(
	view: EditorView,
	seq: number,
	pos: number,
	detail: 0 | 1,
	text: string | null,
	message: string | null
): void {
	const current = view.state.field(docField, false);
	if (!current || current.seq !== seq) return;
	view.dispatch({ effects: setDocState.of(build({ pos, detail, text, message, pending: false, seq })) });
}

/**
 * The extension: the tooltip state plus its dismissal rules.
 *
 * It takes no handle - `showKernelDocs` is passed one per press, so a notebook that
 * had no kernel when its editor was built gets one on its first run with nothing
 * here to re-wire.
 */
export const kernelDocTooltip: Extension = [
	docField,
	// `Prec.highest` so this Escape beats CodeMirror's own bindings, exactly as
	// `completionKeymap` is registered. It returns false with nothing open, so
	// Escape still reaches the notebook's command-mode shortcut.
	Prec.highest(keymap.of([{ key: 'Escape', run: closeDocTooltip }])),
	EditorView.domEventHandlers({
		blur: (_event, view) => {
			closeDocTooltip(view);
			return false;
		}
	})
];
