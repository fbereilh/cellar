/**
 * The web-search opt-in against the REAL claude CLI - the one layer that can
 * prove the toggle is not INERT.
 *
 * `chat-engine-safety.test.ts` pins the argv and drives stub `claude` scripts,
 * so it proves what Cellar REQUESTS. It cannot see what the CLI then DOES with
 * that request, and the two came apart: `--tools WebSearch` alone makes the
 * session LIST the tool (so `system/init` reports it and the exact-allowlist
 * assertion passes) while the CALL stays permission-gated in non-interactive
 * `-p` mode - the model calls WebSearch, the CLI answers "Claude requested
 * permissions to use WebSearch, but you haven't granted it yet.", and the user
 * reads a dead end Cellar offers no way out of. Passing `--allowedTools` from
 * the same allowlist is what grants the call.
 *
 * So this file spends real model turns (gated) to assert the CLI's own
 * behaviour given the argv the product actually ships. The GRANT is pinned at
 * the one observation point that can see it - the tool_result the CLI returns
 * for the model's WebSearch call (the reply TEXT cannot: the model may answer
 * from training either way, measured passing with the grant removed). The
 * second test covers the other real-CLI risk in this shape: the fail-closed
 * allowlist assertion accepting a real search-on session end to end.
 *
 * Gated like the real-CLI e2e and like `databricks-logout.test.ts` gates on the
 * SDK - installed AND ambiently signed in, with the reason in the suite name so
 * a skipped run is never mistaken for a verified one. The probe uses the SAME
 * env scrub (`chatChildEnv`) the app's spawns use, so the gate and the app
 * cannot disagree about which credential answers.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chatCliArgs, chatToolAllowlist, claudeCliEngine, initViolation } from '../../src/lib/server/chat/claude-cli';
import { chatChildEnv, CLAUDE_BIN } from '../../src/lib/server/chat/env';

/** The CLI's own refusal when a tool is listed but its call was never granted. */
const PERMISSION_DENIAL = /requested permissions to use WebSearch/i;

/** A question that cannot be answered from training alone, so a search is attempted. */
const SEARCH_QUESTION =
	'[question] Search the web for the current stable version of the Svelte framework, then answer in one short line citing the source URL.\n';

const REAL_TURN_TIMEOUT_MS = 180_000;

function gate(): { ready: boolean; reason: string } {
	let res;
	try {
		res = spawnSync(CLAUDE_BIN, ['auth', 'status', '--json'], {
			env: chatChildEnv(null),
			encoding: 'utf8',
			timeout: 20_000
		});
	} catch (err) {
		return { ready: false, reason: String(err) };
	}
	if (res.error) return { ready: false, reason: 'the claude CLI is not installed' };
	try {
		const parsed = JSON.parse(res.stdout || '') as { loggedIn?: unknown };
		if (parsed.loggedIn === true) return { ready: true, reason: '' };
		return { ready: false, reason: 'the ambient claude CLI login is signed out' };
	} catch {
		return { ready: false, reason: 'claude auth status printed no JSON' };
	}
}

const cli = gate();

/** The reason rides the SUITE NAME, so a skipped run is legible as a skipped one. */
const SUITE = cli.ready
	? 'the web-search opt-in against the real claude CLI'
	: `the web-search opt-in against the real claude CLI (SKIPPED: ${cli.reason})`;

/** One real `claude` run driven by the argv Cellar ships, with its stream parsed. */
function runRealCli(args: string[], prompt: string): Promise<{ init: Record<string, unknown> | null; toolUses: string[]; toolResults: string[] }> {
	return new Promise((resolve, reject) => {
		const child = spawn(CLAUDE_BIN, args, { env: chatChildEnv(null), cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
		let init: Record<string, unknown> | null = null;
		const toolUses: string[] = [];
		const toolResults: string[] = [];
		let buf = '';
		const onLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let e: Record<string, unknown>;
			try {
				e = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				return;
			}
			if (e.type === 'system' && e.subtype === 'init') init = e;
			const content = (e.message as { content?: unknown })?.content;
			if (!Array.isArray(content)) return;
			for (const block of content) {
				if (typeof block !== 'object' || block === null) continue;
				const b = block as Record<string, unknown>;
				if (b.type === 'tool_use' && typeof b.name === 'string') toolUses.push(b.name);
				if (b.type === 'tool_result') toolResults.push(JSON.stringify(b.content));
			}
		};
		child.stdin?.on('error', () => {});
		child.stdin?.end(prompt);
		child.stdout?.on('data', (d: Buffer) => {
			buf += d.toString();
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				onLine(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
			}
		});
		child.on('error', reject);
		child.on('close', () => {
			if (buf) onLine(buf);
			resolve({ init, toolUses, toolResults });
		});
	});
}

describe.skipIf(!cli.ready)(SUITE, () => {
	it(
		'the shipped search-on argv GRANTS the call: the CLI runs the search instead of refusing it for want of permission',
		async () => {
			// The argv under test is the product's own, not a hand-written one.
			const { init, toolUses, toolResults } = await runRealCli(chatCliArgs({ webSearch: true }), SEARCH_QUESTION);

			// The real init report still satisfies the shipped exact-allowlist
			// assertion - granting the call may not widen what the session holds.
			expect(init).not.toBeNull();
			expect(initViolation(init as Record<string, unknown>, chatToolAllowlist(true))).toBeNull();

			// The question forced a search attempt...
			expect(toolUses).toContain('WebSearch');
			// ...and the CLI answered it with results, not with the permission refusal
			// that made the toggle inert.
			const denials = toolResults.filter((r) => PERMISSION_DENIAL.test(r));
			expect(denials).toEqual([]);
			expect(toolResults.join('\n')).toMatch(/web search results/i);
		},
		REAL_TURN_TIMEOUT_MS
	);

	// The GRANT is pinned by the test above, at the one observation point that can
	// see it: the CLI's own tool_result. This one covers the OTHER real-CLI risk
	// in the search shape - the engine's exact-allowlist assertion is fail-closed,
	// so a real session reporting anything but exactly `['WebSearch']` would fail
	// every search-on run `unsafe_init`, and no stub can prove it does not. It
	// deliberately makes no claim about the grant: the model can answer this
	// question from training whether or not the search succeeded, so a reply-text
	// assertion there would pass with the grant removed (measured) and read as
	// coverage it is not.
	it(
		'a search-on run survives the shipped engine end to end: the real session passes the exact-allowlist assertion',
		async () => {
			const deltas: string[] = [];
			const res = await claudeCliEngine.run({
				prompt: SEARCH_QUESTION,
				configDir: null,
				webSearch: true,
				signal: new AbortController().signal,
				onDelta: (t) => deltas.push(t)
			});

			expect(res.failure).toBeNull();
			expect(res.ok).toBe(true);
			expect((res.replyText ?? deltas.join('')).trim().length).toBeGreaterThan(0);
		},
		REAL_TURN_TIMEOUT_MS
	);
});
