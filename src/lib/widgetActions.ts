/**
 * Cellar — browser → kernel ipywidgets interaction (the send direction).
 *
 * When the user drives an interactive widget, the frontend must push the change
 * back to the model living in the kernel so ipywidgets updates the Python trait
 * and fires its `observe`/`interact` callbacks. That goes through
 * `POST /api/widgets/<comm_id>`; the kernel's reply (changed traits, an `interact`
 * Output re-run) flows back over the existing SSE receive path into the store.
 *
 * Continuous controls (a slider drag) fire a stream of `input` events, so their
 * sends are throttled — leading + trailing, merging pending traits per comm — to
 * a modest rate the kernel can absorb. `flushWidgetUpdate` (a slider release, or
 * any discrete change) cancels the throttle and sends the final value at once so
 * the last value always wins.
 */

const THROTTLE_MS = 80;

/** Merged, not-yet-sent trait patches per comm (the trailing-edge payload). */
const pending = new Map<string, Record<string, unknown>>();
/** An in-flight throttle window per comm; while set, sends are trailing-only. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function post(commId: string, body: Record<string, unknown>): void {
	// Fire-and-forget: the meaningful result comes back over SSE, not this response.
	fetch(`/api/widgets/${encodeURIComponent(commId)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	}).catch(() => {});
}

/** Send a value change immediately (no throttle). */
export function sendWidgetUpdate(commId: string, state: Record<string, unknown>): void {
	post(commId, { method: 'update', state });
}

/** Send a Button click (`on_click` handlers fire kernel-side). */
export function sendWidgetCustom(commId: string, content: Record<string, unknown>): void {
	post(commId, { method: 'custom', content });
}

/**
 * Throttled value change for a continuous control. The first call in a quiet
 * window sends immediately (leading edge, so the kernel reacts without waiting);
 * further calls within `THROTTLE_MS` coalesce and one trailing send flushes the
 * merged latest value when the window closes.
 */
export function throttledWidgetUpdate(commId: string, patch: Record<string, unknown>): void {
	pending.set(commId, { ...(pending.get(commId) ?? {}), ...patch });
	if (timers.has(commId)) return; // trailing send already scheduled
	const lead = pending.get(commId)!;
	pending.delete(commId);
	sendWidgetUpdate(commId, lead);
	timers.set(
		commId,
		setTimeout(() => {
			timers.delete(commId);
			const trail = pending.get(commId);
			if (trail) {
				pending.delete(commId);
				sendWidgetUpdate(commId, trail);
			}
		}, THROTTLE_MS)
	);
}

/**
 * Force the final value out now, cancelling any pending throttle for this comm —
 * used on slider release (`change`) and for discrete widgets (checkbox, dropdown,
 * text), so the authoritative value is never left stuck in the throttle window.
 */
export function flushWidgetUpdate(commId: string, state: Record<string, unknown>): void {
	const t = timers.get(commId);
	if (t) {
		clearTimeout(t);
		timers.delete(commId);
	}
	pending.delete(commId);
	sendWidgetUpdate(commId, state);
}
