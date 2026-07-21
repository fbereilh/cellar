/**
 * Cellar — terminal-style stream output reduction (Phase 1: the cheap tier).
 *
 * A cell that runs a CLI (`tqdm`, a spinner, a single-line progress bar) emits
 * hundreds of carriage-return-overwritten frames plus ANSI color escapes. Left
 * raw, a `<pre>` stacks every `\r`-frame on its own line and prints escape
 * bytes as literal `[32m…` garbage — and the same pile is persisted into the
 * `.ipynb` and read by the agent over MCP.
 *
 * This module collapses that spam to the final rendered line, cheaply and with
 * ZERO dependencies. Two exports:
 *
 *  - `isTerminalStyle(text)` — is this stream text terminal-styled (contains a
 *    `\r` carriage return or a CSI `ESC[` introducer)? A cheap gate: plain logs
 *    are `false` and skip reduction entirely, passing through byte-for-byte.
 *  - `reduceCheap(text)` — strip SGR (ANSI color) escapes, then collapse `\r`
 *    overwrites with true terminal semantics on each physical line. Fixes
 *    `tqdm`, braille/ASCII spinners, and every single-line progress bar.
 *
 * Scope (Phase 1 / cheap tier): single-line `\r` overwrite + color strip only.
 * The multi-line cursor repaint of `uv pip install` / multi-bar `tqdm` needs a
 * full VT screen emulator (cursor-up + erase-line across lines) — deliberately
 * OUT of scope here, and its non-SGR escapes (`[2K`, `[4A`, …) are left in place
 * for the Phase 2 full tier to model. So `reduceCheap` never *worsens* output it
 * does not fully understand; it just does not yet undo a vertical repaint. See
 * the scout report `cellar-terminal-output-scout-t4`.
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
