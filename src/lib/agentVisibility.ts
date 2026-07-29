/**
 * Cellar - what `metadata.cellar.hidden_from_agent` means, in ONE place.
 *
 * A cell may be hidden from the agent surface entirely: `hidden_from_agent` is
 * honored in every map, read, search, section and result, so a hidden cell must
 * never surface its id, its source, its outputs, an image of them, or the FACT
 * that it changed. The flag lives in the allowlisted `cellar` namespace
 * clean-on-save preserves, so it round-trips byte-for-byte.
 *
 * This is single-sourced because a second copy is a DISCLOSURE bug waiting to
 * happen, not a tidiness question. `mcp/service.ts` filters every read through
 * it, and `mcp/userActivity.ts` filters the user-activity digest and the
 * tombstone messages through it - and the two cannot import each other
 * (`service.ts` already imports `userActivity.ts` for `forgetSessionActivity`),
 * so before this module they were two verbatim predicates a single edit could
 * silently drift apart. If the digest's copy ever read the flag differently from
 * the read tools', the digest would name a cell the read tools deliberately
 * refuse to show. It is the agent-visibility counterpart to `hideInput.ts`.
 *
 * DEFAULT-VISIBLE, and strictly `=== true`: the flag is an opt-in hide, so
 * anything else - absent, null, a truthy non-boolean out of a hand-edited
 * `.ipynb` - leaves the cell visible, which is the shape every caller expects.
 */

import type { CellMetadata } from '$lib/server/types';

/** The minimal cell shape this rule reads (Cell/CellView are assignable). */
type AgentVisibilityCell = { metadata?: CellMetadata | null } | null | undefined;

/** Whether this cell is hidden from the agent surface. */
export function isHiddenFromAgent(cell: AgentVisibilityCell): boolean {
	return cell?.metadata?.cellar?.hidden_from_agent === true;
}
