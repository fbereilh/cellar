/**
 * Cellar — pure helpers for rendering an ipywidgets model, shared by
 * `WidgetOutput.svelte`. Kept framework-free so the classification and trait
 * projection are unit-testable without a Svelte runtime.
 *
 * A widget's wire state is a raw trait bundle (`_model_name`, `value`, `index`,
 * `_options_labels`, `children`, …). These functions narrow it into the small
 * shapes the renderer needs, tolerating missing/odd traits (a partially-synced
 * model must still render, never throw).
 */
export type WidgetState = Record<string, unknown>;

export function num(v: unknown, fallback: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(v: unknown, fallback = ''): string {
	return typeof v === 'string' ? v : fallback;
}

export function bool(v: unknown): boolean {
	return v === true;
}

/** ipywidgets `children` are `"IPY_MODEL_<id>"` refs into the store. */
export function childIds(state: WidgetState | undefined): string[] {
	const c = state?.children;
	if (!Array.isArray(c)) return [];
	return c
		.filter((x): x is string => typeof x === 'string')
		.map((x) => x.replace(/^IPY_MODEL_/, ''));
}

/** A selection widget's option labels (`_options_labels`), always strings. */
export function optionLabels(state: WidgetState | undefined): string[] {
	const o = state?._options_labels;
	if (!Array.isArray(o)) return [];
	return o.map((x) => String(x));
}

/** The selected option index, clamped to a valid slot, or -1 when none. */
export function selectedIndex(state: WidgetState | undefined): number {
	const i = state?.index;
	if (typeof i !== 'number' || !Number.isInteger(i)) return -1;
	return i;
}

/** Progress/slider bar geometry, normalized so a non-zero `min` still starts at 0. */
export function barGeometry(state: WidgetState | undefined): { barValue: number; span: number } {
	const min = num(state?.min, 0);
	const max = num(state?.max, 100);
	const value = num(state?.value, 0);
	const span = Math.max(1e-9, max - min);
	return { barValue: Math.min(span, Math.max(0, value - min)), span };
}

/** A range slider's `[lo, hi]` value, defaulted from `min`/`max` when absent. */
export function rangeValue(state: WidgetState | undefined): [number, number] {
	const v = state?.value;
	const min = num(state?.min, 0);
	const max = num(state?.max, 100);
	if (Array.isArray(v) && v.length >= 2) return [num(v[0], min), num(v[1], max)];
	return [min, max];
}

const BAR_STYLE: Record<string, string> = {
	success: 'progress-success',
	info: 'progress-info',
	warning: 'progress-warning',
	danger: 'progress-error'
};
/** `bar_style` → daisyUI progress color (default reads as an ordinary bar). */
export function progressBarClass(state: WidgetState | undefined): string {
	return BAR_STYLE[str(state?.bar_style)] ?? 'progress-primary';
}

const BUTTON_STYLE: Record<string, string> = {
	primary: 'btn-primary',
	success: 'btn-success',
	info: 'btn-info',
	warning: 'btn-warning',
	danger: 'btn-error'
};
/** `button_style` → daisyUI button color (default is a neutral button). */
export function buttonClass(style: unknown): string {
	return BUTTON_STYLE[str(style)] ?? '';
}

/**
 * The renderer kind for an ipywidgets model name (already stripped of its
 * `Model` suffix). Groups the many concrete widgets into the handful of controls
 * `WidgetOutput` draws; anything unknown falls through to `unsupported`.
 */
export function widgetKind(name: string): string {
	switch (name) {
		case 'IntProgress':
		case 'FloatProgress':
			return 'progress';
		case 'IntSlider':
		case 'FloatSlider':
			return 'slider';
		case 'IntRangeSlider':
		case 'FloatRangeSlider':
			return 'rangeslider';
		case 'IntText':
		case 'FloatText':
		case 'BoundedIntText':
		case 'BoundedFloatText':
			return 'numbertext';
		case 'Checkbox':
			return 'checkbox';
		case 'ToggleButton':
			return 'togglebutton';
		case 'Valid':
			return 'valid';
		case 'Dropdown':
			return 'dropdown';
		case 'RadioButtons':
			return 'radio';
		case 'Select':
		case 'SelectionSlider': // rendered as a listbox fallback
			return 'select';
		case 'ToggleButtons':
			return 'togglebuttons';
		case 'Text':
			return 'text';
		case 'Textarea':
			return 'textarea';
		case 'Password':
			return 'password';
		case 'Label':
			return 'label';
		case 'HTML':
		case 'HTMLMath':
			return 'html';
		case 'Button':
			return 'button';
		case 'HBox':
		case 'Box':
		case 'GridBox':
			return 'hbox';
		case 'VBox':
			return 'vbox';
		case 'Output':
			return 'output';
		default:
			return 'unsupported';
	}
}

/** Whether the widget name is a float variant (so its step defaults finer). */
export function isFloatWidget(name: string): boolean {
	return name.startsWith('Float');
}

/** Slider/number step, defaulting to 1 for int widgets and 0.1 for float. */
export function widgetStep(state: WidgetState | undefined, name: string): number {
	const s = state?.step;
	if (typeof s === 'number' && Number.isFinite(s) && s > 0) return s;
	return isFloatWidget(name) ? 0.1 : 1;
}
