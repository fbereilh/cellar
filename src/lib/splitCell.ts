// What a SPLIT cell's lower half inherits from the cell it came out of.
//
// Splitting produces two halves of ONE cell, so the lower half must keep the
// properties that describe how that cell is INTERPRETED and DISPLAYED - drop
// `language` and a split SQL cell mints a plain Python cell that silently
// compiles through the Python path instead of `sqlToPython`. But a `cellar` key
// is not automatically inheritable just because it is durable, so this is an
// explicit list rather than "forward the namespace, it is right there":
//
//   - `language`          the half is the same language; this is the whole point.
//   - `hide_input`        an explicit report-view choice about this code.
//   - `output_scrolled`   an explicit choice about how this cell's output reads.
//   - `hidden_from_agent` the half holds code the user hid; NOT inheriting it
//                         would DISCLOSE it, so this fails toward the user's
//                         privacy choice.
//
// Deliberately NOT inherited:
//   - `role: 'imports'`   there is ONE imports cell per notebook and the upper
//                         half keeps it (`seedCellar`'s uniqueness guard would
//                         strip it from the new cell anyway).
//   - `export`            a per-cell designation the user made about the ORIGINAL
//                         cell; inheriting it silently doubles what the nbdev
//                         `.py` module exports.
//   - the runtime-only stamps (`lastRun`, `editedAt`, `importBindings`), which the
//     server strips from any seeded namespace regardless - the new half has run
//     nothing, so it must not claim otherwise.
import type { CellarNamespace } from './server/types';

/** The `cellar` keys a split's lower half carries over. */
export const SPLIT_INHERITED_CELLAR_KEYS = ['language', 'hide_input', 'output_scrolled', 'hidden_from_agent'] as const;

/**
 * The namespace to seed a split's lower half with, or undefined when nothing
 * carries over (so the common split of a plain Python cell sends no metadata).
 */
export function splitInheritedCellar(cellar: CellarNamespace | undefined | null): CellarNamespace | undefined {
	if (!cellar) return undefined;
	const out: Record<string, unknown> = {};
	for (const key of SPLIT_INHERITED_CELLAR_KEYS) {
		if (cellar[key] !== undefined) out[key] = cellar[key];
	}
	return Object.keys(out).length ? (out as CellarNamespace) : undefined;
}
