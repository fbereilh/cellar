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
import { logicalLines, type LogicalLine } from './imports';

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
 * Is this logical line ENTIRELY a magic / shell escape (`%foo …`, `!cmd`) rather
 * than Python? The single definition of that shape, shared by `blankLineMagics`
 * (which blanks such a line) and by `importBindings.ts`'s imports-only residual
 * test (which discounts one, like a comment) so the two cannot drift.
 *
 * The ASSIGNMENT form (`files = !ls`) is deliberately not one: it binds a name, so
 * it is ordinary code to both callers.
 */
export function isBareMagicLine(raw: string): boolean {
	const first = raw.trimStart()[0];
	return first === '%' || first === '!';
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
 * Internal to the PROBE path (`normalizeForAnalysis`). `importBindings.ts` asks the
 * related but distinct question "is this cell nothing but imports", and reaches the
 * shared vocabulary directly: `isBareMagicLine` for the shape of a magic line, and
 * `scanMagics` for whether every magic present is one we can prove inert. Blanking a
 * magic is right here because magic syntax is not Python either way, and NOT
 * sufficient there - `%run setup.py` executes a script IN the user namespace,
 * `%store -r name` and `%load` inject names, `%pylab` is a star import (see
 * `INERT_LINE_MAGICS`).
 */
function blankLineMagics(src: string): string {
	const edits: { start: number; end: number; text: string }[] = [];
	for (const line of logicalLines(src)) {
		if (isBareMagicLine(line.raw)) {
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
 * `%load_ext` / `%reload_ext` are OUT for the same reason, and that is worth naming
 * because they look inert: they run an arbitrary module's `load_ipython_extension(ip)`,
 * which is free to `ip.push({...})`, so nothing about them is PROVEN and they cannot
 * meet this bar. The practical cost is small - `%load_ext autoreload`, the common
 * case, already disqualifies notebook-wide (see `hasAutoreloadMagic`), and the other
 * ubiquitous header, `%matplotlib inline`, keeps the refinement.
 *
 * `%env` is out too, though it binds nothing in `user_ns`: its bare form RETURNS the
 * environment dict, so IPython's displayhook binds `_`. Nothing imports a name like
 * that, but the bar here is proof, not likelihood.
 *
 * `autoreload` is listed because the flag line itself binds nothing; the reason it
 * still disqualifies is separate and notebook-wide (see `hasAutoreloadMagic`).
 */
const INERT_LINE_MAGICS = new Set(['matplotlib', 'config', 'pip', 'conda', 'autoreload']);

/** What one walk over a cell's logical lines says about its magics. */
export interface MagicScan {
	/** The cell opens with a `%%name` cell magic, so its body is not module-level Python. */
	cellMagic: boolean;
	/** Some line arms `autoreload` (see `hasAutoreloadMagic`). */
	autoreload: boolean;
	/**
	 * Some line magic is NOT on the inert allowlist, i.e. one we cannot claim binds
	 * nothing. Only `importBindings.ts` reads it, and only to REFUSE. Shell escapes
	 * (`!cmd`) run a subprocess and bind nothing, so they never set it; the assignment
	 * form (`files = !ls`) is not a bare magic line at all (see `isBareMagicLine`) and
	 * disqualifies through the ordinary imports-only residual test instead.
	 */
	nonInert: boolean;
}

/**
 * Every magic question `importBindings.ts` asks, answered in ONE pass over lines the
 * caller has already tokenized.
 *
 * It exists because that caller used to ask them separately (one query per fact),
 * paying a full tokenizer walk each, on every 500ms autosave of every cell. The rules
 * themselves are unchanged and stay here, so there is still one vocabulary of what a
 * magic is; `hasAutoreloadMagic` is the same scan for callers holding only a source.
 *
 * `cellMagic` mirrors `cellMagicName` on the first non-blank line; the two must keep
 * agreeing (that function stays the entry point for callers that need the NAME).
 */
export function scanMagics(lines: readonly LogicalLine[]): MagicScan {
	const scan: MagicScan = { cellMagic: false, autoreload: false, nonInert: false };
	let leading = true;
	for (const line of lines) {
		const text = line.raw.trimStart();
		if (text.trim() === '') continue; // blank lines settle nothing
		if (leading) {
			leading = false;
			if (/^%%\w/.test(text)) scan.cellMagic = true;
		}
		if (text[0] !== '%') continue;
		const m = /^%{1,2}(\w+)([^\n]*)/.exec(text);
		if (!m) {
			scan.nonInert = true; // `%` followed by something we cannot name ⇒ conservative
			continue;
		}
		if (m[1] === 'autoreload' || (EXT_LOADERS.has(m[1]) && /\bautoreload\b/.test(m[2]))) {
			scan.autoreload = true;
		}
		if (!INERT_LINE_MAGICS.has(m[1])) scan.nonInert = true; // unknown ⇒ conservative
	}
	return scan;
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
	return scanMagics(logicalLines(source ?? '')).autoreload;
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
