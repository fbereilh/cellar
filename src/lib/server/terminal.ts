/**
 * Cellar — terminal-style stream output reduction (two tiers, zero deps).
 *
 * A cell that runs a CLI (`tqdm`, a spinner, `uv pip install`, any progress
 * bar) emits hundreds of carriage-return-overwritten frames plus ANSI escapes.
 * Left raw, a `<pre>` stacks every `\r`-frame on its own line and prints escape
 * bytes as literal `[2K[4A…` garbage — and the same pile is persisted into the
 * `.ipynb` and read by the agent over MCP.
 *
 * This module collapses that spam to the FINAL rendered state — byte-identical
 * to what a real terminal shows — cheaply and with ZERO dependencies. Exports:
 *
 *  - `isTerminalStyle(text)` — is this stream text terminal-styled (contains a
 *    `\r` carriage return or a CSI `ESC[` introducer)? A cheap gate: plain logs
 *    are `false` and skip reduction entirely, passing through byte-for-byte.
 *  - `reduceCheap(text)` — the cheap tier: strip SGR (ANSI color) escapes, then
 *    collapse `\r` overwrites with true terminal semantics on each physical
 *    line. Fixes `tqdm`, braille/ASCII spinners, single-line progress bars — the
 *    ~80% by frequency. Cannot undo a VERTICAL repaint (cursor-up + erase-line
 *    across lines); its non-SGR escapes are left in place for the full tier.
 *  - `reduceFull(text)` — the full tier: a minimal VT screen emulator over a
 *    line-array screen + `(row, col)` cursor. Applies the small BOUNDED escape
 *    set (`\r`, `\n`, cursor up/down/fwd/back/column-absolute, erase-in-line,
 *    erase-in-display, absolute cursor position) so the multi-line cursor
 *    repaint of `uv pip install` / multi-bar `tqdm` collapses to its final
 *    screen. This is what the output pipeline uses (see `output-accumulator.ts`).
 *
 * The full tier supersedes the cheap tier for pipeline stream output; both are
 * exported so the cheap tier stays independently testable (and cheaply reused
 * where a full screen model is unwarranted). `isTerminalStyle` gates both.
 *
 * The observed escape alphabet is tiny (enumerated from a real `uv pip install`
 * PTY capture: SGR `m`, erase-line `K`, cursor-up `A`, cursor-down `B`, plus
 * `C`/`D`/`G`/`J`/`H`/`f` handled for safety). Any OTHER CSI, and any non-CSI
 * `ESC` sequence, is a defensive no-op — dropped, never printed as garbage — so
 * the emulator can only ever improve output it doesn't fully understand, never
 * worsen it. A full-screen TUI / alternate-screen program is out of scope by
 * design (final-state collapse of command output, not a live terminal widget).
 * See the scout report `cellar-terminal-output-scout-t4` (§3.2, §4.2).
 *
 * Pure and browser-safe (no Node/Cellar state), unit-tested in isolation
 * (`tests/unit/terminal.test.ts`) like `output-accumulator.test.ts`.
 */

/** SGR (Select Graphic Rendition) color/style escape: `ESC[…m`. */
const SGR_RE = /\x1b\[[0-9;]*m/g;

/** True iff the text carries a `\r` carriage return or a CSI introducer `ESC[`. */
export function isTerminalStyle(text: string): boolean {
	return text.includes('\r') || text.includes('\x1b[');
}

/** Strip SGR color/style escapes; every other byte is left untouched. */
function stripSgr(text: string): string {
	return text.replace(SGR_RE, '');
}

/**
 * Collapse one physical line's carriage-return overwrites with true terminal
 * semantics: `\r` returns the write column to 0, each subsequent character
 * overwrites at the column, and the buffer only grows past its end. So
 * `abcdefghij\rXYZ` → `XYZdefghij` (the tail survives), matching a real
 * terminal — strictly more correct than the common "keep text after the last
 * `\r`" shortcut. Iterates by code point so multibyte glyphs (braille spinner
 * frames `⠋⠙⠹`, block bars `█`) each occupy one column.
 */
function collapseCarriageReturns(line: string): string {
	if (!line.includes('\r')) return line;
	const buf: string[] = [];
	let col = 0;
	for (const ch of line) {
		if (ch === '\r') {
			col = 0;
		} else {
			buf[col] = ch;
			col += 1;
		}
	}
	return buf.join('');
}

/**
 * Cheap-tier reduction: strip SGR color, then collapse `\r` overwrites on each
 * physical line independently (a `\r` never reaches across a `\n`). Newlines are
 * preserved. Non-terminal text should be gated out by `isTerminalStyle` before
 * this is called, but passing plain text through is still a no-op.
 */
export function reduceCheap(text: string): string {
	const stripped = stripSgr(text);
	if (!stripped.includes('\r')) return stripped;
	return stripped.split('\n').map(collapseCarriageReturns).join('\n');
}

// ─── Full tier: a minimal VT screen emulator ────────────────────────────────

// Defensive ceilings on the emulated screen. A single CSI carries an arbitrary
// numeric argument (`ESC[9999999B`, `ESC[1;9999999H`), and reduceFull re-reduces
// the WHOLE raw buffer on every flush, so an unclamped cursor move would push
// millions of empty rows/cells per ~10-byte escape, repeatedly. These are far
// beyond any real terminal capture (uv, multi-bar tqdm, colored logs stay
// byte-identical); a huge numeric argument is bounded here, not honored. The
// column ceiling is tighter than the row ceiling because a far cursor move
// followed by a write PADS the gap with real space cells (O(MAX_COLS) work),
// whereas an empty row is nearly free — and no real capture exceeds a few
// hundred columns, so MAX_COLS is still orders of magnitude beyond any of them.
const MAX_ROWS = 100_000;
const MAX_COLS = 10_000;

/**
 * Ensure the screen has a (mutable) row at `row`, appending blank rows as
 * needed. Capped at `MAX_ROWS` so a pathological cursor move cannot force
 * unbounded row growth; callers also clamp the cursor row itself.
 */
function ensureRow(rows: string[][], row: number): string[] {
	const target = Math.min(row, MAX_ROWS);
	while (rows.length <= target) rows.push([]);
	return rows[target];
}

/** First CSI parameter as a number, defaulting an empty/malformed param to `def`. */
function csiParam(params: string, def: number): number {
	if (params === '') return def;
	const v = parseInt(params.split(';')[0], 10);
	return Number.isNaN(v) ? def : v;
}

/** Right-trim ASCII spaces + tabs from a rendered line. */
function rtrim(s: string): string {
	return s.replace(/[ \t]+$/, '');
}

/**
 * Full-tier reduction: emulate a scrollback-less terminal screen so a VERTICAL
 * repaint (cursor-up + erase-line, as `uv pip install` / multi-bar `tqdm` use)
 * collapses to its final rendered state. Models a growing line-array screen and
 * a `(row, col)` cursor, applies the bounded escape set (see the module header),
 * and joins the surviving rows — each right-trimmed of trailing blank cells,
 * trailing blank rows dropped — exactly as a terminal-capture tool renders the
 * final screen (verified byte-identical against `pyte` on a real `uv` capture).
 *
 * Newline semantics are ONLCR (a real terminal's default): `\n` returns the
 * column to 0 as well as advancing the row, matching the cheap tier and how
 * ordinary program output (`print`) renders. Only an explicit `\r`-less cursor
 * move keeps the column.
 *
 * Defensive by construction: an unknown or malformed CSI is dropped (never
 * printed), a non-CSI `ESC` sequence is skipped, and an INCOMPLETE escape at the
 * very end of `text` is held back (dropped from this pass) rather than leaked —
 * the accumulator keeps the raw buffer and re-reduces the completed text on the
 * next flush, so a sequence split across a flush boundary resolves correctly.
 *
 * Iterates by code point (via `Array.from`) so multibyte glyphs (braille spinner
 * frames `⠋⠙⠹`, block bars `█`) each occupy exactly one column.
 */
export function reduceFull(text: string): string {
	const rows: string[][] = [[]];
	let row = 0;
	let col = 0;

	const write = (ch: string): void => {
		const line = ensureRow(rows, row);
		// Clamp the write column to MAX_COLS: a write clamped there can only
		// overwrite the last cell, never pad a line to a huge cursor position.
		const at = Math.min(col, MAX_COLS);
		while (line.length < at) line.push(' ');
		line[at] = ch;
		col += 1;
	};

	const chars = Array.from(text);
	const n = chars.length;
	let i = 0;
	while (i < n) {
		const ch = chars[i];

		if (ch === '\r') {
			col = 0;
			i += 1;
		} else if (ch === '\n') {
			row += 1;
			col = 0;
			ensureRow(rows, row);
			i += 1;
		} else if (ch === '\b') {
			// Backspace: move the cursor left one column (CLIs emit it to redraw).
			if (col > 0) col -= 1;
			i += 1;
		} else if (ch === '\x1b') {
			const advanced = handleEscape(chars, i, rows, row, col);
			if (advanced == null) break; // incomplete escape at end — hold it back
			({ row, col, i } = advanced);
		} else {
			// Ordinary printable character.
			write(ch);
			i += 1;
		}
	}

	// Render: right-trim each row of trailing blank cells, drop trailing blank rows.
	const lines = rows.map((line) => rtrim(line.join('')));
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines.join('\n');
}

/**
 * Handle one `ESC…` sequence starting at `chars[i]`. Mutates `rows` for erase
 * ops and returns the post-sequence `{row, col, i}`; returns `null` when the
 * sequence is INCOMPLETE at the end of the buffer (the caller holds it back).
 */
function handleEscape(
	chars: string[],
	i: number,
	rows: string[][],
	row: number,
	col: number
): { row: number; col: number; i: number } | null {
	const n = chars.length;
	const next = i + 1 < n ? chars[i + 1] : '';

	if (next === '') return null; // lone trailing ESC — hold it back

	if (next === '[') {
		// CSI: ESC [ <params> <intermediates> <final>. Params 0x30–0x3F (digits,
		// `;`, private markers `<=>?`), intermediates 0x20–0x2F, final 0x40–0x7E.
		let j = i + 2;
		let params = '';
		while (j < n) {
			const code = chars[j].codePointAt(0)!;
			if (code >= 0x30 && code <= 0x3f) {
				params += chars[j];
				j += 1;
			} else break;
		}
		while (j < n) {
			const code = chars[j].codePointAt(0)!;
			if (code >= 0x20 && code <= 0x2f) j += 1; // intermediate byte(s)
			else break;
		}
		if (j >= n) return null; // incomplete CSI at end of buffer — hold it back
		const final = chars[j];
		const afterI = j + 1;
		// A private-marker CSI (`ESC[?…`, e.g. hide-cursor `?25l`, alt-screen
		// `?1049h`) is not a cursor/erase op we model — drop it entirely.
		if (params.charCodeAt(0) === 0x3f /* '?' */) return { row, col, i: afterI };
		return applyCsi(rows, params, final, row, col, afterI);
	}

	if (next === ']') {
		// OSC: ESC ] … terminated by BEL (0x07) or ST (ESC \). Drop it whole; if it
		// never terminates within the buffer, it's incomplete — hold it back.
		let j = i + 2;
		while (j < n) {
			if (chars[j] === '\x07') return { row, col, i: j + 1 };
			if (chars[j] === '\x1b' && j + 1 < n && chars[j + 1] === '\\') return { row, col, i: j + 2 };
			j += 1;
		}
		return null;
	}

	// A charset/other nF escape `ESC <intermediate(s)> <final>`: the byte after
	// ESC is an intermediate (0x20–0x2F, e.g. `(` `)` `#` `%`), so consume every
	// intermediate then one final byte (0x30–0x7E). E.g. `ESC(B` is three bytes.
	const nextCode = next.codePointAt(0)!;
	if (nextCode >= 0x20 && nextCode <= 0x2f) {
		let j = i + 1;
		while (j < n) {
			const code = chars[j].codePointAt(0)!;
			if (code >= 0x20 && code <= 0x2f) j += 1;
			else break;
		}
		if (j >= n) return null; // incomplete — hold it back
		return { row, col, i: j + 1 }; // drop through the final byte
	}

	// Any other 2-byte ESC sequence (save/restore `ESC7`/`ESC8`, reverse-index
	// `ESC M`, keypad modes `ESC=`/`ESC>`, reset `ESCc`, …): drop ESC + its byte.
	return { row, col, i: i + 2 };
}

/**
 * Apply one non-private CSI to the screen (erase ops) and cursor. The bounded
 * set the emulator models; every other final byte is a deliberate no-op that
 * only consumes the sequence. Returns the post-sequence `{row, col, i}`.
 */
function applyCsi(
	rows: string[][],
	params: string,
	final: string,
	row: number,
	col: number,
	afterI: number
): { row: number; col: number; i: number } {
	switch (final) {
		case 'A': // cursor up
			row = Math.max(0, row - csiParam(params, 1));
			break;
		case 'B': // cursor down (clamp to MAX_ROWS — a huge argument is bounded)
			row = Math.min(row + csiParam(params, 1), MAX_ROWS);
			ensureRow(rows, row);
			break;
		case 'C': // cursor forward (clamp to MAX_COLS)
			col = Math.min(col + csiParam(params, 1), MAX_COLS);
			break;
		case 'D': // cursor back
			col = Math.max(0, col - csiParam(params, 1));
			break;
		case 'G': // cursor horizontal absolute (1-based, clamp to MAX_COLS)
			col = Math.min(Math.max(0, csiParam(params, 1) - 1), MAX_COLS);
			break;
		case 'H': // cursor position (row;col, 1-based)
		case 'f': {
			const parts = params.split(';');
			const r = parts[0] === '' || parts[0] == null ? 1 : parseInt(parts[0], 10) || 1;
			const c = parts[1] === '' || parts[1] == null ? 1 : parseInt(parts[1], 10) || 1;
			// Clamp both axes — a huge absolute position is bounded, not honored.
			row = Math.min(Math.max(0, r - 1), MAX_ROWS);
			col = Math.min(Math.max(0, c - 1), MAX_COLS);
			ensureRow(rows, row);
			break;
		}
		case 'K': {
			// erase in line
			const mode = csiParam(params, 0);
			const line = ensureRow(rows, row);
			if (mode === 0) line.length = Math.min(line.length, col); // cursor→end
			else if (mode === 1) for (let k = 0; k <= col && k < line.length; k++) line[k] = ' '; // start→cursor
			else line.length = 0; // whole line
			break;
		}
		case 'J': {
			// erase in display
			const mode = csiParam(params, 0);
			if (mode === 0) {
				// cursor→end: truncate current line at cursor, drop rows below.
				const line = ensureRow(rows, row);
				line.length = Math.min(line.length, col);
				rows.length = row + 1;
			} else if (mode === 1) {
				// start→cursor: blank rows above, blank current line up to cursor.
				for (let k = 0; k < row; k++) rows[k] = [];
				const line = ensureRow(rows, row);
				for (let k = 0; k <= col && k < line.length; k++) line[k] = ' ';
			} else {
				// whole screen (2/3): blank every existing row, keep the cursor.
				for (let k = 0; k < rows.length; k++) rows[k] = [];
				ensureRow(rows, row);
			}
			break;
		}
		// SGR ('m') and any other final byte: no-op — consume and move on.
	}
	return { row, col, i: afterI };
}
