/**
 * The DOM half of a token control: put `token` into an affix INPUT at its caret.
 *
 * The rule itself is `insertUploadToken` (pure, in `$lib/databricksUploadName`,
 * which stays import-free because the server reads it too). What lives here is the
 * glue that rule cannot own - reading the caret off the element, writing the node
 * and putting the caret back - which the sidebar's affix fields and the Settings
 * pane's defaults were carrying as two line-for-line copies. It is shared across two
 * different-LOOKING controls (the sidebar's per-field dropdown, Settings' chips)
 * precisely because the gesture is the same one; only the persist path differs.
 * Both writes matter: the inputs are `value=`-bound rather than two-way, so Svelte
 * will not re-render an element it already agrees with, and without restoring the
 * selection a second insertion would land past the first instead of continuing where
 * the user was.
 *
 * `apply` is the caller's own persist path (per-project affix vs cross-project
 * default), so the two keep their different storage rules while sharing the gesture.
 *
 * **A field nobody has edited APPENDS, and that takes a marker rather than the
 * offset.** `insertUploadToken` documents a missing caret as "the field is not being
 * edited", and the DOM cannot say that with a number: a never-focused input reports
 * `selectionStart === 0`, exactly like a caret the user deliberately put at the
 * start. So an affix seeded from the cross-project default was PREPENDED into -
 * picking `{YYYYMMDD}` beside a `_final` postfix nobody had clicked produced
 * `{YYYYMMDD}_final` - while a real caret at 0 must still insert at 0. Reading
 * `document.activeElement` cannot tell them apart either: reaching for the token
 * control takes focus off the field in both cases. What distinguishes them is
 * whether the field has EVER been focused, which only a listener present at that
 * moment can know - hence the `tokenField` action below, and hence the marker lives
 * here beside its one reader rather than as a boolean each surface keeps for itself.
 */

import { insertUploadToken } from '$lib/databricksUploadName';

/**
 * The affix inputs a user has focused at least once, i.e. the ones whose caret is a
 * position they chose. A `WeakSet` because the entry is a fact about a live element
 * and must die with it - a Map keyed by field name would outlive the node and answer
 * for its replacement.
 */
const edited = new WeakSet<HTMLInputElement>();

/**
 * Svelte action for an affix input: record it as edited once it has been focused.
 *
 * Applied at every affix field so that no surface has to remember the rule, and safe
 * to leave off: an unmarked field simply reads as not-being-edited, which is the
 * appending (and therefore non-destructive) direction.
 */
export function tokenField(node: HTMLInputElement) {
	const mark = () => edited.add(node);
	node.addEventListener('focus', mark);
	return {
		destroy() {
			node.removeEventListener('focus', mark);
		}
	};
}

/**
 * The caret to insert at, or nothing when the field is not being edited. `insertTokenIntoField`
 * focuses the element it writes to, so every field is marked from its first insert on
 * and a second pick continues where the first one left the caret.
 */
function caretOf(el: HTMLInputElement | null): [number | null | undefined, number | null | undefined] {
	if (!el || !edited.has(el)) return [undefined, undefined];
	return [el.selectionStart, el.selectionEnd];
}

export function insertTokenIntoField(
	el: HTMLInputElement | null,
	current: string,
	token: string,
	apply: (value: string) => void
): void {
	const [start, end] = caretOf(el);
	const { value, caret } = insertUploadToken(current, token, start, end);
	apply(value);
	if (!el) return;
	el.value = value;
	el.focus();
	el.setSelectionRange(caret, caret);
}
