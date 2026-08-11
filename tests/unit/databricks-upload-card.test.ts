/**
 * Four rules about the Databricks sidebar's **upload** UI that live in the component,
 * and therefore cannot be mounted here (vitest runs without the SvelteKit plugin - see
 * `vitest.config.ts`). Their behavioural proof is `tests/e2e/databricks-upload.spec.ts`,
 * which neither CI nor the no-mistakes gate runs, so the call sites are pinned here too
 * - the `upload-default-guards` / `shell-refresh-handlers` precedent.
 *
 *   1. The upload is its OWN card, not a row inside the cluster/connection card. It
 *      acts on workspace FILES and never on compute, and it carries enough of its own
 *      controls (two fields, their token dropdowns, a preview and a two-step replace
 *      confirm) that nested under Switch/Disconnect they read as more connection
 *      controls.
 *
 *   2. A token picked from an affix's dropdown is read BEFORE that dropdown is reset.
 *      The select holds no state - it is an action - so it must snap back to its
 *      placeholder or the same token cannot be picked twice running (no `change` fires
 *      when the value does not move) and the closed control reads as a setting. Reset
 *      first and the insert receives an empty string: the pick silently does nothing.
 *
 *   3. A pick INSERTS into the affix rather than replacing it. That is what keeps both
 *      fields free text: a token lands beside whatever is typed, and an affix built by
 *      hand is never overwritten by reaching for one token.
 *
 *   4. Only an EXPLICIT pick inserts. A closed select fires `change` on every arrow
 *      key on Windows and Linux, so committing on the bare event let merely tabbing
 *      to the control and pressing Down write a token nobody chose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = readFileSync(join(process.cwd(), 'src/lib/Databricks.svelte'), 'utf8');

/**
 * The `{#snippet name(...)}…{/snippet}` body, matched by its own `{/snippet}` rather
 * than by a line count, so the guard survives the block being reshuffled inside.
 * Snippets do not nest in this file, so the first close is this snippet's own.
 */
function snippetBody(src: string, name: string): string {
	const open = src.indexOf(`{#snippet ${name}(`);
	expect(open, `snippet not found: ${name}`).toBeGreaterThan(-1);
	const close = src.indexOf('{/snippet}', open);
	expect(close, `snippet never closed: ${name}`).toBeGreaterThan(-1);
	return src.slice(open, close);
}

/**
 * The brace-balanced block opening at `marker`'s first `{`, for the markup blocks that
 * are not snippets (the connected-card `<div>` is delimited by markup, so the balanced
 * scan runs over the element instead - see `connectedCard`).
 */
function elementAt(src: string, marker: string): string {
	const start = src.indexOf(marker);
	expect(start, `anchor not found: ${marker}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src.startsWith('<div', i)) depth++;
		else if (src.startsWith('</div>', i)) {
			depth--;
			if (depth === 0) return src.slice(start, i + 6);
		}
	}
	throw new Error(`unbalanced element at anchor: ${marker}`);
}

/**
 * The brace-balanced body of the function whose signature is `signature`.
 *
 * By balance rather than by "the `}` after some call inside it": these handlers now
 * call each other, so an index-of on a shared call string can land in a SIBLING and
 * silently yield an empty slice - a guard that then asserts nothing while passing.
 * None of these bodies carries a brace inside a string, so the scan is exact.
 */
function functionAt(src: string, signature: string): string {
	const start = src.indexOf(signature);
	expect(start, `function not found: ${signature}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced function: ${signature}`);
}

/** `src` with its `//` comments dropped - see `upload-default-guards` for why. */
function codeOnly(src: string): string {
	return src.replace(/^\s*\/\/.*$/gm, '');
}

/** …and the HTML-comment equivalent, for markup blocks whose prose names old shapes. */
function markupOnly(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '');
}

describe('the upload is its own card, not a row in the cluster card', () => {
	const connectedCard = markupOnly(
		elementAt(PANEL, '<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="databricks-connected">')
	);
	const uploadCard = snippetBody(PANEL, 'uploadCard');

	it('renders the upload as a card, in the same card language as the others', () => {
		// The same shell the Cluster and Runtime cards use. Inventing a second card look
		// for this one would make "separate" read as "unrelated stray box".
		expect(uploadCard).toContain('rounded-lg border border-base-300 bg-base-100 p-2.5');
		expect(uploadCard).toContain('data-testid="databricks-upload-card"');
		expect(uploadCard).toContain("{@render cardLabel('upload')}");
	});

	it('is rendered as a SIBLING of the cluster and runtime cards', () => {
		expect(PANEL).toContain('{@render uploadCard()}');
		// Sibling means outside the connection card's own element, which is the whole
		// point: inside it, it is still a row however it is styled.
		expect(connectedCard).not.toContain('{@render uploadCard()}');
		expect(connectedCard).not.toContain('data-testid="databricks-upload"');
	});

	it('leaves the connection card its own controls', () => {
		// The split moves the upload out; it must not take Switch/Disconnect/Log out with
		// it - those ARE connection controls and belong where they were.
		expect(connectedCard).toContain('data-testid="databricks-switch"');
		expect(connectedCard).toContain('data-testid="databricks-disconnect"');
		expect(connectedCard).toContain('{@render logoutRow(true)}');
	});
});

describe('an affix token dropdown is an action, not a value', () => {
	const fn = codeOnly(
		functionAt(PANEL, "function commitUploadToken(which: 'prefix' | 'postfix', el: HTMLSelectElement) {")
	);

	it('reads the picked token BEFORE resetting the select', () => {
		const read = fn.indexOf('const token = el.value;');
		const reset = fn.indexOf("el.value = '';");
		const insert = fn.indexOf('insertUploadDateToken(which, token)');
		expect(read, 'the pick no longer reads the select').toBeGreaterThan(-1);
		expect(reset, 'the select is never reset - the same token cannot be picked twice').toBeGreaterThan(-1);
		expect(insert, 'the pick no longer inserts').toBeGreaterThan(-1);
		// Ordering is the whole rule: reset first and `token` is the empty placeholder,
		// so every pick silently does nothing.
		expect(read).toBeLessThan(reset);
		expect(reset).toBeLessThan(insert);
	});
});

/**
 * Rule 4, learned from the swap itself: a `change` is not by itself a pick. Arrowing
 * over a CLOSED select changes its value and fires `change` per press on Windows and
 * Linux, so committing on the bare event made merely tabbing to this control and
 * pressing Down insert a token nobody chose - something the row of buttons it
 * replaced could never do. The keyboard half is the dangerous direction to get
 * wrong, so both are pinned: the guard has to stay AND Enter has to keep committing.
 */
describe('a token is inserted only on an explicit pick', () => {
	const change = codeOnly(
		functionAt(PANEL, "function onUploadTokenChange(which: 'prefix' | 'postfix', e: Event) {")
	);
	const keydown = codeOnly(
		functionAt(PANEL, "function onUploadTokenKeydown(which: 'prefix' | 'postfix', e: KeyboardEvent) {")
	);

	it('ignores a change that a key moved a closed select through', () => {
		const guard = change.indexOf('if (uploadTokenKeyNav) return;');
		const commit = change.indexOf('commitUploadToken(');
		expect(guard, 'a bare change commits again - arrowing inserts a token nobody picked').toBeGreaterThan(-1);
		expect(commit).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(commit);
	});

	it('still lets a keyboard user commit, and never holds the flag past the task', () => {
		// Without the Enter path the closed-select flow has no commit at all, which is a
		// worse regression than the one being fixed.
		expect(keydown).toContain("if (e.key === 'Enter')");
		expect(keydown).toContain('commitUploadToken(which, e.currentTarget as HTMLSelectElement);');
		expect(keydown).toContain('uploadTokenKeyNav = true;');
		// Cleared on the NEXT task, never sticky: held across one it would swallow the
		// pick that follows the key which OPENED the option list.
		expect(keydown).toMatch(/setTimeout\(\(\) => \(uploadTokenKeyNav = false\), 0\)/);
	});

	it('wires the keydown on the select itself', () => {
		const select = snippetBody(PANEL, 'tokenSelect');
		expect(select).toContain('onkeydown={(e) => onUploadTokenKeydown(which, e)}');
		expect(select).toContain('onchange={(e) => onUploadTokenChange(which, e)}');
		// Leaving without committing puts the placeholder back, so a token arrowed past
		// is never left sitting in the closed control reading as a setting.
		expect(select).toContain('onblur={onUploadTokenBlur}');
	});
});

describe('a picked token composes with typed text', () => {
	const fn = codeOnly(
		functionAt(PANEL, "function insertUploadDateToken(which: 'prefix' | 'postfix', token: string) {")
	);

	it('inserts at the caret through the shared glue, never assigning the affix outright', () => {
		// `insertTokenIntoField` is the one owner of the caret read/write, shared with the
		// Settings pane's defaults. Replacing the value here would both fork that rule and
		// wipe an affix the user typed by hand.
		expect(fn).toContain('insertTokenIntoField(');
		expect(fn).not.toMatch(/setUploadAffix\(\s*which\s*,\s*token\s*\)/);
	});

	it('refuses the placeholder and a busy panel rather than writing an empty token', () => {
		expect(fn).toContain('if (uploadConfirmBusy || !token) return;');
	});
});
