import { getDefaultNotebook } from '$lib/server/notebook';
import { workspaceRoot } from '$lib/server/fstree';
import { harnessState } from '$lib/server/harness.js';
import { getUiState } from '$lib/server/ui-state';
import { parseMaxKernels } from '$lib/kernelCap';

/**
 * Whether `<workspace>/.mcp.json` currently registers the `cellar` stdio server.
 * True → an agent opened in this repo auto-connects with zero config; false →
 * the launcher was run with `--no-mcp-config` (or the file was removed/edited),
 * so the manual `claude mcp add` path is the way in.
 *
 * The verdict comes from `harness.js`, the ONE place that decides what a
 * configured harness looks like - a second copy here (`…cellar?.command ===
 * 'cellar'`, ignoring `args`) could report the panel's "wired up here" banner
 * over an entry the launcher would rewrite on the very next run. Best-effort:
 * any read/parse trouble degrades to false rather than throwing during SSR.
 */
function detectMcpConfig() {
	try {
		return harnessState('claude', workspaceRoot())?.configured === true;
	} catch {
		return false;
	}
}

/** Load the canonical notebook (cells + outputs) for the workspace. */
export function load() {
	// Live MCP endpoint for this instance. The launcher allocates a free port
	// per run and passes it via CELLAR_MCP_PORT (default 39587 matches the MCP
	// server's own fallback), so the "Connect an agent" panel can show the real
	// running value in the demoted raw-endpoint disclosure.
	const mcpPort = Number(process.env.CELLAR_MCP_PORT || 39587);
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
			// Zero-config: did the launcher write a project `.mcp.json` here?
			projectConfigured: detectMcpConfig()
		}
	};
}
