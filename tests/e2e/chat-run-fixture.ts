import { expect, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shared fixture for the two specs that assert what a SIGNAL reaches through
 * a chat run - `chat-stop.spec.ts` (the Stop control) and
 * `chat-shutdown-hangup.spec.ts` (a terminal close).
 *
 * It lives here for the reason `openSidebarSection` was lifted into `harness.ts`:
 * both specs need a run with a REAL descendant, and a hand-rolled copy of that
 * per spec is a documented flake source in this repo - a drift in one copy would
 * silently weaken whichever spec kept the weaker version, and here the weaker
 * version is one whose CLI leaves no descendant, i.e. exactly the masking
 * condition both specs exist to rule out.
 *
 * What is NOT here is what genuinely differs: each spec owns its notebook name,
 * its own launcher, its own tracked-pid array, and its own assertions.
 */

/** The one chat cell both specs seed and drive. */
export const CHAT_CELL_ID = 'chatcell0';

/** A cell by its stable id, so a windowed-out sibling can never be addressed. */
export function cellBy(page: Page, id: string) {
	return page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);
}

/** Ask the OS whether a pid is still there - the only honest form of the question. */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A stub `claude` that starts a long-lived GRANDCHILD, records its pid, and
 * waits on it - the shape a real run has whenever the model used a tool.
 *
 * The grandchild `exec`s so the recorded pid is the sleeper itself, and the stub
 * `wait`s so the direct child does not exit first (a CLI supervising its tools
 * does not either). `$$` is expanded by the inner shell, hence the quoting.
 *
 * The subject is what a SIGNAL reaches, not what a model says - so the stub is
 * the honest fixture: it reproduces the one property of a real run that matters
 * here and lets the descendant be identified by pid and asked about directly. A
 * real turn could not make that observation any sharper, and could not be asked
 * to hang on demand. It answers `auth status` too, so neither spec needs a
 * signed-in CLI.
 */
export function installStubClaude(ws: string, pidfile: string): void {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	const init = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '9.9.9-stub'
	});
	const bin = join(shim, 'claude');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'if [ "$1" = "auth" ]; then',
			`  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.com"}'`,
			'  exit 0',
			'fi',
			'cat > /dev/null', // drain the prompt off stdin, as the real CLI does
			`echo '${init}'`,
			`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"thinking about it"}}}'`,
			`sh -c 'echo $$ > ${pidfile}; exec sleep 900' &`,
			'wait',
			''
		].join('\n')
	);
	chmodSync(bin, 0o755);
}

/** Seed a one-chat-cell notebook at `name` inside `ws`. */
export function seedChatNotebook(name: string, ws: string): void {
	writeFileSync(
		join(ws, name),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						id: CHAT_CELL_ID,
						metadata: { cellar: { language: 'chat' } },
						source: ['what is 2+2?'],
						outputs: [],
						execution_count: null
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
}

/**
 * The pid the stub recorded for this run's descendant, TRACKED into `started`.
 *
 * The destination array is a parameter rather than module state: spec files can
 * share a worker, so one module-level list would let one spec's teardown reap
 * the other's pids. Passing it also makes the tracking structural - a caller
 * cannot read the pid without recording it, and a leaked descendant is the very
 * thing both specs are about.
 */
export async function grandchildPid(pidfile: string, started: number[]): Promise<number> {
	await expect
		.poll(() => (existsSync(pidfile) ? Number(readFileSync(pidfile, 'utf8').trim()) : 0), { timeout: 60_000 })
		.toBeGreaterThan(0);
	const pid = Number(readFileSync(pidfile, 'utf8').trim());
	started.push(pid);
	return pid;
}

/** Open a freshly seeded chat notebook and return its chat cell. */
export async function openChatNotebook(
	page: Page,
	opts: { baseURL: string; workspace: string; name: string }
) {
	seedChatNotebook(opts.name, opts.workspace);
	await page.goto(`${opts.baseURL}/?ws=${encodeURIComponent(opts.workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${opts.name}"]`).click();
	const chat = cellBy(page, CHAT_CELL_ID);
	await expect(chat).toBeVisible({ timeout: 30_000 });
	return chat;
}

/** Kill every tracked descendant, so one failing case cannot leave a leak behind. */
export function reapPids(pids: readonly number[]): void {
	for (const pid of pids) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	}
}
