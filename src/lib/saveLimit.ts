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
 * Pure + browser-safe (no imports, no DOM, no Node): the decision is made in the
 * tab, where the document is.
 */

/**
 * adapter-node's own default `BODY_SIZE_LIMIT` (`'512K'`, see its `handler.js`).
 *
 * Deliberately NOT raised by the launcher: it is an app-wide setting, so lifting
 * it for one save route lifts how much memory ANY unauthenticated request can
 * make the server buffer - on the same process that carries kernel streaming,
 * SSE and the in-process MCP server. An operator who sets the variable still
 * wins (the launcher passes their environment through untouched); Cellar simply
 * assumes the safe default here, so an over-threshold file reads as view-only
 * rather than editable-but-doomed.
 */
export const DEFAULT_BODY_SIZE_LIMIT = 512 * 1024;

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
 */
export function saveFitsTransport(
	relPath: string,
	content: string,
	limit: number = DEFAULT_BODY_SIZE_LIMIT
): boolean {
	// adapter-node refuses on `content_length > limit`, so equality still fits.
	return saveBodyBytes(relPath, content) <= limit;
}
