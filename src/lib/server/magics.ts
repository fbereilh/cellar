/**
 * Cellar — IPython magic awareness for static analysis.
 *
 * Magics EXECUTE fine: a cell's source is sent verbatim to ipykernel (`run.ts`),
 * which is IPython, so `%%time`, `%%bash`, `%pip`, `%load_ext`, `%matplotlib
 * inline` all run natively. This module is only about the STATIC side — the
 * `ast`/`symtable` dataflow probe (`dataflow.ts`) and import routing (`imports-cell.ts`)
 * both assume plain Python, and magic syntax is not valid Python.
 *
 * WHY NOT IPYTHON'S OWN TRANSFORM. `TransformerManager().transform_cell` rewrites
 * `%%time\ndf = load()` into `get_ipython().run_cell_magic('time', '', 'df =
 * load()\\n')` — the body becomes a STRING LITERAL, so the probe never sees `df`
 * assigned. It is exactly the wrong shape for dataflow. It also needs IPython in
 * the interpreter, whereas the probe uses only the stdlib (`ast`/`symtable`) so any
 * Python 3 works with no venv set up. So we normalize in JS instead: a targeted,
 * well-tested line pass that preserves the analyzable Python.
 *
 * The three cases (see `normalizeForAnalysis`):
 *  - a Python-body cell magic (`%%time`, `%%timeit`, …) → strip the header line and
 *    analyze the body, so its assignments register as defines;
 *  - any other cell magic (`%%bash`, `%%html`, `%%writefile`, …) → the body is not
 *    Python, so there is nothing to analyze (like a SQL cell);
 *  - line magics (`%matplotlib inline`) and shell escapes (`!pip …`) → blanked, so
 *    the surrounding Python still analyzes; an assignment FROM one (`files = !ls`)
 *    keeps its left-hand side as a define.
 *
 * Pure and browser-safe-ish (it only imports the pure `logicalLines` tokenizer),
 * so it is unit-testable without a kernel, a subprocess, or a document.
 */
import { logicalLines } from './imports';

/**
 * Cell magics whose BODY is Python and therefore contributes defines/uses. Every
 * other `%%name` is treated as a non-Python cell (bash, html, writefile, latex, …)
 * — the safe default, since analyzing a shell/HTML/file body as Python would only
 * invent or miss names.
 */
const PYTHON_BODY_CELL_MAGICS = new Set(['time', 'timeit', 'capture', 'prun', 'debug', 'pypy']);

/**
 * The name of a leading `%%name` cell magic, or null when the cell is not a cell
 * magic. IPython requires a cell magic to be the cell's first line; leading blank
 * lines are tolerated. The name decides how the body is (or is not) analyzed.
 */
export function cellMagicName(source: string | null | undefined): string | null {
	for (const raw of (source ?? '').split('\n')) {
		if (raw.trim() === '') continue; // skip leading blank lines
		const m = /^%%(\w+)/.exec(raw.trimStart());
		return m ? m[1] : null; // the first non-blank line settles it
	}
	return null;
}

/** True for any `%%name` cell magic (whether or not its body is Python). */
export function isCellMagicCell(source: string | null | undefined): boolean {
	return cellMagicName(source) !== null;
}

/**
 * Blank every whole-logical-line magic (`%foo …`) and shell escape (`!cmd`) so the
 * surrounding Python still parses, preserving line structure (a blanked line stays
 * a line). An assignment whose right-hand side is a magic/shell (`files = !ls`,
 * `t = %timeit -o f()`) keeps its left-hand side as `name = None`, so the define
 * survives — `symtable` does not execute, so `a, b = None` binds `a` and `b` fine.
 *
 * Uses `logicalLines` so a `%`/`!` that is really a continuation of a bracketed
 * expression (`x = (a\n% b)`) is part of the previous logical line and never
 * mistaken for a magic.
 *
 * Exported because `importBindings.ts` needs the SAME notion of "this line is a
 * magic, not Python" when deciding whether a cell is imports-only: a header of
 * `%matplotlib inline` / `%load_ext …` / `%pip install …` above the import block is
 * ubiquitous, and re-deriving what counts as a magic there would be a second,
 * drifting vocabulary. The assignment form (`files = !ls`) keeps its binding as
 * `name = None` and therefore still reads as ordinary module-level code, which is
 * what that caller needs.
 *
 * BUT NOT EVERY BARE MAGIC IS INERT, so blanking one here is right for the PROBE
 * (magic syntax is not Python either way) and NOT sufficient for that caller:
 * `%run setup.py` executes a script IN the user namespace, `%store -r name` and
 * `%load` inject names, `%pylab` is a star import. `importBindings.ts` therefore
 * gates on `hasNonInertLineMagic` as well - see `INERT_LINE_MAGICS`.
 */
export function blankLineMagics(src: string): string {
	const edits: { start: number; end: number; text: string }[] = [];
	for (const line of logicalLines(src)) {
		const first = line.raw.trimStart()[0];
		if (first === '%' || first === '!') {
			edits.push({ start: line.start, end: line.end, text: '\n' });
			continue;
		}
		// `name = !ls` / `a, b = %magic …`: keep the binding, drop the magic RHS.
		const asgn = /^(\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*=)\s*[%!]/.exec(line.raw);
		if (asgn) edits.push({ start: line.start, end: line.end, text: `${asgn[1]} None\n` });
	}
	if (!edits.length) return src;
	// Apply right-to-left so earlier offsets stay valid.
	let out = src;
	for (let i = edits.length - 1; i >= 0; i--) {
		const e = edits[i];
		out = out.slice(0, e.start) + e.text + out.slice(e.end);
	}
	return out;
}

/** `%load_ext autoreload` and `%reload_ext autoreload` both arm the extension. */
const EXT_LOADERS = new Set(['load_ext', 'reload_ext']);

/**
 * Line magics PROVEN to bind no name in the user namespace, and therefore safe for
 * `importBindings.ts` to discount like a comment when testing "is this cell nothing
 * but imports".
 *
 * It is an ALLOWLIST, deliberately: the failure directions are not symmetric. A
 * magic wrongly listed here silently certifies a rebound name as unchanged - a false
 * `fresh`, the one verdict staleness must never invent - while one wrongly left out
 * only costs a needless re-run. So an unrecognized magic, including any IPython (or
 * extension) adds later, disqualifies the cell.
 *
 * Adding an entry means proving the magic injects NOTHING into the namespace.
 * Counter-examples that must stay OUT: `%run` (executes a script in the namespace,
 * so `setup.py` may rebind `pd`), `%store -r name`, `%load`, `%pylab` (a star import
 * of numpy/matplotlib names), `%timeit -o` in its assignment form (already handled -
 * that keeps its left-hand side and reads as ordinary code).
 *
 * `autoreload` is listed because the flag line itself binds nothing; the reason it
 * still disqualifies is separate and notebook-wide (see `hasAutoreloadMagic`).
 */
const INERT_LINE_MAGICS = new Set([
	'matplotlib',
	'load_ext',
	'reload_ext',
	'config',
	'pip',
	'conda',
	'autoreload'
]);

/**
 * Does this source contain a module-level line magic that is NOT on the inert
 * allowlist - i.e. one we cannot claim binds nothing?
 *
 * Only `importBindings.ts` cares, and only to REFUSE. Shell escapes (`!cmd`) run a
 * subprocess and bind nothing, so they are not considered here; the assignment form
 * (`files = !ls`) is not a magic line at all after `blankLineMagics` and disqualifies
 * through the ordinary imports-only residual test.
 */
export function hasNonInertLineMagic(source: string | null | undefined): boolean {
	for (const line of logicalLines(source ?? '')) {
		const text = line.raw.trimStart();
		if (text[0] !== '%') continue;
		const m = /^%{1,2}(\w+)/.exec(text);
		if (!m || !INERT_LINE_MAGICS.has(m[1])) return true; // unknown ⇒ conservative
	}
	return false;
}

/**
 * Does this source arm IPython's `autoreload` extension (`%load_ext autoreload`,
 * `%autoreload 2`, …)?
 *
 * Autoreload changes what re-executing an import MEANS - it reloads a changed
 * module rather than handing back the object `sys.modules` already holds - and that
 * is the one premise the import-binding staleness exemption rests on. Any mention
 * disqualifies, including `%autoreload 0`: distinguishing a live setting from a
 * disabled one would mean tracking cell execution order for a knob whose whole
 * purpose is to make imports non-idempotent.
 *
 * ARMING IT IS KERNEL-GLOBAL, SO THE GATE MUST BE NOTEBOOK-WIDE. The ubiquitous
 * header puts `%load_ext autoreload` / `%autoreload 2` in its OWN cell, and Cellar
 * makes that split the default outcome (`ensureImportsCell` adopts a first cell only
 * via `isImportsOnly`, so a magic-only header is never adopted and a separate,
 * magic-free imports cell is inserted above it). Checking only the cell being
 * analyzed would therefore grant the exemption in exactly the arrangement where
 * autoreload is most commonly armed. `dataflow.ts` runs this over EVERY code cell
 * and, on a hit, omits `imports` for all of them so no edge anywhere is exempt;
 * `importBindings.ts` keeps its own per-cell check as the local half.
 */
export function hasAutoreloadMagic(source: string | null | undefined): boolean {
	for (const line of logicalLines(source ?? '')) {
		const m = /^%{1,2}(\w+)([^\n]*)/.exec(line.raw.trimStart());
		if (!m) continue;
		if (m[1] === 'autoreload') return true;
		if (EXT_LOADERS.has(m[1]) && /\bautoreload\b/.test(m[2])) return true;
	}
	return false;
}

/**
 * Normalize a cell's source into Python that `symtable` can analyze, handling
 * IPython magics (see the module header). Non-magic source is returned unchanged;
 * a non-Python cell magic returns `''` (no defines/uses, like a SQL cell); a
 * Python-body cell magic has its header stripped and its body normalized.
 */
export function normalizeForAnalysis(source: string | null | undefined): string {
	const src = source ?? '';
	const name = cellMagicName(src);
	if (name !== null) {
		if (!PYTHON_BODY_CELL_MAGICS.has(name)) return ''; // bash/html/writefile/… → not Python
		// Strip through the end of the `%%name …` header line, keep + normalize the body.
		const lines = src.split('\n');
		let i = 0;
		while (i < lines.length && lines[i].trim() === '') i++; // skip leading blanks
		return blankLineMagics(lines.slice(i + 1).join('\n'));
	}
	return blankLineMagics(src);
}
