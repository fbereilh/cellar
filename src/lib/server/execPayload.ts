/**
 * Cellar - `func?` / `func??`, i.e. the `page` PAYLOADS on an execute reply.
 *
 * IPython answers `?` and `??` ITSELF, at execute time, and returns the answer in
 * a place nothing else in a notebook uses: `execute_reply`'s `content.payload`,
 * an array of `{source, ...}` entries, of which the documentation one is
 * `{source: 'page', data: <mime bundle>, start: 0}`. It emits NO iopub output for
 * it at all (measured against a real ipykernel: `len?` produces `status`,
 * `execute_input`, `status` and nothing else), so a client that renders only
 * iopub - which Cellar was - shows the user a cell that ran successfully and said
 * nothing.
 *
 * WHAT THIS FILE DOES is translate that one payload shape into an ordinary
 * nbformat `display_data` output. It is the shell-channel sibling of `kernel.ts`'s
 * iopub switch, and lives beside it for the same reason: translating a Jupyter
 * wire message into an nbformat output is ONE job, and `execute()` is where it is
 * done, so every caller of `execute()` - the UI run route, MCP `run_cell`, the
 * imports cell - inherits it without a second rule.
 *
 * WHY AN OUTPUT AND NOT THE SHIFT+TAB TOOLTIP (`$lib/kernelDocTooltip`), which is
 * the other place Cellar shows kernel documentation. They answer questions asked
 * at different moments with different lifetimes, and three of the tooltip's
 * defining properties are wrong here:
 *
 *   - It is anchored to a CARET and dismisses on any caret move, any edit, blur
 *     and Escape. `?` is answered by RUNNING the cell, which is a deliberate act
 *     whose answer the user expects to still be there after they click elsewhere,
 *     scroll away, or reload the notebook.
 *   - It CANNOT be selected with the mouse: it cancels `mousedown` so a scrollbar
 *     drag is not read as a blur, which also suppresses drag-selection. `func??`
 *     on a real library function is hundreds of lines the user wants to copy.
 *   - It has no place to persist. An output rides the cell: it is scrollable
 *     (the per-cell output scroll box), selectable, covered by the cell's own
 *     copy-output button, capped with a VISIBLE truncation marker by
 *     `OutputAccumulator`, and it reaches an MCP agent through the same read
 *     tools every other output does.
 *
 * Classic Jupyter puts this in a pager rather than a tooltip for the same
 * reasons, and VS Code's notebooks render it as cell output.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *   - It does not touch a NAME THAT DOES NOT EXIST. IPython answers that on iopub
 *     as an ordinary stdout stream ("Object `foo` not found."), which Cellar has
 *     always rendered; there is no payload, so nothing here fires and the honest
 *     sentence the kernel wrote is what the user reads. Do not "improve" that
 *     into a synthesized message: the kernel's is already clear, and inventing
 *     one would claim a lookup Cellar never performed.
 *   - It does not transform any cell source. `?` is IPython's own input
 *     transformation, so this only ever renders what IPython CHOSE to answer -
 *     which is why a SQL, mojo, markdown, raw or chat cell is untouched by
 *     construction rather than by a check: their source never reaches IPython's
 *     transformer as Python, so no `page` payload is ever produced for them.
 *   - It handles ONLY `source: 'page'`. The other payload sources a kernel may
 *     send (`set_next_input` from `%load`/`%recall`, `ask_exit`) are ignored
 *     exactly as they are today - never rendered, and never a throw.
 */

import { stripAnsi } from '../outputText';
import type { DisplayDataOutput, MimeBundle } from './types';

/** The one payload source this renders. Everything else is ignored. */
export const PAGE_PAYLOAD_SOURCE = 'page';

/**
 * nbformat mime values are `string | string[]`; anything else (a JSON payload for
 * `application/json`, say) is passed through untouched.
 *
 * ANSI is stripped from `text/plain` and only from it, on the SERVER, because
 * this output is PERSISTED: IPython formats its pager text for a terminal (the
 * probe above shows `Signature:` / `Docstring:` / `Source:` labels in SGR red, and
 * `??` syntax-highlights the source), and no other notebook tool strips it, so a
 * saved `.ipynb` carrying raw escapes would render as garbage in JupyterLab.
 * Stripping is the same choice `Cell.svelte` already makes for tracebacks, which
 * come from the same IPython formatter - the stated cost being that the colour is
 * lost rather than converted to markup.
 *
 * Deliberately `stripAnsi` (SGR only) rather than `terminal.ts`'s `reduceFull`:
 * that is a VT screen emulator for output driven by a terminal-style writer, and
 * this text has no cursor motion at all, so re-flowing it through a screen model
 * would rewrite lines nothing moved.
 */
function cleanMimeValue(mime: string, value: unknown): unknown {
	if (mime !== 'text/plain') return value;
	if (typeof value === 'string') return stripAnsi(value);
	if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? stripAnsi(v) : v));
	return value;
}

/** True when a mime bundle carries something worth rendering. */
function hasContent(data: MimeBundle): boolean {
	return Object.values(data).some((v) => {
		if (typeof v === 'string') return v.trim() !== '';
		if (Array.isArray(v)) return v.join('').trim() !== '';
		return v != null;
	});
}

/**
 * The `display_data` outputs a reply's `page` payloads become, in wire order.
 *
 * Takes the reply CONTENT (or anything at all) and never throws: this runs on the
 * settle path of every execute in the app, so a kernel sending a shape nobody
 * anticipated must cost nothing more than an ignored payload. An entry whose
 * bundle would render as an empty box is dropped rather than emitted - a mute
 * output is worse than none.
 */
export function pagePayloadOutputs(content: unknown): DisplayDataOutput[] {
	const payload = (content as { payload?: unknown } | null | undefined)?.payload;
	if (!Array.isArray(payload)) return [];
	const outputs: DisplayDataOutput[] = [];
	for (const entry of payload) {
		if (!entry || typeof entry !== 'object') continue;
		const e = entry as { source?: unknown; data?: unknown };
		if (e.source !== PAGE_PAYLOAD_SOURCE) continue;
		if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) continue;
		const data: MimeBundle = {};
		for (const [mime, value] of Object.entries(e.data as Record<string, unknown>)) {
			data[mime] = cleanMimeValue(mime, value);
		}
		if (!hasContent(data)) continue;
		outputs.push({ output_type: 'display_data', data, metadata: {} });
	}
	return outputs;
}
