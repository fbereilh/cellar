/**
 * Cellar - Claude account slots: resolution, status, sign-in/out, switching.
 *
 * ## The credential model (verified in the design report, and re-verified here)
 *
 * The claude CLI keeps its credential OUTSIDE its config dir - on macOS a
 * Keychain item whose service name is namespaced by `CLAUDE_CONFIG_DIR`:
 * `Claude Code-credentials` when the env is unset, and
 * `Claude Code-credentials-<first 8 hex of sha256(env value)>` when set (the
 * literal env value is hashed - no normalization). So a directory under
 * `~/.cellar/claude/<slot>` IS an isolated account slot: its login, its logout
 * and its account choice are structurally incapable of touching the user's own
 * terminal login. Logout scoping was verified mechanically before this was
 * built: with `security` shimmed in PATH, `claude auth logout` under a slotted
 * CLAUDE_CONFIG_DIR issued deletes ONLY for the slot-derived suffixed service
 * names, and never named the unsuffixed default item.
 *
 * ## The rules
 *
 * - **Resolution order** (per run and for the sidebar, ONE rule): the selected
 *   Cellar slot if it is authenticated; else the AMBIENT default credential
 *   (env unset), labelled borrowed; else not signed in.
 * - **A borrowed credential is used, never managed**: sign-out is only ever
 *   offered - and only ever executed - for a named Cellar slot. There is no
 *   code path here that runs `claude auth logout` without a slot, the
 *   Databricks-logout doctrine ("only ever clears what Cellar's own sign-in
 *   minted") applied to Claude.
 * - **Cellar never sees a token.** `claude auth status --json` reports identity
 *   only; the login subprocess talks to the browser and the keychain itself.
 *   The one secret-adjacent value passing through Cellar is the paste-fallback
 *   authorisation code, which is forwarded to the child's stdin and NEVER
 *   logged (the login log captures stdout only).
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
	CHAT_SLOT_KEY,
	isValidChatSlotName,
	type ChatAccountInfo,
	type ChatAuthResolution,
	type ChatLoginView,
	type ChatSlotInfo
} from '$lib/chatCell';
import { getUserSettings, setUserSettings } from '$lib/server/user-settings';
import { chatChildEnv, CLAUDE_BIN } from './env';

/** How long a status probe may take before it is killed (ms). */
const STATUS_TIMEOUT_MS = 15_000;
/** Status probe cache TTL (ms): a run + a sidebar poll share one probe. */
const STATUS_TTL_MS = 5_000;
/** How long a human gets to complete a browser sign-in before the child is killed. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * `~/.cellar/claude/`, or whatever `CELLAR_CHAT_SLOTS` names - the override is
 * what makes slots testable at all (the `CELLAR_USER_SETTINGS` precedent): the
 * default path is the real machine-level slot store, so a test exercising it
 * without one would be creating/deleting the developer's own account slots.
 */
export function chatSlotsRoot(): string {
	const override = process.env.CELLAR_CHAT_SLOTS;
	return override && override.trim() ? override : join(homedir(), '.cellar', 'claude');
}

/** The `CLAUDE_CONFIG_DIR` for a named slot. Throws on an illegal name. */
export function chatSlotDir(slot: string): string {
	if (!isValidChatSlotName(slot)) throw new Error(`invalid chat account slot name: ${JSON.stringify(slot)}`);
	return join(chatSlotsRoot(), slot);
}

/**
 * The selected slot name, or null (= borrow ambient). Read through the
 * settings store on every call (a stale copy would keep running chat on an
 * account the user just switched away from); an invalid stored value reads as
 * unset rather than becoming a path segment.
 */
export function selectedChatSlot(): string | null {
	const raw = getUserSettings()[CHAT_SLOT_KEY];
	return isValidChatSlotName(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// Status probes
// ---------------------------------------------------------------------------

type ProbeResult = { notInstalled: true } | { notInstalled: false; account: ChatAccountInfo };

/** Cache key: the config dir ('' = ambient). */
const statusCache = new Map<string, { at: number; value: Promise<ProbeResult> }>();

/** Drop every cached probe - call after anything that can change auth state. */
export function invalidateChatAuthCache(): void {
	statusCache.clear();
}

/**
 * `claude auth status --json` for one slot (configDir null = ambient). ~160ms,
 * no API call; exit 1 simply means "not logged in" and still prints JSON, so
 * the exit code is ignored and the JSON is the answer. Cached briefly +
 * single-flight so a run and a sidebar poll in the same moment cost one spawn.
 */
export function probeChatAccount(configDir: string | null): Promise<ProbeResult> {
	const key = configDir ?? '';
	const hit = statusCache.get(key);
	if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
	const value = runStatusProbe(configDir);
	statusCache.set(key, { at: Date.now(), value });
	return value;
}

function runStatusProbe(configDir: string | null): Promise<ProbeResult> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(CLAUDE_BIN, ['auth', 'status', '--json'], {
				env: chatChildEnv(configDir),
				cwd: tmpdir(),
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: STATUS_TIMEOUT_MS
			});
		} catch {
			resolve({ notInstalled: true });
			return;
		}
		let out = '';
		child.stdout.on('data', (d: Buffer) => {
			out += d.toString();
		});
		child.on('error', () => resolve({ notInstalled: true }));
		child.on('close', () => {
			try {
				const parsed = JSON.parse(out) as Record<string, unknown>;
				resolve({ notInstalled: false, account: accountInfo(parsed) });
			} catch {
				// Unparseable output from an installed CLI: report signed-out rather than
				// inventing an account. (A missing binary lands in 'error' above.)
				resolve({ notInstalled: false, account: { loggedIn: false } });
			}
		});
	});
}

/** Project the status JSON onto the identity fields Cellar renders (no token). */
function accountInfo(parsed: Record<string, unknown>): ChatAccountInfo {
	const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
	return {
		loggedIn: parsed.loggedIn === true,
		authMethod: s(parsed.authMethod),
		email: s(parsed.email),
		orgName: s(parsed.orgName),
		subscriptionType: s(parsed.subscriptionType)
	};
}

let testResolution: ChatAuthResolution | null = null;

/** Test seam: pin the resolution (pass null to restore the real probes). */
export function __setChatAuthForTests(resolution: ChatAuthResolution | null): void {
	testResolution = resolution;
}

/**
 * Which credential a chat run uses NOW - the ONE resolution rule (see header),
 * shared by the run path and the sidebar so the two can never disagree.
 */
export async function resolveChatAuth(): Promise<ChatAuthResolution> {
	if (testResolution) return testResolution;
	const slot = selectedChatSlot();
	if (slot) {
		const probe = await probeChatAccount(chatSlotDir(slot));
		if (probe.notInstalled) return { kind: 'none', notInstalled: true };
		if (probe.account.loggedIn) return { kind: 'slot', slot, account: probe.account };
	}
	const ambient = await probeChatAccount(null);
	if (ambient.notInstalled) return { kind: 'none', notInstalled: true };
	if (ambient.account.loggedIn) return { kind: 'ambient', account: ambient.account };
	return { kind: 'none' };
}

/** The `CLAUDE_CONFIG_DIR` a resolution runs with (null = ambient/none). */
export function configDirFor(resolution: ChatAuthResolution): string | null {
	return resolution.kind === 'slot' && resolution.slot ? chatSlotDir(resolution.slot) : null;
}

// ---------------------------------------------------------------------------
// Slots: list / select
// ---------------------------------------------------------------------------

/** Every named slot with who is signed in to it (sorted by name - stable). */
export async function listChatSlots(): Promise<ChatSlotInfo[]> {
	const root = chatSlotsRoot();
	let names: string[] = [];
	try {
		names = readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory() && isValidChatSlotName(e.name))
			.map((e) => e.name)
			.sort();
	} catch {
		names = []; // no root yet = no slots
	}
	const selected = selectedChatSlot();
	return Promise.all(
		names.map(async (slot) => {
			const probe = await probeChatAccount(chatSlotDir(slot));
			return {
				slot,
				account: probe.notInstalled ? null : probe.account,
				selected: slot === selected
			};
		})
	);
}

/**
 * Select which account chat runs use: a named slot, or null = borrow the
 * ambient terminal login. A SELECTION, not a credential operation - nothing is
 * re-authenticated, nothing revoked; the next run simply spawns with (or
 * without) that slot's `CLAUDE_CONFIG_DIR`.
 */
export function selectChatSlot(slot: string | null): void {
	if (slot !== null && !isValidChatSlotName(slot)) {
		throw new Error(`invalid chat account slot name: ${JSON.stringify(slot)}`);
	}
	setUserSettings({ [CHAT_SLOT_KEY]: slot });
	invalidateChatAuthCache();
}

// ---------------------------------------------------------------------------
// Sign in (browser flow in a subprocess)
// ---------------------------------------------------------------------------

/** A login attempt's live, renderable state (no secrets - see the header). */
export type ChatLoginState = ChatLoginView;

interface LoginSession {
	id: string;
	slot: string;
	child: ReturnType<typeof spawn>;
	tmp: string;
	urlsFile: string;
	stdoutTail: string[];
	pasteUrl: string | null;
	running: boolean;
	ok: boolean | null;
	account: ChatAccountInfo | null;
	error: string | null;
	timer: ReturnType<typeof setTimeout>;
}

const logins = new Map<string, LoginSession>();
let loginSeq = 0;

/**
 * Start `claude auth login` into a slot (created if missing). The child owns
 * the whole OAuth dance - its own loopback listener, the keychain write; Cellar
 * captures only the URL to render (via a BROWSER stub that appends its argv to
 * a file, so no window is popped from a server process) and, for the fallback,
 * forwards a pasted code to the child's stdin.
 */
export function startChatLogin(slot: string): ChatLoginState {
	const dir = chatSlotDir(slot); // validates the name
	mkdirSync(dir, { recursive: true });

	// Cancel a prior half-open login for the same slot rather than racing two.
	for (const s of logins.values()) {
		if (s.slot === slot && s.running) endLogin(s, 'superseded by a new sign-in attempt');
	}

	const tmp = mkdtempSync(join(tmpdir(), 'cellar-chat-login-'));
	const urlsFile = join(tmp, 'urls.txt');
	writeFileSync(urlsFile, '');
	const stub = join(tmp, 'browser.sh');
	// The stub only records what the CLI asked to open; printf appends argv
	// verbatim, one call per line. Never opens anything.
	writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${urlsFile}"\n`);
	chmodSync(stub, 0o700);

	const env = chatChildEnv(dir);
	env.BROWSER = stub;

	const child = spawn(CLAUDE_BIN, ['auth', 'login'], {
		env,
		cwd: tmpdir(),
		stdio: ['pipe', 'pipe', 'pipe']
	});

	const id = `login-${++loginSeq}`;
	const session: LoginSession = {
		id,
		slot,
		child,
		tmp,
		urlsFile,
		stdoutTail: [],
		pasteUrl: null,
		running: true,
		ok: null,
		account: null,
		error: null,
		timer: setTimeout(() => endLogin(session, 'sign-in timed out'), LOGIN_TIMEOUT_MS)
	};
	if (typeof session.timer.unref === 'function') session.timer.unref();
	logins.set(id, session);

	// The paste-fallback code is written to this child's stdin (see
	// `submitChatLoginCode`), and a write to a pipe whose read end has closed
	// raises EPIPE as an `error` EVENT on the stream: unhandled, Node throws it
	// and takes down the whole Cellar process (kernel websockets, SSE fan-out and
	// the in-process MCP server with it). Reachable by re-submitting a corrected
	// code, or by submitting just as the browser round-trip completes. Same guard
	// the chat engine's own child carries, for the same reason.
	child.stdin?.on('error', () => {});

	// stdout only - stdin carries the pasted authorisation code and is never read
	// back or logged.
	const onOut = (d: Buffer) => {
		const text = d.toString();
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			session.stdoutTail.push(trimmed);
			if (session.stdoutTail.length > 50) session.stdoutTail.shift();
			const m = trimmed.match(/visit:\s*(https?:\S+)/i);
			if (m) session.pasteUrl = m[1];
		}
	};
	child.stdout?.on('data', onOut);
	child.stderr?.on('data', onOut);
	child.on('error', (err) => {
		session.error = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Claude Code (`claude`) is not installed.' : String(err);
		settleLogin(session);
	});
	child.on('close', () => settleLogin(session));

	return loginView(session);
}

/** The child exited (or failed to start): probe the slot - status is the arbiter. */
function settleLogin(session: LoginSession): void {
	if (!session.running) return;
	session.running = false;
	clearTimeout(session.timer);
	invalidateChatAuthCache();
	void probeChatAccount(chatSlotDir(session.slot)).then((probe) => {
		const account = probe.notInstalled ? null : probe.account;
		session.account = account;
		session.ok = account?.loggedIn === true;
		if (!session.ok && !session.error) {
			// The CLI's own last words are usually the actionable ones.
			session.error = session.stdoutTail.slice(-3).join(' ') || 'sign-in did not complete';
		}
		cleanupLoginTmp(session);
	});
}

/** Kill a login child; a killed child cannot leave a slot that READS as authed
 * because `claude auth status` (probed at settle) is the arbiter, not our state. */
function endLogin(session: LoginSession, why: string): void {
	if (!session.running) return;
	session.error = why;
	try {
		session.child.kill('SIGTERM');
	} catch {
		// already gone
	}
	// `close` fires and settles; if the child ignores SIGTERM the timeout below
	// escalates.
	const killTimer = setTimeout(() => {
		try {
			session.child.kill('SIGKILL');
		} catch {
			// already gone
		}
	}, 3_000);
	if (typeof killTimer.unref === 'function') killTimer.unref();
}

function cleanupLoginTmp(session: LoginSession): void {
	try {
		rmSync(session.tmp, { recursive: true, force: true });
	} catch {
		// scratch; best-effort
	}
}

/** The renderable state of one login attempt (reads the stub's URL capture). */
function loginView(session: LoginSession): ChatLoginState {
	let browserUrl: string | null = null;
	try {
		if (existsSync(session.urlsFile)) {
			const lines = readFileSync(session.urlsFile, 'utf8').split('\n').filter(Boolean);
			// The stub may be called more than once; the first URL is the sign-in one.
			browserUrl = lines.find((l) => /^https?:\/\//.test(l)) ?? null;
		}
	} catch {
		browserUrl = null;
	}
	return {
		id: session.id,
		slot: session.slot,
		browserUrl,
		pasteUrl: session.pasteUrl,
		running: session.running,
		ok: session.ok,
		account: session.account,
		error: session.error
	};
}

/** Poll a login attempt. Unknown id = null (the panel treats it as gone). */
export function chatLoginStatus(id: string): ChatLoginState | null {
	const session = logins.get(id);
	return session ? loginView(session) : null;
}

/**
 * Forward the pasted authorisation code to the login child's stdin. The code is
 * short-lived and single-use, and it is NEVER logged or echoed back.
 */
export function submitChatLoginCode(id: string, code: string): boolean {
	const session = logins.get(id);
	const stdin = session?.child.stdin;
	// A closed/destroyed stdin is refused rather than written to: the child
	// consumed the first line and closed it, or exited between its `close` landing
	// and this call. The write itself can still fail asynchronously (EPIPE), which
	// is why `startChatLogin` attaches an `error` listener to this very stream -
	// unhandled, that event is thrown and takes the whole server process down.
	if (!session || !session.running || !stdin || stdin.destroyed || !stdin.writable) return false;
	try {
		stdin.write(code.trim() + '\n');
	} catch {
		return false;
	}
	return true;
}

/** Cancel a login attempt (kills the child; the slot stays as status reports it). */
export function cancelChatLogin(id: string): boolean {
	const session = logins.get(id);
	if (!session) return false;
	endLogin(session, 'cancelled');
	return true;
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/**
 * Sign a NAMED Cellar slot out. This is the only logout path, and it requires a
 * slot by construction: the ambient terminal login is borrowed, never managed,
 * so there is deliberately no way to reach `claude auth logout` with an unset
 * `CLAUDE_CONFIG_DIR` from here.
 */
export async function chatLogout(slot: string): Promise<{ ok: boolean; account: ChatAccountInfo | null; error: string | null }> {
	const dir = chatSlotDir(slot); // validates the name
	const result = await new Promise<{ code: number | null; err: string | null }>((resolve) => {
		let child;
		try {
			child = spawn(CLAUDE_BIN, ['auth', 'logout'], {
				env: chatChildEnv(dir),
				cwd: tmpdir(),
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 60_000
			});
		} catch (err) {
			resolve({ code: null, err: String(err) });
			return;
		}
		let tail = '';
		child.stdout.on('data', (d: Buffer) => (tail += d.toString()));
		child.stderr.on('data', (d: Buffer) => (tail += d.toString()));
		child.on('error', (err) => resolve({ code: null, err: String(err) }));
		child.on('close', (code) => resolve({ code, err: code === 0 ? null : tail.trim() || `logout exited ${code}` }));
	});
	invalidateChatAuthCache();
	const probe = await probeChatAccount(dir);
	const account = probe.notInstalled ? null : probe.account;
	const stillIn = account?.loggedIn === true;
	return {
		ok: !stillIn,
		account,
		// `status` is the arbiter: a non-zero logout on an already-signed-out slot
		// still reports ok as long as the slot reads signed out.
		error: stillIn ? (result.err ?? 'the slot still reports signed in') : null
	};
}

/** Test seam: forget in-memory login sessions (children are the tests' to kill). */
export function __resetChatLogins(): void {
	logins.clear();
}
