/**
 * Cellar - Mojo cell execution (compile Mojo -> the `%%mojo` cell magic that runs it).
 *
 * A mojo cell stores BARE Mojo as its source (see `$lib/cellLanguage.ts`), but the
 * kernel is a PYTHON kernel: Modular ships no Mojo Jupyter kernel, and the current,
 * official and only supported Mojo notebook workflow is a Python kernel plus a
 * `%%mojo` CELL MAGIC that `import mojo.notebook` registers. So at RUN time - and
 * only at run time - the source is compiled to that magic. The cell's stored source
 * stays Mojo; this compilation is invisible to the document and to git. Exactly the
 * `server/sql.ts` shape, for exactly its reason.
 *
 * WHY THE MAGIC AND NOT A MOJO KERNEL. The one third-party Mojo kernel that exists
 * is unofficial, stale, and - measured against a live kernel - is wedged permanently
 * by Cellar's own startup injections: `import sys` alone is meaningless in Mojo, and
 * the DataFrame formatter never returns at all, after which the kernel stops
 * answering. That is not a kernel bug: every kernel-side mechanism Cellar injects is
 * Python-shaped and has no Mojo equivalent. Do not revisit this without an OFFICIAL
 * Modular kernel and a fresh measurement of that injection block.
 *
 * WHAT THE MAGIC IS, AND THE THREE CONSEQUENCES THAT ARE MODULAR'S, NOT CELLAR'S.
 * `mojo/notebook.py` is ~58 lines: write the cell body to a fresh temp file, run
 * `mojo run <file>` in a SUBPROCESS with `capture_output=True`, print the captured
 * stdout, delete the temp dir. Therefore:
 *   - **No state persists between Mojo cells.** The subprocess and its whole
 *     namespace die with the cell, which is why Modular's docs say every Mojo cell
 *     must be a complete program with a `main()`. Cellar STATES this (the badge
 *     tooltip and the type-menu hint) rather than faking continuity, and
 *     `hasPythonDataflow` keeps such a cell out of the dependency graph entirely so
 *     nothing downstream ever claims a Mojo cell defined something.
 *   - **Output is fully buffered.** `capture_output=True` means a long Mojo cell
 *     shows nothing until it finishes; the run watchdog is safe here (the kernel is
 *     genuinely busy inside `subprocess.run`, and the watchdog only probes).
 *   - **A compile error arrives as a Python exception** (`MojoCompilationError`)
 *     whose text names a temp path that no longer exists. Left as-is: rewriting a
 *     compiler diagnostic is a separate feature, and a wrong rewrite is worse than a
 *     verbose right one. The line/column ARE cell-relative (the body is written
 *     verbatim with no preamble), so a future rewrite is a path substitution.
 *
 * WHY A PRE-FLIGHT RATHER THAN A STARTUP INJECTION. The magic exists only after
 * `import mojo.notebook`, and `max` is a 534 MB, 16-package dependency Cellar
 * deliberately never installs (`venv.js` adds only `ipykernel` and `ipywidgets`).
 * Importing it from `initKernel` would put that import in front of EVERY kernel
 * start for every user; sending `%%mojo` without it yields IPython's bare
 * `UsageError: Cell magic function %%mojo not found`, which tells the user nothing
 * about the toolchain. So `kernel.ts`'s `ensureMojoMagic` runs `MOJO_SETUP_CODE`
 * once, lazily, the first time a mojo cell runs in a session, and a MISSING
 * toolchain becomes `mojoMissingOutput`'s actionable instruction instead of a
 * traceback. Detect-and-instruct: Cellar never installs `max` itself.
 */

import { cellMagicName } from './magics';
import type { SessionId } from './types';

/** The IPython cell magic a mojo cell compiles to. */
export const MOJO_MAGIC = 'mojo';

/** The header line `mojoToCellSource` prepends when the source has none. */
export const MOJO_MAGIC_HEADER = `%%${MOJO_MAGIC}`;

/** The pip/uv package that provides both `mojo` and the `mojo.notebook` magic. */
export const MOJO_PACKAGE = 'max';

/** The command a user runs to install the toolchain into the project venv. */
export const MOJO_INSTALL_COMMAND = `uv pip install ${MOJO_PACKAGE}`;

/** Marker the setup probe prints its one JSON line behind (the `inspect.ts` convention). */
export const MOJO_SETUP_MARKER = '__CELLAR_MOJO__';

/**
 * Compile a mojo cell's source into what the kernel is sent: the `%%mojo` cell
 * magic with the Mojo source as its body. Returns '' for an empty cell (nothing
 * to run), so an empty mojo cell is the no-op an empty Python cell is.
 *
 * A source that ALREADY opens with a `%%mojo` header is passed through verbatim,
 * for two reasons rather than tidiness: pasting an example straight out of
 * Modular's docs (which show the magic) must not produce a doubled header that
 * IPython reads as one magic whose body starts with `%%mojo`; and the magic takes
 * a SUBCOMMAND (`%%mojo build --emit shared-lib -o m.so`), which is the only way
 * to reach anything but `mojo run` and would be unreachable if this always
 * prepended a bare header. The check is `%%mojo` on the first non-blank line -
 * IPython's own rule for where a cell magic may sit - so a `%%mojo` appearing
 * anywhere else is ordinary Mojo text and is wrapped normally.
 */
export function mojoToCellSource(mojoSource: string | null | undefined): string {
	const raw = String(mojoSource ?? '');
	if (raw.trim() === '') return '';
	if (hasMojoHeader(raw)) return raw;
	return `${MOJO_MAGIC_HEADER}\n${raw}`;
}

/**
 * Does this source already open with a `%%mojo` header?
 *
 * Asked through `magics.ts`'s `cellMagicName` - the ONE owner of "which cell magic
 * does this cell open with", including IPython's rule that it must sit on the first
 * non-blank line. A local regex here would be a second copy of that rule, and it is
 * the same rule `normalizeForAnalysis` and `isCellMagicCell` key off, so the two
 * must not be able to disagree about what a `%%mojo` cell is.
 */
export function hasMojoHeader(source: string | null | undefined): boolean {
	return cellMagicName(source) === MOJO_MAGIC;
}

/**
 * What the setup probe found. `ready` is the ONLY thing that may gate a run: a
 * probe that could not run at all is NOT `ready` and reports its own `detail`,
 * because "we could not tell" must never read as "the toolchain is there".
 */
export interface MojoSetup {
	/** `import mojo.notebook` succeeded, so the `%%mojo` magic is registered in this session. */
	ready: boolean;
	/** The `mojo` version string, when the toolchain reported one. */
	version?: string;
	/** Why it is not ready - the exception text, for the instruction below. */
	detail?: string;
	/**
	 * The kernel-session epoch the probe EXECUTED in, filled in by `kernel.ts`'s
	 * `ensureMojoMagic` (the parser above cannot know it). It is what a run refused
	 * for a missing toolchain is stamped with: the kernel was alive and this probe
	 * ran in it, so the failure is LIVE, not a leftover from a previous session -
	 * the `lastRun` doctrine, applied to the one run path that never reaches
	 * `execute()` and so never sees a `kernel` event of its own. Absent when no
	 * session could be read.
	 */
	session?: SessionId | null;
}

/**
 * Register the `%%mojo` magic in the kernel and report whether it took.
 *
 * Run through `runCapture` as a SILENT, INTERNAL execute (never a queued run), so
 * it neither appears in the notebook nor counts toward `execs_this_session`. It
 * prints exactly ONE marker line and never raises - the `databricks.ts` PROBE
 * convention - so an ImportError, a broken install and a working one are all one
 * parse rather than three code paths.
 *
 * `importlib.invalidate_caches()` first is load-bearing: the common recovery from
 * a missing toolchain is `uv pip install max` INTO THE VENV THIS KERNEL IS ALREADY
 * RUNNING, and Python caches directory listings per `sys.path` entry, so without
 * it the newly-installed package stays invisible until a kernel restart and the
 * instruction Cellar just printed would appear not to work.
 */
export const MOJO_SETUP_CODE = `
def _cellar_mojo_setup():
    import json
    out = {"ready": False}
    try:
        import importlib
        importlib.invalidate_caches()
        import mojo.notebook  # registers the %%mojo cell magic
        out["ready"] = True
        try:
            # The mojo PACKAGE carries no __version__ (verified against max 26.5.0
            # / Mojo 1.0.0); the DISTRIBUTION that ships it does, and reading it costs
            # no subprocess. Diagnostic only - never gates the run.
            from importlib.metadata import version as _version
            out["version"] = str(_version("${MOJO_PACKAGE}"))
        except Exception:
            pass
    except BaseException as e:
        out["detail"] = f"{type(e).__name__}: {e}"
    print("${MOJO_SETUP_MARKER} " + json.dumps(out))

try:
    _cellar_mojo_setup()
finally:
    del _cellar_mojo_setup
`.trim();

/**
 * Read the probe's one marker line. Anything unparseable is NOT ready and says so
 * - the fail-closed direction, since the only cost of a false negative is an
 * instruction the user can ignore, while a false positive sends `%%mojo` to a
 * kernel that has no such magic and returns IPython's opaque `UsageError`.
 */
export function parseMojoSetup(stdout: string | null | undefined): MojoSetup {
	const line = String(stdout ?? '')
		.split('\n')
		.reverse()
		.find((l) => l.trimStart().startsWith(MOJO_SETUP_MARKER));
	if (!line) return { ready: false, detail: 'the Mojo setup probe produced no output' };
	try {
		const parsed = JSON.parse(line.trimStart().slice(MOJO_SETUP_MARKER.length)) as Partial<MojoSetup>;
		if (parsed?.ready !== true) {
			return { ready: false, ...(typeof parsed?.detail === 'string' ? { detail: parsed.detail } : {}) };
		}
		return { ready: true, ...(typeof parsed?.version === 'string' ? { version: parsed.version } : {}) };
	} catch {
		return { ready: false, detail: 'the Mojo setup probe returned unreadable output' };
	}
}

/**
 * The message a user sees when a mojo cell is run without the toolchain: what is
 * missing, the exact command that fixes it, and how big it is - because a 534 MB
 * download the user did not choose is precisely what "detect and instruct, never
 * auto-install" exists to prevent. It names the PROJECT environment, since that
 * is the venv this kernel runs in and the one `uv pip install` must reach.
 */
export function mojoMissingMessage(setup: MojoSetup): string {
	const detail = setup.detail ? `\n\nThe kernel reported: ${setup.detail}` : '';
	return (
		`This is a Mojo cell, but the Mojo toolchain is not available in this project's Python environment, ` +
		`so the \`${MOJO_MAGIC_HEADER}\` magic that runs Mojo could not be registered.\n\n` +
		`Install it into the project venv and run the cell again:\n\n` +
		`    ${MOJO_INSTALL_COMMAND}\n\n` +
		`Cellar deliberately does not install it for you: \`${MOJO_PACKAGE}\` is a large download ` +
		`(~534 MB across 16 packages), far beyond the small packages Cellar adds on its own.` +
		detail
	);
}

/** That message as a cell error output, so it renders where the user is looking. */
export function mojoMissingOutput(setup: MojoSetup): {
	output_type: 'error';
	ename: string;
	evalue: string;
	traceback: string[];
} {
	const message = mojoMissingMessage(setup);
	return { output_type: 'error', ename: 'MojoToolchainMissing', evalue: message, traceback: [message] };
}
