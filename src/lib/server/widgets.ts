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
 * This store is the server half: `kernel.ts` registers a comm target for
 * `jupyter.widget` and feeds every open/update/close here; each mutation is
 * rebroadcast over the SSE bus (`events.ts`) so an already-open browser reflects
 * a live-advancing bar with no rerun. It is DISPLAY-ONLY — we receive state, we
 * never send widget interaction back to the kernel — which is all tqdm needs.
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
 * Drop every widget model — called on a kernel session change (start / restart /
 * rebind / autorestart), where the namespace and thus every widget is gone.
 */
export function resetWidgets(): void {
	if (!models.size) return;
	models.clear();
	publishGlobal({ type: 'widget:clear' });
}
