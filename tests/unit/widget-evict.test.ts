/**
 * Widget model eviction on `comm_close` (memory: bound the widget store).
 *
 * The models map used to retain one entry per widget for the kernel's whole life
 * — one per `tqdm` bar, forever — so a long session leaked. `closeWidget` (reached
 * only from the comm's genuine `onClose`) now EVICTS the model and every
 * per-widget bookkeeping entry; a live, still-updating widget flows through
 * `updateWidget` and keeps its model; a session change (restart/rebind/autorestart)
 * clears the map via `resetWidgets`. These pin: close evicts, live is retained,
 * restart clears, and evicting one widget leaves another untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	openWidget,
	updateWidget,
	closeWidget,
	widgetSnapshot,
	resetWidgets,
	setOutputCapture,
	outputCommForMsg
} from '../../src/lib/server/widgets';
import { subscribe } from '../../src/lib/server/events';

const NB = '/ws/a.ipynb';

function ids(): string[] {
	return widgetSnapshot().models.map((m) => m.comm_id);
}

describe('widget model eviction', () => {
	beforeEach(() => resetWidgets());

	it('a comm_close evicts the model and emits widget:close', () => {
		const events: Array<{ type?: string; nb?: string; comm_id?: string }> = [];
		openWidget(NB, 'w1', { _model_name: 'IntProgressModel', value: 100 });
		expect(ids()).toEqual(['w1']);

		const off = subscribe((e) => events.push(e as { type?: string; nb?: string; comm_id?: string }));
		try {
			closeWidget('w1');
		} finally {
			off();
		}

		// The model is gone from the store (bounded memory), not merely marked closed.
		expect(ids()).toEqual([]);
		// The close event still names the widget + its notebook (captured pre-eviction),
		// so a browser knows which widget stopped updating.
		const close = events.find((e) => e.type === 'widget:close');
		expect(close?.comm_id).toBe('w1');
		expect(close?.nb).toBe(NB);
	});

	it('a closing an unknown comm is a no-op (no event, no throw)', () => {
		const events: unknown[] = [];
		const off = subscribe((e) => events.push(e));
		try {
			closeWidget('nope');
		} finally {
			off();
		}
		expect(events).toEqual([]);
	});

	it('a live widget keeps its model across many updates (never evicted)', () => {
		openWidget(NB, 'bar', { _model_name: 'IntProgressModel', value: 0, max: 100 });
		for (let v = 1; v <= 50; v++) updateWidget('bar', { value: v });
		// Still exactly one model, holding the latest live state — updates never evict.
		expect(ids()).toEqual(['bar']);
		const m = widgetSnapshot().models.find((x) => x.comm_id === 'bar');
		expect(m?.state.value).toBe(50);
	});

	it('evicting one widget does not disturb another live one', () => {
		openWidget(NB, 'done', { _model_name: 'IntProgressModel', value: 100 });
		openWidget(NB, 'live', { _model_name: 'IntProgressModel', value: 10 });
		closeWidget('done');
		updateWidget('live', { value: 20 }); // the survivor still updates
		expect(ids()).toEqual(['live']);
		expect(widgetSnapshot().models[0].state.value).toBe(20);
	});

	it('close cleans up an Output widget capture mapping', () => {
		openWidget(NB, 'out1', { _model_name: 'OutputModel', outputs: [] });
		setOutputCapture('out1', 'msgA');
		expect(outputCommForMsg('msgA')).toBe('out1');
		closeWidget('out1');
		// The msg_id → comm route is dropped with the model, so a stray captured
		// output can never resurrect a closed Output widget.
		expect(outputCommForMsg('msgA')).toBeUndefined();
		expect(ids()).toEqual([]);
	});

	it('a session change (restart) clears every model in the store', () => {
		openWidget(NB, 'a', { value: 1 });
		openWidget(NB, 'b', { value: 2 });
		openWidget(NB, 'c', { value: 3 });
		expect(ids()).toHaveLength(3);
		// beginSession() passes the restarting kernel's comm ids to resetWidgets.
		resetWidgets(['a', 'b', 'c']);
		expect(ids()).toEqual([]);
	});
});
