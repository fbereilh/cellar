/**
 * Cellar spike — notebook state (server-owned).
 *
 * The full product commits stable per-cell IDs inside the `.ipynb` and
 * reconstitutes them on load (spec §3), with Cellar owning ID generation. The
 * spike has no save pipeline yet, so the id lives in the server process: it is
 * generated once and stays fixed for the life of the notebook server, so a
 * browser refresh keeps the same cell id instead of minting a new one.
 */
import { randomUUID } from 'node:crypto';

let cellId = null;

/** The stable id of the single spike cell (nbformat-4.5-style 8-char slug). */
export function getCellId() {
	if (!cellId) cellId = randomUUID().slice(0, 8);
	return cellId;
}
