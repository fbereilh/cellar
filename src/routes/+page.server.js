import { getDefaultNotebook } from '$lib/server/notebook';
import { workspaceRoot } from '$lib/server/fstree';
import { harnessState, isHarnessAllowed, mcpJsonHarnessNames, mcpConfigDisabled } from '$lib/server/harness.js';
import { getUiState } from '$lib/server/ui-state';
import { getUserSettings } from '$lib/server/user-settings';
import { parseMaxKernels } from '$lib/kernelCap';
import { detectNbdev } from '$lib/server/nbdev';

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
 *
 * `managed` is the DURABLE fact, so this instance's own opt-out is reported
 * separately as `paused`: `--no-mcp-config` filters what THIS launch reconciles
 * without touching the allow-list, so the harness stays managed while nothing is
 * being checked or repaired right now - two different remedies (`cellar harness
 * add` vs. relaunching without the flag), so they must not collapse into one
 * boolean. Which harness the flag covers is derived from the registry
 * (`mcpJsonHarnessNames`), exactly as the launcher derives it, never pinned here.
 */
function detectMcpConfig() {
	try {
		const ws = workspaceRoot();
		const managed = isHarnessAllowed('claude', ws);
		return {
			configured: harnessState('claude', ws)?.configured === true,
			managed,
			// Only meaningful for a MANAGED harness: an unmanaged one is not repaired by
			// any launch, so its remedy is `cellar harness add`, not dropping the flag.
			paused: managed && mcpConfigDisabled() && mcpJsonHarnessNames().includes('claude')
		};
	} catch {
		return { configured: false, managed: false, paused: false };
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
		// Cross-project user settings (see `$lib/server/user-settings.ts`) - the global
		// sibling of `uiState`, delivered the same way and for the same reason. It holds
		// DEFAULTS a project inherits only when it has no answer of its own.
		userSettings: getUserSettings(),
		// Is this an nbdev project whose `pyproject.toml` lets nbdev's cleanup erase
		// Cellar's `metadata.cellar` namespace? Detect-and-offer only: the sidebar
		// says what is at risk and what the remedy is, and writes nothing until the
		// user asks. `detectNbdev` never throws, so SSR is safe.
		nbdev: detectNbdev(),
		mcp: {
			port: mcpPort,
			url: `http://127.0.0.1:${mcpPort}/mcp`,
			// Zero-config: does a project `.mcp.json` register `cellar` here, and is
			// Cellar keeping it that way? Separate facts - see `detectMcpConfig`.
			projectConfigured: claude.configured,
			projectManaged: claude.managed,
			projectRepairPaused: claude.paused
		}
	};
}
