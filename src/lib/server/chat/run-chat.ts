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
 */

import { listCells } from '../notebook';
import type { OutputAccumulator } from '../output-accumulator';
import type { CellOutput } from '../types';
import type { ChatFailureKind } from '$lib/chatCell';
import { asText } from '$lib/outputText';
import { registerChatRun, unregisterChatRun } from './active';
import { configDirFor, resolveChatAuth } from './auth';
import { chatEngine } from './engine';
import { chatFailure, chatFailureOutput } from './failure';
import { buildChatPrompt, chatPromptTooLarge, chatPromptTooLargeMessage } from './transcript';

/** What the chat branch hands back to `executeCellRun` for the lastRun stamp. */
export interface ChatRunOutcome {
	status: 'ok' | 'error';
	/** Set on failure; rides `lastRun.chatFailure` so the bulk-run loop can stop. */
	chatFailure?: ChatFailureKind;
	/** Engine provenance (e.g. `claude-cli/2.1.235`) when known. */
	chatEngine?: string;
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
			return { status: 'error', chatFailure: 'cancelled' };
		};
		if (ctrl.signal.aborted) return cancelled();
		const auth = await resolveChatAuth();
		// A stop that landed while the account was being resolved is the user's
		// answer to this run: report it as one rather than going on to spend.
		if (ctrl.signal.aborted) return cancelled();
		if (auth.kind === 'none') {
			const kind: ChatFailureKind = auth.notInstalled ? 'not_installed' : 'not_signed_in';
			acc.push(chatFailureOutput(chatFailure(kind, '')));
			return { status: 'error', chatFailure: kind };
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
			return { status: 'error', chatFailure: kind };
		}
		let sawDelta = false;
		const res = await chatEngine().run({
			prompt,
			configDir: configDirFor(auth),
			signal: ctrl.signal,
			onDelta: (text) => {
				if (!text) return;
				sawDelta = true;
				acc.push({ output_type: 'stream', name: 'stdout', text });
			}
		});
		if (res.ok) {
			// A run that streamed nothing but reported a reply (defensive: a CLI
			// build without partial messages) still lands its text.
			if (!sawDelta && res.replyText) {
				acc.push({ output_type: 'stream', name: 'stdout', text: res.replyText });
			}
			return { status: 'ok', ...(res.engine ? { chatEngine: res.engine } : {}) };
		}
		const failure = res.failure ?? chatFailure('api_error', 'the chat engine failed without a reason');
		acc.push(chatFailureOutput(failure));
		return {
			status: 'error',
			chatFailure: failure.kind,
			...(res.engine ? { chatEngine: res.engine } : {})
		};
	} finally {
		unregisterChatRun(nb, ctrl);
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
