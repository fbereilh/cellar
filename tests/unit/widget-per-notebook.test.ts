/**
 * Per-notebook widget scoping (kernel-per-notebook, Phase 5).
 *
 * Each notebook has its own kernel, so every widget model records the absolute
 * path of the notebook whose kernel opened it, and every widget SSE event carries
 * that `nb` tag. Comm ids are globally unique per session (no cross-notebook
 * collision), so one store still spans all notebooks; the `nb` tag is what lets a
 * per-notebook restart wipe ONLY its own widgets and a client trace a model to its
 * tab. These pin: events carry nb; a scoped reset (by comm ids) drops only one
 * notebook's widgets and leaves the other's live.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	openWidget,
	updateWidget,
	closeWidget,
	widgetSnapshot,
	resetWidgets
} from '../../src/lib/server/widgets';
import { subscribe } from '../../src/lib/server/events';

const A = '/ws/a.ipynb';
const B = '/ws/b.ipynb';

function nbOfModel(commId: string): string | undefined {
	return widgetSnapshot().models.find((m) => m.comm_id === commId)?.nb;
}

describe('per-notebook widget scoping', () => {
	beforeEach(() => resetWidgets());

	it('records the owning notebook on the model and every event', () => {
		const events: Array<{ type?: string; nb?: string; comm_id?: string }> = [];
		const off = subscribe((e) => events.push(e as { type?: string; nb?: string; comm_id?: string }));
		try {
			openWidget(A, 'wA', { _model_name: 'IntProgressModel', value: 1 });
			openWidget(B, 'wB', { _model_name: 'IntProgressModel', value: 2 });
			updateWidget('wA', { value: 5 });
			closeWidget('wB');
		} finally {
			off();
		}

		// The store tags each model with its notebook.
		expect(nbOfModel('wA')).toBe(A);
		expect(nbOfModel('wB')).toBe(B);

		// Every widget event carries the owning notebook, resolved from the comm even
		// when the caller (updateWidget/closeWidget) passed only the comm id.
		const openA = events.find((e) => e.type === 'widget:open' && e.comm_id === 'wA');
		const updA = events.find((e) => e.type === 'widget:update' && e.comm_id === 'wA');
		const closeB = events.find((e) => e.type === 'widget:close' && e.comm_id === 'wB');
		expect(openA?.nb).toBe(A);
		expect(updA?.nb).toBe(A);
		expect(closeB?.nb).toBe(B);
	});

	it('a scoped reset drops ONLY the restarted notebook\'s widgets', () => {
		openWidget(A, 'wA1', { value: 1 });
		openWidget(A, 'wA2', { value: 2 });
		openWidget(B, 'wB1', { value: 3 });
		expect(widgetSnapshot().models).toHaveLength(3);

		// Restarting notebook A's kernel clears A's widgets by their comm ids.
		const events: Array<{ type?: string; comm_ids?: string[] }> = [];
		const off = subscribe((e) => events.push(e as { type?: string; comm_ids?: string[] }));
		try {
			resetWidgets(['wA1', 'wA2']);
		} finally {
			off();
		}

		const ids = widgetSnapshot().models.map((m) => m.comm_id);
		expect(ids).toEqual(['wB1']); // only B's widget survives
		expect(nbOfModel('wB1')).toBe(B);

		// The clear event names exactly the removed comm ids (so a client drops just
		// those, not its whole store).
		const clear = events.find((e) => e.type === 'widget:clear');
		expect(clear?.comm_ids?.sort()).toEqual(['wA1', 'wA2']);
	});

	it('a bare reset clears everything (a full reset)', () => {
		openWidget(A, 'wA', { value: 1 });
		openWidget(B, 'wB', { value: 2 });
		resetWidgets();
		expect(widgetSnapshot().models).toHaveLength(0);
	});
});
