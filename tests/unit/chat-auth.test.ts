/**
 * Claude account slots: resolution order, selection, and the sign-in/out
 * lifecycle - against a scripted `claude` stub on PATH, so the REAL spawn
 * paths run (env scrub, BROWSER capture, stdin code forwarding, settle probes)
 * with zero risk to the developer's own credential.
 *
 * The load-bearing claims:
 * - ONE resolution rule: selected slot if authenticated, else ambient, else
 *   none - shared by the run path and the sidebar.
 * - Sign-out REQUIRES a named slot: the ambient terminal login is borrowed and
 *   no Cellar path can revoke it (asserted behaviorally - the logout child's
 *   CLAUDE_CONFIG_DIR is always the slot's - and at the route, which 400s
 *   without a slot).
 * - A slot name becomes a directory segment, so the name rule is a security
 *   rule: traversal/hidden/empty names are refused everywhere they enter.
 * - The login child's URL is captured for rendering and the pasted code
 *   reaches its stdin; no credential ever appears in any state Cellar holds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidChatSlotName } from '../../src/lib/chatCell';

let BIN: string;
let SLOTS: string;
let SETTINGS: string;
let AMBIENT_FLAG: string; // the stub reports the ambient login authed iff this file exists
let LOG: string; // the stub appends `<cmd> CLAUDE_CONFIG_DIR=<v>` per invocation
const savedPath = process.env.PATH;
const savedSlots = process.env.CELLAR_CHAT_SLOTS;
const savedSettings = process.env.CELLAR_USER_SETTINGS;
const savedAmbient = process.env.CELLAR_TEST_AMBIENT;

let auth: typeof import('../../src/lib/server/chat/auth');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, ms = 8000): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (pred(v)) return v;
		if (Date.now() - t0 > ms) throw new Error(`condition not reached: ${JSON.stringify(v)}`);
		await sleep(100);
	}
}

beforeAll(async () => {
	BIN = mkdtempSync(join(tmpdir(), 'cellar-chat-authbin-'));
	SLOTS = mkdtempSync(join(tmpdir(), 'cellar-chat-slots-'));
	SETTINGS = join(mkdtempSync(join(tmpdir(), 'cellar-chat-settings-')), 'settings.json');
	AMBIENT_FLAG = join(mkdtempSync(join(tmpdir(), 'cellar-chat-ambient-')), 'authed');
	LOG = join(mkdtempSync(join(tmpdir(), 'cellar-chat-authlog-')), 'log.txt');
	process.env.PATH = `${BIN}:${savedPath}`;
	process.env.CELLAR_CHAT_SLOTS = SLOTS;
	process.env.CELLAR_USER_SETTINGS = SETTINGS;
	process.env.CELLAR_TEST_AMBIENT = AMBIENT_FLAG;

	// The scripted claude: status/login/logout, keyed on the slot dir's own
	// `.stub-authed` marker (ambient = the CELLAR_TEST_AMBIENT flag file).
	writeFileSync(
		join(BIN, 'claude'),
		`#!/bin/sh
echo "$1 $2 CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR-}" >> "${LOG}"
marker="\${CLAUDE_CONFIG_DIR:+\$CLAUDE_CONFIG_DIR/.stub-authed}"
marker="\${marker:-\$CELLAR_TEST_AMBIENT}"
case "$1 $2" in
  "auth status")
    if [ -f "$marker" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.com","subscriptionType":"max"}'
      exit 0
    else
      echo '{"loggedIn":false,"authMethod":"none"}'
      exit 1
    fi
    ;;
  "auth login")
    "\$BROWSER" "https://stub.example/oauth/authorize?client=cellar"
    echo "Paste the code, or visit: https://stub.example/paste"
    read -r pasted
    if [ "\$pasted" = "goodcode" ]; then
      touch "$marker"
      echo "Signed in."
      exit 0
    fi
    echo "Invalid code."
    exit 1
    ;;
  "auth logout")
    rm -f "$marker"
    echo "Signed out."
    exit 0
    ;;
  *) exit 2 ;;
esac
`
	);
	chmodSync(join(BIN, 'claude'), 0o755);

	auth = await import('../../src/lib/server/chat/auth');
});

afterAll(() => {
	process.env.PATH = savedPath;
	restore('CELLAR_CHAT_SLOTS', savedSlots);
	restore('CELLAR_USER_SETTINGS', savedSettings);
	restore('CELLAR_TEST_AMBIENT', savedAmbient);
	for (const d of [BIN, SLOTS]) rmSync(d, { recursive: true, force: true });
});

function restore(key: string, v: string | undefined) {
	if (v === undefined) delete process.env[key];
	else process.env[key] = v;
}

beforeEach(() => {
	auth.invalidateChatAuthCache();
	auth.__resetChatLogins();
	rmSync(AMBIENT_FLAG, { force: true });
	auth.selectChatSlot(null);
});

function authSlot(name: string) {
	mkdirSync(join(SLOTS, name), { recursive: true });
	writeFileSync(join(SLOTS, name, '.stub-authed'), '');
	auth.invalidateChatAuthCache();
}

describe('slot names are a security rule (they become directory segments)', () => {
	it('accepts ordinary names and refuses traversal/hidden/empty/separator names', () => {
		for (const ok of ['chat', 'work-2', 'a', 'Team.Alpha', '0slot']) expect(isValidChatSlotName(ok)).toBe(true);
		for (const bad of ['', '.', '..', '../x', '.hidden', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), null, undefined, 42]) {
			expect(isValidChatSlotName(bad)).toBe(false);
		}
	});

	it('every entry point throws/refuses an illegal name', async () => {
		expect(() => auth.chatSlotDir('../escape')).toThrow();
		expect(() => auth.selectChatSlot('../escape' as string)).toThrow();
		expect(() => auth.startChatLogin('.hidden')).toThrow();
		await expect(auth.chatLogout('../escape')).rejects.toThrow();
	});
});

describe('the ONE resolution rule (run path = sidebar)', () => {
	it('nothing anywhere -> none', async () => {
		expect(await auth.resolveChatAuth()).toEqual({ kind: 'none' });
	});

	it('ambient authed, no slot selected -> ambient (borrowed)', async () => {
		writeFileSync(AMBIENT_FLAG, '');
		auth.invalidateChatAuthCache();
		const r = await auth.resolveChatAuth();
		expect(r.kind).toBe('ambient');
		expect(r.account?.email).toBe('stub@example.com');
	});

	it('selected slot authed outranks an authed ambient', async () => {
		writeFileSync(AMBIENT_FLAG, '');
		authSlot('work');
		auth.selectChatSlot('work');
		const r = await auth.resolveChatAuth();
		expect(r.kind).toBe('slot');
		expect(r.slot).toBe('work');
		expect(auth.configDirFor(r)).toBe(join(SLOTS, 'work'));
	});

	it('a selected but signed-out slot falls back to the ambient login', async () => {
		writeFileSync(AMBIENT_FLAG, '');
		mkdirSync(join(SLOTS, 'empty'), { recursive: true });
		auth.selectChatSlot('empty');
		const r = await auth.resolveChatAuth();
		expect(r.kind).toBe('ambient');
		expect(auth.configDirFor(r)).toBeNull();
	});

	it('a missing CLI reports notInstalled', async () => {
		const emptyBin = mkdtempSync(join(tmpdir(), 'cellar-chat-nobin-'));
		const prev = process.env.PATH;
		process.env.PATH = emptyBin;
		auth.invalidateChatAuthCache();
		try {
			expect(await auth.resolveChatAuth()).toEqual({ kind: 'none', notInstalled: true });
		} finally {
			process.env.PATH = prev;
			auth.invalidateChatAuthCache();
			rmSync(emptyBin, { recursive: true, force: true });
		}
	});

	it('the selection persists through the user-settings store and lists as selected', async () => {
		authSlot('alpha');
		authSlot('beta');
		auth.selectChatSlot('beta');
		// The store's disk write is debounced; flush before reading the file back.
		const settings = await import('../../src/lib/server/user-settings');
		settings.__resetUserSettingsCache();
		expect(JSON.parse(readFileSync(SETTINGS, 'utf8'))['cellar-chat-claude-slot']).toBe('beta');
		const slots = await auth.listChatSlots();
		expect(slots.map((s) => [s.slot, s.selected])).toEqual([
			['alpha', false],
			['beta', true],
			['empty', false],
			['work', false]
		]);
		expect(slots[1].account?.loggedIn).toBe(true);
	});
});

describe('sign-in lifecycle (server-run browser flow)', () => {
	it('captures the URL for rendering, forwards the pasted code, settles authed', async () => {
		const state0 = auth.startChatLogin('fresh');
		expect(state0.running).toBe(true);
		// The BROWSER stub's captured URL surfaces for the panel to render...
		const withUrl = await until(
			() => auth.chatLoginStatus(state0.id),
			(s) => !!s && (!!s.browserUrl || !!s.pasteUrl)
		);
		expect(withUrl?.browserUrl).toBe('https://stub.example/oauth/authorize?client=cellar');
		expect(withUrl?.pasteUrl).toBe('https://stub.example/paste');
		// ...the pasted code reaches the child's stdin...
		expect(auth.submitChatLoginCode(state0.id, 'goodcode')).toBe(true);
		const settled = await until(
			() => auth.chatLoginStatus(state0.id),
			(s) => !!s && !s.running
		);
		// ...and settle is decided by the status PROBE, which now reads authed.
		expect(settled?.ok).toBe(true);
		expect(settled?.account?.email).toBe('stub@example.com');
		// No state Cellar holds ever carries the code or a token.
		expect(JSON.stringify(settled)).not.toContain('goodcode');
		const r = await (auth.selectChatSlot('fresh'), auth.resolveChatAuth());
		expect(r.kind).toBe('slot');
	}, 15_000);

	it('a wrong code settles NOT ok, with the CLI last words as the error', async () => {
		const s0 = auth.startChatLogin('fresh2');
		await until(
			() => auth.chatLoginStatus(s0.id),
			(s) => !!s?.pasteUrl
		);
		auth.submitChatLoginCode(s0.id, 'badcode');
		const settled = await until(
			() => auth.chatLoginStatus(s0.id),
			(s) => !!s && !s.running
		);
		expect(settled?.ok).toBe(false);
		expect(settled?.error).toContain('Invalid code');
	}, 15_000);

	it('cancel kills the attempt and the slot stays as status reports it', async () => {
		const s0 = auth.startChatLogin('fresh3');
		await until(
			() => auth.chatLoginStatus(s0.id),
			(s) => !!s?.pasteUrl
		);
		expect(auth.cancelChatLogin(s0.id)).toBe(true);
		const settled = await until(
			() => auth.chatLoginStatus(s0.id),
			(s) => !!s && !s.running
		);
		expect(settled?.ok).toBe(false);
		expect(existsSync(join(SLOTS, 'fresh3', '.stub-authed'))).toBe(false);
	}, 15_000);
});

describe('sign-out is slot-scoped by construction', () => {
	it('signs the named slot out and the ambient login provably survives', async () => {
		writeFileSync(AMBIENT_FLAG, ''); // the "terminal login"
		authSlot('mine');
		const res = await auth.chatLogout('mine');
		expect(res.ok).toBe(true);
		expect(res.account?.loggedIn).toBe(false);
		// The slot's marker is gone; the ambient one is untouched.
		expect(existsSync(join(SLOTS, 'mine', '.stub-authed'))).toBe(false);
		expect(existsSync(AMBIENT_FLAG)).toBe(true);
		// And the logout child ran WITH the slot's CLAUDE_CONFIG_DIR - never unset.
		const logoutLines = readFileSync(LOG, 'utf8')
			.split('\n')
			.filter((l) => l.startsWith('auth logout'));
		expect(logoutLines.length).toBeGreaterThan(0);
		for (const line of logoutLines) {
			expect(line).toMatch(/CLAUDE_CONFIG_DIR=.+/);
			expect(line).toContain(SLOTS); // always a Cellar slot dir
		}
	});

	it('the logout route 400s without a valid slot (no ambient-logout reachable over HTTP)', async () => {
		const { POST } = await import('../../src/routes/api/chat/logout/+server.js');
		for (const body of [{}, { slot: null }, { slot: '' }, { slot: '../x' }]) {
			const res = await POST({
				request: new Request('http://x/api/chat/logout', { method: 'POST', body: JSON.stringify(body) })
			} as Parameters<typeof POST>[0]);
			expect(res.status).toBe(400);
		}
	});
});
