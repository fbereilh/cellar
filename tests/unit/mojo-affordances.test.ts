/**
 * The Python-only AFFORDANCES a Mojo notebook does not offer.
 *
 * Four were named, and by the time this landed two of them already answered
 * correctly by construction, because they hang off rules the language axis
 * introduced rather than off a check of their own:
 *
 *   1. the STALENESS chips - `computeStaleness` builds its graph over
 *      `hasPythonDataflow`, so a Mojo notebook's cells fall to the `n/a` verdict
 *      and `Cell.svelte` draws neither chip (pinned in `notebook-language.test.ts`
 *      and, end to end, in `notebook-language.spec.ts`);
 *   2. the IMPORTS-CELL role - `notebookUsesImportsCell` already gates the ⋮ menu
 *      item, with the stranded-mark exception below.
 *
 * The remaining two are what this file is about, and they are the two the SHELL
 * owns rather than the notebook: the sidebar's VARIABLE INSPECTOR and the palette
 * twin of the toolbar's CONSOLIDATE IMPORTS.
 *
 * THE HIDE-VS-GREY TEST, which is the thing most likely to be got wrong later.
 * The captain ruled two different ways and they only look inconsistent until the
 * question is stated properly:
 *
 *   - HIDE a control that can never MEAN anything on this notebook and carries no
 *     state of its own. The variable inspector is a live view of the kernel; the
 *     consolidate sweep creates and fills, it never clears. Neither can strand
 *     anything, so both are hidden outright.
 *   - SHOW IT GREYED where STATE the user still has to reach would otherwise be
 *     unreachable. That is the imports MARK on a Mojo notebook (and the export
 *     mark on an ineligible cell): the key sits in the user's committed `.ipynb`
 *     under a badge still asserting it, and the ⋮ item is the one surface that can
 *     retire it. Hidden there, the only remedy is switching the notebook back.
 *
 * That last case is a bug that was already found and fixed once in this exact
 * place, so it is asserted here too rather than left to the file that fixed it.
 *
 * The two REAL document behaviours these hidings rest on - that the sweep is
 * already a no-op on a Mojo notebook, and that a kept imports mark really is
 * clearable there - are pinned over real documents in
 * `notebook-language-document.test.ts` and are deliberately not duplicated.
 *
 * Svelte components cannot be MOUNTED here (vitest runs without the SvelteKit
 * plugin) and e2e runs in neither CI nor the no-mistakes gate, so the component
 * halves are SOURCE guards: they witness that the wiring exists and reaches the
 * shared rule, and they prove no behaviour - which is what the e2e is for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { notebookHasPythonNamespace, MOJO_LANGUAGE } from '../../src/lib/cellLanguage';
import { notebookUsesImportsCell, importsRoleStranded, IMPORTS_ROLE } from '../../src/lib/importsRole';
import { buildCommands, type CommandContext } from '../../src/lib/commands';

const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');

/** A palette context with inert handlers - only WHICH commands are built matters. */
function ctx(over: Partial<CommandContext> = {}): CommandContext {
	const noop = () => {};
	return {
		notebook: { dispatch: noop, runAll: noop, clearAll: noop },
		app: {
			toggleTheme: noop,
			toggleSidebar: noop,
			interruptKernel: noop,
			restartKernel: noop,
			newNotebook: noop,
			consolidateImports: noop,
			openSettings: noop
		},
		...over
	};
}
const ids = (c: CommandContext) => buildCommands(c).map((x) => x.id);

describe('the RULE: does this notebook have a Python namespace to inspect?', () => {
	// Stated over the NOTEBOOK, because there is no per-cell answer to give: the
	// namespace is the kernel's, one per notebook.
	it('a Python notebook does', () => {
		expect(notebookHasPythonNamespace('python')).toBe(true);
	});

	it('a Mojo notebook does NOT - every cell runs in a subprocess whose namespace dies with it', () => {
		expect(notebookHasPythonNamespace(MOJO_LANGUAGE)).toBe(false);
	});

	it('defaults to Python, so every existing caller answers exactly as before', () => {
		expect(notebookHasPythonNamespace()).toBe(true);
	});

	// The sibling rule the consolidate surfaces ask. Both are stated POSITIVELY over
	// the notebook language, so a SEVENTH language is out by construction rather
	// than by remembering a `!== 'mojo'` clause at each surface.
	it('the consolidate rule is the imports-cell one, not a second copy', () => {
		expect(notebookUsesImportsCell('python')).toBe(true);
		expect(notebookUsesImportsCell(MOJO_LANGUAGE)).toBe(false);
	});
});

describe('the palette OMITS Consolidate imports on a Mojo notebook', () => {
	it('lists it for a Python notebook', () => {
		expect(ids(ctx({ offersConsolidateImports: true }))).toContain('consolidate-imports');
	});

	it('drops it entirely for a Mojo notebook - not listed disabled', () => {
		const built = buildCommands(ctx({ offersConsolidateImports: false }));
		expect(built.map((c) => c.id)).not.toContain('consolidate-imports');
		// And nothing else went with it: this is one entry, not a category.
		expect(built.map((c) => c.id)).toContain('new-notebook');
		expect(built.map((c) => c.id)).toContain('open-settings');
	});

	it('an OMITTED flag behaves exactly as before the language axis existed', () => {
		expect(ids(ctx())).toContain('consolidate-imports');
	});

	it('a Python notebook is otherwise byte-for-byte the same command list', () => {
		// The guard that matters most: the ONLY difference between the two lists is
		// the one entry, so hiding it cannot have moved, renamed or re-ordered
		// anything else.
		const python = ids(ctx({ offersConsolidateImports: true }));
		const mojo = ids(ctx({ offersConsolidateImports: false }));
		expect(python.filter((id) => id !== 'consolidate-imports')).toEqual(mojo);
	});

	it('the entry it drops still carries its own handler when shown', () => {
		let called = 0;
		const built = buildCommands(
			ctx({ offersConsolidateImports: true, app: { ...ctx().app, consolidateImports: () => called++ } })
		);
		built.find((c) => c.id === 'consolidate-imports')?.run();
		expect(called).toBe(1);
	});
});

describe('nothing hidden here can strand state the user cannot clear', () => {
	// Criterion 4, asserted directly. Of the four, only the imports ROLE is a
	// per-cell key that survives a language switch (a switch writes to no cell),
	// so it is the only one with anything to strand - and it is precisely the one
	// that is greyed rather than hidden.
	it('a kept imports mark reads as STRANDED, which is what keeps its control on screen', () => {
		const marked = { cell_type: 'code', metadata: { cellar: { role: IMPORTS_ROLE } } };
		expect(importsRoleStranded(marked, MOJO_LANGUAGE)).toBe(true);
		// ...while an unmarked cell has nothing to reach, so it is offered nothing.
		expect(importsRoleStranded({ cell_type: 'code', metadata: {} }, MOJO_LANGUAGE)).toBe(false);
		// And on a Python notebook the mark is not stranded at all.
		expect(importsRoleStranded(marked, 'python')).toBe(false);
	});

	it('the two HIDDEN affordances write no per-cell key, so there is nothing to reach', () => {
		// Consolidate is the only one of the two that writes anything at all, and
		// what it writes is the imports ROLE - which is covered above and remains
		// clearable from the cell menu. The variable inspector writes nothing: it is
		// a live read of the kernel. Pinned as a SOURCE fact, because "this surface
		// persists nothing" is not observable from its output.
		const shell = src('routes/+page.svelte');
		// The gate is a read of the rule, never a write of any notebook state.
		expect(shell).toMatch(/const showVariablesSection = \$derived\(\s*notebookHasPythonNamespace\(/);
	});
});

describe('the wiring exists and reaches the shared rules (source guards)', () => {
	it('LiveNotebook publishes its language up, so the shell can decide', () => {
		const nb = src('lib/LiveNotebook.svelte');
		expect(nb).toMatch(/onLanguageChange\?: \(path: string, language: NotebookLanguage\) => void;/);
		// Reported from an EFFECT on the state itself, so every path that moves the
		// language (the mount load, the SSE event, this tab's own commit) reports it -
		// which is what makes the switch update the shell with no reload.
		expect(nb).toMatch(/\$effect\(\(\) => \{\s*onLanguageChange\?\.\(path, notebookLanguage\);/);
	});

	it('the shell derives both affordances from the ACTIVE notebook language, failing OPEN', () => {
		const shell = src('routes/+page.svelte');
		// `|| 'python'` is the fail-open: no notebook active, or one that has not
		// reported yet, must hide nothing.
		expect(shell).toMatch(/notebooksLanguage\[activeNotebookPath\]\) \|\| 'python'/);
		expect(shell).toMatch(/notebookHasPythonNamespace\(activeNotebookLanguage\)/);
		expect(shell).toMatch(/notebookUsesImportsCell\(activeNotebookLanguage\)/);
		// Both derived values really reach their surface.
		expect(shell).toMatch(/^\s*\{showVariablesSection\}$/m);
		expect(shell).toMatch(/offersConsolidateImports,/);
		// EVERY LiveNotebook mount reports, or one of the two tabs would never decide.
		expect(shell.match(/onLanguageChange=\{handleLanguageChange\}/g)?.length).toBe(2);
	});

	it('the variables PROBE is gated on the same rule that hides the panel', () => {
		const shell = src('routes/+page.svelte');
		// A real kernel `execute` for a panel nobody can see - and gated inside
		// `refreshVariables` rather than at each caller, so no trigger can forget it.
		const fn = shell.slice(shell.indexOf('async function refreshVariables()'));
		expect(fn.slice(0, fn.indexOf('++varsReqSeq'))).toMatch(/if \(!showVariablesSection\) return;/);
		// ...and it probes again when the gate re-OPENS, or the panel would come back
		// empty and stay empty until the next run.
		expect(shell).toMatch(/if \(open && !varsGateOpen\) refreshVariables\(\);/);
	});

	it('the Sidebar skips the RENDER of the vars section, leaving the persisted order alone', () => {
		const sb = src('lib/Sidebar.svelte');
		expect(sb).toMatch(/function sectionApplies\(key: string\): boolean \{\s*return key === 'vars' \? showVariablesSection : true;/);
		expect(sb).toMatch(/\{#if sectionApplies\(key\)\}/);
		// The order itself is never filtered - only the render is skipped - so the
		// section returns to exactly its place, and a persisted order is not rewritten.
		expect(sb).not.toMatch(/sectionOrder\s*=\s*sectionOrder\.filter\(\(k\) => sectionApplies/);
	});

	it("the toolbar's Consolidate button is gated, and by the shared rule", () => {
		const nb = src('lib/Notebook.svelte');
		expect(nb).toMatch(
			/import \{ notebookUsesImportsCell \} from '\$lib\/importsRole';/
		);
		expect(nb).toMatch(
			/const offersConsolidateImports = \$derived\(notebookUsesImportsCell\(notebookLanguage\)\);/
		);
		// The BUTTON must sit INSIDE the gate, not merely after it - a `{/if}` that
		// closed before the button would pass an "is it further down the file" check
		// while leaving the control rendered on every notebook. The block is matched
		// by its own INDENTATION, so the assertion is about nesting rather than about
		// distance, and a reformat that moved the button out fails.
		const open = '\t\t\t{#if offersConsolidateImports}\n';
		const gate = nb.indexOf(open);
		expect(gate, 'the toolbar must gate Consolidate imports').toBeGreaterThan(-1);
		const close = nb.indexOf('\n\t\t\t{/if}', gate);
		expect(close, 'the gate must close at its own indentation').toBeGreaterThan(gate);
		const inside = nb.slice(gate + open.length, close);
		expect(inside).toContain('data-testid="consolidate-imports"');
	});

	it('no surface re-derives the rules with its own mojo check', () => {
		// The whole point of stating them positively: a `!== "mojo"` or
		// `isMojoCell(...)` clause at a call site is how the NEXT language gets
		// forgotten at exactly one of these four surfaces.
		for (const f of ['lib/Sidebar.svelte', 'lib/commands.ts']) {
			expect(src(f), `${f} must not name mojo`).not.toMatch(/MOJO_LANGUAGE|'mojo'|isMojoCell/);
		}
	});
});
