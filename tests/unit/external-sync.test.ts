import { describe, it, expect } from 'vitest';
import { externalEdits, applyTextEdits } from '../../src/lib/externalSync';

/**
 * The offset arithmetic that turns an external on-disk change into the MINIMAL
 * editor edit. It matters twice over: the result has to be EXACTLY the new
 * document (a wrong offset silently corrupts a file the user then saves), and it
 * has to be minimal (that is what preserves the caret, the scroll position and
 * the undo history rather than throwing the caret to the end).
 *
 * Every case is checked by replaying the edits - the two failure modes are not
 * distinguishable by eyeballing offsets, and the document edges (no trailing
 * newline, append past the last line, delete through the end) are exactly where
 * line-offset maths goes wrong.
 */

function roundTrip(before: string, after: string) {
	const edits = externalEdits(before, after);
	expect(applyTextEdits(before, edits)).toBe(after);
	return edits;
}

describe('externalEdits', () => {
	it('is empty for identical content, so a no-op never enters the undo history', () => {
		expect(externalEdits('# same\n', '# same\n')).toEqual([]);
		expect(externalEdits('', '')).toEqual([]);
	});

	it('rewrites one line of a many-line document and touches nothing else', () => {
		const before = '# Notes\n\nalpha\nbeta\ngamma\n';
		const after = '# Notes\n\nalpha\nBETA\ngamma\n';
		const edits = roundTrip(before, after);

		// One edit, and it spans only the changed line - this is what the caret,
		// the scroll position and the undo history survive.
		expect(edits).toHaveLength(1);
		expect(before.slice(edits[0].from, edits[0].to)).toBe('beta');
		expect(edits[0].insert).toBe('BETA');
	});

	it('handles insertion, deletion and replacement at every document edge', () => {
		// Insert in the middle / at the very top.
		roundTrip('a\nb\n', 'a\nNEW\nb\n');
		roundTrip('a\nb\n', 'TOP\na\nb\n');
		// Append, with and without a trailing newline on the original.
		roundTrip('a\nb\n', 'a\nb\nc\n');
		roundTrip('a\nb', 'a\nb\nc');
		// Delete in the middle / through the end / from the top.
		roundTrip('a\nb\nc\n', 'a\nc\n');
		roundTrip('a\nb\nc', 'a');
		roundTrip('a\nb\nc\n', 'c\n');
		// Replace the last line, with and without a trailing newline.
		roundTrip('a\nb\n', 'a\nZ\n');
		roundTrip('a\nb', 'a\nZ');
		// Whole-document rewrites, including to and from empty.
		roundTrip('a\nb\nc\n', 'totally\ndifferent\n');
		roundTrip('', '# fresh\n');
		roundTrip('# gone\n', '');
		// Trailing-newline changes on their own.
		roundTrip('a\nb', 'a\nb\n');
		roundTrip('a\nb\n', 'a\nb');
	});

	it('produces several non-overlapping edits in ascending order for scattered changes', () => {
		const before = 'one\ntwo\nthree\nfour\nfive\nsix\n';
		const after = 'one\nTWO\nthree\nfour\nFIVE\nsix\n';
		const edits = roundTrip(before, after);

		expect(edits.length).toBeGreaterThan(1);
		// CodeMirror requires a change array to be sorted and non-overlapping, with
		// every position in the ORIGINAL document's coordinates.
		for (let i = 0; i < edits.length; i++) {
			expect(edits[i].from).toBeLessThanOrEqual(edits[i].to);
			if (i > 0) expect(edits[i].from).toBeGreaterThanOrEqual(edits[i - 1].to);
		}
	});

	it('survives edits it cannot express minimally, still landing the exact content', () => {
		// Past the Myers bound `gitdiff` traces, it reports one whole-region hunk
		// rather than lying. A coarse edit is a worse UX, never a wrong document.
		const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
		const after = Array.from({ length: 3000 }, (_, i) => `LINE ${i * 7}`).join('\n');
		roundTrip(before, after);
	});

	it('lands the exact content for randomized line edits', () => {
		// The failure this guards is a corrupt document, so the check is the
		// document, not the edit list.
		let seed = 20260804;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

		for (let trial = 0; trial < 200; trial++) {
			const n = Math.floor(rnd() * 12);
			const lines = Array.from({ length: n }, (_, i) => `l${i}-${Math.floor(rnd() * 3)}`);
			const before = lines.join('\n') + (rnd() < 0.5 ? '\n' : '');
			const next = lines.slice();
			const ops = Math.floor(rnd() * 4);
			for (let o = 0; o < ops; o++) {
				const at = Math.floor(rnd() * (next.length + 1));
				const kind = rnd();
				if (kind < 0.34) next.splice(at, 0, `ins-${o}`);
				else if (kind < 0.67 && next.length) next.splice(Math.min(at, next.length - 1), 1);
				else if (next.length) next[Math.min(at, next.length - 1)] = `mod-${o}`;
			}
			const after = next.join('\n') + (rnd() < 0.5 ? '\n' : '');
			expect(applyTextEdits(before, externalEdits(before, after))).toBe(after);
		}
	});
});
