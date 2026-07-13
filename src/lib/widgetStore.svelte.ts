/**
 * Cellar — client-side ipywidgets model store (tqdm progress bars).
 *
 * A single reactive singleton keyed by model id (the comm id). It is fed the
 * `widget:*` global SSE events (dispatched from every mounted `LiveNotebook`,
 * idempotently, since the store is shared) and read by `WidgetOutput.svelte`,
 * which renders the `application/vnd.jupyter.widget-view+json` output by looking
 * up its `model_id` here. Model ids are unique per kernel session, so one global
 * store serves every open notebook.
 *
 * Two-way: we receive kernel→frontend state and render it live, and interactive
 * widgets send changes back through `$lib/widgetActions` (the values here are
 * updated optimistically via `setWidgetTrait`, then reconciled by the kernel's
 * reply over SSE). Purely runtime — nothing here is persisted.
 */
import { SvelteMap } from 'svelte/reactivity';

/** A widget model's raw trait state (`_model_name`, `value`, `children`, …). */
export type WidgetState = Record<string, unknown>;

/** Reactive: mutations re-run the `$derived` model lookups in `WidgetOutput`. */
const models = new SvelteMap<string, WidgetState>();

/** The live state for a widget model id, or `undefined` until its comm opens. */
export function getWidgetState(id: string): WidgetState | undefined {
	return models.get(id);
}

/**
 * Optimistically merge a trait change into the local model — used the instant a
 * user drives a control, so the readout / thumb follows without waiting for the
 * POST → kernel → SSE round-trip. The authoritative value still arrives over SSE
 * (our own broadcast, or a kernel-side clamp) and reconciles on top. No-op for an
 * unknown model. Writes a fresh object so the `$derived` lookups re-run.
 */
export function setWidgetTrait(id: string, patch: WidgetState): void {
	const cur = models.get(id);
	if (!cur) return;
	models.set(id, { ...cur, ...patch });
}

/** The ipywidgets model class of a state bundle, e.g. `IntProgress`, `HBox`. */
export function widgetModelName(state: WidgetState | undefined): string {
	const n = state?._model_name;
	return typeof n === 'string' ? n.replace(/Model$/, '') : '';
}

/** A `widget:*` global event as it arrives from the SSE bus. */
type WidgetEvent =
	| { type: 'widget:sync'; models?: { comm_id: string; state: WidgetState }[] }
	| { type: 'widget:open'; comm_id: string; state: WidgetState }
	| { type: 'widget:update'; comm_id: string; state: WidgetState }
	| { type: 'widget:close'; comm_id: string }
	| { type: 'widget:clear'; comm_ids?: string[] };

/** Whether an event is one this store handles. */
export function isWidgetEvent(ev: { type?: string }): boolean {
	return typeof ev.type === 'string' && ev.type.startsWith('widget:');
}

/**
 * Apply a widget SSE event to the store. `sync` (seeded on SSE connect) replaces
 * the whole set; `open`/`update` merge; `clear` (a kernel session change) empties
 * it. `close` is a no-op — a finished tqdm bar keeps its final state so it stays
 * rendered. Each mutation writes a *new* state object so the reactive lookup
 * fires even on an in-place trait change (the progress `value` ticking up).
 */
export function applyWidgetEvent(ev: WidgetEvent): void {
	switch (ev.type) {
		case 'widget:sync':
			models.clear();
			for (const m of ev.models ?? []) models.set(m.comm_id, { ...m.state });
			break;
		case 'widget:open':
			models.set(ev.comm_id, { ...ev.state });
			break;
		case 'widget:update':
			models.set(ev.comm_id, { ...(models.get(ev.comm_id) ?? {}), ...ev.state });
			break;
		case 'widget:clear':
			// `comm_ids` present → one notebook's kernel restarted; drop only its
			// widgets. Bare `clear` empties everything (a full reset).
			if (ev.comm_ids) {
				for (const id of ev.comm_ids) models.delete(id);
			} else {
				models.clear();
			}
			break;
		case 'widget:close':
			// Keep the model so a completed (leave=True) bar still renders.
			break;
	}
}
