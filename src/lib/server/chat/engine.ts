/**
 * Cellar - the ChatEngine seam.
 *
 * One interface between "run this chat cell" and whatever produces the reply.
 * Today the one implementation is the claude CLI (`claude-cli.ts`); the seam
 * exists so a future engine (a direct API client, another CLI) is a second
 * implementation of THIS interface rather than a second run path - and so unit
 * tests can drive the whole chat run pipeline (transcript -> accumulator ->
 * persist -> run:end) against a scripted engine with no CLI installed.
 *
 * The engine's contract is deliberately narrow: one prompt in, streamed text
 * deltas out, one settled result. It knows nothing about notebooks, cells,
 * accumulators or events - `run-chat.ts` owns that glue.
 */

import type { ChatFailureKind } from '$lib/chatCell';
import { claudeCliEngine } from './claude-cli';

/** Arguments for one engine run. */
export interface ChatEngineRunArgs {
	/** The full prompt (transcript + question), already built and byte-stable. */
	prompt: string;
	/** The slot's `CLAUDE_CONFIG_DIR`, or null for the ambient default login. */
	configDir: string | null;
	/**
	 * The model to run - a `$lib/chatCell` `CHAT_MODELS` id. The caller reads it
	 * from user settings through `normalizeChatModel`, and the claude engine
	 * re-normalizes through the SAME function before the value can reach argv, so
	 * an arbitrary string here cannot inject a flag value. Absent = the default.
	 */
	model?: string;
	/**
	 * May this run search the web? Default (absent/false) = today's bare session:
	 * the engine requests NO tools and asserts the CLI reported none. `true`
	 * requests web search ONLY, and the engine asserts the reported tool set is
	 * exactly that - search is mediated; arbitrary URL fetch stays off.
	 */
	webSearch?: boolean;
	/**
	 * May this run READ files, and where? Absent/null = no file tools at all
	 * (today's bare session). A non-null value is the ABSOLUTE directory reads are
	 * confined to - the claude engine turns it into path-scoped `--allowedTools`
	 * rules and refuses (read-less) anything it cannot confine, so this is a
	 * confinement root and never a mere hint. The caller passes the WORKSPACE, not
	 * a notebook code root: a code root may sit outside the workspace and grants
	 * no file reach anywhere else in Cellar.
	 */
	readRoot?: string | null;
	/**
	 * The ABSOLUTE path of the notebook this run answers in. REQUIRED, not
	 * optional: with reads on the engine DENIES this file (the model already holds
	 * the notebook as a fresher, hidden-cell-filtered transcript, so reading it
	 * could only add a stale copy and the cells the user withheld), and a run that
	 * cannot name it gets no file tools at all rather than an unbounded grant.
	 * Pass null only where there is genuinely no notebook - that too is read-less.
	 */
	notebookPath: string | null;
	/**
	 * May OTHER notebooks in the workspace be read? Only a literal `true` opens
	 * them; absent/false additionally denies every `*.ipynb` there, so a reply
	 * still reads `.py`, `.md` and data files. The notebook named above and
	 * Cellar's own `.cellar/` state stay denied either way.
	 */
	otherNotebooks?: boolean;
	/** Aborted by interrupt / kernel restart / shutdown; the engine must kill its work. */
	signal: AbortSignal;
	/** Streamed reply text, in order, as it is produced. */
	onDelta: (text: string) => void;
}

/** Why a run failed, in the shared failure vocabulary plus a human detail line. */
export interface ChatEngineFailure {
	kind: ChatFailureKind;
	/** Engine-reported detail (safe to render; never a credential). */
	message: string;
	/** For `rate_limited`: when the window resets (epoch SECONDS), if reported. */
	resetsAt?: number;
}

/** One settled engine run. */
export interface ChatEngineResult {
	ok: boolean;
	failure: ChatEngineFailure | null;
	/** Engine identity for provenance, e.g. `claude-cli/2.1.235` (null if unknown). */
	engine: string | null;
	/**
	 * The full reply text as the engine's own final result reported it - the
	 * fallback for a run that streamed no deltas; normally the deltas already
	 * carried every byte of it.
	 */
	replyText: string | null;
}

/** The seam. */
export interface ChatEngine {
	run(args: ChatEngineRunArgs): Promise<ChatEngineResult>;
}

let testEngine: ChatEngine | null = null;

/** The engine chat runs use (the claude CLI, unless a test scripted one). */
export function chatEngine(): ChatEngine {
	return testEngine ?? claudeCliEngine;
}

/** Test seam: script the engine (pass null to restore the real one). */
export function __setChatEngineForTests(engine: ChatEngine | null): void {
	testEngine = engine;
}
