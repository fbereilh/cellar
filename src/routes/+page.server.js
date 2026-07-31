import { getDefaultNotebook } from '$lib/server/notebook';
import { workspaceRoot } from '$lib/server/fstree';
import { harnessState, isHarnessAllowed } from '$lib/server/harness.js';
import { getUiState } from '$lib/server/ui-state';
import { parseMaxKernels } from '$lib/kernelCap';

/**
 * The two INDEPENDENT facts the "Connect an agent" panel needs about Claude Code,
 * exactly as `cellar harness list` prints them:
 *
 *   `configured` — `<workspace>/.mcp.json` registers the `cellar` stdio server
 *                  right now, so an agent opened in this repo auto-connects.
 *   `managed`    — Claude Code is on the workspace allow-list, so every `cellar`
 *                  start CHECKS AND REPAIRS that entry.
 *
 * They are separate because they can honestly disagree: `cellar harness remove
 * claude` deliberately leaves the entry in place, so a configured harness may no
 * longer be maintained, and the banner must not promise a self-heal that will not
 * happen. Both verdicts come from `harness.js`, the ONE place that decides what a
 * configured/managed harness is - a second copy here (`…cellar?.command ===
 * 'cellar'`, ignoring `args`) could claim "wired up" over an entry the launcher
 * would rewrite on the very next run. Best-effort: any read/parse trouble degrades
 * to false rather than throwing during SSR.
 */
function detectMcpConfig() {
	try {
		const ws = workspaceRoot();
		return {
			configured: harnessState('claude', ws)?.configured === true,
			managed: isHarnessAllowed('claude', ws)
		};
	} catch {
		return { configured: false, managed: false };
	}
}

/** Load the canonical notebook (cells + outputs) for the workspace. */
export function load() {
	// Live MCP endpoint for this instance. The launcher allocates a free port
	// per run and passes it via CELLAR_MCP_PORT (default 39587 matches the MCP
	// server's own fallback), so the "Connect an agent" panel can show the real
	// running value in the demoted raw-endpoint disclosure.
	const mcpPort = Number(process.env.CELLAR_MCP_PORT || 39587);
	const claude = detectMcpConfig();
	return {
		notebook: getDefaultNotebook(),
		// Soft cap on live kernels: past this the Kernels sidebar shows a
		// high-memory warning (warn-only, never blocks a run). Each kernel is a full
		// Python process (100s of MB with pandas/pyspark). Tunable via
		// `CELLAR_MAX_KERNELS` (default 8; 0 disables the warning).
		maxKernels: parseMaxKernels(process.env.CELLAR_MAX_KERNELS),
		// Per-project UI preferences, port-independent (see `$lib/server/ui-state.js`).
		// Delivered via SSR so the client seeds them synchronously - no flash, and
		// they survive the dynamic app port that resets `localStorage` each launch.
		uiState: getUiState(),
		mcp: {
			port: mcpPort,
			url: `http://127.0.0.1:${mcpPort}/mcp`,
			// Zero-config: does a project `.mcp.json` register `cellar` here, and is
			// Cellar keeping it that way? Separate facts - see `detectMcpConfig`.
			projectConfigured: claude.configured,
			projectManaged: claude.managed
		}
	};
}
