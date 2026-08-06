import { describe, it, expect } from 'vitest';
import {
	MAX_UPLOAD_NAME_CHARS,
	UPLOAD_DATE_TOKENS,
	expandDateTokens,
	insertUploadToken,
	notebookStem,
	resolveUploadName,
	unknownDateTokens
} from '../../src/lib/databricksUploadName';

/**
 * **The name a notebook takes when it is uploaded to the Databricks workspace.**
 *
 * `resolveUploadName` is the ONE rule the sidebar's live preview and the server's
 * import path both read, so what this file pins is what makes the preview honest:
 *
 *   1. **Date tokens** expand against the LOCAL date, zero-padded, and an unknown
 *      braced run is left LITERAL (never silently dropped, which would produce a
 *      name the user cannot see the cause of). Expansion is idempotent, which is
 *      what lets the browser expand once and the server re-expand for free.
 *   2. **Assembly** is `<prefix><stem><postfix>`, on the stem - the extension is
 *      dropped first, so a `.ipynb` can never end up mid-name.
 *   3. **A no-affix upload is unchanged** - byte-for-byte the pre-affix name, which
 *      is what makes this feature a pure superset.
 *   4. **An affix cannot escape `/Users/<you>/`**: a separator or a control
 *      character is REFUSED, not repaired - a quietly sanitized name is one the
 *      preview promised and the workspace never received.
 *
 * Pure and browser-safe, so it needs no workspace, no SDK and no kernel. The wiring
 * (the server actually importing to this name) is `databricks-upload-notebook.test.ts`.
 */

/** 2026-08-05, local time - the constructor takes local components, which is the point. */
const DAY = new Date(2026, 7, 5, 13, 45);
/** A single-digit month AND day, so a missing zero-pad cannot hide. */
const PADDED = new Date(2026, 2, 9, 0, 5);

describe('date tokens', () => {
	it('expands each documented token against the LOCAL date', () => {
		expect(expandDateTokens('{YYYY-MM-DD}', DAY)).toBe('2026-08-05');
		expect(expandDateTokens('{YYYYMMDD}', DAY)).toBe('20260805');
		expect(expandDateTokens('{YYYY}', DAY)).toBe('2026');
		expect(expandDateTokens('{MM}', DAY)).toBe('08');
		expect(expandDateTokens('{DD}', DAY)).toBe('05');
	});

	it('zero-pads the month and the day', () => {
		// March 9th: `3`/`9` would sort wrongly beside every other notebook and is the
		// whole reason a token exists rather than typing the date by hand.
		expect(expandDateTokens('{YYYY-MM-DD}', PADDED)).toBe('2026-03-09');
		expect(expandDateTokens('{YYYYMMDD}', PADDED)).toBe('20260309');
		expect(expandDateTokens('{MM}-{DD}', PADDED)).toBe('03-09');
	});

	it('every token the UI advertises is one the expander really handles', () => {
		// The tooltip renders `<token> → expandDateTokens(<token>)`, so its examples can
		// no longer go stale by construction (a stored `2026` would still be advertised
		// years later). What that leaves worth pinning is the vocabulary itself: a token
		// offered here but not handled would be shown to the user as if it worked and
		// then land LITERALLY in their notebook name.
		for (const token of UPLOAD_DATE_TOKENS) {
			const shown = expandDateTokens(token, DAY);
			expect(shown).not.toBe(token);
			// …and the tooltip's example is the same expansion the NAME is built from,
			// not a second clock that could disagree with it.
			expect(resolveUploadName('analysis.ipynb', { prefix: token }, DAY).prefix).toBe(shown);
		}
	});

	it('leaves an UNKNOWN braced run literal, and does not touch ordinary text', () => {
		// Visible in the preview and fixable; dropping it would produce a name the user
		// never asked for with nothing on screen explaining why.
		expect(expandDateTokens('{FOO}', DAY)).toBe('{FOO}');
		expect(expandDateTokens('report-{WEEK}-{YYYY}', DAY)).toBe('report-{WEEK}-2026');
		expect(expandDateTokens('{}', DAY)).toBe('{}');
		expect(expandDateTokens('plain_name', DAY)).toBe('plain_name');
	});

	it('is CASE-SENSITIVE, so `{mm}` cannot silently mean the month', () => {
		// `{mm}` is minutes by every other convention; this set has no time tokens, so
		// it must stay literal rather than quietly resolving to something else.
		expect(expandDateTokens('{mm}', DAY)).toBe('{mm}');
		expect(expandDateTokens('{yyyy}', DAY)).toBe('{yyyy}');
	});

	it('is IDEMPOTENT - which is what keeps the preview exact across the client/server hop', () => {
		// The browser expands at click time and sends literal text; the server expands
		// again. If that second pass could change anything, a name could land differing
		// from the one previewed - including across midnight, with a DIFFERENT date.
		const once = expandDateTokens('{YYYY-MM-DD}_', DAY);
		expect(expandDateTokens(once, PADDED)).toBe(once);
	});

	it('expands several tokens in one affix', () => {
		expect(expandDateTokens('{YYYY}-{MM}', DAY)).toBe('2026-08');
		expect(expandDateTokens('{DD}{MM}{YYYY}', DAY)).toBe('05082026');
	});
});

describe('naming a brace that is NOT a token', () => {
	it('names a near-miss of a REAL token, which is how the reported bug happened', () => {
		// The bug as it actually happened: someone who has seen `{YYYYMMDD}` and `{YYYY}`
		// work reaches for a shorter stamp. Left literal (correctly - dropping it would be
		// worse), the preview reads `{YYYYMMD}_analysis`, which looks like a token waiting
		// to expand rather than one that never will. Naming it is what makes the failure
		// visible at all; `{YYYYMM}` itself is now real, and is covered below.
		expect(unknownDateTokens('{YYYYMMD}_', DAY)).toEqual(['{YYYYMMD}']);
		expect(expandDateTokens('{YYYYMMD}_', DAY)).toBe('{YYYYMMD}_');
	});

	it('the MONTH stamps are real tokens - the stamp the report was reaching for', () => {
		// Both spellings, matching the two day stamps. Unambiguous contractions on the
		// identical convention, and what people actually type - so they expand rather than
		// being explained away.
		expect(expandDateTokens('{YYYYMM}_', DAY)).toBe('202608_');
		expect(expandDateTokens('{YYYY-MM}_', DAY)).toBe('2026-08_');
		expect(expandDateTokens('{YYYYMM}', PADDED)).toBe('202603');
		expect(expandDateTokens('{YYYY-MM}', PADDED)).toBe('2026-03');
		expect(unknownDateTokens('{YYYYMM}_{YYYY-MM}', DAY)).toEqual([]);
		// …and each means the same as spelling it out, so neither is a trap.
		expect(expandDateTokens('{YYYY}{MM}_', DAY)).toBe(expandDateTokens('{YYYYMM}_', DAY));
		expect(expandDateTokens('{YYYY}-{MM}_', DAY)).toBe(expandDateTokens('{YYYY-MM}_', DAY));
	});

	it('a month stamp is ONE lookup, so it can never be read as a shorter token plus junk', () => {
		// The hazard a sequential token-by-token replace would have: `{YYYY}` matching
		// INSIDE `{YYYYMM}` and leaving `2026MM}`. `BRACED` captures the whole group and
		// each group is looked up once, so the longest and shortest spellings coexist.
		expect(expandDateTokens('{YYYYMM}', DAY)).toBe('202608');
		expect(expandDateTokens('{YYYYMMDD}', DAY)).toBe('20260805');
		expect(expandDateTokens('{YYYY}', DAY)).toBe('2026');
		expect(expandDateTokens('{YYYYMM}{YYYY}{YYYYMMDD}', DAY)).toBe('202608202620260805');
		// The order they are declared in cannot matter either, for the same reason.
		expect(expandDateTokens('{YYYY}{YYYYMM}', DAY)).toBe('2026202608');
	});

	it('stays silent on every token the UI offers - a false warning is worse than none', () => {
		for (const token of UPLOAD_DATE_TOKENS) {
			expect(unknownDateTokens(token, DAY)).toEqual([]);
		}
		expect(unknownDateTokens('{YYYY}-{MM}-{DD}_report', DAY)).toEqual([]);
		// Nothing braced at all is nothing to say.
		expect(unknownDateTokens('daily_', DAY)).toEqual([]);
		expect(unknownDateTokens('', DAY)).toEqual([]);
	});

	it('catches the other near-misses the same way, wrong CASE included', () => {
		// Case sensitivity is deliberate (`{mm}` is minutes by every other convention),
		// which makes it exactly the kind of near-miss that needs saying out loud.
		expect(unknownDateTokens('{yyyy}', DAY)).toEqual(['{yyyy}']);
		expect(unknownDateTokens('{MMDD}', DAY)).toEqual(['{MMDD}']);
		expect(unknownDateTokens('{YY}', DAY)).toEqual(['{YY}']);
	});

	it('lists each unknown run ONCE, in order, and only the unknown ones', () => {
		// The message names them, so a repeated token must not read as two problems.
		expect(unknownDateTokens('{FOO}-{YYYY}-{FOO}-{BAR}', DAY)).toEqual(['{FOO}', '{BAR}']);
	});

	it('is decided by the EXPANDER, so it cannot drift from what really expands', () => {
		// The membership test is "did expanding change it", not a second copy of the token
		// list - a copy would eventually warn about a token that works, or stay quiet
		// about one that does not. Every known token expands to something brace-free, so
		// the test can never mistake one for unknown.
		for (const token of UPLOAD_DATE_TOKENS) {
			expect(expandDateTokens(token, DAY)).not.toContain('{');
		}
	});
});

describe('inserting a token from a chip', () => {
	it('appends when the field has never been focused, so the first click still lands', () => {
		expect(insertUploadToken('', '{YYYYMMDD}')).toEqual({ value: '{YYYYMMDD}', caret: 10 });
		expect(insertUploadToken('daily_', '{DD}')).toEqual({ value: 'daily_{DD}', caret: 10 });
		// An explicit null is the same statement as an absent one - the DOM hands back
		// `null` for an element that was never edited.
		expect(insertUploadToken('daily_', '{DD}', null, null).value).toBe('daily_{DD}');
	});

	it('inserts at the caret, and leaves the caret past what it inserted', () => {
		// Continuing where the user was is the whole reason the caret is threaded through:
		// two chips in a row must read `{YYYY}{MM}`, not `{MM}` stranded at the end.
		const first = insertUploadToken('report__v2', '{YYYY}', 7, 7);
		expect(first).toEqual({ value: 'report_{YYYY}_v2', caret: 13 });
		const second = insertUploadToken(first.value, '{MM}', first.caret, first.caret);
		expect(second.value).toBe('report_{YYYY}{MM}_v2');
	});

	it('replaces a SELECTED run rather than pushing it aside', () => {
		// Selecting the wrong token and clicking the right one is the obvious way to fix
		// one; keeping both would leave a name carrying two dates.
		expect(insertUploadToken('{YYYY}_notes', '{YYYYMMDD}', 0, 6).value).toBe('{YYYYMMDD}_notes');
	});

	it('clamps and orders offsets instead of trusting them', () => {
		// They come from the DOM. An out-of-range one taken literally slices text the user
		// typed straight out of the field, which is silent data loss in a persisted field.
		expect(insertUploadToken('abc', '{DD}', 99, 99).value).toBe('abc{DD}');
		expect(insertUploadToken('abc', '{DD}', -5, -5).value).toBe('{DD}abc');
		expect(insertUploadToken('abcdef', '{DD}', 4, 2).value).toBe('ab{DD}ef');
		expect(insertUploadToken('abc', '{DD}', Number.NaN, Number.NaN).value).toBe('abc{DD}');
	});

	it('inserts the BRACED form, so anything a chip writes really does expand', () => {
		// The chips are the answer to "how was I supposed to know about the braces", so a
		// chip that inserted a bare token would teach exactly the syntax that fails.
		for (const token of UPLOAD_DATE_TOKENS) {
			const { value } = insertUploadToken('', token);
			expect(value).toBe(token);
			expect(expandDateTokens(value, DAY)).not.toContain('{');
		}
	});
});

describe('the stem', () => {
	it('drops a notebook extension, and only a notebook extension', () => {
		// Databricks names a workspace notebook by its path segment and carries no
		// suffix, so keeping it would show `analysis.ipynb` in the workspace UI.
		expect(notebookStem('analysis.ipynb')).toBe('analysis');
		expect(notebookStem('analysis.py')).toBe('analysis');
		expect(notebookStem('Analysis.IPYNB')).toBe('Analysis');
		expect(notebookStem('quarterly.report.ipynb')).toBe('quarterly.report');
		expect(notebookStem('notes.txt')).toBe('notes.txt');
		expect(notebookStem('no-extension')).toBe('no-extension');
	});
});

describe('assembling the workspace name', () => {
	it('with NO affixes is exactly the old name - the feature is a pure superset', () => {
		expect(resolveUploadName('analysis.ipynb', {}, DAY)).toMatchObject({
			name: 'analysis',
			error: null
		});
		// The shapes a caller may legitimately pass for "nothing".
		expect(resolveUploadName('analysis.ipynb', { prefix: '', postfix: '' }, DAY).name).toBe('analysis');
		expect(resolveUploadName('analysis.ipynb', { prefix: null, postfix: null }, DAY).name).toBe('analysis');
		expect(resolveUploadName('analysis.ipynb', undefined, DAY).name).toBe('analysis');
	});

	it('puts a date prefix in front, and a date postfix behind the STEM', () => {
		expect(resolveUploadName('analysis.ipynb', { prefix: '{YYYY-MM-DD}_' }, DAY).name).toBe(
			'2026-08-05_analysis'
		);
		// Behind the stem, NOT behind `.ipynb`: the extension is gone by then, so the
		// name can never read `analysis.ipynb_20260805`.
		expect(resolveUploadName('analysis.ipynb', { postfix: '_{YYYYMMDD}' }, DAY).name).toBe(
			'analysis_20260805'
		);
		expect(resolveUploadName('analysis.py', { postfix: '_{YYYYMMDD}' }, DAY).name).toBe(
			'analysis_20260805'
		);
	});

	it('composes both at once', () => {
		expect(resolveUploadName('analysis.ipynb', { prefix: '{YYYY}-', postfix: '_v2' }, DAY).name).toBe(
			'2026-analysis_v2'
		);
	});

	it('reports the affixes AS EXPANDED, so the UI can show what a token became', () => {
		const out = resolveUploadName('analysis.ipynb', { prefix: '{YYYYMMDD}_', postfix: '_{DD}' }, DAY);
		expect(out.prefix).toBe('20260805_');
		expect(out.postfix).toBe('_05');
	});

	it('trims the assembled name - a leading/trailing space is invisible and untypeable', () => {
		expect(resolveUploadName('analysis.ipynb', { prefix: '  ', postfix: '  ' }, DAY).name).toBe('analysis');
		// A trailing space is a legal filename, and the extension is anchored to the
		// end - so the stem has to be trimmed BEFORE the suffix is matched, or the
		// notebook lands in the workspace still called `analysis.ipynb`.
		expect(resolveUploadName(' analysis.ipynb ', {}, DAY).name).toBe('analysis');
		// Interior spacing is the user's business and is kept.
		expect(resolveUploadName('analysis.ipynb', { prefix: 'draft ' }, DAY).name).toBe('draft analysis');
	});
});

describe('an affix can never move the upload out of /Users/<you>/', () => {
	// The name is ONE segment appended after the user's home folder, so a separator
	// inside it is the whole escape surface. Refused, never repaired: a sanitized
	// name is one the preview showed and the workspace never got.
	const escapes = [
		['a forward slash', '../'],
		['a bare parent segment with a separator', '../../Shared/'],
		['an absolute path', '/Shared/'],
		['a backslash', 'team\\'],
		['a NUL', 'a\u0000b'],
		['a newline', 'a\nb'],
		['a DEL', 'a\u007fb']
	] as const;

	for (const [what, affix] of escapes) {
		it(`refuses ${what} in the prefix`, () => {
			const out = resolveUploadName('analysis.ipynb', { prefix: affix }, DAY);
			expect(out.name).toBe('');
			expect(out.error).toBeTruthy();
			// Actionable, and it names the field the user can fix - not the notebook's
			// own filename, which is where they would otherwise go looking.
			expect(out.error).toContain('prefix');
		});

		it(`refuses ${what} in the postfix`, () => {
			const out = resolveUploadName('analysis.ipynb', { postfix: affix }, DAY);
			expect(out.name).toBe('');
			expect(out.error).toContain('postfix');
		});
	}

	it('refuses a notebook with NO stem even when an affix would fill the name out', () => {
		// `.ipynb` leaves an empty stem, so there is no notebook name to affix around -
		// and an affix must not be allowed to stand in for one, or the workspace would
		// receive a notebook called nothing but the user's naming pattern.
		//
		// The remedy is the FILENAME's, not the affix's, which is what the assertion
		// pins: this goes through the stem check, NOT the post-assembly one (that branch
		// is unreachable - see `resolveUploadName`), and a bare `toBeTruthy()` could not
		// tell the two apart, so it would keep passing if the stem check ever went away.
		const out = resolveUploadName('.ipynb', { prefix: '..' }, DAY);
		expect(out.name).toBe('');
		expect(out.error).toContain('Rename the file');
		expect(out.error).not.toContain('prefix');
	});

	it('refuses a notebook whose whole stem is `..`, which would name the parent folder', () => {
		// `...ipynb` strips to `..`: no separator, so nothing traverses - but the SEGMENT
		// itself would be the home folder's parent, which is not a notebook the user
		// asked to create. Again the stem, not the assembled name.
		expect(notebookStem('...ipynb')).toBe('..');
		const out = resolveUploadName('...ipynb', {}, DAY);
		expect(out.name).toBe('');
		expect(out.error).toContain('Rename the file');
	});

	it('allows a leading dot, which traverses nowhere', () => {
		// `/Users/you/..notes` is an ordinary (if odd) name. Banning the substring
		// would reject a legal name and buy no safety.
		expect(resolveUploadName('notes.ipynb', { prefix: '..' }, DAY).name).toBe('..notes');
	});

	it('refuses an unusable notebook name with the remedy for THAT - renaming the file', () => {
		const out = resolveUploadName('.ipynb', {}, DAY);
		expect(out.name).toBe('');
		expect(out.error).toContain('Rename the file');
	});

	it('an affix that empties to nothing still leaves a usable name', () => {
		expect(resolveUploadName('analysis.ipynb', { prefix: '   ', postfix: '' }, DAY).error).toBeNull();
	});
});

describe('the assembled name is bounded in LENGTH, not only in content', () => {
	// The resolved name rides `argv` as part of the probe's JSON request - the exact
	// limit the notebook's own bytes are base64'd onto stdin to stay under - and a
	// workspace object name has a ceiling of its own. Unbounded, a pasted affix
	// surfaced as a bare `spawn E2BIG` (or a round trip to an SDK refusal); bounded
	// here, it is refused with the same actionable message the preview shows.
	const stem = 'analysis';

	it('allows a name exactly at the limit', () => {
		const postfix = '_'.repeat(MAX_UPLOAD_NAME_CHARS - stem.length);
		const out = resolveUploadName(`${stem}.ipynb`, { postfix }, DAY);
		expect(out.error).toBeNull();
		expect(out.name).toHaveLength(MAX_UPLOAD_NAME_CHARS);
	});

	it('refuses one character past it, naming the limit and the field to shorten', () => {
		const postfix = '_'.repeat(MAX_UPLOAD_NAME_CHARS - stem.length + 1);
		const out = resolveUploadName(`${stem}.ipynb`, { postfix }, DAY);
		expect(out.name).toBe('');
		expect(out.error).toContain(String(MAX_UPLOAD_NAME_CHARS));
		expect(out.error).toContain('Shorten the prefix or postfix');
	});

	it('counts the ASSEMBLED name, so two individually-short affixes can still overrun', () => {
		const half = 'a'.repeat(MAX_UPLOAD_NAME_CHARS);
		expect(resolveUploadName(`${stem}.ipynb`, { prefix: half, postfix: half }, DAY).error).toContain(
			'Shorten the prefix or postfix'
		);
	});

	it('measures the EXPANDED affix, not the token that produced it', () => {
		// `{YYYY-MM-DD}` is 12 characters and expands to 10, so a name that only fits
		// once the tokens are resolved must be allowed - the bound is on what the
		// workspace receives.
		const postfix = `${'_'.repeat(MAX_UPLOAD_NAME_CHARS - stem.length - 10)}{YYYY-MM-DD}`;
		expect(postfix.length + stem.length).toBeGreaterThan(MAX_UPLOAD_NAME_CHARS);
		const out = resolveUploadName(`${stem}.ipynb`, { postfix }, DAY);
		expect(out.error).toBeNull();
		expect(out.name).toHaveLength(MAX_UPLOAD_NAME_CHARS);
	});

	it('blames the FILENAME when the notebook alone is past the limit', () => {
		// Nothing the affixes can do about it, so the remedy has to name the file.
		const out = resolveUploadName(`${'n'.repeat(MAX_UPLOAD_NAME_CHARS + 1)}.ipynb`, {}, DAY);
		expect(out.name).toBe('');
		expect(out.error).toContain('Rename the file');
		expect(out.error).toContain(String(MAX_UPLOAD_NAME_CHARS));
	});
});
