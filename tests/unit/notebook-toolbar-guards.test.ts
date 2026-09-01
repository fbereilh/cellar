/**
 * Source guards for the notebook toolbar's four whole-notebook actions.
 *
 * WHAT THESE PROVE, AND WHAT THEY DO NOT. vitest runs without the SvelteKit
 * plugin (see `vitest.config.ts`), so `Notebook.svelte` cannot be mounted here —
 * these read the component source, so they can only witness that the wiring is
 * DECLARED, never that it behaves. The behavioural proof (the buttons render,
 * gate on real state, and really interrupt a batch / clear every cell's outputs
 * on disk) is `tests/e2e/toolbar-interrupt-clear-all.spec.ts`, against a real
 * kernel. These stay in the unit suite only because e2e runs in neither CI nor
 * the no-mistakes gate, so without them the two invariants below could regress
 * and merge green.
 *
 * Deliberately narrow: only what raw source text can honestly carry and what
 * survives a behaviour-preserving refactor — the controls exist and are
 * labelled, and the clear-all button reaches the SAME function the palette's
 * `clear-all-outputs` command does. Assertions on exact expressions (a
 * `$derived` line, an `onclick` body) belong to the e2e, not here: they break on
 * a rename and pass on dead code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOTEBOOK = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');
const LIVE = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');

const TOOLBAR_ACTIONS = ['run-all', 'interrupt-all', 'clear-all-outputs', 'consolidate-imports'];

const NAVBAR = readFileSync(join(process.cwd(), 'src/lib/Navbar.svelte'), 'utf8');

/** The `<button …>` element whose `data-testid` is `id`. */
function buttonWith(testid: string): string {
	const marker = `data-testid="${testid}"`;
	const at = NOTEBOOK.indexOf(marker);
	expect(at, `no control carries data-testid="${testid}"`).toBeGreaterThan(-1);
	const open = NOTEBOOK.lastIndexOf('<button', at);
	const close = NOTEBOOK.indexOf('</button>', at);
	expect(open, `data-testid="${testid}" is not on a <button>`).toBeGreaterThan(-1);
	expect(close).toBeGreaterThan(at);
	return NOTEBOOK.slice(open, close);
}

/**
 * The source of the `<tag>` element opening at `open`, balanced by nesting.
 *
 * Deliberately THROWS when the element is never closed rather than falling back
 * to a fixed-size window: a silently widened region would let "these buttons are
 * in the toolbar" start passing on markup from outside it.
 */
function elementBlock(source: string, tag: string, open: number): string {
	const token = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
	token.lastIndex = open;
	let depth = 0;
	for (let m = token.exec(source); m; m = token.exec(source)) {
		depth += m[0][1] === '/' ? -1 : 1;
		if (depth === 0) return source.slice(open, token.lastIndex);
	}
	throw new Error(`<${tag}> holding the notebook toolbar is never closed; the block moved`);
}

/** The toolbar element itself, bounded by its own closing tag. */
const TOOLBAR = (() => {
	const at = NOTEBOOK.indexOf('data-testid="notebook-toolbar"');
	expect(at, 'the notebook toolbar is gone').toBeGreaterThan(-1);
	const open = NOTEBOOK.lastIndexOf('<div', at);
	expect(open, 'data-testid="notebook-toolbar" is not on a <div>').toBeGreaterThan(-1);
	return elementBlock(NOTEBOOK, 'div', open);
})();

/** The balanced `open`..`close` span starting at `from` (which must be `open`). */
function balanced(source: string, from: number, open: string, close: string): string {
	let depth = 0;
	for (let i = from; i < source.length; i++) {
		const c = source[i];
		if (c === open) depth++;
		else if (c === close && --depth === 0) return source.slice(from, i + 1);
	}
	throw new Error(`unbalanced ${open}${close} from offset ${from}`);
}

/** Top-level property names of an object-literal source (`{ a, b: c }` -> a, b). */
function propertyNames(objectLiteral: string): string[] {
	const body = objectLiteral.slice(1, -1);
	const names: string[] = [];
	let depth = 0;
	let start = 0;
	const take = (end: number) => {
		const part = body.slice(start, end).trim();
		start = end + 1;
		if (!part) return;
		const key = part.split(':')[0].trim().replace(/^['"]|['"]$/g, '');
		if (/^[A-Za-z_$][\w$]*$/.test(key)) names.push(key);
	};
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '{' || c === '(' || c === '[') depth++;
		else if (c === '}' || c === ')' || c === ']') depth--;
		else if (c === ',' && depth === 0) take(i);
	}
	take(body.length);
	return names;
}

/** The property names of the API object THIS notebook registers with the shell. */
function registeredApiProps(): string[] {
	const call = 'onRegisterApi?.(';
	const at = LIVE.indexOf(call);
	expect(at, 'LiveNotebook no longer registers a notebook API').toBeGreaterThan(-1);
	const args = balanced(LIVE, at + call.length - 1, '(', ')');
	const brace = args.indexOf('{');
	expect(brace, 'the registered notebook API is not an object literal').toBeGreaterThan(-1);
	return propertyNames(balanced(args, brace, '{', '}'));
}

describe('notebook toolbar: the three whole-notebook actions', () => {
	it('renders Run all, Interrupt, Clear all outputs and Consolidate imports together', () => {
		for (const id of TOOLBAR_ACTIONS) {
			expect(TOOLBAR, `${id} is not in the toolbar`).toContain(`data-testid="${id}"`);
		}
	});

	it('gives each button a title and an aria-label', () => {
		for (const id of TOOLBAR_ACTIONS) {
			const btn = buttonWith(id);
			expect(btn, `${id} has no title`).toMatch(/title="/);
			expect(btn, `${id} has no aria-label`).toMatch(/aria-label="/);
		}
	});
});

describe('LiveNotebook wiring', () => {
	it('passes the palette command`s own clearAll in as onClearAll', () => {
		expect(LIVE).toContain('onClearAll={clearAll}');
		// The same function the `clear-all-outputs` command reaches through the
		// notebook API registry, so the button and the palette cannot diverge. It
		// has to be a PROPERTY of the registered object, not merely a mention.
		expect(
			registeredApiProps(),
			'clearAll is not a property of the API object handed to onRegisterApi'
		).toContain('clearAll');
	});

	it('passes the existing kernel interrupt in as onInterrupt', () => {
		expect(LIVE).toContain('onInterrupt={onInterruptKernel}');
	});

	// The shell owns the consolidate request (it is a fetch, not notebook state), so
	// LiveNotebook only forwards it — the same shape as onInterruptKernel. Both the
	// handler and its busy flag have to reach the toolbar, since the flag is what
	// stops a second click.
	it('forwards the shell`s consolidate handler and its busy flag to the toolbar', () => {
		expect(LIVE).toContain('onConsolidateImports={onConsolidateImports}');
		expect(LIVE).toContain('consolidating={consolidating}');
	});
});

/**
 * An action promoted to the toolbar LEAVES the navbar Options menu rather than
 * living in both: Run all / Interrupt / Clear all outputs have always been toolbar
 * + palette only, and Consolidate imports now follows them. The palette twin is
 * unaffected either way — this is about the two POINTED surfaces not carrying the
 * same button one click apart.
 */
describe('one pointed surface per action', () => {
	it('keeps every toolbar action out of the navbar Options menu', () => {
		for (const id of TOOLBAR_ACTIONS) {
			expect(NAVBAR, `${id} is in BOTH the toolbar and the Options menu`).not.toContain(
				`data-testid="${id}"`
			);
		}
	});

	it('still offers Consolidate imports from the command palette', () => {
		const commands = readFileSync(join(process.cwd(), 'src/lib/commands.ts'), 'utf8');
		expect(commands).toContain("'consolidate-imports'");
	});
});
