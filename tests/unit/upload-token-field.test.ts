// @vitest-environment jsdom
/**
 * The shared caret glue behind every upload-affix token control - the sidebar's
 * per-field dropdowns and the Settings pane's chips both write through it.
 *
 * The rule it owns and that nothing else can: a field NOBODY HAS EDITED appends,
 * while a caret the user really put at the start still inserts at the start.
 *
 * The offset cannot decide that, because for a never-focused field it is not a fact
 * about the user at all - it is a fact about how the value ARRIVED. Setting `.value`
 * moves the cursor to the end (so a pick appended by luck), while a value that came
 * down as an `value=` ATTRIBUTE - server-rendered markup that hydration then leaves
 * alone, since Svelte's own `set_value` returns early when the property already
 * agrees - leaves it at 0, indistinguishable from a caret the user put there. A
 * cross-project default postfix `_final` was then PREPENDED into: picking
 * `{YYYYMMDD}` beside a field nobody had clicked produced `{YYYYMMDD}_final`. Both
 * shapes are pinned below, and so is the opposite direction, because a fix reading
 * "offset 0 means append" would just trade this surprise for its mirror image.
 *
 * Real elements in jsdom rather than a fake: the whole question is what the DOM
 * reports for an input in a state a stub would simply be told to have.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertTokenIntoField, tokenField } from '$lib/uploadTokenField';

/**
 * An affix input holding `value`, populated the way a CLIENT-mounted one is (the
 * `.value` property, which also drags the cursor to the end).
 */
function field(value: string): HTMLInputElement {
	const el = document.createElement('input');
	el.value = value;
	document.body.appendChild(el);
	// What every affix input carries in the markup, so the element under test is in the
	// state the components put it in.
	tokenField(el);
	return el;
}

/**
 * The same field as it arrives from SERVER-RENDERED markup: the value is the
 * attribute, so the cursor really is reported at 0 with nobody having touched it.
 */
function hydratedField(value: string): HTMLInputElement {
	document.body.insertAdjacentHTML('beforeend', `<input value="${value}">`);
	const el = document.body.lastElementChild as HTMLInputElement;
	tokenField(el);
	return el;
}

/** The one call shape both surfaces use: element, its current text, the token. */
function insert(el: HTMLInputElement | null, current: string, token: string): string {
	let stored = current;
	insertTokenIntoField(el, current, token, (v) => (stored = v));
	return stored;
}

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('a field that has never been edited appends', () => {
	it('appends into an affix seeded from the cross-project default', () => {
		// The reported shape: a postfix arrives pre-populated from the Settings default
		// and the user reaches straight for the dropdown. Nothing focused it, so there is
		// no position to speak of and "add this on" means the end.
		const el = field('_final');
		expect(insert(el, '_final', '{YYYYMMDD}')).toBe('_final{YYYYMMDD}');
	});

	it('appends even where the DOM reports offset 0 for such a field', () => {
		// The trap in one line: server-rendered, the offset is indistinguishable from a
		// real caret at the start, so anything reading it alone gets this case wrong.
		const el = hydratedField('_final');
		expect(el.selectionStart).toBe(0);
		expect(insert(el, '_final', '{DD}')).toBe('_final{DD}');
	});

	it('appends when there is no element at all', () => {
		expect(insert(null, '_final', '{YYYY}')).toBe('_final{YYYY}');
	});
});

describe('a caret the user chose is honoured, including at the start', () => {
	it('inserts at 0 when the field was focused and the caret really is there', () => {
		const el = field('_final');
		el.focus();
		el.setSelectionRange(0, 0);
		expect(insert(el, '_final', '{YYYYMMDD}')).toBe('{YYYYMMDD}_final');
	});

	it('inserts mid-string at the caret', () => {
		const el = field('ab');
		el.focus();
		el.setSelectionRange(1, 1);
		expect(insert(el, 'ab', '{MM}')).toBe('a{MM}b');
	});

	it('replaces a selected range', () => {
		const el = field('old');
		el.focus();
		el.setSelectionRange(0, 3);
		expect(insert(el, 'old', '{YYYY}')).toBe('{YYYY}');
	});

	it('continues where the previous pick left the caret', () => {
		// The first insert focuses the field, so from then on it IS being edited - which
		// is what makes two picks compose instead of both appending by accident.
		const el = field('');
		expect(insert(el, '', '{YYYY}')).toBe('{YYYY}');
		el.setSelectionRange(0, 0);
		expect(insert(el, '{YYYY}', '{DD}')).toBe('{DD}{YYYY}');
	});

	it('writes the element and leaves the caret past what it inserted', () => {
		const el = field('_final');
		insert(el, '_final', '{DD}');
		expect(el.value).toBe('_final{DD}');
		expect(el.selectionStart).toBe('_final{DD}'.length);
	});
});

describe('the marker is a fact about the element, not about the field name', () => {
	it('does not carry a focus from one element to its replacement', () => {
		const first = field('_final');
		first.focus();
		first.setSelectionRange(0, 0);
		const second = field('_final');
		// A remount is a different node with no history, so it appends.
		expect(insert(second, '_final', '{YYYY}')).toBe('_final{YYYY}');
	});

	it('stops marking once the action is destroyed', () => {
		const el = document.createElement('input');
		document.body.appendChild(el);
		tokenField(el).destroy();
		el.focus();
		expect(insert(el, '_final', '{YYYY}')).toBe('_final{YYYY}');
	});
});

describe('every affix input is marked', () => {
	// The helper degrades safely when a field is unmarked (it appends), but silently -
	// so a field that forgot the action would quietly stop honouring its own caret.
	// vitest runs without the SvelteKit plugin, so the wiring gets a source guard.
	const inputs: [string, string[]][] = [
		['src/lib/Databricks.svelte', ['uploadPrefixEl', 'uploadPostfixEl']],
		['src/lib/Settings.svelte', ['prefixDefaultEl', 'postfixDefaultEl']]
	];

	for (const [file, bindings] of inputs) {
		const src = readFileSync(join(process.cwd(), file), 'utf8');
		for (const binding of bindings) {
			it(`${file} marks the ${binding} field`, () => {
				expect(src).toMatch(new RegExp(`bind:this=\\{${binding}\\}\\s+use:tokenField\\b`));
			});
		}
	}
});
