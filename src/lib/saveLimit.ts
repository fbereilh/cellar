/**
 * Cellar - how big a file-tab save may be before the TRANSPORT refuses it.
 *
 * Distinct from the read/write ceilings in `$lib/server/limits.js`: those are
 * about the file, this one is about the request. A file tab saves by PUTting
 * `JSON.stringify({path, content})`, and adapter-node caps a request body at
 * `BODY_SIZE_LIMIT` - rejecting it with a 413 BEFORE any route handler runs.
 * That cap is read once at module load and applied upstream of every route, so
 * it cannot be relaxed for one endpoint; the honest answer is therefore to stop
 * OFFERING an edit that could never be persisted, which is what
 * `saveFitsTransport` decides.
 *
 * Reading is untouched by any of this: a file arrives in a GET *response*, so a
 * 15 MB HTML export still opens and previews exactly as before. Only the save
 * direction has a body.
 *
 * The limit compared against is the one ACTUALLY in force, never a guess: the
 * server computes it (`effectiveBodyLimit`) and the file GET carries it to the
 * tab. Guessing was a real defect in both directions - `cellar --dev` runs Vite,
 * whose handler calls `getRequest()` with NO `bodySizeLimit` at all, so a 600 KB
 * `.md` that saves fine there would have opened read-only; and an operator who
 * raises `BODY_SIZE_LIMIT` would have gained nothing user-visible.
 *
 * Pure + browser-safe (no imports, no DOM, no Node): the decision is made in the
 * tab, where the document is, and the server half only feeds it a number.
 */

/**
 * adapter-node's own default `BODY_SIZE_LIMIT` (`'512K'`, see its `handler.js`)
 * - the FALLBACK for when the effective limit cannot be determined.
 *
 * Cellar's launcher deliberately does not raise the real setting: it is app-wide,
 * so lifting it for one save route lifts how much memory ANY unauthenticated
 * request can make the server buffer - on the same process that carries kernel
 * streaming, SSE and the in-process MCP server. An over-threshold document opens
 * view-only instead of editable-but-doomed.
 */
export const DEFAULT_BODY_SIZE_LIMIT = 512 * 1024;

/**
 * Wire sentinel for "no body cap at all" - what the Vite dev server enforces
 * (nothing), and what `BODY_SIZE_LIMIT=Infinity` asks for in production. A
 * string, not `Infinity`: `JSON.stringify(Infinity)` is `null`, which would be
 * indistinguishable from a field the server never sent.
 */
export const UNLIMITED_BODY_LIMIT = 'unlimited';

/** What the server tells the browser about the in-force request-body ceiling. */
export type BodyLimitWire = number | typeof UNLIMITED_BODY_LIMIT;

/**
 * Parse a `BODY_SIZE_LIMIT` value exactly as adapter-node does (`parse_as_bytes`
 * in its `utils.js`): an optional `K`/`M`/`G` suffix over a plain number, with
 * `Infinity` meaning uncapped. `null` for anything unparseable - adapter-node
 * refuses to boot on a NaN limit, so a value we cannot read is a value we must
 * not assume anything about.
 */
export function parseBodySizeLimit(raw: string | undefined | null): number | null {
	const value = String(raw ?? '').trim();
	if (!value) return null;
	const unit = value[value.length - 1].toUpperCase();
	const multiplier = unit === 'K' ? 1024 : unit === 'M' ? 1024 * 1024 : unit === 'G' ? 1024 * 1024 * 1024 : 1;
	const n = Number(multiplier === 1 ? value : value.slice(0, -1)) * multiplier;
	if (Number.isNaN(n) || n < 0) return null;
	return n;
}

/**
 * The request-body ceiling the running server actually enforces, as the browser
 * should hear it.
 *
 * @param raw `process.env.BODY_SIZE_LIMIT` - an operator's own setting, which the
 *   launcher passes through untouched and which therefore really does widen the
 *   editable range.
 * @param isDev SvelteKit's `dev`. The Vite dev handler applies no body cap, so
 *   nothing may be view-only for transport reasons under `cellar --dev`.
 */
export function effectiveBodyLimit(raw: string | undefined | null, isDev: boolean): BodyLimitWire {
	if (isDev) return UNLIMITED_BODY_LIMIT;
	const parsed = parseBodySizeLimit(raw);
	if (parsed === null) return DEFAULT_BODY_SIZE_LIMIT; // unset, or unreadable
	return Number.isFinite(parsed) ? parsed : UNLIMITED_BODY_LIMIT;
}

/**
 * Read the wire value back into a number of bytes, `Infinity` for uncapped.
 * Anything unrecognised - a field an older server never sent, a malformed value -
 * falls to the conservative default rather than assuming there is no cap.
 */
export function resolveBodyLimit(wire: unknown): number {
	if (wire === UNLIMITED_BODY_LIMIT) return Infinity;
	if (typeof wire === 'number' && Number.isFinite(wire) && wire >= 0) return wire;
	return DEFAULT_BODY_SIZE_LIMIT;
}

/** `{"path":` + `,"content":` + `}` - the framing around the two JSON strings. */
const FRAME_BYTES = 20;

/**
 * The UTF-8 byte length `JSON.stringify` would produce for one string, quotes
 * included - computed in a single pass with no allocation, because the string
 * may be megabytes and this runs on the load path of every file tab.
 *
 * Exact, not an estimate: a threshold guessed from the raw length would either
 * refuse files that fit or admit files that 413, and admitting one recreates the
 * silent-failure defect this exists to retire. HTML is full of `"` and `\n`,
 * each of which becomes two bytes.
 */
function jsonStringBytes(s: string): number {
	let n = 2; // the surrounding quotes
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0x22 || c === 0x5c) n += 2; // \" \\
		else if (c < 0x20) {
			// \b \t \n \f \r are two bytes; every other control char is \u00xx.
			n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
		} else if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				n += 4; // a well-formed pair is one 4-byte UTF-8 sequence
				i++;
			} else n += 6; // a lone surrogate is escaped as \udXXX
		} else if (c >= 0xdc00 && c <= 0xdfff) n += 6; // lone trailing surrogate
		else n += 3;
	}
	return n;
}

/** Byte length of the exact body a file-tab save would PUT. */
export function saveBodyBytes(relPath: string, content: string): number {
	return FRAME_BYTES + jsonStringBytes(String(relPath ?? '')) + jsonStringBytes(content ?? '');
}

/**
 * Can this document be saved at all? `false` ⇒ the tab opens read-only and says
 * so, instead of accepting edits the PUT would 413 on.
 *
 * `limit` is the effective in-force ceiling in bytes (`Infinity` = uncapped),
 * which callers get by running the server's wire value through
 * `resolveBodyLimit`; the default is only the fallback for a caller with no wire
 * value at all.
 */
export function saveFitsTransport(
	relPath: string,
	content: string,
	limit: number = DEFAULT_BODY_SIZE_LIMIT
): boolean {
	if (limit === Infinity) return true; // don't walk megabytes to compare against ∞
	// adapter-node refuses on `content_length > limit`, so equality still fits.
	return saveBodyBytes(relPath, content) <= limit;
}
