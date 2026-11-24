/**
 * A Rust notebook's exported cells become ONE `.rs` module (`$lib/rustExport`).
 *
 * An Evcxr cell mixes items (`fn`, `struct`, `use`) with top-level statements
 * (`let x = 1;`), and a `.rs` file holds only items. So the rule splits every
 * cell: items go to module level, the MAIN cell's statements go inside a
 * generated `fn main()`, and every other cell's statements are left out with a
 * comment, a badge and a hazard.
 *
 * Two tiers, the `mojo-export.test.ts` convention:
 *  - UNCONDITIONAL: the lexer, the item/statement split, the plan, and the exact
 *    bytes the generator writes. These run in CI.
 *  - GATED on a real `rustc` (`CELLAR_RUSTC`, else `rustc` on PATH, else
 *    `~/.cargo/bin/rustc`), with the reason IN THE SUITE NAME. That tier compiles
 *    and RUNS the module a realistic notebook generates, and carries the CONTROL
 *    that proves the split matters: the same cells concatenated as-is do not
 *    compile.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	RUST_HEADER,
	RUST_MAIN_DROPPED_COMMENT,
	RUST_STATEMENTS_DROPPED_COMMENT,
	analyzeRustCell,
	generateRustModule,
	planRustExport,
	rustDropBadge,
	rustDropReason,
	rustExportDrops,
	rustMainMarked,
	stripEvcxrCommands,
	type RustExportInput
} from '../../src/lib/rustExport';

/** The kind of each unit a cell splits into, in order (trivia dropped). */
function kinds(src: string): string[] {
	return analyzeRustCell(src)
		.units.filter((u) => u.kind !== 'trivia')
		.map((u) => u.kind);
}

/** The text of each unit of the given kind. */
function texts(src: string, kind: string): string[] {
	return analyzeRustCell(src)
		.units.filter((u) => u.kind === kind)
		.map((u) => u.text);
}

describe('analyzeRustCell: what is an item', () => {
	const items = [
		'fn f() {}',
		'pub fn f() -> i32 { 1 }',
		'pub(crate) fn f() {}',
		'pub(in crate::a) fn f() {}',
		'async fn f() {}',
		'unsafe fn f() {}',
		'const fn f() -> u8 { 0 }',
		'pub const unsafe fn f() {}',
		'extern "C" fn f() {}',
		'unsafe extern "C" fn f() {}',
		'extern crate core;',
		'extern "C" { fn abs(x: i32) -> i32; }',
		'struct Unit;',
		'struct Tuple(i32, String);',
		'struct S { a: i32 }',
		'enum E { A, B(i32) }',
		'union U { a: u32, b: f32 }',
		'trait T { fn m(&self); }',
		'unsafe trait T {}',
		'impl S { fn new() -> Self { S { a: 0 } } }',
		'impl<T: Clone> From<T> for Wrap<T> { fn from(t: T) -> Self { Wrap(t) } }',
		'unsafe impl Send for S {}',
		'mod m { pub fn g() {} }',
		'static N: i32 = 3;',
		'static mut C: i32 = 0;',
		'const MAX: usize = 10;',
		'type Map = std::collections::HashMap<String, i32>;',
		'use std::fmt;',
		'use std::{collections::HashMap, fmt::{self, Display}};',
		'pub use crate::m::g;',
		'macro_rules! sq { ($x:expr) => { $x * $x }; }'
	];
	for (const src of items) {
		it(`reads \`${src.slice(0, 40)}\` as one item`, () => {
			expect(kinds(src)).toEqual(['item']);
		});
	}

	it('keeps outer attributes, doc comments and plain comments with the item below them', () => {
		const src = '// a note\n/// Docs.\n#[derive(Debug)]\n#[allow(dead_code)]\nstruct P { x: i32 }';
		expect(texts(src, 'item')).toEqual([src]);
	});

	it('reads a top-level fn main as an item and flags it', () => {
		const u = analyzeRustCell('fn main() { println!("hi"); }').units[0];
		expect(u.kind).toBe('item');
		expect(u.isMainFn).toBe(true);
		expect(analyzeRustCell('fn mainly() {}').units[0].isMainFn).toBe(false);
	});

	it('reads an inner attribute as its own unit', () => {
		expect(kinds('#![allow(unused)]\nfn f() {}')).toEqual(['inner-attr', 'item']);
	});
});

describe('analyzeRustCell: what is a statement', () => {
	const stmts = [
		'let x = 1;',
		'let mut v: Vec<i32> = Vec::new();',
		'x += 1;',
		'println!("{}", x);',
		'v.push(3);',
		'if x > 1 { println!("big"); } else if x < 0 { println!("neg"); } else { println!("small"); }',
		'match x { 1 => println!("one"), _ => {} }',
		'for i in 0..3 { println!("{i}"); }',
		'while x < 10 { x += 1; }',
		'loop { break; }',
		"'outer: loop { break 'outer; }",
		'unsafe { C += 1; }',
		'{ let y = 2; println!("{y}"); }',
		'thread_local! { static T: u8 = 0; }',
		'x'
	];
	for (const src of stmts) {
		it(`reads \`${src.slice(0, 40)}\` as one statement`, () => {
			expect(kinds(src)).toEqual(['stmt']);
		});
	}

	it('splits a cell into items and statements in order', () => {
		const src = [
			'use std::fmt;',
			'let a = 1;',
			'fn add(x: i32, y: i32) -> i32 { x + y }',
			'let b = add(a, 2);',
			'struct S;',
			'b'
		].join('\n');
		expect(kinds(src)).toEqual(['item', 'stmt', 'item', 'stmt', 'item', 'stmt']);
	});

	it('a method chain after a block continues the same statement', () => {
		expect(kinds('let v = if true { 1 } else { 2 }.max(0);\nlet w = 3;')).toEqual(['stmt', 'stmt']);
		expect(kinds('if true { vec![1] } else { vec![] }.len();\nfn f() {}')).toEqual(['stmt', 'item']);
	});

	it('marks whether a statement is terminated', () => {
		const t = (src: string) => analyzeRustCell(src).units[0].terminated;
		expect(t('let x = 1;')).toBe(true);
		expect(t('for i in 0..1 {}')).toBe(true);
		expect(t('x + 1')).toBe(false);
		expect(t('x + 1 // the answer')).toBe(false);
	});
});

describe('analyzeRustCell: strings and comments are not code', () => {
	it('a keyword, a semicolon or a brace inside a string does not split anything', () => {
		const src = 'let s = "fn main() { let x = 1; }";\nlet t = 2;';
		expect(kinds(src)).toEqual(['stmt', 'stmt']);
	});

	it('handles raw, byte and escaped strings', () => {
		expect(kinds('let a = r#"he said "fn x;" twice"#;\nlet b = b"x;y";\nlet c = "q\\";";')).toEqual([
			'stmt',
			'stmt',
			'stmt'
		]);
	});

	it('tells a char literal from a lifetime', () => {
		expect(kinds("fn f<'a>(s: &'a str) -> &'a str { s }\nlet c = '{';\nlet d = '\\'';")).toEqual([
			'item',
			'stmt',
			'stmt'
		]);
	});

	it('ignores code in nested block comments and line comments', () => {
		expect(kinds('/* outer /* fn inner() {} */ still; */\nfn f() {} // let x = {\nlet y = 1;')).toEqual([
			'item',
			'stmt'
		]);
	});
});

describe('stripEvcxrCommands', () => {
	it('removes `:` command lines and collects the :dep specs', () => {
		const { source, deps } = stripEvcxrCommands(
			':dep serde = { version = "1", features = ["derive"] }\n:dep rand\n:timing\nuse std::fmt;'
		);
		expect(source).toBe('use std::fmt;');
		expect(deps).toEqual(['serde = { version = "1", features = ["derive"] }', 'rand = "*"']);
	});

	it('keeps a `:dep`-looking line inside a string', () => {
		const src = 'let s = r#"\n:dep not-a-command\n"#;';
		expect(stripEvcxrCommands(src)).toEqual({ source: src, deps: [] });
	});

	it('keeps a `::path` line, which is code', () => {
		expect(stripEvcxrCommands('::std::println!("x");').source).toBe('::std::println!("x");');
	});
});

const cell = (source: string, main = false): RustExportInput => ({ source, main });

describe('planRustExport', () => {
	it('with no main cell, every statement is left out', () => {
		const plan = planRustExport([cell('fn f() {}\nlet x = 1;'), cell('struct S;')]);
		expect(plan.mainIndex).toBeNull();
		expect(plan.drops).toEqual([
			{ statements: true, main: false },
			{ statements: false, main: false }
		]);
	});

	it("the main cell's statements are kept and outrank every user fn main", () => {
		const plan = planRustExport([cell('fn main() {}'), cell('let x = 1;', true), cell('fn main() {}')]);
		expect(plan.mainMode).toBe('cell');
		expect(plan.drops).toEqual([
			{ statements: false, main: true },
			{ statements: false, main: false },
			{ statements: false, main: true }
		]);
	});

	it('without main-cell statements, the LAST user fn main is kept (the Mojo rule)', () => {
		const plan = planRustExport([cell('fn main() { a(); }'), cell('fn helper() {}', true), cell('fn main() {}')]);
		expect(plan.mainMode).toBe('fn');
		expect(plan.keptMainFn).toBe(2);
		expect(plan.drops.map((d) => d.main)).toEqual([true, false, false]);
	});

	it('the last marked cell is the main cell', () => {
		expect(planRustExport([cell('let a = 1;', true), cell('let b = 2;', true)]).mainIndex).toBe(1);
	});

	it('deduplicates :dep specs across cells, in first-seen order', () => {
		expect(planRustExport([cell(':dep rand\n:dep anyhow = "1"'), cell(':dep rand')]).deps).toEqual([
			'rand = "*"',
			'anyhow = "1"'
		]);
	});
});

describe('generateRustModule', () => {
	it('writes the exact module for a small notebook', () => {
		const out = generateRustModule(
			[
				cell(':dep rand\nuse std::fmt;\n\n/// Twice.\nfn twice(x: i32) -> i32 { x * 2 }\nlet stray = twice(1);'),
				cell('use std::fmt;\nlet x = twice(21);\nprintln!("{x}");\nx', true)
			],
			'demo.ipynb'
		);
		expect(out).toBe(
			[
				RUST_HEADER,
				'// Source notebook: demo.ipynb',
				'// Dependencies (Evcxr :dep lines; add them to Cargo.toml [dependencies]):',
				'//   rand = "*"',
				'',
				'use std::fmt;',
				'',
				'/// Twice.',
				'fn twice(x: i32) -> i32 { x * 2 }',
				RUST_STATEMENTS_DROPPED_COMMENT,
				'',
				'fn main() {',
				'    let x = twice(21);',
				'    println!("{x}");',
				'    let _ = x;',
				'}',
				''
			].join('\n')
		);
	});

	it('marks each left-out run once, keeping the items around it', () => {
		const out = generateRustModule([cell('let a = 1;\nlet b = 2;\nfn f() {}\nlet c = 3;')], 'n.ipynb');
		expect(out.split(RUST_STATEMENTS_DROPPED_COMMENT).length - 1).toBe(2);
		expect(out).toContain('fn f() {}');
		expect(out).not.toContain('let a');
	});

	it("comments the spot where a cell's fn main was left out", () => {
		const out = generateRustModule([cell('fn main() { old(); }'), cell('fn main() { new(); }')], 'n.ipynb');
		expect(out).toContain(RUST_MAIN_DROPPED_COMMENT);
		expect(out).not.toContain('old()');
		expect(out).toContain('fn main() { new(); }');
	});

	it('finishes a trailing let with its semicolon', () => {
		expect(generateRustModule([cell('let x = 1', true)], 'n.ipynb')).toContain('    let x = 1;\n}');
	});

	it('does not indent a line that is inside a multi-line string', () => {
		const out = generateRustModule([cell('let s = "line one\nline two";\nprintln!("{s}");', true)], 'n.ipynb');
		expect(out).toContain('    let s = "line one\nline two";');
	});

	it('hoists inner attributes to the top of the module', () => {
		const out = generateRustModule([cell('fn f() {}'), cell('#![allow(dead_code)]\nfn g() {}')], 'n.ipynb');
		const lines = out.split('\n');
		expect(lines.indexOf('#![allow(dead_code)]')).toBeLessThan(lines.indexOf('fn f() {}'));
	});

	it('is deterministic', () => {
		const cells = [cell('use std::fmt;\nlet a = 1;'), cell('fn f() {}\nf();', true)];
		expect(generateRustModule(cells, 'n.ipynb')).toBe(generateRustModule(cells, 'n.ipynb'));
	});
});

describe('rustExportDrops / rustMainMarked', () => {
	const mk = (id: string, source: string, cellar: Record<string, unknown> = {}) => ({
		id,
		cell_type: 'code',
		source,
		metadata: { cellar: { export: true, ...cellar } }
	});

	it('reports only cells that lost something, and only for a Rust module', () => {
		const cells = [mk('a', 'fn f() {}'), mk('b', 'let x = 1;'), mk('c', 'let y = 2;', { export_main: true })];
		const drops = rustExportDrops(cells, 'rust');
		expect([...drops.keys()]).toEqual(['b']);
		expect(rustExportDrops(cells, 'python').size).toBe(0);
		expect(rustExportDrops(cells, null).size).toBe(0);
	});

	it('ignores cells that are not exported', () => {
		const cells = [{ id: 'z', cell_type: 'code', source: 'let x = 1;', metadata: {} }];
		expect(rustExportDrops(cells, 'rust').size).toBe(0);
	});

	it('a main mark on an unexported cell does not count', () => {
		expect(
			rustMainMarked([{ id: 'z', cell_type: 'code', source: '', metadata: { cellar: { export_main: true } } }])
		).toBe(false);
		expect(rustMainMarked([mk('a', '', { export_main: true })])).toBe(true);
	});

	it('the badge names what was lost and the tooltip names the remedy', () => {
		expect(rustDropBadge({ statements: true, main: false })).toBe('statements not exported');
		expect(rustDropBadge({ statements: false, main: true })).toBe('main not exported');
		expect(rustDropBadge({ statements: true, main: true })).toBe('code not exported');
		expect(rustDropBadge({ statements: false, main: false })).toBeNull();
		expect(rustDropReason({ statements: true, main: false }, false)).toContain('Mark a cell as the main cell');
		expect(rustDropReason({ statements: true, main: false }, true)).toContain('Move the statements into the main cell');
	});
});

// ---------------------------------------------------------------------------
// A realistic notebook, compiled by a real rustc
// ---------------------------------------------------------------------------

/** Cells of a realistic Evcxr notebook, all exported; the fourth is the main cell. */
const NOTEBOOK: RustExportInput[] = [
	cell(':dep serde = { version = "1", features = ["derive"] }\nuse std::collections::HashMap;'),
	cell(
		[
			'/// A point in 2D.',
			'#[derive(Debug, Clone, Copy, PartialEq)]',
			'pub struct Point {',
			'    pub x: f64,',
			'    pub y: f64,',
			'}',
			'',
			'impl Point {',
			'    pub fn dist(&self, o: &Point) -> f64 {',
			'        ((self.x - o.x).powi(2) + (self.y - o.y).powi(2)).sqrt()',
			'    }',
			'}',
			'',
			'// Try it out in the notebook.',
			'let p = Point { x: 1.0, y: 2.0 };',
			'p'
		].join('\n')
	),
	cell(
		[
			'use std::collections::HashMap;',
			'',
			'fn word_counts(text: &str) -> HashMap<String, usize> {',
			'    let mut m = HashMap::new();',
			'    for w in text.split_whitespace() {',
			'        *m.entry(w.to_lowercase()).or_insert(0) += 1;',
			'    }',
			'    m',
			'}',
			'',
			'const GREETING: &str = "hello; world { not a block }";'
		].join('\n')
	),
	cell(
		[
			'let a = Point { x: 0.0, y: 0.0 };',
			'let b = Point { x: 3.0, y: 4.0 };',
			'println!("distance = {}", a.dist(&b));',
			'let counts = word_counts("the cat The hat");',
			'let mut keys: Vec<_> = counts.keys().cloned().collect();',
			'keys.sort();',
			'for k in &keys {',
			'    println!("{k}: {}", counts[k]);',
			'}',
			'println!("{GREETING}");',
			'a.dist(&b)'
		].join('\n'),
		true
	),
	cell('fn main() {\n    println!("an old main from an earlier experiment");\n}')
];

describe('the realistic notebook (always)', () => {
	const out = generateRustModule(NOTEBOOK, 'geometry.ipynb');

	it('lists the :dep and drops the command line', () => {
		expect(out).toContain('//   serde = { version = "1", features = ["derive"] }');
		expect(out).not.toMatch(/^:dep/m);
	});

	it('writes the shared use once', () => {
		expect(out.match(/^use std::collections::HashMap;$/gm)?.length).toBe(1);
	});

	it('reports the stray statement cell and the old fn main', () => {
		expect(planRustExport(NOTEBOOK).drops).toEqual([
			{ statements: false, main: false },
			{ statements: true, main: false },
			{ statements: false, main: false },
			{ statements: false, main: false },
			{ statements: false, main: true }
		]);
		expect(out).not.toContain('an old main');
		expect(out).not.toContain('let p = Point');
	});
});

function findRustc(): string {
	const candidates = [process.env.CELLAR_RUSTC, 'rustc', join(homedir(), '.cargo', 'bin', 'rustc')];
	for (const c of candidates) {
		if (!c) continue;
		try {
			execFileSync(c, ['--version'], { stdio: 'ignore' });
			return c;
		} catch {
			/* try the next one */
		}
	}
	return '';
}

const RUSTC = findRustc();
const why = RUSTC ? '' : ' [SKIPPED: no rustc found; set CELLAR_RUSTC]';

describe.skipIf(!RUSTC)(`the generated module against a REAL rustc${why}`, () => {
	const dir = RUSTC ? mkdtempSync(join(tmpdir(), 'cellar-rust-export-')) : '';

	function compile(name: string, src: string, crateType: 'bin' | 'lib'): { ok: boolean; stderr: string; bin: string } {
		const file = join(dir, `${name}.rs`);
		const bin = join(dir, name);
		writeFileSync(file, src);
		try {
			execFileSync(RUSTC, ['--edition', '2021', '--crate-type', crateType, '-o', bin, file], {
				stdio: ['ignore', 'pipe', 'pipe']
			});
			return { ok: true, stderr: '', bin };
		} catch (e) {
			return { ok: false, stderr: String((e as { stderr?: Buffer }).stderr ?? e), bin };
		}
	}

	it('compiles and runs the realistic notebook as a program', () => {
		const res = compile('geometry', generateRustModule(NOTEBOOK, 'geometry.ipynb'), 'bin');
		expect(res.stderr).toBe('');
		expect(res.ok).toBe(true);
		const stdout = execFileSync(res.bin, { encoding: 'utf8' });
		expect(stdout).toBe('distance = 5\ncat: 1\nhat: 1\nthe: 2\nhello; world { not a block }\n');
	});

	it('CONTROL: the same cells concatenated as-is do not compile', () => {
		const naive = NOTEBOOK.map((c) => stripEvcxrCommands(c.source).source).join('\n\n');
		const res = compile('naive', naive, 'bin');
		expect(res.ok).toBe(false);
	});

	it('compiles a notebook with no main cell as a library', () => {
		const lib = generateRustModule([NOTEBOOK[1], NOTEBOOK[2]], 'geometry.ipynb');
		const res = compile('geometry_lib', '#![allow(dead_code)]\n' + lib, 'lib');
		expect(res.stderr).toBe('');
		expect(res.ok).toBe(true);
	});

	it('compiles a notebook whose main comes from a cell fn main', () => {
		const src = generateRustModule(
			[cell('fn main() { println!("first"); }'), cell('fn helper() -> i32 { 2 }'), cell('fn main() { println!("{}", helper()); }')],
			'n.ipynb'
		);
		const res = compile('cellmain', src, 'bin');
		expect(res.ok).toBe(true);
		expect(execFileSync(res.bin, { encoding: 'utf8' })).toBe('2\n');
	});

	it('a temp dir was really used', () => {
		expect(existsSync(dir)).toBe(true);
	});
});
