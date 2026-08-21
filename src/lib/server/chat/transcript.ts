/**
 * Cellar - chat transcript builder (pure).
 *
 * Renders the cells ABOVE a chat cell into the ONE user message the chat engine
 * sends: a plain-text transcript, then the question. One message = one inference
 * (feeding a real message array makes the CLI run an inference PER user message -
 * measured in the scout report - so the transcript shape is a cost decision, not
 * a style one).
 *
 * Three load-bearing rules:
 *
 * 1. **`isHiddenFromAgent` is honored here, through the ONE shared predicate.**
 *    A hidden cell must be provably absent from what is sent - same doctrine as
 *    the MCP read surface, same predicate, so one flag means one thing
 *    everywhere: "this cell is not shown to AI".
 *
 *    **Its SCOPE, stated precisely, because a reads-on run has file reach.** The
 *    filter below bounds the TRANSCRIPT; on its own that would leave a hidden
 *    cell one `Read('<ws>/notebook.ipynb')` away, since the notebook file (and
 *    `.cellar/checkpoints.json`, which snapshots cells WITH outputs) sits inside
 *    the confinement root. So the two halves are paired: this filter bounds what
 *    is SENT, and `server/chat/claude-cli.ts`'s `denialPatterns` denies, at the
 *    tool layer on EVERY reads-on run and never optionally, the current notebook,
 *    the artifacts Cellar names after it (`<stem>.py`, `<stem>.html`, the
 *    `.ipynb_checkpoints` copy - none of those writers filters hidden cells), and
 *    `.cellar/` whole.
 *
 *    **The claim that supports, exactly, and its two residuals.** What holds is
 *    the narrow statement: a hidden cell in THIS notebook is unreachable through
 *    the notebook file, the copies named after it, and the checkpoint store -
 *    which is what keeps `chatPromptTooLargeMessage`'s "hide cells from the
 *    agent" remedy honest. It is NOT a general "hidden cells cannot be read".
 *    Two residuals, both stated rather than glossed: (a) a hidden cell in a
 *    DIFFERENT notebook is reachable when the person turns the other-notebooks
 *    option on, which is what that option, defaulting OFF, exists to decide; and
 *    (b) a derived artifact written to a NON-DEFAULT path is invisible to a
 *    by-name rule - specifically MCP `export_html` called with an explicit
 *    `path`, and an nbdev export module at a configured
 *    `metadata.cellar.export_target`, neither of which is derivable from the
 *    notebook's name.
 *
 * 2. **The transcript is BYTE-STABLE across runs of an unchanged notebook.**
 *    Prompt caching keys on an exact prefix and is what makes a long notebook
 *    affordable (a measured 22.6x cost reduction on a warm re-run) - so nothing
 *    time-varying may enter: no timestamps, no run counters, no set iteration
 *    order. Cells render in document order; outputs render from their stored
 *    text. A unit test renders the same notebook twice and asserts identical
 *    bytes; keep it true.
 *
 * 3. **The built prompt is BOUNDED, and an over-budget notebook is REFUSED - it
 *    is never sampled, summarized or truncated here.** One cell's outputs are
 *    capped at 500 KB and a notebook's at 10 MB (`output-accumulator.ts`), so a
 *    handful of output-heavy cells builds a multi-megabyte prompt that is re-sent
 *    on every chat run in that notebook: a silently large bill, and past the
 *    model's context window an opaque engine error naming nothing the user can
 *    act on. `chatPromptTooLarge` turns that into an honest refusal naming the
 *    size and the two levers the user already has (hide cells from the agent,
 *    clear outputs). Choosing WHAT to send instead - selection, summarization,
 *    per-cell truncation - is a separate, deliberate feature; do not smuggle a
 *    policy in here, and note that any such policy must keep rule 2 intact.
 */

import { isHiddenFromAgent } from '$lib/agentVisibility';
import { isChatCell, logicalCellType } from '$lib/cellLanguage';
import { asText, stripAnsi } from '$lib/outputText';
import type { CellOutput } from '$lib/server/types';

/**
 * The largest prompt (UTF-8 bytes) a chat run will send. ~600 KB is roughly
 * 150k tokens - well inside the model's window with room for the reply, and
 * orders of magnitude past any hand-written notebook: what reaches it is stored
 * OUTPUT (a big `to_string()`, a training log, a traceback), which is exactly
 * what the refusal tells the user to clear. `CELLAR_CHAT_MAX_PROMPT_BYTES`
 * overrides it (an unparseable/non-positive value falls back, the
 * `envMs` convention).
 */
export const MAX_CHAT_PROMPT_BYTES = 600_000;

export function chatPromptLimitBytes(): number {
	const raw = Number(process.env.CELLAR_CHAT_MAX_PROMPT_BYTES);
	return Number.isFinite(raw) && raw > 0 ? raw : MAX_CHAT_PROMPT_BYTES;
}

/**
 * Is this prompt over budget, and by how much? Returns null when it fits, so a
 * caller reads it as "no refusal". Measured in UTF-8 BYTES (what is actually
 * sent), never characters.
 */
export function chatPromptTooLarge(prompt: string, limit = chatPromptLimitBytes()): { bytes: number; limit: number } | null {
	const bytes = Buffer.byteLength(prompt, 'utf8');
	return bytes > limit ? { bytes, limit } : null;
}

/**
 * The two sizes as strings that are never EQUAL. The whole point of the refusal
 * is to name what is over and by how much, and any fixed precision collides for
 * a transcript just past the ceiling (601 KB and 600 KB are both "0.6 MB"), so a
 * message whose only job is to be actionable read as self-contradictory.
 * Precision grows until the two differ, and exact byte counts are the floor -
 * `bytes > limit` is this function's precondition, so that always terminates.
 */
function distinctSizes(bytes: number, limit: number): { size: string; cap: string } {
	for (const digits of [1, 2, 3]) {
		const size = `${(bytes / 1_000_000).toFixed(digits)} MB`;
		const cap = `${(limit / 1_000_000).toFixed(digits)} MB`;
		if (size !== cap) return { size, cap };
	}
	return {
		size: `${bytes.toLocaleString('en-US')} bytes`,
		cap: `${limit.toLocaleString('en-US')} bytes`
	};
}

/** The actionable refusal message for an over-budget transcript. */
export function chatPromptTooLargeMessage({ bytes, limit }: { bytes: number; limit: number }): string {
	const { size, cap } = distinctSizes(bytes, limit);
	return (
		`This notebook's transcript is ${size}, over the ${cap} a chat cell sends. ` +
		'Nothing was sent. Shrink what the chat cell sees: clear the outputs of the heavy cells ' +
		'(their stored text is what dominates), or hide cells from the agent - a cell marked ' +
		'hidden_from_agent is left out of the transcript entirely.'
	);
}

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
		const hasOutputs = cell.cell_type === 'code';
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
