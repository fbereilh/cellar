/**
 * Cellar - the chat run glue: what `executeCellRun` does when the cell is a
 * chat cell instead of handing source to the kernel.
 *
 * The chat branch reuses the ENTIRE run pipeline - queue ticket, run:start,
 * OutputAccumulator (+ its ~40ms flush, delta rail, mid-run-clear truncation),
 * setOutputs persist, lastRun stamp, run:end - and swaps only the middle:
 * instead of `execute()`, the reply streams from the ChatEngine as coalesced
 * stream text, and a successful run's surviving text is then FINALIZED into one
 * `display_data` carrying `text/markdown` (a native nbformat mime, so plain
 * Jupyter renders the reply too). Streaming as stream text first is what buys
 * live feedback through machinery every tab already understands; the finalize
 * frame at the same stable index is what snaps it to rendered markdown at the
 * end.
 *
 * The finalize reads the accumulator's SURVIVING text, so a mid-run "clear
 * outputs" behaves exactly as it does for a kernel cell: pre-clear reply text
 * is gone for good, only what streamed after the clear persists.
 *
 * ## Tool-activity lines ride the SAME stream as the reply
 *
 * A tool call the model makes is annotated with one compact line (`tool-lines.ts`
 * owns what it may say), pushed into the accumulator as markdown text between
 * the reply deltas either side of it. That is the whole mechanism, and it is
 * chosen for what it makes free rather than for tidiness: the lines stream in
 * order through the rail every tab already understands, fold into the ONE
 * finalized markdown output, and therefore persist, round-trip through the
 * `.ipynb` and reach the HTML export with no second path anywhere. (Cellar's
 * `.py` notebook formats carry no outputs at all, so neither the reply nor its
 * lines reach them - nothing to decide there.)
 *
 * Emitting them as their own OUTPUT elements was the alternative and it does not
 * work: the finalize collapses to `outputs = [reply]` and republishes index 0,
 * with no retract frame for anything else - the same reason a capped run skips
 * the finalize entirely - so tool outputs would either be orphaned on every
 * client or block the finalize and leave the whole reply as unrendered
 * monospace text.
 *
 * `pushText`/`pushToolLine` own the JOINS, and they are load-bearing rather than
 * cosmetic. A blockquote swallows the line that follows it (markdown's lazy
 * continuation), so resumed reply text must be separated by a blank line or it
 * becomes part of the annotation. And consecutive lines join with a BACKSLASH
 * hard break so a burst of calls renders as ONE dim block of short lines rather
 * than a stack of separately-bordered ones (which is what keeps a chatty run
 * from burying a short answer under a column of separate quotes); the engine
 * renders `breaks: false`, so a bare newline there would run them together on
 * one line instead. Markdown's OTHER hard break - two trailing spaces - is
 * measurably WRONG here and must not replace it: the accumulator runs its
 * terminal reducer over any buffer holding an escape sequence, and that reducer
 * RIGHT-TRIMS every line, so a reply that merely mentions an ANSI code would
 * silently collapse every annotation onto one line. A backslash survives it.
 *
 * Every call is shown, none is summarised away: a harness shows every call, the
 * file paths ARE the provenance a chatty run most needs, each line is bounded to
 * one short line, and a tall output is already contracted to a scroll box by the
 * scrollable-outputs rule - so a cap would only lose provenance for exactly the
 * runs that depend on it, and the accumulator's own byte cap is the backstop.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { workspaceRoot } from '../fstree';
import { listCells } from '../notebook';
import type { OutputAccumulator } from '../output-accumulator';
import type { CellOutput } from '../types';
import { toolCallLine } from './tool-lines';
import {
	CHAT_MODEL_KEY,
	CHAT_OTHER_NOTEBOOKS_KEY,
	CHAT_WEB_SEARCH_KEY,
	CHAT_WORKSPACE_READS_KEY,
	chatOtherNotebooksEnabled,
	chatWebSearchEnabled,
	chatWorkspaceReadsEnabled,
	normalizeChatModel,
	type ChatFailureKind
} from '$lib/chatCell';
import { asText } from '$lib/outputText';
import { getUserSettings } from '$lib/server/user-settings';
import { registerChatRun, unregisterChatRun } from './active';
import { configDirFor, resolveChatAuth } from './auth';
import { chatEngine } from './engine';
import { chatFailure, chatFailureOutput } from './failure';
import { buildChatPrompt, chatPromptTooLarge, chatPromptTooLargeMessage } from './transcript';

/**
 * What the chat branch hands back to `executeCellRun`.
 *
 * The outcome is the RUN's status and nothing else: the failure itself is
 * already a persisted output (a friendly markdown message the user reads), so a
 * second copy of the kind on the run stamp would be write-only state - no bulk
 * path can produce a chat failure any more, both surfaces skipping chat cells.
 */
export interface ChatRunOutcome {
	status: 'ok' | 'error';
}

/**
 * Run one chat cell: resolve the account, build the transcript from the LIVE
 * document (cells above, minus hidden), stream the reply into `acc`. The caller
 * owns the accumulator lifecycle (flush timer, finish, persist) exactly as for
 * a kernel run.
 *
 * The abort controller is registered BEFORE the first await, not just before the
 * engine call: `interruptKernel`/`restartKernel`/`teardownKernel` stop a chat run
 * by aborting whatever `abortChatRuns(nb)` finds registered, so any await this
 * function reaches with nothing registered is a window in which Stop silently
 * does nothing and the CLI is spawned - and billed - anyway. `resolveChatAuth`
 * really is such a window: its probe cache lives 5s, so an ordinary run pays a
 * real `claude auth status` spawn. Registered first, an abort landing there is
 * observed at the next checkpoint and the run settles `cancelled` before the
 * engine is ever asked. Registration/unregistration are balanced by the single
 * `finally` spanning every path.
 */
export async function executeChatRun({
	nb,
	cellId,
	question,
	acc
}: {
	nb: string;
	cellId: string;
	question: string;
	acc: OutputAccumulator;
}): Promise<ChatRunOutcome> {
	const ctrl = new AbortController();
	registerChatRun(nb, ctrl);
	try {
		const cancelled = (): ChatRunOutcome => {
			acc.push(chatFailureOutput(chatFailure('cancelled', 'interrupted')));
			return { status: 'error' };
		};
		if (ctrl.signal.aborted) return cancelled();
		const auth = await resolveChatAuth();
		// A stop that landed while the account was being resolved is the user's
		// answer to this run: report it as one rather than going on to spend.
		if (ctrl.signal.aborted) return cancelled();
		if (auth.kind === 'none') {
			const kind: ChatFailureKind = auth.notInstalled ? 'not_installed' : 'not_signed_in';
			acc.push(chatFailureOutput(chatFailure(kind, '')));
			return { status: 'error' };
		}

		const { prompt } = buildChatPrompt(listCells(nb), cellId, question);
		// Over the send ceiling the run is REFUSED before the engine is spawned, with
		// a message naming the size and what shrinks it - rather than sending a
		// multi-megabyte prompt whose only feedback is a silently large bill or, past
		// the model's window, an opaque `api_error` naming nothing actionable. Nothing
		// is truncated or sampled here (see `transcript.ts`'s bound).
		const oversize = chatPromptTooLarge(prompt);
		if (oversize) {
			const kind: ChatFailureKind = 'transcript_too_large';
			acc.push(chatFailureOutput(chatFailure(kind, chatPromptTooLargeMessage(oversize))));
			return { status: 'error' };
		}
		let sawDelta = false;
		// What the accumulator last received, so the two pushers below can put the
		// right JOIN between them (see the header). `none` is the very start, where
		// no separator belongs at all.
		let last: 'none' | 'text' | 'tool' = 'none';
		// Trailing newlines of everything emitted so far, so a separator TOPS UP to a
		// blank line instead of always adding one. A reply delta routinely ends with
		// its own newline, and an unconditional `\n\n` after it left a stray blank
		// line in the persisted markdown and in the live (plain-text) view.
		let trailingNewlines = 0;
		const emit = (text: string) => {
			if (!text) return;
			acc.push({ output_type: 'stream', name: 'stdout', text });
			const tail = /\n*$/.exec(text)?.[0].length ?? 0;
			trailingNewlines = tail === text.length ? trailingNewlines + tail : tail;
		};
		/** The newlines still needed for a blank line between blocks. */
		const gap = () => '\n'.repeat(Math.max(0, 2 - trailingNewlines));
		const pushText = (text: string) => {
			// A blockquote lazily swallows the line under it, so reply text resuming
			// after an annotation needs a blank line or it becomes part of it.
			if (last === 'tool') emit(gap());
			emit(text);
			last = 'text';
		};
		const pushToolLine = (line: string) => {
			if (last === 'text') emit(gap());
			// A backslash hard break keeps consecutive annotations in ONE blockquote,
			// one per rendered line; a bare newline would run them together, since the
			// reply engine renders with `breaks: false`.
			else if (last === 'tool') emit('\\\n');
			emit(`> ${line}`);
			last = 'tool';
		};
		// The reference frame every rendered path is made relative to, read ONCE per
		// run. `resolve()`d exactly as `chatReadableWorkspace` resolves it, so the
		// root a line measures against is the SAME string the child was CONFINED to
		// - the two answering different questions about one path is how a plainly
		// in-workspace file would come out as `outside the workspace`.
		const workspace = resolve(workspaceRoot());
		// The engine's capability inputs, read from the person-scoped store at run
		// time (the `auth.ts` CHAT_SLOT_KEY pattern) through the shared gates: the
		// model is constrained to the known set BEFORE it rides the seam (and the
		// engine re-normalizes - no path to argv skips the gate), and each capability
		// is on only for a literal stored `true`, so absent keys are exactly the
		// pre-settings behavior. The opt-ins are read from SEPARATE keys and composed
		// here rather than in the store: web search and workspace reads widen the
		// session in different directions (an outbound query channel vs. local file
		// reach), so neither may arrive as a side effect of the other, while the
		// other-notebooks key only ever NARROWS the read grant and is inert unless
		// reads are already on.
		const settings = getUserSettings();
		const res = await chatEngine().run({
			prompt,
			configDir: configDirFor(auth),
			model: normalizeChatModel(settings[CHAT_MODEL_KEY]),
			webSearch: chatWebSearchEnabled(settings[CHAT_WEB_SEARCH_KEY]),
			readRoot: chatWorkspaceReadsEnabled(settings[CHAT_WORKSPACE_READS_KEY]) ? chatReadableWorkspace() : null,
			// The notebook this run is answering in, so the engine can DENY it: the
			// model already holds it as a fresher, hidden-cell-filtered transcript, so
			// reading the file could only add a stale copy and the cells the user
			// deliberately withheld. `nb` is the resolved absolute path the whole run
			// pipeline is keyed by, which is exactly what the deny rule needs.
			notebookPath: nb,
			otherNotebooks: chatOtherNotebooksEnabled(settings[CHAT_OTHER_NOTEBOOKS_KEY]),
			signal: ctrl.signal,
			onDelta: (text) => {
				if (!text) return;
				sawDelta = true;
				pushText(text);
			},
			onToolCall: (call) => {
				// One line per call, at the moment its outcome is known, so it lands
				// between the reply text either side of it rather than being batched at
				// the end. `toolCallLine` is a pure function of the CALL - a result
				// string has no path here.
				//
				// Deliberately does NOT set `sawDelta`: that flag means the reply TEXT
				// streamed, and it is what decides whether the engine's own final
				// `replyText` still has to be landed. A tool line satisfying it would
				// drop the entire reply of a CLI build that streams no text deltas.
				pushToolLine(toolCallLine(call, workspace));
			}
		});
		if (res.ok) {
			// A run that streamed nothing but reported a reply (defensive: a CLI
			// build without partial messages) still lands its text.
			if (!sawDelta && res.replyText) {
				pushText(res.replyText);
			}
			return { status: 'ok' };
		}
		const failure = res.failure ?? chatFailure('api_error', 'the chat engine failed without a reason');
		acc.push(chatFailureOutput(failure));
		return { status: 'error' };
	} finally {
		unregisterChatRun(nb, ctrl);
	}
}

/**
 * The directory a reads-on chat run is confined to: the WORKSPACE, or null when
 * it cannot be established.
 *
 * The workspace and NOT the notebook's code root, deliberately - a code root may
 * be an external git worktree, and Cellar's standing rule is that such a root
 * grants a kernel cwd and not one byte of file reach, every file surface staying
 * workspace-scoped. Reads follow that rule rather than inventing a second answer
 * to "which directory may this notebook see".
 *
 * A root that is not an existing directory yields null (= reads off) rather than
 * being passed on: the engine spawns the child WITH this as its cwd, so a
 * missing one would surface as a spawn ENOENT, and a read-less run is the
 * safe degradation - the frozen prompt is chosen from the same policy, so such a
 * run is also TOLD it cannot read rather than being left to discover it.
 *
 * It cannot close the race, only narrow it - the directory can still go away
 * between this check and the spawn - so `spawnFailure` re-asks there and names
 * the workspace instead of blaming a CLI that is installed.
 */
function chatReadableWorkspace(): string | null {
	try {
		const root = resolve(workspaceRoot());
		return statSync(root).isDirectory() ? root : null;
	} catch {
		return null;
	}
}

/**
 * The finalized reply for a SUCCESSFUL chat run: the finished outputs' stream
 * text as one markdown `display_data`, or null when there is nothing to convert
 * (an empty reply, or outputs that are not purely streamed text - a failure
 * message is already `display_data` and must pass through untouched).
 *
 * `text/plain` carries the same text so any consumer without a markdown
 * renderer still shows the reply.
 */
export function chatReplyOutput(outputs: readonly CellOutput[]): CellOutput | null {
	if (outputs.length === 0) return null;
	if (!outputs.every((o) => o.output_type === 'stream')) return null;
	const text = outputs
		.map((o) => (o.output_type === 'stream' ? asText(o.text) : ''))
		.join('')
		.replace(/\s+$/, '');
	if (!text) return null;
	return {
		output_type: 'display_data',
		data: { 'text/markdown': text, 'text/plain': text },
		metadata: {}
	};
}
