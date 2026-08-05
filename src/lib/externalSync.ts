/**
 * Cellar - turning an external on-disk change into a MINIMAL editor edit.
 *
 * When a file open in a tab changes on disk (an agent's `Edit`/`Write`, a
 * terminal command, another editor) and the tab has no unsaved edits, the new
 * content is applied silently. Replacing the whole document to do that would
 * throw the caret to the end, scroll the view, drop the selection and wipe the
 * undo history - the sync would be more disruptive than the staleness it fixes.
 *
 * So the change is expressed as the SMALLEST set of edits that turns the current
 * document into the new one, derived from the Myers line diff Cellar already
 * ships for the git gutter (`gitdiff.ts`). Dispatched as one transaction,
 * CodeMirror maps the caret, selection and scroll through it, and only the
 * changed region repaints.
 *
 * Browser-safe and dependency-free (it returns plain `{from,to,insert}` records
 * rather than CodeMirror types), which is what lets the offset arithmetic - the
 * part that is easy to get subtly wrong at document edges - be unit tested
 * without mounting an editor.
 */
import { diffLines, splitLines } from '$lib/gitdiff';

/** One replacement, in offsets into the CURRENT document. */
export interface TextEdit {
	from: number;
	to: number;
	insert: string;
}

/**
 * The minimal edits turning `current` into `next`, in ascending document order
 * and non-overlapping - the shape CodeMirror's `changes` accepts, where every
 * position refers to the document as it was before the transaction.
 *
 * Returns `[]` when the texts are identical, so a caller can skip the dispatch
 * entirely rather than pushing an empty transaction through the undo history.
 */
export function externalEdits(current: string, next: string): TextEdit[] {
	if (current === next) return [];
	const oldLines = splitLines(current);
	const newLines = splitLines(next);

	// lineStart[i] = offset of line i's first character. lineStart[n] is one PAST
	// the document (it counts a newline after the last line that does not exist),
	// so it is never used as an offset directly - only via the cases below.
	const lineStart: number[] = new Array(oldLines.length + 1);
	lineStart[0] = 0;
	for (let i = 0; i < oldLines.length; i++) lineStart[i + 1] = lineStart[i] + oldLines[i].length + 1;
	const n = oldLines.length;
	const docLength = lineStart[n] - 1;

	const edits: TextEdit[] = [];
	for (const h of diffLines(oldLines, newLines)) {
		const { oldStart: s, oldCount: c, newStart: s2, newCount: c2 } = h;
		const inserted = newLines.slice(s2, s2 + c2);

		if (c === 0) {
			// Pure insertion. Before line `s` it carries its own trailing newline;
			// past the last line there is no newline to reuse, so it brings a
			// LEADING one instead (appending to a file with no final newline).
			if (s < n) {
				const at = lineStart[s];
				edits.push({ from: at, to: at, insert: inserted.join('\n') + '\n' });
			} else {
				edits.push({ from: docLength, to: docLength, insert: '\n' + inserted.join('\n') });
			}
			continue;
		}

		if (c2 === 0) {
			// Pure deletion. Mid-document it takes the deleted lines' own trailing
			// newlines; through the end of the document there is none after the
			// last line, so it takes the newline BEFORE the first deleted line.
			if (s + c < n) edits.push({ from: lineStart[s], to: lineStart[s + c], insert: '' });
			else edits.push({ from: s > 0 ? lineStart[s] - 1 : 0, to: docLength, insert: '' });
			continue;
		}

		// Replacement: rewrite the lines' CONTENT and leave the newline that
		// follows the last of them (if any) exactly where it is.
		const last = s + c - 1;
		edits.push({
			from: lineStart[s],
			to: lineStart[last] + oldLines[last].length,
			insert: inserted.join('\n')
		});
	}
	return edits;
}

/** Apply `externalEdits` in plain JS - the oracle the unit tests check against. */
export function applyTextEdits(current: string, edits: TextEdit[]): string {
	let out = '';
	let at = 0;
	for (const e of edits) {
		out += current.slice(at, e.from) + e.insert;
		at = e.to;
	}
	return out + current.slice(at);
}
