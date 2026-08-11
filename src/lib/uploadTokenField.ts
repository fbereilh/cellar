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
 */

import { insertUploadToken } from '$lib/databricksUploadName';

export function insertTokenIntoField(
	el: HTMLInputElement | null,
	current: string,
	token: string,
	apply: (value: string) => void
): void {
	const { value, caret } = insertUploadToken(current, token, el?.selectionStart, el?.selectionEnd);
	apply(value);
	if (!el) return;
	el.value = value;
	el.focus();
	el.setSelectionRange(caret, caret);
}
