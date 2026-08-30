/**
 * The nbdev `#|` directive scanner (`$lib/nbdevDirectives`).
 *
 * Every case here was DRIVEN through real nbdev 3.3.13 / fastcore 2.2.16 before it
 * was written down - `NbCell(...).directives` and `has_directive('export')` over
 * the same sources - rather than read off the docs. Three of them are the reason
 * the module exists at all and each is a silent wrong answer if it flips:
 *
 *  - a `#|` line AFTER code, after a PLAIN comment, or inside a triple-quoted
 *    string is NOT a directive to nbdev. Cellar's previous `default_exp` scan was a
 *    `/m` regex over the whole source and honoured all three, which is the
 *    "half-speaks nbdev" defect: a target resolved from text nbdev ignores, written
 *    to a file nbdev would never write.
 *  - `exporti` / `exports` / `exportd` are each their OWN directive name. An exact
 *    match on `export` excludes them for free; a prefix match would silently claim
 *    cells whose semantics a single boolean cannot express.
 *  - a VALUED `#| export other` names a DIFFERENT module in nbdev. Reading it as a
 *    mark for this notebook's own module is the same wrong-file write from the cell
 *    side, so only the BARE form counts.
 *
 * The cost property is behavioural, not a spy: the leading block ends at the first
 * ordinary line, so an ordinary cell is answered from line 1 whatever follows it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	nbdevDirective,
	hasBareNbdevDirective,
	nbdevDirectiveOutsideBlock
} from '../../src/lib/nbdevDirectives';

/** Every case below was run through real nbdev; the comment records its verdict. */
const RECOGNIZED: Array<[string, string]> = [
	['#| export\ndef a(): pass', 'the canonical spelling'],
	['#|export\ndef a(): pass', 'no space after the pipe'],
	['# | export\ndef a(): pass', 'a space between # and |'],
	['   #| export\ndef a(): pass', 'indented with spaces'],
	['\t#| export\ndef a(): pass', 'indented with a tab'],
	['#| export: true\ndef a(): pass', 'the explicit `true` value, which nbdev normalizes to bare'],
	['#| export   \ndef a(): pass', 'trailing whitespace'],
	['#| export\r\ndef a(): pass', 'CRLF line endings'],
	['\n\n#| export\ndef a(): pass', 'blank lines may precede it'],
	['%%time\n#| export\ndef a(): pass', 'a cell magic may precede it'],
	['#| hide\n#| export\ndef a(): pass', 'a second directive may precede it'],
	['#|\n#| export\ndef a(): pass', 'a bare `#|` parses to nothing but does not end the block'],
	['#| export', 'the whole cell, with no trailing newline']
];

const NOT_RECOGNIZED: Array<[string, string]> = [
	['x = 1\n#| export\ndef a(): pass', 'after code: the block already ended'],
	['# a note\n#| export\ndef a(): pass', 'after a PLAIN comment: only `#|` lines stay in the block'],
	["s = '''\n#| export\n'''\ndef a(): pass", 'inside a string: the assignment ended the block'],
	['#| exporti\ndef a(): pass', 'exporti is a different directive name'],
	['#| exports\ndef a(): pass', 'exports is a different directive name'],
	['#| exportd\ndef a(): pass', 'exportd is a different directive name'],
	['#| exportx\ndef a(): pass', 'an unknown export-family name is not `export`'],
	['#| EXPORT\ndef a(): pass', 'directive names are case-sensitive'],
	['def a(): pass', 'no directive at all'],
	['', 'an empty cell']
];

describe('the scanner agrees with nbdev about what a directive IS', () => {
	for (const [source, why] of RECOGNIZED)
		it(`recognizes a bare export: ${why}`, () => {
			expect(nbdevDirective(source, 'export')).toBe('');
			expect(hasBareNbdevDirective(source, 'export')).toBe(true);
		});

	for (const [source, why] of NOT_RECOGNIZED)
		it(`does not recognize an export: ${why}`, () => {
			expect(nbdevDirective(source, 'export')).toBeNull();
			expect(hasBareNbdevDirective(source, 'export')).toBe(false);
		});

	it('reports a VALUED export as its value, never as bare', () => {
		// nbdev: `#| export other` exports the cell to a module named `other`, a SECOND
		// module beside the `default_exp` one. Present, but not a mark for this
		// notebook's module - so the two readings must stay distinguishable.
		expect(nbdevDirective('#| export other\ndef a(): pass', 'export')).toBe('other');
		expect(hasBareNbdevDirective('#| export other\ndef a(): pass', 'export')).toBe(false);
	});

	it('reads a directive VALUE for the shapes nbdev accepts', () => {
		expect(nbdevDirective('#| default_exp core', 'default_exp')).toBe('core');
		expect(nbdevDirective('#|default_exp pkg.utils\nimport os', 'default_exp')).toBe('pkg.utils');
		expect(nbdevDirective('#| default_exp:core', 'default_exp')).toBe('core');
		expect(nbdevDirective('#| default_exp   core   ', 'default_exp')).toBe('core');
	});

	it('takes the LAST occurrence of a repeated name, like nbdev\'s dict build', () => {
		// Measured, not reasoned about: the obvious first-wins guess is WRONG, and the
		// differential below is what caught it. `_directives_get` builds a dict over the
		// block's lines, so a later line overwrites an earlier one.
		expect(nbdevDirective('#| default_exp first\n#| default_exp second', 'default_exp')).toBe('second');
	});

	it('reads every directive in the leading block, not just the first line', () => {
		const src = '%%time\n\n#| hide\n#| default_exp core\n#| export\nimport os';
		expect(nbdevDirective(src, 'hide')).toBe('');
		expect(nbdevDirective(src, 'default_exp')).toBe('core');
		expect(nbdevDirective(src, 'export')).toBe('');
		expect(nbdevDirective(src, 'exporti')).toBeNull();
	});

	it('answers null for absent input rather than throwing', () => {
		expect(nbdevDirective(null, 'export')).toBeNull();
		expect(nbdevDirective(undefined, 'export')).toBeNull();
	});
});

describe('the leading block bounds the cost', () => {
	it('stops at the first ordinary line, whatever follows it', () => {
		// The cost guard is structural rather than a spy on some string method: a
		// directive buried 200_000 lines down is not found, which is precisely the
		// statement that the walk never got there. It also has to be FAST - a whole-
		// source regex over this input is not.
		const huge = 'x = 1\n'.repeat(200_000) + '#| export\n';
		const started = Date.now();
		expect(nbdevDirective(huge, 'export')).toBeNull();
		expect(Date.now() - started).toBeLessThan(200);
	});

	it('still reads a block that legitimately runs long', () => {
		const many = '#| hide\n'.repeat(50) + '#| export\nx = 1\n';
		expect(hasBareNbdevDirective(many, 'export')).toBe(true);
	});
});

/**
 * The REPORTING half of the leading-block rule.
 *
 * The rule itself is NOT loosened - what nbdev ignores, Cellar ignores - but a
 * `#| default_exp core` written after code, after a plain comment, or inside a
 * string LOOKS like a working target, and Cellar's own pre-fix scan honoured it.
 * So the ignored line has to be FINDABLE, or the drop is silent and a previously
 * generated module goes stale with nothing saying why (`export-py.ts` is what
 * turns this into the user-facing message).
 */
describe('a directive OUTSIDE the leading block is findable, so the drop is not silent', () => {
	// The three shapes that carry a REAL `export` directive nbdev ignores for its
	// POSITION. The rest of NOT_RECOGNIZED is refused for its NAME instead
	// (`exporti`, `EXPORT`), and those must report nothing here either - there is
	// no misplaced `export` line in them at all.
	const MISPLACED: Array<[string, string]> = [
		['x = 1\n#| export\ndef a(): pass', 'after code'],
		['# a note\n#| export\ndef a(): pass', 'after a PLAIN comment'],
		["s = '''\n#| export\n'''\ndef a(): pass", 'inside a triple-quoted string']
	];
	for (const [source, why] of MISPLACED)
		it(`finds the ignored export: ${why}`, () => {
			// The very source the scanner correctly refuses is the one this must see.
			expect(nbdevDirective(source, 'export')).toBeNull();
			expect(nbdevDirectiveOutsideBlock(source, 'export')).toBe('');
		});

	it('reports nothing for a directive refused for its NAME rather than its place', () => {
		const misplacedSources = new Set(MISPLACED.map(([src]) => src));
		for (const [source, why] of NOT_RECOGNIZED) {
			if (misplacedSources.has(source)) continue;
			expect(nbdevDirectiveOutsideBlock(source, 'export'), why).toBeNull();
		}
	});

	it('reports the ignored directive VALUE, so a caller can name the module', () => {
		expect(nbdevDirectiveOutsideBlock('x = 1\n#| default_exp core', 'default_exp')).toBe('core');
		expect(nbdevDirectiveOutsideBlock('# a note\n#|default_exp pkg.utils', 'default_exp')).toBe('pkg.utils');
		expect(nbdevDirectiveOutsideBlock("s = '''\n#| default_exp core\n'''", 'default_exp')).toBe('core');
	});

	it('finds NOTHING for a directive that IS in the leading block', () => {
		// The two answers are complements: reporting an in-block directive here would
		// make the message claim a line is misplaced when nbdev reads it perfectly.
		for (const [source] of RECOGNIZED) expect(nbdevDirectiveOutsideBlock(source, 'export')).toBeNull();
		expect(nbdevDirectiveOutsideBlock('#| default_exp core\nx = 1', 'default_exp')).toBeNull();
		// A BARE `#| default_exp` with no module IS in the block - it names no module,
		// which is a different complaint, and must not be reported as misplaced.
		expect(nbdevDirectiveOutsideBlock('#| default_exp\nx = 1', 'default_exp')).toBeNull();
	});

	it('finds nothing where there is no directive at all, however the word appears', () => {
		expect(nbdevDirectiveOutsideBlock('default_exp = 3\nprint(default_exp)', 'default_exp')).toBeNull();
		expect(nbdevDirectiveOutsideBlock('x = 1\n# a note about default_exp', 'default_exp')).toBeNull();
		expect(nbdevDirectiveOutsideBlock('x = 1\n#| hide', 'default_exp')).toBeNull();
		expect(nbdevDirectiveOutsideBlock(null, 'default_exp')).toBeNull();
		expect(nbdevDirectiveOutsideBlock(undefined, 'default_exp')).toBeNull();
	});

	it('reads the FIRST occurrence once out of the block, and handles CRLF', () => {
		expect(nbdevDirectiveOutsideBlock('x = 1\n#| default_exp a\n#| default_exp b', 'default_exp')).toBe('a');
		expect(nbdevDirectiveOutsideBlock('x = 1\r\n#| default_exp a\r\n', 'default_exp')).toBe('a');
	});
});

/**
 * The DIFFERENTIAL: this scanner against real nbdev, over a committed corpus of the
 * shapes above plus the awkward ones (`#|  export`, `#|export:false`, a trailing
 * comment, a magic-then-blank-then-directive block).
 *
 * It is what caught the one rule reasoning got wrong - a repeated directive name is
 * LAST-wins, not first - so keeping it is the difference between "Cellar agrees with
 * nbdev" and "Cellar agrees with what someone remembered of nbdev". The expectations
 * are a FIXTURE captured from nbdev 3.3.13, so the corpus half runs everywhere; the
 * gated half re-captures it live, which is what notices nbdev changing its rule.
 *
 * Regenerate the fixture with the snippet in the file header comment of
 * `tests/unit/fixtures/nbdev-directives.json`'s producer - or simply point
 * `CELLAR_NBDEV_PYTHON` at an interpreter that can `import fastcore` and let the
 * gated test tell you it has drifted.
 */
type DirectiveCase = { source: string; export: string | null; default_exp: string | null };
const CORPUS: DirectiveCase[] = JSON.parse(
	readFileSync(new URL('./fixtures/nbdev-directives.json', import.meta.url), 'utf8')
);

describe('differential against the captured nbdev 3.3.13 verdicts', () => {
	it('agrees on every case in the corpus, for both directive names', () => {
		const disagreements = CORPUS.flatMap((c) =>
			(['export', 'default_exp'] as const)
				.filter((name) => nbdevDirective(c.source, name) !== (c[name] ?? null))
				.map((name) => ({ source: c.source, name, cellar: nbdevDirective(c.source, name), nbdev: c[name] ?? null }))
		);
		expect(disagreements).toEqual([]);
		expect(CORPUS.length).toBeGreaterThan(30);
	});
});

/** A python that can `import fastcore.nbio`, or null. See the sibling nbdev suite. */
function findFastcorePython(): string | null {
	const candidates = [
		process.env.CELLAR_NBDEV_PYTHON,
		join(process.cwd(), '.venv', 'bin', 'python'),
		join(process.env.HOME ?? '', '.cellar', 'host-venv', 'bin', 'python')
	].filter((p): p is string => !!p);
	for (const py of candidates) {
		if (!existsSync(py)) continue;
		try {
			execFileSync(py, ['-c', 'import fastcore.nbio'], { stdio: 'ignore' });
			return py;
		} catch {
			/* not this one */
		}
	}
	return null;
}

const PYTHON = findFastcorePython();
const VERSION = PYTHON
	? execFileSync(PYTHON, ['-c', 'import fastcore;print(fastcore.__version__)'], { encoding: 'utf8' }).trim()
	: '';

// SKIPS where no fastcore interpreter is discoverable (CI has none), with the reason
// IN THE SUITE NAME so a green run is never mistaken for a verified one.
const suite = PYTHON
	? `differential against LIVE nbdev (fastcore ${VERSION})`
	: 'differential against LIVE nbdev [SKIPPED: no interpreter with fastcore - set CELLAR_NBDEV_PYTHON]';

describe.skipIf(!PYTHON)(suite, () => {
	it('still agrees with the installed fastcore, and the fixture still matches it', () => {
		const probe = [
			'import json,sys',
			'from fastcore.nbio import NbCell',
			'out=[]',
			'for src in json.load(sys.stdin):',
			"    c=NbCell(0, dict(cell_type='code', source=src, metadata={}, outputs=[], execution_count=None))",
			'    d=c.directives',
			"    out.append({'source':src,'export':d.get('export'),'default_exp':d.get('default_exp')})",
			'print(json.dumps(out))'
		].join('\n');
		const live: DirectiveCase[] = JSON.parse(
			execFileSync(PYTHON!, ['-c', probe], {
				input: JSON.stringify(CORPUS.map((c) => c.source)),
				encoding: 'utf8'
			})
		);
		// Cellar agrees with the LIVE library...
		for (const c of live)
			for (const name of ['export', 'default_exp'] as const)
				expect(
					{ source: c.source, name, value: nbdevDirective(c.source, name) },
					`cellar disagrees with live nbdev on ${JSON.stringify(c.source)} / ${name}`
				).toEqual({ source: c.source, name, value: c[name] ?? null });
		// ...and the committed fixture is still what the library says, so a corpus-only
		// run on CI is testing today's nbdev rather than a snapshot that has drifted.
		expect(live).toEqual(CORPUS);
	});
});
