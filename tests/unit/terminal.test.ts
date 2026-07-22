import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isTerminalStyle, reduceCheap, reduceFull } from '../../src/lib/server/terminal';

// ESC introducer, written out of the literals so the intent of each case is legible.
const ESC = '\x1b';

describe('isTerminalStyle', () => {
	it('is true when a carriage return is present', () => {
		expect(isTerminalStyle('loading\rdone')).toBe(true);
	});

	it('is true when a CSI introducer (ESC[) is present', () => {
		expect(isTerminalStyle('\x1b[32mok\x1b[0m')).toBe(true);
	});

	it('is false for a plain multi-line log', () => {
		expect(isTerminalStyle('INFO epoch 1\nINFO epoch 2\n')).toBe(false);
	});

	it('is false for empty text', () => {
		expect(isTerminalStyle('')).toBe(false);
	});
});

describe('reduceCheap — CR-overwrite collapse', () => {
	it('keeps only the final frame of repeated \\r overwrites (no newline)', () => {
		expect(reduceCheap('\rloading 10%\rloading 99%')).toBe('loading 99%');
	});

	it('overwrites at the column and keeps the surviving tail (true terminal semantics)', () => {
		expect(reduceCheap('abcdefghij\rXYZ')).toBe('XYZdefghij');
	});

	it('collapses a real tqdm-style bar to its final line', () => {
		const tqdm =
			'\r  0%|          | 0/30 [00:00<?, ?it/s]' +
			'\r 50%|█████     | 15/30 [00:00<00:00, 45it/s]' +
			'\r100%|██████████| 30/30 [00:00<00:00, 54.57it/s]';
		expect(reduceCheap(tqdm)).toBe('100%|██████████| 30/30 [00:00<00:00, 54.57it/s]');
	});

	it('collapses a braille spinner to its final frame', () => {
		const spin = '\r⠋ Working\r⠙ Working\r⠹ Working\r✔ Done   ';
		expect(reduceCheap(spin)).toBe('✔ Done   ');
	});

	it('collapses each physical line independently — a \\r never crosses a \\n', () => {
		expect(reduceCheap('one\rONE\ntwo\rTWO')).toBe('ONE\nTWO');
	});

	it('treats CRLF line endings as a no-op reset (nothing after the \\r)', () => {
		expect(reduceCheap('abc\r\ndef')).toBe('abc\ndef');
	});

	it('a trailing \\r with nothing after leaves the line intact', () => {
		expect(reduceCheap('abc\r')).toBe('abc');
	});
});

describe('reduceCheap — SGR (ANSI color) strip', () => {
	it('strips color escapes from a single-line status', () => {
		expect(reduceCheap('\x1b[32m✓\x1b[0m installed \x1b[1mrich\x1b[0m')).toBe('✓ installed rich');
	});

	it('strips SGR combined with a \\r overwrite', () => {
		expect(reduceCheap('\r\x1b[32m50%\x1b[0m\r\x1b[32m100%\x1b[0m done')).toBe('100% done');
	});

	it('strips a bare reset escape', () => {
		expect(reduceCheap('done\x1b[0m')).toBe('done');
	});
});

describe('reduceCheap — passthrough', () => {
	it('is a no-op on plain multi-line text', () => {
		const log = 'INFO epoch 1\nINFO epoch 2\nINFO epoch 3\n';
		expect(reduceCheap(log)).toBe(log);
	});

	it('leaves non-SGR CSI escapes in place (Phase 2 owns cursor/erase)', () => {
		// The cheap tier deliberately does not model erase-in-line / cursor moves;
		// it must not print them as garbage nor strip them (that is the full tier).
		expect(reduceCheap('a\x1b[2Kb')).toBe('a\x1b[2Kb');
	});
});

// ─── Full tier: the VT screen emulator ──────────────────────────────────────
//
// Every expected value below was produced by an INDEPENDENT VT emulator (`pyte`)
// fed the same bytes with ONLCR applied (`\n`→`\r\n`, matching a real terminal),
// so these assert byte-identity with a real terminal's final screen, not merely
// against our own implementation. The flagship case is a genuine `uv pip install`
// PTY capture (tests/unit/fixtures/uv-pip-install.raw.txt).

describe('reduceFull — subsumes the cheap tier', () => {
	it('collapses single-line \\r overwrites like the cheap tier', () => {
		expect(reduceFull('\rloading 10%\rloading 99%')).toBe('loading 99%');
	});

	it('keeps the surviving tail on a \\r overwrite (true terminal semantics)', () => {
		expect(reduceFull('abcdefghij\rXYZ')).toBe('XYZdefghij');
	});

	it('collapses a real tqdm-style single-line bar to its final frame', () => {
		const tqdm =
			'\r  0%|          | 0/30 [00:00<?, ?it/s]' +
			'\r 50%|█████     | 15/30 [00:00<00:00, 45it/s]' +
			'\r100%|██████████| 30/30 [00:00<00:00, 54.57it/s]';
		expect(reduceFull(tqdm)).toBe('100%|██████████| 30/30 [00:00<00:00, 54.57it/s]');
	});

	it('strips SGR color', () => {
		expect(reduceFull(`${ESC}[32m✓${ESC}[0m installed ${ESC}[1mrich${ESC}[0m`)).toBe(
			'✓ installed rich'
		);
	});

	it('resets the column on a newline (ONLCR), each line collapsing independently', () => {
		expect(reduceFull('one\rONE\ntwo\rTWO')).toBe('ONE\nTWO');
	});

	it('preserves interior content and newlines, trimming only trailing blank lines (final-screen)', () => {
		// Plain logs never actually reach reduceFull — isTerminalStyle gates them out
		// so they pass through byte-for-byte (see the accumulator test). When fed
		// directly, reduceFull preserves every interior line and trims the trailing
		// blank row a final `\n` leaves, exactly as a terminal-capture tool renders.
		expect(reduceFull('INFO epoch 1\nINFO epoch 2\nINFO epoch 3')).toBe(
			'INFO epoch 1\nINFO epoch 2\nINFO epoch 3'
		);
		expect(reduceFull('INFO epoch 1\nINFO epoch 2\nINFO epoch 3\n')).toBe(
			'INFO epoch 1\nINFO epoch 2\nINFO epoch 3'
		);
		// A blank line BETWEEN content is preserved — only trailing blanks are trimmed.
		expect(reduceFull('a\n\nb')).toBe('a\n\nb');
	});
});

describe('reduceFull — the multi-line cursor repaint the cheap tier cannot undo', () => {
	it('repaints an earlier line via cursor-up (ESC[nA) + carriage return', () => {
		// Three lines, then cursor up 2 and rewrite line 0 in place; cursor down 2.
		const input = `line A\nline B\nline C${ESC}[2A\rREPAINTED${ESC}[2B`;
		expect(reduceFull(input)).toBe('REPAINTED\nline B\nline C');
		// The cheap tier cannot undo the vertical repaint: it never reaches line 0
		// from line 2, so its output stays wrong and still carries a raw cursor escape.
		expect(reduceCheap(input)).not.toBe('REPAINTED\nline B\nline C');
		expect(reduceCheap(input)).toContain(`${ESC}[2B`);
	});

	it('repaints two stacked bars via cursor-up + erase-line (ESC[2K), multi-bar tqdm style', () => {
		const input = `bar1\nbar2${ESC}[1A\r${ESC}[2Kfresh1${ESC}[1B\r${ESC}[2Kfresh2`;
		expect(reduceFull(input)).toBe('fresh1\nfresh2');
	});

	it('collapses a real `uv pip install` PTY capture to its exact final screen', () => {
		const raw = readFileSync(new URL('./fixtures/uv-pip-install.raw.txt', import.meta.url), 'utf8');
		const finalScreen = readFileSync(
			new URL('./fixtures/uv-pip-install.final.txt', import.meta.url),
			'utf8'
		).replace(/\n$/, '');
		expect(reduceFull(raw)).toBe(finalScreen);
		// It is small, clean, and carries no leftover CR or escape bytes.
		expect(reduceFull(raw)).not.toMatch(/[\r\x1b]/);
		expect(Buffer.byteLength(reduceFull(raw), 'utf8')).toBeLessThan(500);
	});
});

describe('reduceFull — the bounded escape set', () => {
	it('erase-in-line to end (ESC[K / ESC[0K) clears from the cursor rightward', () => {
		expect(reduceFull(`keep${ESC}[Kgone-after\rkeep`)).toBe('keepgone-after');
	});

	it('erase-in-line whole (ESC[2K) after a carriage return drops the prior frame', () => {
		expect(reduceFull(`first line\r${ESC}[2Ksecond`)).toBe('second');
	});

	it('erase-in-display whole-screen (ESC[2J) blanks earlier rows', () => {
		expect(reduceFull(`x${ESC}[2Jy`)).toBe(' y');
	});

	it('cursor back (ESC[nD) then overwrite', () => {
		expect(reduceFull(`aaa${ESC}[3Dbb`)).toBe('bba');
	});

	it('cursor forward (ESC[nC) advances the write column', () => {
		expect(reduceFull(`ab${ESC}[2Ccd`)).toBe('ab  cd');
	});

	it('column-absolute (ESC[nG) jumps to a 1-based column', () => {
		expect(reduceFull(`hello${ESC}[5Gworld`)).toBe('hellworld');
	});

	it('absolute cursor position (ESC[r;cH) addresses a row and column', () => {
		expect(reduceFull(`top\nmid\nbot${ESC}[1;1Hedited`)).toBe('edited\nmid\nbot');
	});

	it('backspace moves the cursor left one column', () => {
		expect(reduceFull('abc\b\bX')).toBe('aXc');
	});
});

describe('reduceFull — degrades gracefully, never leaks raw escapes or throws', () => {
	it('drops an incomplete trailing CSI (held back for the next flush)', () => {
		// A sequence split across a flush boundary must not leak; the raw buffer is
		// re-reduced whole next tick (see output-accumulator.ts).
		expect(reduceFull(`done${ESC}[3`)).toBe('done');
	});

	it('drops a lone trailing ESC', () => {
		expect(reduceFull(`half${ESC}`)).toBe('half');
	});

	it('drops an OSC sequence (window title) whole', () => {
		expect(reduceFull(`osc${ESC}]0;title\x07after`)).toBe('oscafter');
	});

	it('drops a private-marker CSI (hide/show cursor) without printing it', () => {
		expect(reduceFull(`a${ESC}[?25lb${ESC}[?25h`)).toBe('ab');
	});

	it('drops an unknown CSI final byte rather than leaking it', () => {
		// `ESC[5n` (device status report) is not modeled — consumed, never printed.
		expect(reduceFull(`x${ESC}[5ny`)).toBe('xy');
	});

	it('drops a two-byte / three-byte non-CSI ESC sequence (charset select)', () => {
		expect(reduceFull(`a${ESC}(Bb`)).toBe('ab');
	});

	it('never throws on a pile of malformed escapes', () => {
		expect(() => reduceFull(`${ESC}${ESC}[${ESC}[;;;${ESC}]${ESC}[999Z`)).not.toThrow();
	});
});
