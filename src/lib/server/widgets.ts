/**
 * Cellar — minimal Jupyter Widgets (ipywidgets) state store, scoped to tqdm.
 *
 * `tqdm.notebook` / `tqdm.auto` render their progress bar as a small tree of
 * ipywidgets models, pushed kernel→frontend over the comm protocol on iopub:
 *
 *   1. `comm_open` (target `jupyter.widget`) with the initial model state — tqdm
 *      opens an `HBox` holding two `HTML`/`Label`s and an `IntProgress`/
 *      `FloatProgress`, the box's `children` referencing the others by model id.
 *   2. `comm_msg` with `data.method === 'update'` carrying the changed traits
 *      (the progress `value`, the label `value`) as the loop advances.
 *   3. A `display_data` carrying the mimetype
 *      `application/vnd.jupyter.widget-view+json` = `{ model_id }`, the output
 *      that says "render widget model `model_id` here".
 *
 * This store is the server-side RECEIVE half: `kernel.ts` registers a comm target
 * for `jupyter.widget` and feeds every open/update/close here; each mutation is
 * rebroadcast over the SSE bus (`events.ts`) so an already-open browser reflects a
 * live-advancing bar / a widget's changed value with no rerun. The SEND half (the
 * return direction interactive widgets need) lives in `kernel.ts`'s
 * `sendWidgetComm` + the `/api/widgets/<comm_id>` route: a browser interaction
 * forwards a `comm_msg` to the kernel, which fires the widget's callbacks; the
 * resulting state flows back in here. `updateWidget` is also called by that route
 * to optimistically broadcast a frontend-originated change to other tabs (the
 * kernel does not echo those back as a plain `update`).
 *
 * State is per kernel session and purely runtime: cleared on every session
 * change (a fresh namespace has no widgets), never persisted to the `.ipynb`
 * (clean.ts strips the volatile widget output + the `metadata.widgets` blob).
 * Binary comm buffers are ignored — tqdm's widget state is all JSON.
 */
import { publishGlobal } from './events';
import type { WidgetModel, WidgetSnapshot } from './types';

/** comm_id → current merged model state. One map for the live kernel session. */
const models = new Map<string, WidgetModel>();

/**
 * `Output` widget capture routing. An `Output` widget (the result area an
 * `interact`/`interactive` builds) does NOT sync its rendered outputs over its
 * comm's `outputs` trait; instead it publishes a `msg_id` trait naming a kernel
 * message, and every iopub output whose `parent_header.msg_id` matches is meant
 * to be captured into that widget. `kernel.ts`'s iopub handler feeds those here.
 *
 *   msgIdToComm:  the captured kernel msg_id  → the Output widget's comm_id
 *   commToMsgId:  the Output widget's comm_id → its current captured msg_id
 *   pendingClear: comm_ids with a `clear_output(wait=True)` armed (clear on the
 *                 next appended output, so interact's re-run doesn't flicker empty)
 */
const msgIdToComm = new Map<string, string>();
const commToMsgId = new Map<string, string>();
const pendingClear = new Set<string>();

/** Every widget model currently known, for seeding a freshly-connected tab. */
export function widgetSnapshot(): WidgetSnapshot {
	return { models: [...models.values()] };
}

/**
 * A `comm_open` for `jupyter.widget`: record the model's initial state. `state`
 * carries `_model_name` (e.g. `IntProgressModel`, `HTMLModel`, `HBoxModel`),
 * which is how the frontend picks a renderer.
 */
export function openWidget(commId: string, state: Record<string, unknown>): void {
	const model: WidgetModel = { comm_id: commId, state: { ...state } };
	models.set(commId, model);
	publishGlobal({ type: 'widget:open', comm_id: commId, state: model.state });
}

/**
 * A `comm_msg` `update`: merge the changed traits onto the stored state (tqdm
 * pushes just `value` / the label text each tick) and rebroadcast the delta.
 * An update for an unknown comm is stored as-is so a late-registered model still
 * renders — over-keeping is the safe direction for display-only state.
 */
export function updateWidget(commId: string, state: Record<string, unknown>): void {
	const prev = models.get(commId);
	const merged: WidgetModel = { comm_id: commId, state: { ...(prev?.state ?? {}), ...state } };
	models.set(commId, merged);
	publishGlobal({ type: 'widget:update', comm_id: commId, state });
}

/**
 * A `comm_close`. We KEEP the last state (a finished `leave=True` tqdm bar must
 * still render its final 100%); closing only ends live updates. The event lets
 * the client stop expecting more.
 */
export function closeWidget(commId: string): void {
	if (!models.has(commId)) return;
	publishGlobal({ type: 'widget:close', comm_id: commId });
}

/**
 * An `Output` widget's `msg_id` trait changed (seen on `comm_open`/`comm_msg`).
 * Point the named kernel message at this Output's comm so its captured outputs
 * route here; an empty `msgId` just stops capture (the widget keeps its outputs).
 */
export function setOutputCapture(commId: string, msgId: unknown): void {
	const prev = commToMsgId.get(commId);
	if (prev) msgIdToComm.delete(prev);
	if (typeof msgId === 'string' && msgId) {
		commToMsgId.set(commId, msgId);
		msgIdToComm.set(msgId, commId);
	} else {
		commToMsgId.delete(commId);
	}
}

/** The Output widget capturing kernel message `msgId`, or undefined. */
export function outputCommForMsg(msgId: string | undefined): string | undefined {
	return msgId ? msgIdToComm.get(msgId) : undefined;
}

/** Append one nbformat output to an Output widget, honoring an armed clear. */
export function appendWidgetOutput(commId: string, output: Record<string, unknown>): void {
	const prev = models.get(commId);
	let outputs = Array.isArray(prev?.state?.outputs) ? [...(prev!.state.outputs as unknown[])] : [];
	if (pendingClear.has(commId)) {
		outputs = [];
		pendingClear.delete(commId);
	}
	outputs.push(output);
	const merged: WidgetModel = { comm_id: commId, state: { ...(prev?.state ?? {}), outputs } };
	models.set(commId, merged);
	publishGlobal({ type: 'widget:update', comm_id: commId, state: { outputs } });
}

/**
 * A `clear_output` for an Output widget. `wait:true` (interact's re-run) defers
 * the clear until the next output arrives, so the area never flickers empty.
 */
export function clearWidgetOutput(commId: string, wait: boolean): void {
	if (wait) {
		pendingClear.add(commId);
		return;
	}
	const prev = models.get(commId);
	const merged: WidgetModel = { comm_id: commId, state: { ...(prev?.state ?? {}), outputs: [] } };
	models.set(commId, merged);
	publishGlobal({ type: 'widget:update', comm_id: commId, state: { outputs: [] } });
}

/**
 * Drop every widget model — called on a kernel session change (start / restart /
 * rebind / autorestart), where the namespace and thus every widget is gone.
 */
export function resetWidgets(): void {
	msgIdToComm.clear();
	commToMsgId.clear();
	pendingClear.clear();
	if (!models.size) return;
	models.clear();
	publishGlobal({ type: 'widget:clear' });
}
