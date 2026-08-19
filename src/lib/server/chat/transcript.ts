/**
 * Cellar - chat transcript builder (pure).
 *
 * Renders the cells ABOVE a chat cell into the ONE user message the chat engine
 * sends: a plain-text transcript, then the question. One message = one inference
 * (feeding a real message array makes the CLI run an inference PER user message -
 * measured in the scout report - so the transcript shape is a cost decision, not
 * a style one).
 *
 * Two load-bearing rules:
 *
 * 1. **`isHiddenFromAgent` is honored here, through the ONE shared predicate.**
 *    A hidden cell must be provably absent from what is sent - same doctrine as
 *    the MCP read surface, same predicate, so one flag means one thing
 *    everywhere: "this cell is not shown to AI".
 *
 * 2. **The transcript is BYTE-STABLE across runs of an unchanged notebook.**
 *    Prompt caching keys on an exact prefix and is what makes a long notebook
 *    affordable (a measured 22.6x cost reduction on a warm re-run) - so nothing
 *    time-varying may enter: no timestamps, no run counters, no set iteration
 *    order. Cells render in document order; outputs render from their stored
 *    text. A unit test renders the same notebook twice and asserts identical
 *    bytes; keep it true.
 */

import { isHiddenFromAgent } from '$lib/agentVisibility';
import { isChatCell, isSqlCell, logicalCellType } from '$lib/cellLanguage';
import { asText, stripAnsi } from '$lib/outputText';
import type { CellOutput } from '$lib/server/types';

/** The minimal cell shape the builder reads (Cell/CellView are assignable). */
export interface TranscriptCell {
	id: string;
	cell_type: string;
	source?: string;
	outputs?: CellOutput[];
	metadata?: { cellar?: Record<string, unknown> } | null;
}

/** What was built, and which cells went into it (for tests + provenance). */
export interface ChatTranscript {
	/** The full user message: transcript blocks, then `[question]`. */
	prompt: string;
	/** Ids of the cells whose source/outputs were included, in document order. */
	includedIds: string[];
}

/**
 * The text ONE output contributes. Deterministic and text-only: stream text,
 * then the markdown/plain repr of a rich bundle (markdown first - that is the
 * chat reply's own mime), an error as its compact `ename: evalue` line. A
 * purely rich output (image, widget, plotly) contributes nothing - a picture
 * cannot ride a text transcript, and inventing a placeholder would spend cached
 * prefix bytes on noise.
 */
function outputText(o: CellOutput): string {
	switch (o.output_type) {
		case 'stream':
			return asText(o.text);
		case 'execute_result':
		case 'display_data': {
			const d = o.data || {};
			if (d['text/markdown']) return asText(d['text/markdown']);
			if (d['text/plain']) return asText(d['text/plain']);
			return '';
		}
		case 'error':
			return stripAnsi(`${o.ename}: ${o.evalue}`);
		default:
			return '';
	}
}

/** The `[cell <id> · <kind>]` label kind for a cell. */
function kindOf(cell: TranscriptCell): string {
	return logicalCellType(cell as Parameters<typeof logicalCellType>[0]);
}

/**
 * Build the chat prompt for `chatCellId`: every cell STRICTLY ABOVE it (document
 * order), minus the ones hidden from agents, then the question. `question` is
 * the just-submitted source (the run doctrine: run what the user last
 * submitted), not the possibly-stale stored one.
 */
export function buildChatPrompt(
	cells: readonly TranscriptCell[],
	chatCellId: string,
	question: string
): ChatTranscript {
	const at = cells.findIndex((c) => c.id === chatCellId);
	const above = at >= 0 ? cells.slice(0, at) : [];
	const blocks: string[] = [];
	const includedIds: string[] = [];

	for (const cell of above) {
		if (isHiddenFromAgent(cell as Parameters<typeof isHiddenFromAgent>[0])) continue;
		const source = (cell.source ?? '').replace(/\s+$/, '');
		const kind = kindOf(cell);
		const cellBlocks: string[] = [];
		if (source) cellBlocks.push(`[cell ${cell.id} · ${kind}]\n${source}`);
		// A chat cell's persisted output is its REPLY - label it so the dialog
		// reads as one; a code/sql cell's outputs are results.
		const isChat = isChatCell(cell as Parameters<typeof isChatCell>[0]);
		const hasOutputs = cell.cell_type === 'code' || isSqlCell(cell as Parameters<typeof isSqlCell>[0]);
		if (hasOutputs) {
			const text = (cell.outputs ?? [])
				.map(outputText)
				.filter(Boolean)
				.join('\n')
				.replace(/\s+$/, '');
			if (text) cellBlocks.push(`[cell ${cell.id} · ${isChat ? 'reply' : 'output'}]\n${text}`);
		}
		if (cellBlocks.length) {
			blocks.push(...cellBlocks);
			includedIds.push(cell.id);
		}
	}

	blocks.push(`[question]\n${question.replace(/\s+$/, '')}`);
	return { prompt: blocks.join('\n\n') + '\n', includedIds };
}
