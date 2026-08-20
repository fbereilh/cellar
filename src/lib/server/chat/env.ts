/**
 * Cellar - the environment a chat subprocess (claude CLI) is spawned with.
 *
 * The CLI reads a LARGE env surface (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
 * `ANTHROPIC_BASE_URL`, Bedrock/Foundry/Vertex routing, `ANTHROPIC_CONFIG_DIR`,
 * `CLAUDE_CODE_HOST_CREDS_FILE`, ...). Any of them, inherited from the shell the
 * launcher happened to start in, would silently bill a different account or route
 * to a different provider - while the sidebar still displays the account Cellar
 * THINKS it is using. So the child env is scrubbed the way `databricks.ts`'s
 * `scrubEnv` scrubs `DATABRICKS_*`: delete every key starting with `ANTHROPIC`
 * or `CLAUDE` (the bare prefix, so `CLAUDECODE`/`CLAUDE_CODE_*` markers from a
 * parent Claude Code session go too), then set exactly the one thing Cellar
 * means: `CLAUDE_CONFIG_DIR` when a Cellar-owned slot is in use, or nothing at
 * all for the borrowed ambient login (env unset IS how the CLI addresses the
 * default slot). The keep-set is empty.
 *
 * A unit test pins that the child env contains no other `ANTHROPIC`/`CLAUDE` key
 * - the `html-preview.test.ts` precedent: the isolation is one word wide.
 */

/** Is `key` an env var the claude CLI could read auth/routing state from? */
export function isChatSensitiveEnv(key: string): boolean {
	return key.startsWith('ANTHROPIC') || key.startsWith('CLAUDE');
}

/**
 * The scrubbed child env. `configDir` is the slot's `CLAUDE_CONFIG_DIR` (a
 * Cellar-owned slot directory), or null to address the ambient default slot.
 */
export function chatChildEnv(configDir: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!isChatSensitiveEnv(k)) env[k] = v;
	}
	if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
	return env;
}

/** The claude CLI binary name (resolved via PATH, like `uv`/`git` elsewhere). */
export const CLAUDE_BIN = 'claude';
