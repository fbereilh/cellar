/**
 * The ONE rule for what a notebook is CALLED when it is uploaded into the
 * Databricks workspace, shared verbatim by the server (`databricks.ts`, which
 * assembles the path it imports to) and the browser (`Databricks.svelte`, which
 * previews it before the click). A second copy of any part of this - the
 * extension strip, the token set, the separator refusal - would let the preview
 * promise one name while the upload lands another, and the preview is the whole
 * point: the user must see precisely what will appear in their workspace.
 *
 * The name is `<prefix><stem><postfix>`, where `stem` is the open notebook's
 * basename with its `.ipynb`/`.py` suffix dropped. Both affixes are OPTIONAL and
 * default to empty, so a notebook with neither resolves byte-for-byte to what the
 * upload has always produced (`/Users/<you>/<basename-without-extension>`).
 *
 * **Why the postfix attaches to the STEM.** Databricks names a workspace notebook
 * by its path segment and carries no suffix (`analysis`, never `analysis.ipynb`),
 * so the extension is dropped before anything is affixed. That is what makes
 * `analysis.ipynb` + `_{YYYYMMDD}` land as `analysis_20260805` rather than the
 * nonsense `analysis.ipynb_20260805`; there is no "postfix before the extension"
 * decision left to get wrong, because by then there is no extension.
 *
 * **Date tokens** (`{YYYY-MM-DD}`, `{YYYYMMDD}`, `{YYYY}`, `{MM}`, `{DD}`) expand
 * against the LOCAL date - the user is naming a notebook after the day they are
 * working, not after UTC. They are deliberately CASE-SENSITIVE and the set is
 * deliberately small: no time-of-day tokens, so `{mm}` (minutes by every other
 * convention) can never silently mean the month. Anything else in braces is left
 * LITERAL - `{FOO}` uploads as `{FOO}` - because a typo in a name is visible in
 * the preview and fixable, while silently dropping it would produce a name the
 * user never asked for and cannot see the cause of.
 *
 * **Expansion is idempotent**, which is what makes the CLIENT/SERVER hop exact:
 * the browser expands at click time and sends literal text, so the server's own
 * expansion finds no tokens left and changes nothing. That covers the hop alone -
 * keeping the PREVIEW itself in step with the day is the browser's job (it
 * re-resolves against a clock that ticks while the panel is open), because nothing
 * here can know when the date the caller passed stopped being today.
 *
 * Browser-safe by construction: no imports, pure string work.
 */

/** A workspace notebook carries no file suffix, so the source file's is dropped. */
const NOTEBOOK_EXT = /\.(ipynb|py)$/i;

/** Anything in braces; the contents decide whether it is a token or literal text. */
const BRACED = /\{[^{}]*\}/g;

/**
 * A character that must never reach a workspace name. `/` and `\` are the reason
 * this validation exists at all: the name is ONE segment appended after
 * `/Users/<you>/`, so a separator inside it would silently redirect the upload
 * somewhere else in the workspace tree. Control characters (C0 plus DEL) are
 * refused alongside them - they are invisible, so a name carrying one looks
 * identical to a name that does not.
 *
 * Note what is deliberately NOT here: a bare `..`. Without a separator it cannot
 * traverse anywhere (`/Users/you/..notes` is an ordinary, if odd, notebook name),
 * so the only dangerous form is the whole name being `.` or `..`, which
 * `nameProblem` refuses on its own. Banning the substring would reject a legal
 * name and buy nothing.
 */
const FORBIDDEN = /[\u0000-\u001f\u007f/\\]/;

/**
 * The tokens an affix may carry, in the order the UI should list them.
 *
 * Deliberately the tokens ALONE: the UI shows each one beside its expansion, and
 * that example is produced by running `expandDateTokens` on it rather than stored
 * here, so the vocabulary it advertises cannot drift from what the expander does
 * (a literal example would have gone on claiming `{YYYY} → 2026` for years).
 */
export const UPLOAD_DATE_TOKENS: readonly string[] = [
	'{YYYY-MM-DD}',
	'{YYYYMMDD}',
	'{YYYY}',
	'{MM}',
	'{DD}'
];

/** Two digits, zero-padded - `{MM}` of March is `03`, never `3`. */
function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * Replace every KNOWN date token in `text` with `now`'s local date; leave every
 * other braced run exactly as written. Idempotent - the output carries no tokens,
 * so expanding it again is a no-op.
 */
export function expandDateTokens(text: string, now: Date = new Date()): string {
	const yyyy = String(now.getFullYear()).padStart(4, '0');
	const mm = pad2(now.getMonth() + 1);
	const dd = pad2(now.getDate());
	const values: Record<string, string> = {
		'{YYYY-MM-DD}': `${yyyy}-${mm}-${dd}`,
		'{YYYYMMDD}': `${yyyy}${mm}${dd}`,
		'{YYYY}': yyyy,
		'{MM}': mm,
		'{DD}': dd
	};
	return text.replace(BRACED, (match) => values[match] ?? match);
}

/**
 * The open notebook's basename with its `.ipynb`/`.py` suffix dropped.
 *
 * Trimmed BEFORE the suffix is matched, not only after: the extension is anchored
 * to the end, so a file literally named `analysis.ipynb ` (a trailing space is a
 * legal filename on every platform Cellar runs on) kept its whole suffix and
 * uploaded as a workspace notebook called `analysis.ipynb`.
 */
export function notebookStem(fileName: string): string {
	return fileName.trim().replace(NOTEBOOK_EXT, '').trim();
}

/** Why `name` is not something Databricks can call a workspace notebook, or null. */
function nameProblem(name: string): string | null {
	if (!name) return 'empty';
	if (name === '.' || name === '..') return 'dots';
	if (FORBIDDEN.test(name)) return 'forbidden';
	return null;
}

/** What an affix is called in a message the user reads. */
type Affix = 'prefix' | 'postfix';

export interface UploadNameAffixes {
	prefix?: string | null;
	postfix?: string | null;
}

export interface ResolvedUploadName {
	/** The final workspace segment, e.g. `2026-08-05_analysis`. Empty when `error` is set. */
	name: string;
	/** The affixes as they expand right now, so the UI can show what a token became. */
	prefix: string;
	postfix: string;
	/**
	 * Why this name cannot be uploaded, ready to show as-is, or null. Set means
	 * NOTHING should be sent: the name is refused rather than quietly repaired,
	 * because a silently sanitized name is one the preview promised and the
	 * workspace never received.
	 */
	error: string | null;
}

/**
 * Resolve the workspace name for `fileName` under `affixes`, expanding date
 * tokens against `now`.
 *
 * Both halves of the upload call this: the browser to render the preview and to
 * decide whether the button may be pressed, the server to build the path it
 * imports to. Neither may reimplement any part of it.
 */
export function resolveUploadName(
	fileName: string,
	affixes: UploadNameAffixes = {},
	now: Date = new Date()
): ResolvedUploadName {
	const prefix = expandDateTokens(affixes.prefix ?? '', now);
	const postfix = expandDateTokens(affixes.postfix ?? '', now);
	const stem = notebookStem(fileName);
	// The affixes are checked FIRST and separately, so the remedy names the thing
	// the user can act on: told only that the assembled name is bad, someone with a
	// `/` in their prefix would go looking at the notebook's filename.
	for (const [which, value] of [
		['prefix', prefix],
		['postfix', postfix]
	] as [Affix, string][]) {
		if (FORBIDDEN.test(value)) {
			return {
				name: '',
				prefix,
				postfix,
				error: `The ${which} cannot contain a slash, a backslash or a control character - the upload has to stay inside your own workspace folder.`
			};
		}
	}
	if (nameProblem(stem)) {
		return {
			name: '',
			prefix,
			postfix,
			error: `"${fileName}" is not a name Databricks can give a workspace notebook. Rename the file, then upload again.`
		};
	}
	// Trimmed as a whole: a leading or trailing space in a workspace name is
	// invisible in the UI and impossible to type back. With no affixes this is the
	// already-trimmed stem, so the no-affix upload is unchanged.
	const name = `${prefix}${stem}${postfix}`.trim();
	// Defence in depth, and NOT reachable through the call order above: the stem has
	// already been proven non-empty, trimmed, neither `.` nor `..` and forbidden-free,
	// and both affixes have already been FORBIDDEN-checked, so their concatenation
	// cannot be any of those things either. It stays because the guarantee is an
	// emergent property of that order rather than of this line - reordering the checks,
	// or adding a THIRD source of text to the name, would otherwise let an unusable
	// name reach the workspace silently. Every refusal a caller can actually trigger is
	// raised above this, with a message naming the field they can fix.
	if (nameProblem(name)) {
		return {
			name: '',
			prefix,
			postfix,
			error: `"${name}" is not a name Databricks can give a workspace notebook. Change the prefix or postfix, then upload again.`
		};
	}
	return { name, prefix, postfix, error: null };
}
