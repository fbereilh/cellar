/**
 * WHICH CARD the Databricks sidebar's connection area renders, and WHICH FACE the
 * Cluster card wears - the one rule, in one place.
 *
 * It lives here rather than as an expression inside `Databricks.svelte` for the same
 * reason `defaultProfileNoticeApplies` does: the only suite CI (`npm test`) and the
 * no-mistakes gate run is the vitest unit one - Playwright e2e is deliberately absent
 * from both - and `Databricks.svelte` cannot be mounted there (vitest runs without the
 * SvelteKit plugin). A rule kept in the template can therefore be rewritten and merge
 * green, taking the defect below back in with it.
 *
 * THE FLICKER RULE (the whole reason this module exists). A connecting state is a
 * state OF THE CLUSTER CARD, never a replacement for the panel. Rendered as a sibling
 * branch, a cluster SWITCH unmounted the Cluster card, the Upload card, the Runtime
 * card and the whole Unity Catalog browser down to one small "Connecting…" card and
 * sprang them all back a moment later - measured at a 971px -> 144px -> 709px
 * collapse-and-restore of the sidebar, which on a warm cluster is a single hard blink
 * and on a cold one is a panel that empties out for minutes. `runtimeApplying` already
 * had the right treatment (keep the cards, say it in the card); the connect path never
 * got it. So a transition with a live session under it HOLDS the connected view, and
 * only a transition with nothing to hold - a FIRST connect from the picker, or an
 * expected restart whose session is already gone - gets the standalone card, where it
 * is an honest progression (picker -> connecting -> connected) rather than a collapse.
 *
 * What it does NOT do is hide real state. `expired` and `lost` are still reported
 * whenever no expected transition explains them; the connected view is held only for a
 * transition this panel or the server actually told us to expect.
 *
 * OWNERSHIP is the other half of that honesty, and it belongs to this rule rather than
 * to the caller. The panel is ONE long-lived component whose `notebookPath` follows the
 * active tab, while its transition flags (`busy`, `restarting`, `runtimeApplying`,
 * `connectOverLive`) are panel-wide - so switching notebooks during a connect that can
 * run to MINUTES left the whole connected view held over a notebook with no session at
 * all. A transition therefore carries the notebook it was latched for, exactly as
 * `uploadToWorkspace` latches its target path, and a panel showing a different notebook
 * reads it as not its own and falls through to that notebook's honest state.
 */

/** Which card the connection area renders. */
export type DbxPanelView = 'connecting' | 'connected' | 'expired' | 'lost' | 'picker';

export interface DbxPanelInputs {
	/** The notebook the panel is showing right now (its `notebookPath` prop). */
	notebookPath: string | null;
	/**
	 * The notebook the panel's own expected kernel RESTART was latched for (`undefined`
	 * before it has ever issued one). A restart outlives the request that asked for it,
	 * so it needs a latch of its own; `busyPath` answers for everything that does not.
	 */
	transitionPath: string | null | undefined;
	/** The panel's in-flight verb (`''` when idle) - only `'connect'` matters here. */
	busy: string;
	/**
	 * The notebook the in-flight REQUEST was issued for, latched where `busy` is
	 * assigned (`undefined` while idle). Kept apart from `transitionPath` on purpose:
	 * only `connect` and `applyRuntime` start a VIEW transition, while all seven verbs
	 * hold `busy`, so attributing `busy` through `transitionPath` mis-credits the other
	 * five to whichever notebook last started a transition - or, on a fresh reload, to
	 * none at all, which silently unlocks the controls a request is holding.
	 */
	busyPath: string | null | undefined;
	/** The server reports a live session. */
	connected: boolean;
	/**
	 * The PANEL issued an expected kernel restart (a runtime apply) and it has not
	 * settled yet. Panel-wide, hence subject to ownership.
	 */
	restarting: boolean;
	/**
	 * The SERVER's own grace window around the epoch change, for THIS notebook - which
	 * is what covers a restart the panel did NOT initiate (the Kernels sidebar,
	 * `%restart_python`). It arrives on this notebook's status, so it is already
	 * notebook-scoped and ownership does not apply to it.
	 */
	serverRestarting: boolean;
	/** A runtime toggle/version apply is restarting the kernel. */
	runtimeApplying: boolean;
	/**
	 * A connect was issued over a session that was ALREADY live - i.e. a cluster
	 * SWITCH. Latched by the caller at the click, NOT re-read from `connected` each
	 * frame: a switch to an older-DBR cluster makes `ensurePinnedConnect` restart the
	 * kernel mid-connect, and the status read that follows honestly reports the session
	 * lost. That frame is exactly the one that must not unmount the panel.
	 */
	connectOverLive: boolean;
	/** The server reports the session expired. */
	expired: boolean;
	/** The server reports the session lost (a kernel restart ended it). */
	lost: boolean;
}

export interface DbxPanelState {
	view: DbxPanelView;
	/**
	 * Within the `connected` view: the Cluster card wears its CONNECTING face - the
	 * badge slot reads "connecting", the identity row names the cluster being connected
	 * TO, and the `spark`/`w`-are-ready line yields to the wait's own sentence. Never
	 * set for a runtime toggle, which has its own "restarting" face.
	 */
	connecting: boolean;
	/** Within the `connected` view: the Cluster card wears its runtime-restart face. */
	restarting: boolean;
}

/**
 * Is the RESTART the panel issued about the notebook it is currently showing? Written
 * only by `applyRuntime`, which cannot run while `busy` is set - so a connect can never
 * take this latch over from a kernel restart still in flight on another notebook, and
 * a restart can never take it from a connect.
 */
export function panelOwnsTransition(i: DbxPanelInputs): boolean {
	return i.transitionPath === i.notebookPath;
}

/**
 * Is the panel's in-flight REQUEST about the notebook on screen? Asked of `busyPath`,
 * which is latched where `busy` is ASSIGNED, so it covers all seven verbs rather than
 * the one that also starts a restart.
 */
export function panelOwnsBusy(i: DbxPanelInputs): boolean {
	return i.busyPath === i.notebookPath;
}

/**
 * The panel-wide flags, silenced when they belong to another notebook - each asking the
 * latch that really answers for it. The connect half lives exactly as long as
 * `busy === 'connect'`, so `busyPath` is its natural owner; the restart half outlives
 * every request, so it keeps `transitionPath`. Sharing ONE latch let a connect on B
 * inherit a runtime restart still running on A - B's own connect then wore the
 * "restarting" badge over the OLD cluster's name, and A, having lost the latch, fell
 * back to the standalone connecting card or a spurious "lost": the very collapse this
 * module exists to prevent, reached from both ends at once.
 */
function ownFlags(i: DbxPanelInputs) {
	const ownsBusy = panelOwnsBusy(i);
	const ownsRestart = panelOwnsTransition(i);
	return {
		connect: ownsBusy && i.busy === 'connect',
		// The server half is already per-notebook, so it survives a panel that moved on.
		expectedRestart: (ownsRestart && i.restarting) || i.serverRestarting,
		runtimeApplying: ownsRestart && i.runtimeApplying,
		connectOverLive: ownsBusy && i.connectOverLive
	};
}

/**
 * The two panel-wide flags as the CARDS' CONTROLS may read them - the `disabled`
 * sibling of the view rule, asking the same ownership question so the two cannot
 * disagree about whose work it is.
 *
 * Scoping only the view left a second connected notebook rendering a plain connected
 * card whose every control was greyed out with nothing saying why. A click there is
 * safe - `connect`/`disconnect`/`uploadToWorkspace`/`applyRuntime` each re-guard on
 * `busy`/`runtimeApplying`, so at worst the handler no-ops - and a live control whose
 * handler declines is honest in a way a mute grey one is not. For the notebook that
 * OWNS the work these are the raw flags, byte for byte - which is what keeps the
 * upload confirm's Cancel inert for the whole of its own replace, the invariant that
 * stops a clobber already on the wire from being presented as an aborted one.
 */
export function ownedTransitionFlags(i: DbxPanelInputs): { busy: string; runtimeApplying: boolean } {
	return {
		busy: panelOwnsBusy(i) ? i.busy : '',
		runtimeApplying: panelOwnsTransition(i) && i.runtimeApplying
	};
}

/**
 * The muted `profile · host · spark` line under the Cluster card's identity row.
 *
 * The DBR is dropped while the card wears its connecting face: it is a property of the
 * SESSION, so during a switch it is the OUTGOING cluster's runtime sitting under a row
 * that already reads "Connecting to <new cluster>…" - the stale claim the
 * `spark`/`w`-are-ready line was swapped out to avoid.
 *
 * The workspace half falls back to the last connection that was really live, because
 * the payload legitimately drops it: a kernel restart under EITHER face - the re-pin
 * one mid-switch, or the one a runtime toggle issues - reports the session lost, and
 * that shape carries no top-level `profile`/`host`. Read straight from it the line
 * came out EMPTY, its `{#if}` unmounted and the card lost a row for the whole restart
 * - the layout jump this task exists to remove. So the fallback is gated on the card
 * HOLDING a transition at all, not on the connecting face alone: both faces meet the
 * identical payload, and covering one would leave the jump on its sibling. It is not
 * a stale claim either way: a switch stays inside one workspace
 * (`connectionParams()` sends no cluster at all) and a runtime restart does not change
 * workspace, so it is the same profile and host the card was already showing.
 */
export function connectionMetaLine(i: {
	profile?: string | null;
	host?: string | null;
	sparkVersion?: string | null;
	lastProfile?: string | null;
	lastHost?: string | null;
	connecting: boolean;
	restarting?: boolean;
}): string {
	// The DBR stays scoped to the CONNECTING face: only a switch changes cluster, so
	// only there is the session's runtime the outgoing one's.
	const holding = i.connecting || !!i.restarting;
	const profile = i.profile ?? (holding ? i.lastProfile : null);
	const host = i.host ?? (holding ? i.lastHost : null);
	return [
		profile,
		host ? host.replace(/^https?:\/\//, '') : null,
		i.connecting ? null : i.sparkVersion
	]
		.filter(Boolean)
		.join(' · ');
}

/**
 * An expected transition is in flight - a connect/switch, or a kernel restart the panel
 * or the server told us to expect. A runtime toggle is deliberately excluded: it keeps
 * the connected card with its own "restarting" pill.
 */
export function expectedTransition(i: DbxPanelInputs): boolean {
	const f = ownFlags(i);
	return f.connect || (f.expectedRestart && !f.runtimeApplying);
}

/**
 * Is there a connected view worth HOLDING under that transition? `connectOverLive` is
 * what makes this true for the whole of a switch, including the frames where a re-pin
 * kernel restart has momentarily taken `connected` away.
 */
export function holdsConnectedView(i: DbxPanelInputs): boolean {
	const f = ownFlags(i);
	return i.connected || f.runtimeApplying || f.connectOverLive;
}

/** The one decision the template renders. */
export function databricksPanelState(i: DbxPanelInputs): DbxPanelState {
	const f = ownFlags(i);
	const transition = expectedTransition(i);
	const hold = holdsConnectedView(i);
	// Nothing to hold: the standalone card IS the progression, not a collapse.
	if (transition && !hold) return { view: 'connecting', connecting: false, restarting: false };
	if (hold)
		return {
			view: 'connected',
			connecting: transition && !f.runtimeApplying,
			restarting: f.runtimeApplying
		};
	// No expected transition explains these, so they are the honest state.
	if (i.expired) return { view: 'expired', connecting: false, restarting: false };
	if (i.lost) return { view: 'lost', connecting: false, restarting: false };
	return { view: 'picker', connecting: false, restarting: false };
}
