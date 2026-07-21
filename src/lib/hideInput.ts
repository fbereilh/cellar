/**
 * Cellar — "hide code input" identity + precedence.
 *
 * A code cell's editor can be hidden (report view) two ways, and one rule
 * combines them: an explicit per-cell `metadata.cellar.hide_input` (tri-state)
 * ALWAYS wins, and when it is unset the cell follows the notebook-wide
 * `hide_all_code` default. Both flags live in the allowlisted `cellar` namespace
 * clean-on-save preserves, so they round-trip byte-for-byte. Display only: the
 * source is never touched and the cell still runs.
 *
 * Every surface that decides "is this cell's code shown" reads THIS rule — the
 * browser (`Cell.svelte`), the HTML export (`export-html.ts`), and the agent map
 * (`mcp/service.ts`) — so the precedence lives in one pure, browser-safe module
 * rather than a predicate copied on each side. It is the display-view counterpart
 * to `exportRole.ts` / `importsRole.ts`.
 */

import type { CellMetadata } from '$lib/server/types';

/** The minimal cell shape these rules read (Cell/CellView are assignable). */
type HideInputCell = { cell_type?: string; metadata?: CellMetadata | null } | null | undefined;

/**
 * The EXPLICIT per-cell choice, tri-state: `true` = force hidden, `false` = force
 * shown, `undefined` = no choice (follow the notebook-wide default). Only a code
 * cell can carry it — a markdown cell has no code to hide (a SQL cell is itself a
 * `code` cell, so it does) — so a non-code cell reads `undefined`.
 */
export function hideInputExplicit(cell: HideInputCell): boolean | undefined {
	if (!cell || cell.cell_type !== 'code') return undefined;
	return cell.metadata?.cellar?.hide_input;
}

/**
 * Whether a cell's code input is EFFECTIVELY hidden, given the notebook-wide
 * `hideAllCode` (report view) default. The explicit per-cell `hide_input` wins in
 * either direction; when unset the cell follows `hideAllCode`. Markdown cells
 * never hide (there is no code to hide).
 */
export function isCodeHidden(cell: HideInputCell, hideAllCode: boolean): boolean {
	if (!cell || cell.cell_type !== 'code') return false;
	return cell.metadata?.cellar?.hide_input ?? hideAllCode;
}
