import { describe, it, expect, beforeEach } from 'vitest';
import {
	openWidget,
	updateWidget,
	widgetSnapshot,
	resetWidgets,
	setOutputCapture,
	outputCommForMsg,
	appendWidgetOutput,
	clearWidgetOutput
} from '../../src/lib/server/widgets';

/**
 * The Output-widget capture routing: an `Output` widget (interact's result area)
 * publishes a `msg_id` and the kernel's iopub outputs for that message are routed
 * into the widget's `outputs` here. These pin that routing + the wait-clear.
 */
function outputsOf(commId: string): unknown[] {
	const m = widgetSnapshot().models.find((x) => x.comm_id === commId);
	return (m?.state.outputs as unknown[]) ?? [];
}

const STREAM = (t: string) => ({ output_type: 'stream', name: 'stdout', text: t });

describe('Output widget capture routing', () => {
	beforeEach(() => resetWidgets());

	it('maps a captured msg_id to the Output comm and appends outputs', () => {
		openWidget('/ws/a.ipynb', 'out1', { _model_name: 'OutputModel', outputs: [] });
		setOutputCapture('out1', 'msgA');
		expect(outputCommForMsg('msgA')).toBe('out1');

		appendWidgetOutput('out1', STREAM('x squared = 4\n'));
		expect(outputsOf('out1')).toHaveLength(1);
		appendWidgetOutput('out1', STREAM('more\n'));
		expect(outputsOf('out1')).toHaveLength(2);
	});

	it('clear_output(wait=true) defers: next append replaces, not adds', () => {
		openWidget('/ws/a.ipynb', 'out1', { _model_name: 'OutputModel', outputs: [] });
		appendWidgetOutput('out1', STREAM('old\n'));
		expect(outputsOf('out1')).toHaveLength(1);
		clearWidgetOutput('out1', true); // armed, not yet cleared
		expect(outputsOf('out1')).toHaveLength(1);
		appendWidgetOutput('out1', STREAM('x squared = 49\n')); // clears then appends
		expect(outputsOf('out1')).toEqual([STREAM('x squared = 49\n')]);
	});

	it('clear_output(wait=false) empties immediately', () => {
		openWidget('/ws/a.ipynb', 'out1', { outputs: [STREAM('a')] });
		clearWidgetOutput('out1', false);
		expect(outputsOf('out1')).toEqual([]);
	});

	it('re-targeting msg_id unhooks the old message; empty stops capture', () => {
		openWidget('/ws/a.ipynb', 'out1', { outputs: [] });
		setOutputCapture('out1', 'msgA');
		setOutputCapture('out1', 'msgB');
		expect(outputCommForMsg('msgA')).toBeUndefined();
		expect(outputCommForMsg('msgB')).toBe('out1');
		setOutputCapture('out1', '');
		expect(outputCommForMsg('msgB')).toBeUndefined();
	});

	it('resetWidgets drops capture mappings (a session change)', () => {
		openWidget('/ws/a.ipynb', 'out1', { outputs: [] });
		setOutputCapture('out1', 'msgA');
		resetWidgets();
		expect(outputCommForMsg('msgA')).toBeUndefined();
		expect(widgetSnapshot().models).toHaveLength(0);
	});

	it('registering a widget via comm_open keeps its non-output traits', () => {
		openWidget('/ws/a.ipynb', 's1', { _model_name: 'IntSliderModel', value: 3, max: 10 });
		updateWidget('s1', { value: 8 });
		const m = widgetSnapshot().models.find((x) => x.comm_id === 's1');
		expect(m?.state.value).toBe(8);
		expect(m?.state.max).toBe(10);
	});
});
