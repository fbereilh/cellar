/**
 * The shell's transient status line, as one channel every caller shares.
 *
 * Two kinds of message ride it and they need OPPOSITE dismissal rules, which is
 * why the choice is per-call rather than a single global timeout:
 *
 *  - a RESULT (an export finished, a document invariant refused a delete) states
 *    what already happened, so it auto-dismisses - a refusal the user will retry
 *    must not need dismissing before the retry can be seen.
 *  - PROGRESS ("Converting: running all cells…") is posted BEFORE an operation
 *    that can take minutes, so a timeout would take the only indication anything
 *    is in flight off screen while the work is still running. It is `sticky` and
 *    stays up until the completion/failure message REPLACES it.
 *
 * `seq` is what makes a REPEAT visible: re-assigning an identical string is a
 * reactive no-op, so the markup keys off the nonce and re-mounts even for the
 * same text. Without it a second refused Mod+A + `dd` changes nothing on screen.
 */

/** How long a result message stays up. Long enough to read a sentence. */
export const NOTICE_TIMEOUT_MS = 6000;

export type NoticeOptions = {
	/** Keep this message up until something REPLACES it (use for progress). */
	sticky?: boolean;
};

export function createNoticeChannel(timeoutMs = NOTICE_TIMEOUT_MS) {
	let message = $state('');
	let seq = $state(0);
	let sticky = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Take it down - always cancels a pending auto-dismiss. */
	function dismiss() {
		clearTimeout(timer);
		timer = undefined;
		message = '';
		sticky = false;
	}

	/** The one way anything reaches the status line. */
	function show(text: string, opts?: NoticeOptions) {
		// A replacement supersedes whatever was up, sticky included - so the
		// completion message of a long operation ends its progress message and
		// starts its own countdown.
		clearTimeout(timer);
		timer = undefined;
		message = text;
		sticky = opts?.sticky === true;
		seq += 1;
		if (!sticky) timer = setTimeout(dismiss, timeoutMs);
	}

	return {
		get message() {
			return message;
		},
		get seq() {
			return seq;
		},
		get sticky() {
			return sticky;
		},
		show,
		dismiss
	};
}
