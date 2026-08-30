/**
 * Cellar - reading nbdev's `#|` cell directives out of a cell's SOURCE.
 *
 * nbdev marks a cell with a comment directive (`#| export`, `#| default_exp core`)
 * rather than with metadata, so a notebook authored in nbdev carries its export
 * marks in text that Cellar's own `metadata.cellar` reader cannot see. This module
 * is the ONE place that reads them, shared by the per-cell mark (`exportRole.ts`)
 * and the notebook target (`export-py.ts`) - a second copy is how the two come to
 * disagree about whether a line is a directive at all.
 *
 * STATIC, never executed. A `#|` line is a comment: running it does nothing, so a
 * directive is a fact about the source and is read the same way whether or not the
 * cell has ever run. That is also what lets the browser read it (this module is
 * pure and browser-safe, the `$lib/hideInput` / `$lib/agentVisibility` precedent),
 * so the row toggle and the exporter answer from one rule.
 *
 * ## The rule, measured against nbdev 3.3.13 / fastcore 2.2.16
 *
 * `fastcore/nbio.py`'s `_partition` + `_directive` decide this, and the parts that
 * are easy to get wrong were driven case by case rather than remembered:
 *
 * - **Leading block only.** Directives are read from the run of lines at the TOP of
 *   the cell, and the block ends at the first line that is not a directive, a cell
 *   magic (`%%time`), or blank. So `x = 1` then `#| export` is NOT an export mark,
 *   and neither is a `#| export` inside a triple-quoted string (the opening `s = '''`
 *   already ended the block). A PLAIN comment (`# a note`) ends it too - only `#|`
 *   lines count. Cellar's previous `default_exp` scan used a `/m` regex over the
 *   whole source and so honoured all three, which is precisely the "half-speaks
 *   nbdev" defect: a target that resolves plausibly from text nbdev ignores.
 * - **Prefix shape** is `\s*#\s*\|`, so `#|export`, `#| export`, `# | export` and an
 *   indented (space or tab) form all match, and `\r\n` is handled.
 * - **Name and value**: after the prefix, `([^\s:]+)\s*:?\s?(.*?)\s*$`. The name runs
 *   to the first whitespace or colon; the rest is the value, with the literal
 *   `true` normalized to the empty string (nbdev's spelling for a BARE directive),
 *   so `#| export` and `#| export: true` are the same thing.
 * - **Case-sensitive, exact names.** `#| EXPORT` is a different directive, and so
 *   are `exporti`, `exports` and `exportd` - each is its own name, so an exact match
 *   on `export` excludes them for free rather than by a special case.
 *
 * ## Cost
 *
 * `isExportCell` runs per cell on hot paths (the agent map, the export hazard scan,
 * every cell render), so this must not walk a whole source. It does not: the block
 * ends at the first ordinary line, which for almost every cell is line 1, so the
 * common case reads one line and stops. Lines are taken with `indexOf('\n')` rather
 * than by splitting, so no array is allocated for a source that is not a directive
 * block.
 *
 * **There is deliberately NO `source.includes(...)` pre-check here, and it is not an
 * oversight - it was MEASURED to be the slower half.** `storedExportTarget`
 * (`export-py.ts`) keeps its `includes('default_exp')` guard and that is still right,
 * because the two ask different questions: that one scans EVERY cell of a document
 * before it can conclude "no target", so a cheap reject per cell pays for itself,
 * while this predicate is asked about ONE cell and already answers from its first
 * line. A substring test cannot short-circuit - on the common no-directive notebook
 * it reads the WHOLE source to conclude nothing - so it is pure added work in front
 * of a walk that had already stopped.
 *
 * Measured (node 26, 200 realistic cells averaging ~5 KiB of ordinary analysis code
 * and no directives, one `nbdevDirective(source,'export')` per cell, best of three
 * runs after warm-up): **~7 us per 200-cell sweep for the walk as shipped, ~160 us
 * for an `includes('export')`-guarded variant - the guard is ~23x SLOWER.** Do not
 * re-add it.
 */

/** `\s*#\s*\|` - nbdev's python directive prefix. */
const PREFIX = /^[ \t]*#[ \t]*\|/;
/** A cell magic (`%%time`): allowed inside the leading block, not a directive. */
const CELL_MAGIC = /^[ \t]*%%\w/;
/** `([^\s:]+)\s*:?\s?(.*?)\s*$` - the name/value split, after the prefix. */
const NAME_VALUE = /^([^\s:]+)[ \t]*:?[ \t]?([\s\S]*?)[ \t]*$/;

/**
 * The value of nbdev directive `name` in this source, or null when it is absent.
 *
 * A BARE directive (`#| export`, or its `#| export: true` spelling) reports the
 * empty string, which is nbdev's own normalization - so "present and bare" is
 * `=== ''` and "present with a value" is a non-empty string. Callers must keep
 * those apart: `#| export other` names a DIFFERENT module in nbdev and is not a
 * mark for this notebook's own (see `exportRole.ts`).
 *
 * The LAST occurrence wins for a repeated name, which is what `_directives_get`'s
 * `dict(...)` build over the block's lines does - verified by differential rather
 * than reasoned about, after the obvious first-wins guess proved wrong. That is
 * why the walk runs to the end of the block instead of returning on the first hit;
 * the block is bounded by the first ordinary line either way, so an ordinary cell
 * is still answered from line 1.
 */
export function nbdevDirective(source: string | null | undefined, name: string): string | null {
	if (!source) return null;
	let found: string | null = null;
	let at = 0;
	const len = source.length;
	while (at <= len) {
		const nl = source.indexOf('\n', at);
		const end = nl === -1 ? len : nl;
		// Trim only the line terminator; leading whitespace is part of the patterns.
		const line = source.slice(at, end > at && source[end - 1] === '\r' ? end - 1 : end);
		at = end + 1;
		const d = directiveOn(line);
		if (d) {
			if (d.name === name) found = d.value;
		} else if (!staysInBlock(line)) break;
		if (nl === -1) break;
	}
	return found;
}

/**
 * The value of the FIRST `#| <name>` line that sits OUTSIDE this source's leading
 * directive block, or null when there is none. A BARE one reports `''`, exactly as
 * `nbdevDirective` does.
 *
 * The REPORTING half of the leading-block rule, and it is deliberately not a
 * loosening of it: what nbdev ignores, Cellar ignores. But `#| default_exp core`
 * written after a line of code, after a plain comment, or inside a triple-quoted
 * string LOOKS like a working target, and Cellar's own scan used to honour it - so
 * resolving to nothing and saying nothing leaves a previously generated module
 * quietly going stale. This is what lets the caller NAME the ignored line instead
 * (`storedExportTarget` in `server/export-py.ts`).
 *
 * Cost: only the caller's no-target fallback runs this, and only for a cell that
 * already passed its `includes('default_exp')` guard AND yielded no usable
 * directive - i.e. exactly the suspicious cell. It never touches the ordinary
 * resolve path, where `nbdevDirective` still answers most cells from line 1.
 */
export function nbdevDirectiveOutsideBlock(
	source: string | null | undefined,
	name: string
): string | null {
	if (!source) return null;
	let inBlock = true;
	let at = 0;
	const len = source.length;
	while (at <= len) {
		const nl = source.indexOf('\n', at);
		const end = nl === -1 ? len : nl;
		const line = source.slice(at, end > at && source[end - 1] === '\r' ? end - 1 : end);
		at = end + 1;
		const d = directiveOn(line);
		if (d) {
			if (!inBlock && d.name === name) return d.value;
		} else if (inBlock && !staysInBlock(line)) inBlock = false;
		if (nl === -1) break;
	}
	return null;
}

/**
 * The directive a single line carries, or null when the line is not a `#|` line at
 * all. A BARE `#|` reports a null NAME: it names no directive yet still belongs to
 * the leading block (it matched the prefix), so it must not end a walk.
 *
 * The line-level RULE lives here so both walks above read one copy of it - the
 * loops differ only in what they do with the answer.
 */
function directiveOn(line: string): { name: string | null; value: string } | null {
	if (!PREFIX.test(line)) return null;
	const rest = line.replace(PREFIX, '').trim();
	const m = rest === '' ? null : NAME_VALUE.exec(rest);
	if (!m) return { name: null, value: '' };
	return { name: m[1], value: m[2] === 'true' ? '' : m[2] };
}

/** Does a NON-directive line stay inside the leading block? (a cell magic, or blank) */
function staysInBlock(line: string): boolean {
	return CELL_MAGIC.test(line) || line.trim() === '';
}

/** Is `name` present as a BARE directive (no value)? */
export function hasBareNbdevDirective(source: string | null | undefined, name: string): boolean {
	return nbdevDirective(source, name) === '';
}
