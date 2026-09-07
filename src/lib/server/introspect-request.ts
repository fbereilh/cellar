/**
 * The one reader for both editor-introspection routes' request bodies
 * (`/api/kernel/complete`, `/api/kernel/inspect`).
 *
 * Shared because the two carry the same payload and the same validation
 * question, and because a second copy is how one route comes to accept a body
 * the other refuses. Both take the WHOLE cell source plus a cursor offset - the
 * kernel's own completer and `token_at_cursor` are what read it (see
 * `$lib/kernelIntrospect`), so nothing is extracted here.
 *
 * Validated rather than coerced: `cursorPos` is an offset INTO `code` that the
 * kernel indexes with, so a non-integer or out-of-range value is a malformed
 * request, not something to clamp. A clamp would answer confidently about a
 * position the caller never asked about.
 */
export interface IntrospectRequest {
	ok: true;
	/** Workspace-relative or absolute notebook path; empty means the active notebook. */
	path: string;
	code: string;
	cursorPos: number;
	/** `inspect_request` detail level; absent (undefined) on the completion route. */
	detail?: unknown;
}

export async function readIntrospectRequest(
	request: Request
): Promise<IntrospectRequest | { ok: false; message: string }> {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') return { ok: false, message: 'expected a JSON object body' };
	const { path, code, cursorPos, detail } = body;
	if (path != null && typeof path !== 'string') return { ok: false, message: 'path must be a string' };
	if (typeof code !== 'string') return { ok: false, message: 'code must be a string' };
	if (typeof cursorPos !== 'number' || !Number.isInteger(cursorPos) || cursorPos < 0 || cursorPos > code.length)
		return { ok: false, message: 'cursorPos must be an integer offset within code' };
	return { ok: true, path: (path as string | undefined) ?? '', code, cursorPos, detail };
}
