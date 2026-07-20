import { describe, it, expect } from 'vitest';
import {
	widgetKind,
	barGeometry,
	rangeValue,
	optionLabels,
	selectedIndex,
	selectedIndices,
	comboOptions,
	childIds,
	progressBarClass,
	buttonClass,
	widgetStep,
	isFloatWidget,
	num,
	str,
	bool
} from '../../src/lib/widgetModel';

/**
 * Pure projection of an ipywidgets wire-state bundle into the shapes the renderer
 * consumes. These pin the classification + trait tolerance that keeps interactive
 * widgets rendering from partial/odd state without ever throwing.
 */
describe('widgetKind — model name → renderer group', () => {
	it('maps the core interactive widgets', () => {
		expect(widgetKind('IntSlider')).toBe('slider');
		expect(widgetKind('FloatSlider')).toBe('slider');
		expect(widgetKind('IntRangeSlider')).toBe('rangeslider');
		expect(widgetKind('BoundedFloatText')).toBe('numbertext');
		expect(widgetKind('Checkbox')).toBe('checkbox');
		expect(widgetKind('ToggleButton')).toBe('togglebutton');
		expect(widgetKind('Dropdown')).toBe('dropdown');
		expect(widgetKind('RadioButtons')).toBe('radio');
		expect(widgetKind('ToggleButtons')).toBe('togglebuttons');
		expect(widgetKind('Select')).toBe('select');
		expect(widgetKind('Combobox')).toBe('combobox');
		expect(widgetKind('SelectMultiple')).toBe('multiselect');
		expect(widgetKind('Text')).toBe('text');
		expect(widgetKind('Password')).toBe('password');
		expect(widgetKind('Textarea')).toBe('textarea');
		expect(widgetKind('Button')).toBe('button');
		expect(widgetKind('Output')).toBe('output');
	});
	it('keeps the #86 display-only widgets working', () => {
		expect(widgetKind('IntProgress')).toBe('progress');
		expect(widgetKind('FloatProgress')).toBe('progress');
		expect(widgetKind('HTML')).toBe('html');
		expect(widgetKind('Label')).toBe('label');
		expect(widgetKind('HBox')).toBe('hbox');
		expect(widgetKind('VBox')).toBe('vbox');
		expect(widgetKind('Box')).toBe('hbox');
		expect(widgetKind('GridBox')).toBe('hbox');
	});
	it('falls through to unsupported for anything unknown', () => {
		expect(widgetKind('ColorPicker')).toBe('unsupported');
		expect(widgetKind('')).toBe('unsupported');
	});
});

describe('scalar coercions tolerate missing/odd traits', () => {
	it('num / str / bool default safely', () => {
		expect(num(3, 0)).toBe(3);
		expect(num('x', 7)).toBe(7);
		expect(num(NaN, 7)).toBe(7);
		expect(str('hi')).toBe('hi');
		expect(str(undefined, 'd')).toBe('d');
		expect(bool(true)).toBe(true);
		expect(bool('true')).toBe(false); // only strict true
		expect(bool(1)).toBe(false);
	});
});

describe('bar + range geometry', () => {
	it('normalizes a non-zero min to start at 0', () => {
		const { barValue, span } = barGeometry({ min: 10, max: 20, value: 15 });
		expect(span).toBe(10);
		expect(barValue).toBe(5);
	});
	it('clamps out-of-range values', () => {
		expect(barGeometry({ min: 0, max: 10, value: 99 }).barValue).toBe(10);
		expect(barGeometry({ min: 0, max: 10, value: -5 }).barValue).toBe(0);
	});
	it('reads a [lo,hi] range value, defaulting from min/max', () => {
		expect(rangeValue({ min: 0, max: 10, value: [2, 8] })).toEqual([2, 8]);
		expect(rangeValue({ min: 1, max: 9 })).toEqual([1, 9]);
		expect(rangeValue({ min: 0, max: 10, value: 5 })).toEqual([0, 10]); // scalar → default
	});
});

describe('selection traits', () => {
	it('reads option labels as strings', () => {
		expect(optionLabels({ _options_labels: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
		expect(optionLabels({ _options_labels: [1, 2] })).toEqual(['1', '2']);
		expect(optionLabels({})).toEqual([]);
	});
	it('reads the selected index, -1 when none', () => {
		expect(selectedIndex({ index: 2 })).toBe(2);
		expect(selectedIndex({ index: 0 })).toBe(0);
		expect(selectedIndex({})).toBe(-1);
		expect(selectedIndex({ index: null })).toBe(-1);
	});
	it('reads a multi-select index tuple, empty when none', () => {
		expect(selectedIndices({ index: [0, 2] })).toEqual([0, 2]);
		expect(selectedIndices({ index: [] })).toEqual([]);
		expect(selectedIndices({ index: 1 })).toEqual([]); // scalar → not a multi-select
		expect(selectedIndices({ index: [0, 1.5, 'x'] })).toEqual([0]); // non-int slots dropped
		expect(selectedIndices({})).toEqual([]);
	});
	it('reads combobox options (from `options`, coerced to strings)', () => {
		expect(comboOptions({ options: ['a', 'b'] })).toEqual(['a', 'b']);
		expect(comboOptions({ options: [1, 2] })).toEqual(['1', '2']);
		expect(comboOptions({ _options_labels: ['a'] })).toEqual([]); // combobox uses `options`
		expect(comboOptions({})).toEqual([]);
	});
});

describe('layout children', () => {
	it('strips the IPY_MODEL_ prefix', () => {
		expect(childIds({ children: ['IPY_MODEL_abc', 'IPY_MODEL_def'] })).toEqual(['abc', 'def']);
		expect(childIds({ children: [1, 'IPY_MODEL_x'] })).toEqual(['x']); // non-strings dropped
		expect(childIds({})).toEqual([]);
	});
});

describe('style + step derivation', () => {
	it('maps bar_style and button_style to daisyUI classes', () => {
		expect(progressBarClass({ bar_style: 'success' })).toBe('progress-success');
		expect(progressBarClass({ bar_style: 'danger' })).toBe('progress-error');
		expect(progressBarClass({})).toBe('progress-primary');
		expect(buttonClass('primary')).toBe('btn-primary');
		expect(buttonClass('danger')).toBe('btn-error');
		expect(buttonClass('')).toBe('');
	});
	it('defaults step by int/float variant', () => {
		expect(isFloatWidget('FloatSlider')).toBe(true);
		expect(isFloatWidget('IntSlider')).toBe(false);
		expect(widgetStep({}, 'IntSlider')).toBe(1);
		expect(widgetStep({}, 'FloatSlider')).toBe(0.1);
		expect(widgetStep({ step: 2 }, 'IntSlider')).toBe(2);
		expect(widgetStep({ step: 0 }, 'IntSlider')).toBe(1); // non-positive ignored
	});
});
