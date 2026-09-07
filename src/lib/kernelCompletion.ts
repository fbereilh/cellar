/**
 * Cellar - CodeMirror completion backed by the LIVE kernel.
 *
 * `@codemirror/lang-python` already supplies two completion sources: names it can
 * see in THIS cell's syntax tree, and Python's builtins. Neither can know what is
 * actually alive in the kernel - a variable a cell created when it ran, a module
 * imported three cells up, the columns of a DataFrame - and both bail outright
 * after a dot (`PropertyName` is in their `dontComplete` list), so attribute
 * completion is unserved today. This adds a THIRD source that asks the kernel.
 *
 * IT IS ADDED BESIDE THEM, NEVER INSTEAD OF THEM, and both halves of that matter:
 *
 *  - A name typed in a cell that has NOT been run exists only in the file, so the
 *    file-local source is the only one that knows it. Replacing the sources with
 *    the kernel's would lose exactly the names a user is in the middle of writing.
 *  - With no kernel (or a busy one) the kernel source returns null and the editor
 *    behaves exactly as it did before this feature existed.
 *
 * The cost of merging is duplicates, and CodeMirror already solves it: `sortOptions`
 * drops an option whose label, `detail`, `apply`, `boost` AND `type` all match one
 * already emitted (a null `type` on either side counts as a match). That is the
 * whole reason the options built here carry ONLY `label` and a MAPPED `type` - see
 * `completionType`. Adding a `detail` ("from the kernel") or a `boost` to rank
 * kernel matches first would defeat the dedupe and show `print` twice.
 */

import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import {
	completionType,
	toCodePointOffset,
	fromCodePointOffset,
	type KernelIntrospectHandle
} from '$lib/kernelIntrospect';

/**
 * Fire without an explicit request only when the caret sits just after something
 * completable: an identifier character or the dot that opens an attribute.
 *
 * Deliberately narrow. This source is the one thing here that runs at keystroke
 * frequency, and a request per character typed inside prose or a string literal
 * would be a round trip per keystroke for an answer nobody asked for. Tab
 * (`explicit`) bypasses it entirely, which is what keeps IPython's path completion
 * inside `open('` reachable.
 */
const COMPLETABLE_BEFORE = /[\w.]$/;

/**
 * Once the kernel has answered, typing more identifier characters filters the list
 * locally instead of asking again. This is what `@codemirror/lang-python` does and
 * what keeps `pandas.` -> `pandas.read_c` to one request rather than seven; IPython
 * returns the complete set of matches for a prefix, so filtering down is exact.
 */
const VALID_FOR = /^[\w$]*$/;

/**
 * Is a Tab at `pos` a COMPLETION gesture, or should it keep its default meaning?
 *
 * Jupyter's rule, and it is what makes binding Tab admissible at all: completion
 * needs something before the caret to complete. With only whitespace (or nothing)
 * between the line start and the caret, Tab is NOT a completion gesture, the
 * notebook's action reports NOT HANDLED, and the keystroke keeps doing exactly what
 * it did before this feature existed - moving focus out of the editor. That is the
 * keyboard user's way out, and without it Tab would trap them in a cell.
 *
 * Deliberately WIDER than `COMPLETABLE_BEFORE`, which decides whether to ask the
 * kernel while merely TYPING. A Tab after `open('` is an explicit request and
 * reaches IPython's path completion; a keystroke inside a string is not.
 */
export function tabStartsCompletion(state: EditorState, pos: number): boolean {
	const line = state.doc.lineAt(pos);
	return state.sliceDoc(line.from, pos).trim().length > 0;
}

/**
 * A completion source that asks `getHandle()`'s kernel, or does nothing when there
 * is none.
 *
 * `getHandle` is read per query rather than captured, because a cell's editor
 * outlives any one value of the prop: a notebook that had no kernel when the editor
 * was built gets one on its first run, and windowing can rebuild the Cell around a
 * living editor.
 */
export function kernelCompletionSource(getHandle: () => KernelIntrospectHandle | null): CompletionSource {
	return async (context: CompletionContext): Promise<CompletionResult | null> => {
		const handle = getHandle();
		if (!handle) return null;
		const doc = context.state.doc;
		if (!context.explicit) {
			const before = doc.sliceString(Math.max(0, context.pos - 1), context.pos);
			if (!COMPLETABLE_BEFORE.test(before)) return null;
		}
		const code = doc.toString();
		// An HTTP request the query can outlive: CodeMirror aborts a stale query, and
		// without this the fetch would run to completion for a caret nobody is at.
		const abort = new AbortController();
		context.addEventListener('abort', () => abort.abort());
		// The protocol counts `cursor_pos` in unicode CODE POINTS while a CodeMirror
		// offset is in UTF-16 code units, so anything astral earlier in the cell (an
		// emoji in a comment is enough) would shift every offset the kernel reads.
		let outcome: Awaited<ReturnType<KernelIntrospectHandle['complete']>>;
		try {
			outcome = await handle.complete(code, toCodePointOffset(code, context.pos), abort.signal);
		} catch {
			// The handle THROWS for a no-verdict transport failure (a rejected or aborted
			// fetch, a reply that is not the route's own shape) as opposed to a refusal
			// the server reached. Both end the same way here - see below.
			return null;
		}
		if (context.aborted) return null;
		// EVERY failure is silent here - no kernel, a busy one, a timeout, an
		// unreachable server. This runs on a keystroke and the file-local sources have
		// already answered; surfacing a reason would be noise on the one path that must
		// never interrupt typing. The Shift+Tab tooltip is where it is worth stating,
		// because there the user asked a direct question and silence would read as a
		// broken key.
		if (!outcome.ok || outcome.matches.length === 0) return null;
		const range = replacementRange(outcome.cursorStart, outcome.cursorEnd, code, context.pos, doc.length);
		if (!range) return null;
		const options: Completion[] = outcome.matches.map((m) => {
			const type = completionType(m.type);
			// Only ever `label` + `type` - see the header: anything else defeats
			// CodeMirror's cross-source dedupe and shows a builtin twice.
			return type ? { label: m.text, type } : { label: m.text };
		});
		return { from: range.from, to: range.to, options, validFor: VALID_FOR };
	};
}

/**
 * The kernel's `cursor_start`/`cursor_end` translated back into editor offsets, or
 * null when they cannot be trusted.
 *
 * The protocol's own answer to "what does this completion replace" is strictly
 * better than re-deriving a word boundary here - it is what makes `os.pa` replace
 * only `pa` and `t.` insert at the caret. But it arrives over the wire from a
 * kernel Cellar does not control, so a range that is inverted or outside the
 * document is REFUSED rather than clamped: a clamp would silently rewrite a
 * different span of the user's code than the kernel meant.
 */
function replacementRange(
	cursorStart: number,
	cursorEnd: number,
	code: string,
	pos: number,
	docLength: number
): { from: number; to: number } | null {
	if (!Number.isInteger(cursorStart) || !Number.isInteger(cursorEnd)) return null;
	const from = fromCodePointOffset(code, cursorStart);
	const to = fromCodePointOffset(code, cursorEnd);
	if (from == null || to == null) return null;
	if (from > to || to > docLength) return null;
	// The end must not sit past the caret: CodeMirror would then apply a completion
	// over text the user typed after the request went out.
	if (to > pos) return null;
	return { from, to };
}

/**
 * The extension form: registers the source as language data for THIS editor only.
 *
 * `EditorState.languageData` rather than `pythonLanguage.data.of(...)` because the
 * latter is a process-wide singleton - every editor in the app would get one
 * notebook's kernel. This contributes alongside the language's own sources, so
 * `autocompletion()` (already in `basicSetup`) collects all three.
 *
 * The source object is created ONCE per extension so its identity is stable:
 * `autocompletion` reuses an active source by reference across transactions, and a
 * fresh function each time would restart the query on every keystroke.
 */
export function kernelCompletion(getHandle: () => KernelIntrospectHandle | null): Extension {
	const source = kernelCompletionSource(getHandle);
	const data = [{ autocomplete: source }];
	return EditorState.languageData.of(() => data);
}
