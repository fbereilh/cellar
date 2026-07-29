/**
 * Cellar — short cell-id handles for the agent surface.
 *
 * Cell ids are 36-char UUIDs (notebook.ts owns generation + uniqueness). Emitting
 * the full UUID in every map / read / search / run payload is pure token overhead —
 * a ~50-cell get_notebook_map spends ~315 tokens on ids alone. The agent never
 * needs the whole UUID to address a cell: the first 8 chars already identify it
 * uniquely in all but astronomically-unlikely cases.
 *
 * A HANDLE is the shortest unique prefix of a cell's id, of length >= 8, WITHIN a
 * single notebook. Normally exactly 8 chars; if two cells collide on their first 8
 * chars the colliding handles are lengthened just enough to disambiguate, so an
 * emitted handle ALWAYS resolves back to exactly the cell it names.
 *
 * Handles are computed over ALL of a notebook's cells (visible AND hidden), so a
 * handle is unique within the whole document — never merely among the cells one
 * response happened to show. That is what lets emission and `resolveCellId` share
 * the exact same uniqueness rule and never disagree.
 *
 * The canonical id stored in the document / .ipynb stays the full UUID — handles
 * are a display/addressing convenience only, never written back as a cell's id.
 */

/** The floor length for a handle; a UUID prefix this short is essentially always unique. */
export const MIN_HANDLE = 8;

/**
 * Why a cell reference could not be resolved, as a CODE rather than only prose.
 *
 * The three failures call for different responses and a caller must be able to
 * tell them apart WITHOUT matching on the message text: `not_found` is the one
 * the MCP boundary enriches with a "the user deleted this cell" note when the id
 * is in the notebook's tombstone registry (`userActivity.ts`), while `ambiguous`
 * names a live collision that a deletion note would misdescribe. Message strings
 * are unchanged, so nothing that only reads `.message` is affected.
 */
export type CellRefFailure = 'empty' | 'ambiguous' | 'not_found';

export class CellRefError extends Error {
	readonly code: CellRefFailure;
	constructor(message: string, code: CellRefFailure) {
		super(message);
		this.name = 'CellRefError';
		this.code = code;
	}
}

/** Map each cell's full id to its short handle (shortest unique prefix >= 8). */
export function computeHandles(cells: ReadonlyArray<{ id: string }>): Map<string, string> {
	const ids = cells.map((c) => c.id);
	const handles = new Map<string, string>();
	for (const id of ids) {
		let len = Math.min(MIN_HANDLE, id.length);
		// Grow the prefix until it uniquely identifies this id among all cells. A
		// UUID differs from every other id within its first few chars, so this almost
		// never advances past MIN_HANDLE; when two ids DO share their first 8 chars,
		// both grow just enough to separate, so neither handle is ever ambiguous.
		while (len < id.length) {
			const prefix = id.slice(0, len);
			if (ids.filter((other) => other.startsWith(prefix)).length <= 1) break;
			len++;
		}
		handles.set(id, id.slice(0, len));
	}
	return handles;
}

/**
 * Resolve an agent-supplied cell reference to the one full cell id it names, or
 * throw an actionable error. Accepts, in order:
 *   1. an exact full id (a 36-char UUID an agent or log still holds) — wins immediately,
 *   2. a short handle, or ANY prefix, that matches exactly one cell,
 * and rejects a prefix that matches more than one cell (ambiguous) or none
 * (not found). It NEVER silently picks a cell: an ambiguous or unknown ref is an
 * error the caller surfaces, so a handle can only ever resolve to the exact cell
 * it was emitted for. Every rejection throws a `CellRefError` carrying the `code`
 * above, so a caller can tell the three apart without matching on message text.
 */
export function resolveCellId(cells: ReadonlyArray<{ id: string }>, ref: string): string {
	const r = (ref ?? '').trim();
	if (!r) throw new CellRefError('a cell id is required', 'empty');
	// A full-id exact match wins outright, so a caller holding a whole UUID is
	// unaffected even in the (impossible-in-practice) case that it also prefixes another id.
	const exact = cells.find((c) => c.id === r);
	if (exact) return exact.id;
	const matches = cells.filter((c) => c.id.startsWith(r));
	if (matches.length === 1) return matches[0].id;
	if (matches.length > 1) {
		throw new CellRefError(
			`ambiguous cell id "${r}" — it matches ${matches.length} cells; pass more characters or the full id`,
			'ambiguous'
		);
	}
	throw new CellRefError(
		`no cell matches id "${r}" — use get_notebook_map to see current cell handles`,
		'not_found'
	);
}
