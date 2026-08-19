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
	 * The notebook the panel's OWN in-flight transition was latched for, at the click
	 * that started it (`undefined` before the panel has ever started one). The panel's
	 * transition flags are panel-wide but its subject is not: a connect issued for one
	 * notebook says nothing about the next one the user tabs to.
	 */
	transitionPath: string | null | undefined;
	/** The panel's in-flight verb (`''` when idle) - only `'connect'` matters here. */
	busy: string;
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
 * Is the panel's own in-flight transition about the notebook it is currently showing?
 * A transition latched for another notebook may not speak for this one - neither to
 * hold its view nor to suppress its lost/expired card.
 */
export function panelOwnsTransition(i: DbxPanelInputs): boolean {
	return i.transitionPath === i.notebookPath;
}

/** The panel-wide flags, silenced when they belong to another notebook. */
function ownFlags(i: DbxPanelInputs) {
	const owned = panelOwnsTransition(i);
	return {
		connect: owned && i.busy === 'connect',
		// The server half is already per-notebook, so it survives a panel that moved on.
		expectedRestart: (owned && i.restarting) || i.serverRestarting,
		runtimeApplying: owned && i.runtimeApplying,
		connectOverLive: owned && i.connectOverLive
	};
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
