/**
 * Cellar - chat failure copy: each failure kind's actionable, renderable text.
 *
 * A failed chat run persists a FRIENDLY markdown `display_data`, never a
 * traceback - there is no Python exception behind "sign in first", and a red
 * traceback would send the user reading a stack that does not exist. Each kind
 * gets its own message naming its own remedy (the sidebar's REMEDY-map
 * doctrine); the engine's detail line rides along where it adds anything.
 *
 * These messages become part of the notebook the way any output does, so they
 * are also honest transcript context for a LATER chat run ("the previous
 * attempt was rate-limited") - deliberate, not leakage.
 */

import type { ChatFailureKind } from '$lib/chatCell';
import type { ChatEngineFailure } from './engine';
import type { CellOutput } from '$lib/server/types';

/** The heading + remedy for one failure kind (detail appended by the caller). */
function headline(failure: ChatEngineFailure): string {
	switch (failure.kind) {
		case 'not_installed':
			return (
				'**Claude Code is not installed.** Chat cells run through the `claude` CLI. ' +
				'Install it (see claude.com/claude-code) and make sure `claude` is on PATH, then re-run this cell.'
			);
		case 'not_signed_in':
			return (
				'**Not signed in.** No Claude account is available for chat. ' +
				'Sign in from the CHAT section of the sidebar (or pick an account there), then re-run this cell.'
			);
		case 'rate_limited': {
			const resets =
				typeof failure.resetsAt === 'number'
					? ` The window resets around ${new Date(failure.resetsAt * 1000).toLocaleString()}.`
					: '';
			return (
				`**Rate limited.** The Claude account's usage window is exhausted.${resets} ` +
				'Wait for it to reset, or switch to another account in the sidebar, then re-run.'
			);
		}
		case 'unsafe_init':
			return (
				'**Chat refused to run.** The Claude CLI session reported capabilities that do ' +
				'not match what this run allows (tools beyond its allowlist, MCP servers or ' +
				'slash commands - or no report at all), so the run was stopped and its reply ' +
				'discarded. This usually means a claude CLI update changed flag behavior; ' +
				'report it rather than working around it.'
			);
		case 'transcript_too_large':
			// The engine never ran, so the whole message is Cellar's own: the size and
			// the two levers that shrink it (see `transcript.ts`'s bound). The detail
			// line carries it, so the headline must not repeat the numbers.
			return '**Too much to send.**';
		case 'cancelled':
			return '*(interrupted)*';
		case 'api_error':
			return '**Chat failed.**';
	}
}

/** The full markdown for a failure (headline + the engine's detail, deduped). */
export function chatFailureMarkdown(failure: ChatEngineFailure): string {
	const head = headline(failure);
	const detail = failure.message?.trim();
	// The headline already says everything for the states whose message is only
	// our own classification echo; append detail where it genuinely adds (an API
	// error's cause, a rate limit's server wording).
	const wantsDetail =
		failure.kind === 'api_error' ||
		failure.kind === 'rate_limited' ||
		failure.kind === 'not_signed_in' ||
		failure.kind === 'transcript_too_large';
	if (wantsDetail && detail && !head.includes(detail)) {
		return `${head}\n\n> ${detail.replace(/\n/g, '\n> ')}`;
	}
	return head;
}

/** The failure as a persistable output (markdown display_data + plain fallback). */
export function chatFailureOutput(failure: ChatEngineFailure): CellOutput {
	const md = chatFailureMarkdown(failure);
	return {
		output_type: 'display_data',
		data: { 'text/markdown': md, 'text/plain': md },
		metadata: {}
	};
}

/** Convenience for failures Cellar decides itself (no engine run happened). */
export function chatFailure(kind: ChatFailureKind, message: string): ChatEngineFailure {
	return { kind, message };
}
