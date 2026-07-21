import { describe, it, expect } from 'vitest';
import { isTerminalStyle, reduceCheap } from '../../src/lib/server/terminal';

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
