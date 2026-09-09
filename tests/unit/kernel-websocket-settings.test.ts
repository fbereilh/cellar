/**
 * The kernel socket must be constructible on every Node `engines` declares.
 *
 * `package.json` says `node: >=18`, and until this test existed cellar could not
 * execute a single cell on Node 18 or 20. `makeSettings` passed
 * `WebSocket: globalThis.WebSocket` unconditionally; the global WebSocket is
 * **Node 22+** (Node 21 had it behind `--experimental-websocket`), and
 * `ServerConnection.makeSettings` spreads `...options` OVER its own defaults - so
 * below Node 22 the key arrived as `undefined` and clobbered the default, which
 * in Node is the `ws` package @jupyterlab/services already depends on. Every
 * `new settings.WebSocket(...)` then threw `WebSocket is not a constructor` and
 * the cell's OUTPUT was that message.
 *
 * It stayed invisible because the only layer that boots a kernel is the e2e
 * suite, which had never run in CI, and every developer machine here is on a
 * Node that has the global. The first Linux CI run found it in three specs -
 * exactly the three of that shard that execute a cell.
 *
 * This is a unit test rather than an e2e one because the failing axis is the
 * NODE VERSION, which e2e cannot vary: the suite runs on whatever Node the
 * runner has. Deleting the global here reproduces Node 20 on any interpreter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeSettings } from '../../src/lib/server/kernel';

const globals = globalThis as { WebSocket?: unknown };
const REAL = globals.WebSocket;

afterEach(() => {
	if (REAL === undefined) delete globals.WebSocket;
	else globals.WebSocket = REAL;
});

describe('the jupyter server settings always carry a usable WebSocket', () => {
	it('falls back to @jupyterlab\'s own `ws` default when there is no global (Node 18/20)', () => {
		delete globals.WebSocket;
		const settings = makeSettings();
		// CONSTRUCTIBLE, not merely defined: the real breakage was the `new
		// settings.WebSocket(...)` inside @jupyterlab, so assert what that call
		// needs - callable AND carrying a prototype (an arrow function is a
		// function and still throws there). Deliberately not actually constructed:
		// `ws` would open a real TCP connection, and a test that dials a socket to
		// prove a type is a flake waiting to happen.
		expect(typeof settings.WebSocket).toBe('function');
		expect((settings.WebSocket as { prototype?: unknown }).prototype).toBeDefined();
	});

	it('still prefers the platform global when there IS one (Node 22+)', () => {
		// The override is not pointless - it keeps modern Node off the `ws`
		// package. Losing that silently would be a regression in the other
		// direction, so both branches are pinned.
		class FakeWebSocket {}
		globals.WebSocket = FakeWebSocket;
		expect(makeSettings().WebSocket).toBe(FakeWebSocket);
	});

	it('never hands back `undefined`, whatever the platform', () => {
		// The single invariant the two branches exist to serve, stated once so a
		// future third branch has to keep it.
		for (const ws of [undefined, class Fake {}]) {
			if (ws === undefined) delete globals.WebSocket;
			else globals.WebSocket = ws;
			expect(makeSettings().WebSocket).toBeTypeOf('function');
		}
	});
});
