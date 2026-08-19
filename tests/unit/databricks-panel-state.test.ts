import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	databricksPanelState,
	expectedTransition,
	connectionMetaLine,
	holdsConnectedView,
	ownedTransitionFlags,
	panelOwnsBusy,
	panelOwnsTransition,
	type DbxPanelInputs
} from '../../src/lib/databricksPanelState';

/**
 * The Databricks sidebar's connection-area state machine - THE FLICKER RULE.
 *
 * The reported defect: "when i change dbx clusters there is a flickering of the
 * screen". Cause: the connecting state was rendered as a SIBLING BRANCH of the
 * connected view, so a cluster switch unmounted the Cluster card, the Upload card,
 * the Runtime card and the whole Unity Catalog browser down to one small
 * "Connecting…" card and sprang them all back a moment later - a 971px -> 144px ->
 * 709px collapse-and-restore of the sidebar, measured in a real browser.
 *
 * These are UNIT tests on purpose. Playwright e2e is deliberately absent from both CI
 * (`.github/workflows/ci.yml` -> `npm run test`) and the no-mistakes gate
 * (`.no-mistakes.yaml` `commands.test`), so an e2e-only assertion would let a
 * regression merge green - which is exactly why the rule was lifted out of
 * `Databricks.svelte` (vitest runs without the SvelteKit plugin, so that component
 * cannot be mounted here) into a pure module.
 */

/** The notebook the panel is showing, and a second one the user can tab to. */
const NB = 'analysis.ipynb';
const OTHER = 'scratch.ipynb';

/** Disconnected and idle: nothing in flight, no session. */
const IDLE: DbxPanelInputs = {
	notebookPath: NB,
	transitionPath: NB,
	busy: '',
	busyPath: NB,
	connected: false,
	restarting: false,
	serverRestarting: false,
	runtimeApplying: false,
	connectOverLive: false,
	expired: false,
	lost: false
};

const CONNECTED: DbxPanelInputs = { ...IDLE, connected: true };

describe('the connected view is HELD across a cluster switch', () => {
	/**
	 * The headline. A switch walks: connected -> click -> (server work, which may
	 * include a re-pin kernel restart that momentarily reports the session lost) ->
	 * connected on the new cluster. The view must read `connected` at EVERY step, so
	 * the Upload/Runtime/browser cards below it are never unmounted and remounted.
	 */
	it('never leaves the connected view at any step of a switch', () => {
		const timeline: { label: string; s: DbxPanelInputs }[] = [
			{ label: 'connected to A', s: CONNECTED },
			// The click: `connectOverLive` is latched from the still-true `connected`.
			{ label: 'connect issued', s: { ...CONNECTED, busy: 'connect', connectOverLive: true } },
			// A switch to an older-DBR cluster re-pins databricks-connect and restarts the
			// kernel; the status read that follows honestly reports the session gone. This
			// is the frame the latch exists for.
			{
				label: 're-pin restart mid-connect',
				s: {
					...IDLE,
					busy: 'connect',
					connectOverLive: true,
					connected: false,
					lost: true,
					serverRestarting: true
				}
			},
			{
				label: 'server grace window',
				s: { ...IDLE, busy: 'connect', connectOverLive: true, serverRestarting: true }
			},
			// The reply lands and the status is re-read before `busy` clears.
			{ label: 'status back, still busy', s: { ...CONNECTED, busy: 'connect', connectOverLive: true } },
			{ label: 'connected to B', s: CONNECTED }
		];
		for (const { label, s } of timeline) {
			expect(databricksPanelState(s).view, label).toBe('connected');
		}
	});

	it('shows the connecting face IN the card while the switch is in flight, and only then', () => {
		expect(databricksPanelState(CONNECTED).connecting).toBe(false);
		const inFlight = { ...CONNECTED, busy: 'connect', connectOverLive: true };
		expect(databricksPanelState(inFlight)).toEqual({ view: 'connected', connecting: true, restarting: false });
		// ...and it is gone the moment the connect settles.
		expect(databricksPanelState({ ...CONNECTED, busy: '', connectOverLive: false }).connecting).toBe(false);
	});

	/**
	 * The latch, not the live flag, is what holds the view. Keyed off `connected`
	 * alone, the re-pin-restart frame above collapses the panel - the original defect,
	 * reached by a different door.
	 */
	it('holds on the LATCH, so a mid-connect loss of `connected` cannot collapse the panel', () => {
		const lostMidConnect: DbxPanelInputs = {
			...IDLE,
			busy: 'connect',
			connected: false,
			lost: true,
			serverRestarting: true,
			connectOverLive: true
		};
		expect(holdsConnectedView(lostMidConnect)).toBe(true);
		expect(databricksPanelState(lostMidConnect).view).toBe('connected');
		// The same frame WITHOUT the latch is a first connect: nothing to hold.
		expect(databricksPanelState({ ...lostMidConnect, connectOverLive: false }).view).toBe('connecting');
	});
});

/**
 * The panel is ONE long-lived component whose `notebookPath` follows the active tab,
 * while every transition flag it owns is panel-wide. A connect can run to MINUTES, so
 * tabbing to another notebook mid-connect is an ordinary thing to do - and that
 * notebook must show ITS state, not the held connected view of the one being connected.
 */
describe('a transition speaks only for the notebook it was latched for', () => {
	/** The connect from the timeline above, still in flight, after the user tabs away. */
	const switchInFlight: DbxPanelInputs = {
		...CONNECTED,
		busy: 'connect',
		connectOverLive: true,
		busyPath: NB
	};

	it('does not hold a connected view over a notebook with no session of its own', () => {
		const moved: DbxPanelInputs = { ...switchInFlight, notebookPath: OTHER, connected: false };
		expect(panelOwnsBusy(moved)).toBe(false);
		expect(holdsConnectedView(moved)).toBe(false);
		expect(expectedTransition(moved)).toBe(false);
		expect(databricksPanelState(moved).view).toBe('picker');
	});

	it('does not suppress the other notebook`s real lost/expired card', () => {
		const lostElsewhere: DbxPanelInputs = {
			...switchInFlight,
			notebookPath: OTHER,
			connected: false,
			lost: true
		};
		expect(databricksPanelState(lostElsewhere).view).toBe('lost');
		expect(databricksPanelState({ ...lostElsewhere, lost: false, expired: true }).view).toBe('expired');
	});

	it('leaves a notebook that IS connected reading plainly connected, with no face', () => {
		const otherConnected: DbxPanelInputs = { ...switchInFlight, notebookPath: OTHER };
		expect(databricksPanelState(otherConnected)).toEqual({
			view: 'connected',
			connecting: false,
			restarting: false
		});
	});

	it('does not put another notebook`s card into the runtime-restart face', () => {
		const applyingHere: DbxPanelInputs = {
			...IDLE,
			runtimeApplying: true,
			restarting: true,
			lost: true,
			connected: false
		};
		expect(databricksPanelState(applyingHere)).toEqual({
			view: 'connected',
			connecting: false,
			restarting: true
		});
		// The panel moves to a notebook whose session really did end: its own card wins.
		const moved = { ...applyingHere, notebookPath: OTHER };
		expect(databricksPanelState(moved).view).toBe('lost');
	});

	it('still honours the SERVER grace window, which arrives on this notebook`s status', () => {
		// `connection.restarting` is read from the status of whichever notebook the panel
		// is showing, so it is already scoped and ownership must not silence it.
		const serverSide: DbxPanelInputs = {
			...IDLE,
			notebookPath: OTHER,
			transitionPath: NB,
			serverRestarting: true,
			lost: true
		};
		expect(panelOwnsTransition(serverSide)).toBe(false);
		expect(expectedTransition(serverSide)).toBe(true);
		expect(databricksPanelState(serverSide).view).toBe('connecting');
	});

	/**
	 * The `disabled` sibling of that rule. Scoping the VIEW alone left a second
	 * connected notebook's Cluster/Upload/Runtime controls greyed out with nothing
	 * saying why; they now ask the same ownership question the view does.
	 */
	it('hands the cards raw flags for the owner and silenced ones for everyone else', () => {
		const connecting: DbxPanelInputs = { ...CONNECTED, busy: 'connect', connectOverLive: true };
		expect(ownedTransitionFlags(connecting)).toEqual({ busy: 'connect', runtimeApplying: false });
		expect(ownedTransitionFlags({ ...connecting, notebookPath: OTHER })).toEqual({
			busy: '',
			runtimeApplying: false
		});

		const applying: DbxPanelInputs = { ...CONNECTED, runtimeApplying: true, restarting: true };
		expect(ownedTransitionFlags(applying)).toEqual({ busy: '', runtimeApplying: true });
		expect(ownedTransitionFlags({ ...applying, notebookPath: OTHER })).toEqual({
			busy: '',
			runtimeApplying: false
		});
	});

	/**
	 * Every verb holds `busy`, but only `connect` and `applyRuntime` start a VIEW
	 * transition - so `busy` is attributed through its OWN latch. Read through
	 * `transitionPath` instead, the five other verbs were credited to whichever
	 * notebook last started a transition, or to none at all.
	 */
	it('attributes EVERY verb to the notebook that issued it', () => {
		for (const busy of ['login', 'connect', 'disconnect', 'upload', 'logout', 'reconnect', 'install']) {
			// Issued here, and no view transition was ever started (a fresh reload).
			const owner: DbxPanelInputs = { ...CONNECTED, busy, busyPath: NB, transitionPath: undefined };
			expect(panelOwnsBusy(owner), busy).toBe(true);
			expect(ownedTransitionFlags(owner).busy, busy).toBe(busy);
			// Issued for another notebook: silenced here, whatever the view latch says.
			expect(ownedTransitionFlags({ ...owner, busyPath: OTHER }).busy, busy).toBe('');
			expect(ownedTransitionFlags({ ...owner, busyPath: OTHER, transitionPath: NB }).busy, busy).toBe('');
		}
	});

	/**
	 * The regression this latch exists for, as its own case: a reload leaves
	 * `transitionPath` undefined, so a replace in flight on the notebook ON SCREEN
	 * must still report busy - that is what keeps the upload confirm's Cancel inert
	 * while the overwrite is on the wire.
	 */
	it('reports a replace in flight after a reload, so its Cancel stays inert', () => {
		const replacing: DbxPanelInputs = {
			...CONNECTED,
			busy: 'upload',
			busyPath: NB,
			transitionPath: undefined
		};
		expect(ownedTransitionFlags(replacing).busy).toBe('upload');
		// ...and the view is untouched by it: an upload is not a transition.
		expect(databricksPanelState(replacing).view).toBe('connected');
		expect(databricksPanelState(replacing).connecting).toBe(false);
	});

	/**
	 * The two latches answer different questions, so they may not be shared. With ONE,
	 * a connect on B inherited a runtime restart still running on A: B's own connect
	 * wore the "restarting" badge, and A - having lost the latch - fell back to the
	 * standalone connecting card or a spurious "lost", i.e. the collapse this module
	 * exists to prevent, reached from both ends at once.
	 */
	it('a connect elsewhere cannot steal an in-flight runtime restart', () => {
		// A flipped the Runtime toggle: its restart is latched and still settling.
		const restartOnA = { restarting: true, runtimeApplying: true, transitionPath: NB };
		// ...and B, whose controls were live because it owns none of that, connects.
		const connectOnB: DbxPanelInputs = {
			...CONNECTED,
			...restartOnA,
			notebookPath: OTHER,
			busy: 'connect',
			busyPath: OTHER,
			connectOverLive: true
		};
		expect(databricksPanelState(connectOnB)).toEqual({
			view: 'connected',
			connecting: true,
			restarting: false
		});

		// Tabbing back to A mid-restart, with its session momentarily gone: A still owns
		// its restart, so its card is HELD rather than collapsing to connecting/lost.
		const backOnA: DbxPanelInputs = {
			...IDLE,
			...restartOnA,
			notebookPath: NB,
			busy: 'connect',
			busyPath: OTHER,
			connectOverLive: true,
			connected: false,
			lost: true
		};
		expect(databricksPanelState(backOnA)).toEqual({
			view: 'connected',
			connecting: false,
			restarting: true
		});
	});

	it('treats a panel that has issued nothing as owning nothing', () => {
		// Both latches start `undefined`; a real `notebookPath` is never equal to it.
		expect(panelOwnsTransition({ ...IDLE, transitionPath: undefined })).toBe(false);
		expect(panelOwnsBusy({ ...IDLE, busyPath: undefined })).toBe(false);
		// A pathless panel (no notebook open) that starts one latches `null`, and that
		// IS its own.
		expect(panelOwnsTransition({ ...IDLE, notebookPath: null, transitionPath: null })).toBe(true);
		expect(panelOwnsBusy({ ...IDLE, notebookPath: null, busyPath: null })).toBe(true);
		expect(panelOwnsTransition({ ...IDLE, notebookPath: null, transitionPath: undefined })).toBe(false);
		expect(panelOwnsBusy({ ...IDLE, notebookPath: null, busyPath: undefined })).toBe(false);
	});
});

/**
 * The Cluster card's muted `profile · host · spark` line. It shares the connecting
 * face's honesty rule (the DBR belongs to the session, so it yields) and must not
 * empty out in the one frame the whole task is about - a re-pin kernel restart
 * mid-switch reports the session lost, and that payload carries no `profile`/`host`.
 */
describe('the connection meta line', () => {
	const LIVE = {
		profile: 'DEFAULT',
		host: 'https://dbc-demo.cloud.databricks.com',
		sparkVersion: '15.4.x-scala2.12',
		lastProfile: 'DEFAULT',
		lastHost: 'https://dbc-demo.cloud.databricks.com'
	};

	it('shows the whole line at rest, scheme stripped', () => {
		expect(connectionMetaLine({ ...LIVE, connecting: false })).toBe(
			'DEFAULT · dbc-demo.cloud.databricks.com · 15.4.x-scala2.12'
		);
	});

	it('drops the outgoing session`s DBR while connecting', () => {
		expect(connectionMetaLine({ ...LIVE, connecting: true })).toBe(
			'DEFAULT · dbc-demo.cloud.databricks.com'
		);
	});

	it('never empties mid-switch when the payload drops the workspace half', () => {
		// The re-pin-restart frame: `connectionStatus()` reports the session lost, with
		// no top-level profile/host. Empty here unmounts the row and jumps the card.
		const midRestart = {
			profile: undefined,
			host: undefined,
			sparkVersion: undefined,
			lastProfile: LIVE.lastProfile,
			lastHost: LIVE.lastHost,
			connecting: true
		};
		expect(connectionMetaLine(midRestart)).toBe('DEFAULT · dbc-demo.cloud.databricks.com');
	});

	it('holds the row on the RESTART face too, which meets the same payload', () => {
		// A runtime toggle restarts the kernel, so the status read reports the session
		// lost with no top-level profile/host - the identical shape, on the sibling
		// face. Covering only `connecting` left the row unmounting for the whole
		// restart. A runtime restart does not change workspace, so the fallback is the
		// same profile and host the card was already showing.
		const midRuntimeRestart = {
			profile: undefined,
			host: undefined,
			sparkVersion: undefined,
			lastProfile: LIVE.lastProfile,
			lastHost: LIVE.lastHost,
			connecting: false,
			restarting: true
		};
		expect(connectionMetaLine(midRuntimeRestart)).toBe('DEFAULT · dbc-demo.cloud.databricks.com');
		// The cluster is unchanged by a restart, so its DBR is not the outgoing one's
		// and is kept whenever the payload still carries it.
		expect(connectionMetaLine({ ...LIVE, connecting: false, restarting: true })).toBe(
			'DEFAULT · dbc-demo.cloud.databricks.com · 15.4.x-scala2.12'
		);
	});

	it('does NOT resurrect a workspace half once the transition is over', () => {
		// Not connecting: nothing is being held, so the line reports only what is there.
		expect(
			connectionMetaLine({
				profile: undefined,
				host: undefined,
				sparkVersion: undefined,
				lastProfile: LIVE.lastProfile,
				lastHost: LIVE.lastHost,
				connecting: false
			})
		).toBe('');
	});
});

describe('a FIRST connect still gets the standalone connecting card', () => {
	it('progresses picker -> connecting -> connected', () => {
		expect(databricksPanelState(IDLE).view).toBe('picker');
		// No live session under it, so there is nothing to hold and the standalone card
		// is the honest progression rather than a collapse.
		expect(databricksPanelState({ ...IDLE, busy: 'connect' }).view).toBe('connecting');
		expect(databricksPanelState(CONNECTED).view).toBe('connected');
	});

	it('a first connect never claims a connected view it does not have', () => {
		const s = databricksPanelState({ ...IDLE, busy: 'connect' });
		expect(s).toEqual({ view: 'connecting', connecting: false, restarting: false });
	});
});

describe('real lost/expired state is still reported', () => {
	it('reports expired and lost when no expected transition explains them', () => {
		expect(databricksPanelState({ ...IDLE, expired: true, lost: true }).view).toBe('expired');
		expect(databricksPanelState({ ...IDLE, lost: true }).view).toBe('lost');
	});

	it('reports them the moment a failed connect releases the latch', () => {
		// `connect`'s `finally` clears `busy` + `connectOverLive` whatever happened, so a
		// connect that FAILS over a session that really did die falls straight through.
		const afterFailure: DbxPanelInputs = { ...IDLE, lost: true };
		expect(databricksPanelState(afterFailure).view).toBe('lost');
	});

	it('does NOT report them mid-restart - that is the lost-flash the transition suppresses', () => {
		const restarting: DbxPanelInputs = { ...IDLE, serverRestarting: true, lost: true };
		expect(databricksPanelState(restarting).view).toBe('connecting');
	});
});

describe('the runtime toggle keeps its own face', () => {
	it('holds the connected view and reads "restarting", never "connecting"', () => {
		const applying: DbxPanelInputs = { ...IDLE, runtimeApplying: true, restarting: true, lost: true };
		expect(databricksPanelState(applying)).toEqual({ view: 'connected', connecting: false, restarting: true });
	});

	it('a runtime apply is not an `expectedTransition`', () => {
		expect(expectedTransition({ ...IDLE, restarting: true, runtimeApplying: true })).toBe(false);
		expect(expectedTransition({ ...IDLE, restarting: true })).toBe(true);
		expect(expectedTransition({ ...IDLE, serverRestarting: true })).toBe(true);
		expect(expectedTransition({ ...IDLE, busy: 'connect' })).toBe(true);
		// Any other verb is not a connect.
		expect(expectedTransition({ ...IDLE, busy: 'disconnect' })).toBe(false);
		expect(expectedTransition({ ...IDLE, busy: 'upload' })).toBe(false);
	});
});

describe('exactly one view, and only the connected one carries a face', () => {
	it('over every combination of inputs', () => {
		const bools = [false, true];
		for (const notebookPath of [NB, OTHER])
			for (const busyPath of [NB, OTHER])
				for (const busy of ['', 'connect', 'disconnect'])
					for (const connected of bools)
						for (const restarting of bools)
							for (const serverRestarting of bools)
								for (const runtimeApplying of bools)
									for (const connectOverLive of bools)
										for (const expired of bools)
											for (const lost of bools) {
												const i: DbxPanelInputs = {
													notebookPath,
													transitionPath: NB,
													busy,
													busyPath,
													connected,
													restarting,
													serverRestarting,
													runtimeApplying,
													connectOverLive,
													expired,
													lost
												};
												const s = databricksPanelState(i);
												const label = JSON.stringify(i);
												expect(['connecting', 'connected', 'expired', 'lost', 'picker'], label).toContain(s.view);
												// A face is a state OF the Cluster card, so it can only ever ride the
												// connected view - a standalone/expired/lost card has no face to wear.
												if (s.view !== 'connected') {
													expect(s.connecting, label).toBe(false);
													expect(s.restarting, label).toBe(false);
												}
												// The two faces are mutually exclusive: the header renders one badge slot.
												expect(s.connecting && s.restarting, label).toBe(false);
												// A held view is never claimed without something to hold it.
												if (s.view === 'connected') expect(holdsConnectedView(i), label).toBe(true);
												// The RESTART half answers to `transitionPath`: a runtime apply latched
												// elsewhere may never put THIS card into the restarting face.
												if (!panelOwnsTransition(i)) expect(s.restarting, label).toBe(false);
												// The CONNECT half answers to `busyPath`. With neither latch ours the
												// panel contributes nothing of its own, and the only thing that may
												// still move it is the server's own per-notebook grace window.
												if (!panelOwnsTransition(i) && !panelOwnsBusy(i)) {
													expect(holdsConnectedView(i), label).toBe(connected);
													if (!serverRestarting) {
														expect(expectedTransition(i), label).toBe(false);
														expect(s.connecting, label).toBe(false);
													}
												}
											}
	});
});

// ---- The template really asks the rule -------------------------------------
//
// The rule above is only load-bearing if the component actually asks it: re-inlining
// the branch conditions into the template would restore the defect with every test
// above still green. vitest cannot mount `Databricks.svelte`, so these read the
// source - the same mechanism `databricks-upload-card.test.ts` and
// `git-notebooks-panel.test.ts` already use for component rules of this shape.
//
// The branch-shape guards below parse the template's `{#if}` nesting rather than
// grepping for a pre-fix string, so a standalone connecting branch re-added in ANY
// spelling fails them - as an arm of the chain (its condition is not a `panel.view`
// test) or as a sibling of it (the standalone card is no longer inside the chain).

const SRC = readFileSync(new URL('../../src/lib/Databricks.svelte', import.meta.url), 'utf8');

/** An arm of an `{#if}` chain: its condition (`null` for a bare `{:else}`) + its body. */
interface TemplateArm {
	cond: string | null;
	start: number;
	end: number;
}
interface TemplateChain {
	arms: TemplateArm[];
	start: number;
}

/** Blank a region to spaces, keeping its length (and its newlines) so offsets hold. */
const blank = (m: string) => m.replace(/[^\n]/g, ' ');

/**
 * The template's `{#if}` chains as a nesting model. Everything that is NOT markup is
 * blanked first, length-preservingly so offsets still line up: HTML comments AND the
 * whole `<script>` block, both of which carry prose mentioning block tags like
 * `{#each}` or `{#if panel.view === '…'}`. Without the second one, documenting the
 * branch structure in a JSDoc comment would fail this file with an "unclosed {#if}"
 * that points nowhere near the edit.
 */
function parseIfChains(src: string): { code: string; chains: TemplateChain[] } {
	const code = src
		.replace(/<script[\s\S]*?<\/script>/g, blank)
		.replace(/<!--[\s\S]*?-->/g, blank);
	const re = /\{#if\s([^}]*)\}|\{:else if\s([^}]*)\}|\{:else\}|\{\/if\}/g;
	const open: { start: number; arms: { cond: string | null; tagStart: number; bodyStart: number }[] }[] = [];
	const chains: TemplateChain[] = [];
	for (let m: RegExpExecArray | null; (m = re.exec(code)); ) {
		const tag = m[0];
		if (tag.startsWith('{#if')) {
			open.push({ start: m.index, arms: [{ cond: m[1].trim(), tagStart: m.index, bodyStart: re.lastIndex }] });
		} else if (tag === '{/if}') {
			const chain = open.pop();
			if (!chain) throw new Error(`unbalanced {/if} at offset ${m.index}`);
			const close = m.index;
			chains.push({
				start: chain.start,
				arms: chain.arms.map((a, k) => ({
					cond: a.cond,
					start: a.bodyStart,
					end: k + 1 < chain.arms.length ? chain.arms[k + 1].tagStart : close
				}))
			});
		} else {
			const chain = open[open.length - 1];
			if (!chain) throw new Error(`stray ${tag} at offset ${m.index}`);
			const cond = tag.startsWith('{:else if') ? m[2].trim() : null;
			chain.arms.push({ cond, tagStart: m.index, bodyStart: re.lastIndex });
		}
	}
	if (open.length) throw new Error(`${open.length} unclosed {#if}`);
	return { code, chains };
}

/** The chain arm that DIRECTLY renders `marker` (innermost wins). */
function armRendering(parsed: ReturnType<typeof parseIfChains>, marker: string) {
	const at = parsed.code.indexOf(marker);
	expect(at, marker).toBeGreaterThan(-1);
	let best: { chain: TemplateChain; arm: TemplateArm } | null = null;
	for (const chain of parsed.chains)
		for (const arm of chain.arms)
			if (arm.start <= at && at < arm.end && (!best || arm.start > best.arm.start)) best = { chain, arm };
	if (!best) throw new Error(`${marker} is not inside any {#if}`);
	return best;
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('source guards: the panel really asks the shared rule', () => {
	it('imports and derives the panel state from the one module', () => {
		expect(SRC).toMatch(/import \{[^}]*\bdatabricksPanelState\b[^}]*\} from '\$lib\/databricksPanelState'/);
		expect(SRC).toMatch(/const panel = \$derived\(\s*databricksPanelState\(/);
		// The `disabled` sibling of the same rule - see `ownedTransitionFlags`.
		expect(SRC).toMatch(/import \{[^}]*\bownedTransitionFlags\b[^}]*\} from '\$lib\/databricksPanelState'/);
		expect(SRC).toMatch(/\$derived\(ownedTransitionFlags\(/);
	});

	it('every connection branch is decided by it, not by a re-inlined condition', () => {
		for (const view of ['connecting', 'connected', 'expired', 'lost']) {
			expect(SRC, view).toContain(`panel.view === '${view}'`);
		}
	});

	/**
	 * The shape the collapse came from: the standalone connecting card as a SIBLING of
	 * the connected view. Asserted structurally - the connection area is ONE chain whose
	 * every arm is a `panel.view` test - so any re-added branch fails, whatever it says.
	 */
	it('the connection area is one chain, every arm of it decided by panel.view', () => {
		const parsed = parseIfChains(SRC);
		const { chain } = armRendering(parsed, 'data-testid="databricks-connected"');
		expect(chain.arms.map((a) => a.cond)).toEqual([
			"panel.view === 'connecting'",
			"panel.view === 'connected'",
			"panel.view === 'expired'",
			"panel.view === 'lost'",
			// The disconnected fallback; the only arm that needs no condition.
			null
		]);
	});

	it('the standalone connecting card exists only as that chain`s connecting arm', () => {
		const marker = 'data-testid="databricks-connecting"';
		const parsed = parseIfChains(SRC);
		expect(count(parsed.code, marker)).toBe(1);
		const standalone = armRendering(parsed, marker);
		const connected = armRendering(parsed, 'data-testid="databricks-connected"');
		expect(standalone.chain.start).toBe(connected.chain.start);
		expect(standalone.arm.cond).toBe("panel.view === 'connecting'");
	});

	it('the Cluster card keeps its siblings mounted in the connected branch', () => {
		// The cards the collapse used to take with it. They must live under the
		// connected view, which the switch now holds.
		const parsed = parseIfChains(SRC);
		const { arm } = armRendering(parsed, 'data-testid="databricks-connected"');
		const branch = parsed.code.slice(arm.start, arm.end);
		for (const card of ['uploadCard()', 'runtimeCard()', 'dataBrowser()']) {
			expect(branch, card).toContain(card);
		}
	});

	it('latches `connectOverLive` from `connected` BEFORE the request, and always clears it', () => {
		// Read off `connected` per frame instead, the re-pin-restart frame collapses the
		// panel - which is what the latch (and its timeline test above) exists for.
		const body = SRC.slice(SRC.indexOf('async function connect('), SRC.indexOf('async function disconnect('));
		const latch = body.indexOf('connectOverLive = connected');
		const fetched = body.indexOf('await fetch(');
		expect(latch).toBeGreaterThan(-1);
		expect(fetched).toBeGreaterThan(latch);
		expect(body).toMatch(/finally \{[\s\S]*connectOverLive = false/);
	});

	it('latches WHOSE work it is before the first await, one latch per question', () => {
		// Without the latch, work that can run to minutes speaks for whichever notebook
		// the user tabs to next. `busy` is latched at its ONE assignment site so all
		// seven verbs are covered; the restart keeps its own, so the two cannot collide.
		for (const [fn, latch] of [
			['function beginBusy(', 'busyPath = notebookPath'],
			['async function applyRuntime(', 'transitionPath = target']
		]) {
			const at = SRC.indexOf(fn);
			expect(at, fn).toBeGreaterThan(-1);
			const body = SRC.slice(at, SRC.indexOf('\n\t}', at));
			const set = body.indexOf(latch);
			expect(set, fn).toBeGreaterThan(-1);
			const awaited = body.indexOf('await ');
			if (awaited > -1) expect(awaited, fn).toBeGreaterThan(set);
		}
	});

	/**
	 * `applyRuntime` awaits one `setUiNow` PUT (two for a version edit) between its latch
	 * and the restart it issues, and `notebookPath` follows the ACTIVE TAB - so any read
	 * of the live prop after the capture answers for whichever notebook the user tabbed
	 * to, restarting that one's kernel while attributing the transition to the one they
	 * left. The `uploadToWorkspace` idiom is to capture once and never look again, so
	 * that is what is pinned: past the capture the function names only `target`.
	 */
	it('reads the notebook it captured, never the live prop, after its first await', () => {
		const at = SRC.indexOf('async function applyRuntime(');
		expect(at).toBeGreaterThan(-1);
		const body = SRC.slice(at, SRC.indexOf('\n\t}', at));
		const capture = body.indexOf('const target = notebookPath');
		expect(capture).toBeGreaterThan(-1);
		expect(body.indexOf('await ')).toBeGreaterThan(capture);
		// Comments explain the rule by naming the prop, so only CODE lines are read.
		const after = body
			.slice(capture + 'const target = notebookPath'.length)
			.split('\n')
			.filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
			.join('\n');
		expect(after).not.toContain('notebookPath');
		expect(after).toContain('onRestartKernel(target)');
	});

	/**
	 * Each latch has exactly ONE writer, which is what makes them independent: shared,
	 * a connect on one notebook inherited a runtime restart still settling on another.
	 */
	it('gives each latch a single writer', () => {
		const writers = (name: string) =>
			SRC.split('\n').filter((l) => new RegExp(`(?<!let )\\b${name} = [^=]`).test(l)).length;
		expect(writers('transitionPath')).toBe(1);
		expect(writers('busyPath')).toBe(1);
	});
});

/**
 * The SECOND contributor to the same flicker: the Unity Catalog tree was keyed on the
 * cluster, so a switch tore it down (`loadCatalogs` drops `nodes`/`openNodes`), flashed
 * "loading catalogs…" and rebuilt an identical list - while also silently discarding
 * every catalog the user had expanded. The listing does not depend on the cluster at
 * all: `connectionParams()` sends `profile`/`host` and nothing else.
 */
describe('source guard: the catalog tree is keyed on the workspace, not the cluster', () => {
	it('the catalogs effect key carries no clusterId', () => {
		const at = SRC.indexOf('const key = connected ?');
		expect(at).toBeGreaterThan(-1);
		const line = SRC.slice(at, SRC.indexOf('\n', at));
		expect(line).not.toContain('clusterId');
		expect(line).toContain('connection.profile');
		expect(line).toContain('connection.host');
	});

	it('the listing really is workspace-scoped, so the key is right', () => {
		const params = SRC.slice(SRC.indexOf('function connectionParams()'));
		const body = params.slice(0, params.indexOf('\n\t}'));
		expect(body).not.toContain('clusterId');
	});
});
