/**
 * Cellar - which Mojo cells have RUN in a notebook's kernel session.
 *
 * `$lib/mojoCarry` decides what a Mojo program is made of. This module holds its
 * one input that is not in the document: the sources that already ran. It is the
 * Mojo stand-in for a namespace, and it follows the namespace's own lifetime.
 *
 * FOUR RULES:
 *   - Only a run that ended `ok` is recorded. A cell that failed to compile has
 *     declared nothing, and carrying it would break every later cell. A failed
 *     re-run keeps the cell's previous good snapshot, exactly as a Python cell that
 *     raises half-way leaves its earlier definitions in place.
 *   - What is recorded is the source that RAN, never the cell's current text. An
 *     edited cell contributes its new declarations once it runs again, which is
 *     what a Python namespace does too.
 *   - The record is scoped to one kernel SESSION epoch. A restart clears a Python
 *     namespace, so it clears this as well: reading or writing under a different
 *     epoch drops everything recorded under the old one.
 *   - Nothing here is persisted. A reopened notebook starts with nothing carried.
 *
 * Keys are the ABSOLUTE notebook path, like `kernels` and `docs`. It imports
 * neither `notebook.ts` nor `kernel.ts`, so `run.ts` can use it freely.
 */

import type { SessionId } from './types';

interface Recorded {
	seq: number;
	source: string;
}

interface SessionRecord {
	session: SessionId;
	seq: number;
	cells: Map<string, Recorded>;
}

const sessions = new Map<string, SessionRecord>();

function recordFor(nb: string, session: SessionId): SessionRecord {
	let rec = sessions.get(nb);
	if (!rec || rec.session !== session) {
		rec = { session, seq: 0, cells: new Map() };
		sessions.set(nb, rec);
	}
	return rec;
}

/** Remember the Mojo source a cell just ran successfully in `session`. */
export function recordMojoRun(nb: string, session: SessionId, cellId: string, source: string): void {
	const rec = recordFor(nb, session);
	rec.seq += 1;
	rec.cells.set(cellId, { seq: rec.seq, source });
}

/** The cells that ran successfully in `session`, oldest run first. */
export function mojoRunsIn(nb: string, session: SessionId | null): { cellId: string; seq: number; source: string }[] {
	if (session === null) return [];
	const rec = sessions.get(nb);
	if (!rec || rec.session !== session) return [];
	return [...rec.cells].map(([cellId, r]) => ({ cellId, ...r })).sort((a, b) => a.seq - b.seq);
}

/** Test seam: forget every notebook. */
export function __resetMojoSessions(): void {
	sessions.clear();
}
