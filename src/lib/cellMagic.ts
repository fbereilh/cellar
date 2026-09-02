/**
 * Cellar - "which cell magic does this cell open with", the browser-safe half.
 *
 * IPython requires a `%%name` cell magic to be the cell's FIRST line (leading
 * blank lines tolerated), and several unrelated rules turn on the answer: the
 * static-analysis normalizer and the imports sweep (`server/magics.ts`), the Mojo
 * run path (`server/mojo.ts`, which compiles a mojo cell to `%%mojo` and must not
 * double a header the source already has), and now the EXPORT eligibility rule
 * (`exportRole.ts`), which has to refuse a `%%mojo`-bodied cell for a `.py`
 * target.
 *
 * That last caller is a BROWSER module (`Cell.svelte` reads it), and `$lib/server`
 * may not be imported from the client, so the rule was lifted here rather than
 * copied - the `write-file-atomic.js` / `toml.js` precedent. Both server modules
 * re-export from this one, so every existing importer is unchanged and there is
 * still exactly ONE definition of what a `%%mojo` cell is.
 *
 * It imports nothing, so it is safe on either side.
 */

/** The IPython cell magic a mojo cell compiles to (`server/mojo.ts` owns the run path). */
export const MOJO_MAGIC = 'mojo';

/** The header line a mojo cell's source carries, or that the run path prepends. */
export const MOJO_MAGIC_HEADER = `%%${MOJO_MAGIC}`;

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
 * Does this source open with a `%%mojo` header - i.e. is its BODY Mojo rather
 * than Python, whatever the cell's declared type says?
 *
 * Two kinds of cell answer true, and both are genuinely Mojo: a Cellar `mojo`
 * cell whose stored source already carries the header (pasting an example
 * straight out of Modular's docs, or a `%%mojo build …` subcommand), and a plain
 * `code` cell a user pasted the same thing into without converting its type. The
 * second is why the export eligibility rule asks this at all - such a cell reads
 * as Python to every type-based test while its body is Mojo.
 */
export function hasMojoHeader(source: string | null | undefined): boolean {
	return cellMagicName(source) === MOJO_MAGIC;
}
