/**
 * Which blame the shell's bottom status bar shows for the active tab.
 *
 * The rule is "whichever tab is active answers", and the trap it exists to close
 * is that the two keys are BOTH live at once: `activeNotebookPath` falls back to
 * the canonical notebook whenever any notebook tab is open — including while a
 * plain file tab holds focus — and a LiveNotebook keeps publishing its focused
 * cell's record under that key. So a selection made by truthiness attributed a
 * notebook cell's author and date to an untracked file, which is the COMMON shape
 * for this feature (a generated `report.html` is normally gitignored or never
 * added, so its tab correctly reports null).
 */
import { describe, it, expect } from 'vitest';
import { activeBlameFor, isBlameUnavailable, type BlameReport } from '../../src/lib/blame';

const NB = 'notebook.ipynb';
const cellRecord: BlameReport = {
	commit: 'a'.repeat(40),
	shortSha: 'aaaaaaa',
	author: 'Notebook Author',
	authorTime: 1700000000,
	summary: 'add a cell',
	notCommitted: false
};
const fileRecord: BlameReport = {
	commit: 'b'.repeat(40),
	shortSha: 'bbbbbbb',
	author: 'File Author',
	authorTime: 1700000001,
	summary: 'add a file',
	notCommitted: false
};
const tooLarge: BlameReport = { unavailable: 'too_large' };

describe('activeBlameFor', () => {
	it('shows nothing for an untracked file tab, even with a blamed notebook open', () => {
		// The regression: `notebookPath` is set and its record is truthy, so a `||`
		// chain fell through and credited someone else's commit to this file.
		expect(activeBlameFor('report.html', NB, { [NB]: cellRecord, 'report.html': null })).toBe(null);
		// …and the same when the file tab has reported nothing at all yet.
		expect(activeBlameFor('report.html', NB, { [NB]: cellRecord })).toBe(null);
	});

	it('shows the focused file tab its OWN record', () => {
		expect(activeBlameFor('src/app.ts', NB, { [NB]: cellRecord, 'src/app.ts': fileRecord })).toBe(
			fileRecord
		);
	});

	it('shows the too-large state for an oversized tracked file, by construction', () => {
		// Not because the marker happens to be truthy: it is the active tab's report.
		const shown = activeBlameFor('big.html', NB, { [NB]: cellRecord, 'big.html': tooLarge });
		expect(isBlameUnavailable(shown)).toBe(true);
	});

	it('shows the notebook cell record when the notebook tab is the active one', () => {
		expect(activeBlameFor(null, NB, { [NB]: cellRecord })).toBe(cellRecord);
		expect(activeBlameFor(null, NB, { [NB]: null })).toBe(null);
		expect(activeBlameFor(null, null, { [NB]: cellRecord })).toBe(null);
	});

	it('each arm of the union resolves to itself, never to another tab', () => {
		const byPath: Record<string, BlameReport | null> = {
			[NB]: cellRecord,
			'tracked.ts': fileRecord,
			'big.html': tooLarge,
			'report.html': null
		};
		expect(activeBlameFor('tracked.ts', NB, byPath)).toBe(fileRecord);
		expect(activeBlameFor('big.html', NB, byPath)).toBe(tooLarge);
		expect(activeBlameFor('report.html', NB, byPath)).toBe(null);
		expect(activeBlameFor(null, NB, byPath)).toBe(cellRecord);
	});
});
