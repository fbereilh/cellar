/**
 * Cellar - the shared vocabulary for LIVE-KERNEL editor introspection.
 *
 * Two Jupyter behaviours ride Jupyter's own SHELL channel rather than the
 * execute bridge: `complete_request` (Tab completion that knows the running
 * namespace) and `inspect_request` (the Shift+Tab documentation tooltip). This
 * module holds only what BOTH sides need - the wire shapes, the refusal
 * vocabulary and its wording, and the Jedi-type mapping - so the server
 * (`$lib/server/kernel`) and the editor (`$lib/kernelCompletion`,
 * `$lib/kernelDocTooltip`) can never describe one kernel differently. Pure and
 * browser-safe: no DOM, no `$lib/server`.
 *
 * WHY THE SHELL CHANNEL, NOT AN EXECUTE PROBE. `inspect.ts` sets the opposite
 * house precedent (introspect by running a Python probe through `execute()`),
 * and it is right for what it does - a namespace snapshot, on demand, once. It
 * is the wrong shape here, and the reasons were MEASURED against a real
 * ipykernel 7.3 / IPython 9.15 rather than assumed:
 *
 *   1. BOTH approaches queue behind a running cell. The kernel's shell channel
 *      is single-threaded, so a `complete_request` sent while an 8s cell runs
 *      answered in 7.55s - exactly what an `execute` probe would have done.
 *      Queueing is therefore NOT the discriminator; what queueing COSTS is.
 *   2. A probe additionally takes Cellar's per-kernel exec lock (`execChain`),
 *      so the user's NEXT run parks behind a tooltip. A shell request touches
 *      neither that lock nor the run queue, so a completion can never delay a
 *      cell. That asymmetry is the whole decision.
 *   3. A probe EXECUTES code in the user's kernel, at keystroke frequency. On a
 *      Databricks-backed kernel that is a remote round trip and a namespace
 *      write risk for something as trivial as a tooltip.
 *   4. `inspect_request`'s `detail_level` 0 -> 1 IS the Shift+Tab escalation
 *      (measured: 266 -> 424 chars, gaining `Source:`), and `complete_request`
 *      returns `cursor_start`/`cursor_end`, i.e. the exact replacement range.
 *      Reproducing either through a probe means reimplementing IPython's own
 *      `_inspect` and completer - and both work for a non-IPython kernel, which
 *      a Python probe cannot.
 *
 * Neither request may ever START a kernel: a tooltip must not boot a Python
 * process. That, and every refusal below, is decided server-side; this module
 * only names the outcomes.
 */

/**
 * Why a kernel could not answer. Each names a DISTINCT fact rather than a
 * generic failure, because the tooltip states the reason to the user and a
 * wrong one sends them to fix something that is not wrong - the same
 * assert-only-what-was-observed rule the interrupt and watchdog paths follow.
 *
 * `busy` in particular means the request was NOT SENT: it would have queued in
 * the kernel behind the running cell, so Cellar declines rather than making the
 * user wait out someone else's Spark query for a tooltip.
 */
export type IntrospectRefusal =
	| 'no_kernel'
	| 'busy'
	| 'busy_timeout'
	| 'restarting'
	| 'dead'
	| 'not_ready'
	| 'not_connected'
	| 'timeout'
	| 'failed';

/** One completion candidate: the text to insert plus the kernel's own type name. */
export interface KernelMatch {
	text: string;
	/** IPython's `_jupyter_types_experimental` type, or null when the kernel offered none. */
	type: string | null;
}

/** A `complete_reply` the kernel answered. */
export interface CompleteOk {
	ok: true;
	matches: KernelMatch[];
	/** Replacement range in the submitted code, from the protocol's own fields. */
	cursorStart: number;
	cursorEnd: number;
}

/** An `inspect_reply` the kernel answered. `found: false` is a real answer, not a refusal. */
export interface InspectOk {
	ok: true;
	found: boolean;
	/** `data['text/plain']`, ANSI-stripped (Cellar renders tracebacks the same way). */
	text: string;
	/** The `detail_level` this text was produced at, echoed so the client can escalate. */
	detail: 0 | 1;
}

/** Nothing was asked, or nothing came back. */
export interface IntrospectRefused {
	ok: false;
	reason: IntrospectRefusal;
}

export type CompleteOutcome = CompleteOk | IntrospectRefused;
export type InspectOutcome = InspectOk | IntrospectRefused;

/**
 * The editor's handle on ONE notebook's kernel. `LiveNotebook` builds it (it is
 * the only layer that knows the notebook path) and drills it to `Cell`, so the
 * CodeMirror extensions stay transport-free and unit-testable against a fake.
 */
export interface KernelIntrospectHandle {
	complete(code: string, cursorPos: number, signal?: AbortSignal): Promise<CompleteOutcome>;
	inspect(code: string, cursorPos: number, detail: 0 | 1, signal?: AbortSignal): Promise<InspectOutcome>;
}

/**
 * What to tell the user when the kernel could not answer.
 *
 * Only the Shift+Tab tooltip renders these - completion refusals are SILENT by
 * design, because it fires at keystroke frequency and the file-local completer
 * has already answered. Each sentence claims exactly what was observed: `busy`
 * says the kernel was not asked, `timeout` says it was asked and did not reply.
 */
export function refusalMessage(reason: IntrospectRefusal): string {
	switch (reason) {
		case 'no_kernel':
			return 'No kernel is running for this notebook yet - run a cell to start one.';
		case 'busy':
			return 'The kernel is busy running a cell, so it was not asked.';
		case 'busy_timeout':
			// Deliberately NOT 'the kernel is busy': no cell of the user's is running.
			// Cellar's own background work held the kernel and Cellar stopped waiting
			// for it, which is a different fact and a different thing to do about it.
			return 'Cellar gave up waiting for its own background work on this kernel - try again in a moment.';
		case 'restarting':
			return 'The kernel is restarting.';
		case 'dead':
			return 'The kernel is not running.';
		case 'not_ready':
			return 'The kernel is not ready to answer yet.';
		case 'not_connected':
			return 'Cellar is not connected to the kernel right now.';
		case 'timeout':
			return 'The kernel did not answer in time.';
		case 'failed':
			return 'Cellar could not ask the kernel.';
	}
}

// --- Offsets: UTF-16 code units (JS) vs unicode code points (the protocol) ---
//
// Jupyter's messaging spec counts `cursor_pos` - and the `cursor_start`/`cursor_end`
// that come back - in unicode CHARACTERS, because the kernel is Python and Python
// slices strings by code point. A CodeMirror document offset is a UTF-16 code unit
// index. The two agree for everything on the BMP and diverge by one per astral
// character, so a single emoji in a comment above the caret is enough to make the
// kernel complete a different span of the cell than the editor is looking at - and
// it degrades silently, as a completion that replaces the wrong characters.
//
// Both helpers walk the string with `for...of`, which iterates code points, so they
// are exact rather than an estimate. They are O(offset); the cost is a scan of the
// text BEFORE the caret on a path that already does a round trip, and the common
// all-BMP case is a plain counted walk with no allocation.

/** A UTF-16 offset into `text` as the code-point offset the kernel expects. */
export function toCodePointOffset(text: string, utf16Offset: number): number {
	if (utf16Offset <= 0) return 0;
	let units = 0;
	let points = 0;
	for (const ch of text) {
		if (units >= utf16Offset) break;
		units += ch.length;
		points += 1;
	}
	return points;
}

/**
 * A code-point offset from the kernel as a UTF-16 offset into `text`, or null when
 * it is out of range.
 *
 * Null rather than a clamp on purpose: this feeds a REPLACEMENT range, so an
 * out-of-range value means the kernel and the editor disagree about the text, and
 * quietly picking the nearest legal span would edit code the kernel never named.
 */
export function fromCodePointOffset(text: string, codePointOffset: number): number | null {
	if (codePointOffset < 0) return null;
	if (codePointOffset === 0) return 0;
	let units = 0;
	let points = 0;
	for (const ch of text) {
		units += ch.length;
		points += 1;
		if (points === codePointOffset) return units;
	}
	return points === codePointOffset ? units : null;
}

/**
 * Jedi's type name -> a CodeMirror completion type (which picks the option icon).
 *
 * MAPPED, NEVER PASSED THROUGH, and the reason is dedupe rather than icons.
 * CodeMirror merges the results of every completion source and drops a duplicate
 * only when label, `detail`, `apply`, `boost` AND `type` all agree (a null type
 * on either side counts as agreement). `@codemirror/lang-python`'s own sources
 * emit `variable` / `function` / `class` / `keyword`, so a kernel match for a
 * name they also know - `print`, or a file-local name that has been run - is
 * deduped only if we speak the SAME vocabulary. That is also why the kernel
 * options carry no `detail` and no `boost`: either one would defeat the dedupe
 * and show the name twice.
 *
 * An unrecognised or absent type maps to undefined (no icon) rather than being
 * invented, which keeps the dedupe working for a non-IPython kernel too.
 */
export function completionType(kernelType: string | null | undefined): string | undefined {
	switch (kernelType) {
		case 'function':
			return 'function';
		case 'class':
			return 'class';
		case 'module':
			return 'namespace';
		case 'keyword':
			return 'keyword';
		case 'instance':
		case 'param':
		case 'statement':
			return 'variable';
		case 'property':
			return 'property';
		case 'path':
			return 'text';
		default:
			// `<unknown>` (Jedi could not infer), a type we do not model, or a kernel
			// that sent no metadata at all.
			return undefined;
	}
}
