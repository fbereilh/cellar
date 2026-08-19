import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	databricksPanelState,
	expectedTransition,
	holdsConnectedView,
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

/** Disconnected and idle: nothing in flight, no session. */
const IDLE: DbxPanelInputs = {
	busy: '',
	connected: false,
	expectedRestart: false,
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
				s: { ...IDLE, busy: 'connect', connectOverLive: true, connected: false, lost: true, expectedRestart: true }
			},
			{ label: 'server grace window', s: { ...IDLE, busy: 'connect', connectOverLive: true, expectedRestart: true } },
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
			expectedRestart: true,
			connectOverLive: true
		};
		expect(holdsConnectedView(lostMidConnect)).toBe(true);
		expect(databricksPanelState(lostMidConnect).view).toBe('connected');
		// The same frame WITHOUT the latch is a first connect: nothing to hold.
		expect(databricksPanelState({ ...lostMidConnect, connectOverLive: false }).view).toBe('connecting');
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
		const restarting: DbxPanelInputs = { ...IDLE, expectedRestart: true, lost: true };
		expect(databricksPanelState(restarting).view).toBe('connecting');
	});
});

describe('the runtime toggle keeps its own face', () => {
	it('holds the connected view and reads "restarting", never "connecting"', () => {
		const applying: DbxPanelInputs = { ...IDLE, runtimeApplying: true, expectedRestart: true, lost: true };
		expect(databricksPanelState(applying)).toEqual({ view: 'connected', connecting: false, restarting: true });
	});

	it('a runtime apply is not an `expectedTransition`', () => {
		expect(expectedTransition({ ...IDLE, expectedRestart: true, runtimeApplying: true })).toBe(false);
		expect(expectedTransition({ ...IDLE, expectedRestart: true })).toBe(true);
		expect(expectedTransition({ ...IDLE, busy: 'connect' })).toBe(true);
		// Any other verb is not a connect.
		expect(expectedTransition({ ...IDLE, busy: 'disconnect' })).toBe(false);
		expect(expectedTransition({ ...IDLE, busy: 'upload' })).toBe(false);
	});
});

describe('exactly one view, and only the connected one carries a face', () => {
	it('over every combination of inputs', () => {
		const bools = [false, true];
		for (const busy of ['', 'connect', 'disconnect'])
			for (const connected of bools)
				for (const expectedRestart of bools)
					for (const runtimeApplying of bools)
						for (const connectOverLive of bools)
							for (const expired of bools)
								for (const lost of bools) {
									const i: DbxPanelInputs = {
										busy,
										connected,
										expectedRestart,
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
								}
	});
});

/**
 * SOURCE GUARDS. The rule above is only load-bearing if the component actually asks
 * it - re-inlining the branch conditions into the template would restore the defect
 * with every test here still green. vitest cannot mount `Databricks.svelte`, so these
 * read the source, which is the same mechanism `databricks-upload-card.test.ts` and
 * `git-notebooks-panel.test.ts` already use for component rules of this shape.
 */
describe('source guards: the panel really asks the shared rule', () => {
	const src = readFileSync(new URL('../../src/lib/Databricks.svelte', import.meta.url), 'utf8');

	it('imports and derives the panel state from the one module', () => {
		expect(src).toMatch(/import \{ databricksPanelState \} from '\$lib\/databricksPanelState'/);
		expect(src).toMatch(/const panel = \$derived\(\s*databricksPanelState\(/);
	});

	it('every connection branch is decided by it, not by a re-inlined condition', () => {
		for (const view of ['connecting', 'connected', 'expired', 'lost']) {
			expect(src, view).toContain(`panel.view === '${view}'`);
		}
		// The pre-fix condition, in the shape that caused the collapse: a standalone
		// connecting card rendered as a sibling of the connected view.
		expect(src).not.toContain("{#if busy === 'connect' || (expectedRestart");
		expect(src).not.toContain('{:else if connected || runtimeApplying}');
	});

	it('the Cluster card keeps its siblings mounted in the connected branch', () => {
		// The cards the collapse used to take with it. They must live under the
		// connected view, which the switch now holds.
		const at = src.indexOf("{:else if panel.view === 'connected'}");
		const end = src.indexOf("{:else if panel.view === 'expired'}");
		expect(at).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(at);
		const branch = src.slice(at, end);
		for (const card of ['uploadCard()', 'runtimeCard()', 'dataBrowser()']) {
			expect(branch, card).toContain(card);
		}
	});

	it('latches `connectOverLive` from `connected` BEFORE the request, and always clears it', () => {
		// Read off `connected` per frame instead, the re-pin-restart frame collapses the
		// panel - which is what the latch (and its timeline test above) exists for.
		const body = src.slice(src.indexOf('async function connect('), src.indexOf('async function disconnect('));
		const latch = body.indexOf('connectOverLive = connected');
		const fetched = body.indexOf('await fetch(');
		expect(latch).toBeGreaterThan(-1);
		expect(fetched).toBeGreaterThan(latch);
		expect(body).toMatch(/finally \{[\s\S]*connectOverLive = false/);
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
	const src = readFileSync(new URL('../../src/lib/Databricks.svelte', import.meta.url), 'utf8');

	it('the catalogs effect key carries no clusterId', () => {
		const at = src.indexOf('const key = connected ?');
		expect(at).toBeGreaterThan(-1);
		const line = src.slice(at, src.indexOf('\n', at));
		expect(line).not.toContain('clusterId');
		expect(line).toContain('connection.profile');
		expect(line).toContain('connection.host');
	});

	it('the listing really is workspace-scoped, so the key is right', () => {
		const params = src.slice(src.indexOf('function connectionParams()'));
		const body = params.slice(0, params.indexOf('\n\t}'));
		expect(body).not.toContain('clusterId');
	});
});
