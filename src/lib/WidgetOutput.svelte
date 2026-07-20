<script lang="ts">
	// Renders an ipywidgets model tree from the live client widget store — both the
	// display-only progress bars from #86 AND the common INTERACTIVE controls
	// (sliders, checkbox, dropdown, button, text, toggle, …). A
	// `application/vnd.jupyter.widget-view+json` output names a `model_id`; this
	// looks the model up and renders it by its `_model_name`, recursing through the
	// layout boxes (`children` are `IPY_MODEL_` refs).
	//
	// TWO-WAY: an interactive control sends its change back to the kernel via
	// `$lib/widgetActions` (`POST /api/widgets/<comm_id>` → the model in the kernel),
	// so ipywidgets updates the Python trait and fires `observe`/`interact`
	// callbacks. The reply (changed traits, an `interact` Output re-run) flows back
	// over SSE into the store and repaints here — no rerun. The local value is set
	// optimistically on interaction (`setWidgetTrait`) for lag-free feedback, then
	// reconciled by the kernel's authoritative reply.
	//
	// Any widget type outside the supported set degrades to a small muted note —
	// never a crash. Both themes are handled by daisyUI semantic classes.
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';
	import { getWidgetState, widgetModelName, setWidgetTrait, type WidgetState } from '$lib/widgetStore.svelte';
	import {
		throttledWidgetUpdate,
		flushWidgetUpdate,
		sendWidgetCustom
	} from '$lib/widgetActions';
	import {
		widgetKind,
		barGeometry,
		progressBarClass,
		buttonClass,
		childIds,
		optionLabels,
		selectedIndex,
		selectedIndices,
		comboOptions,
		rangeValue,
		widgetStep,
		isFloatWidget,
		num,
		str,
		bool
	} from '$lib/widgetModel';
	import Self from '$lib/WidgetOutput.svelte';
	import WidgetOutputArea from '$lib/WidgetOutputArea.svelte';

	let { modelId }: { modelId: string } = $props();

	const state = $derived<WidgetState | undefined>(getWidgetState(modelId));
	const name = $derived(widgetModelName(state));
	const kind = $derived(widgetKind(name));

	const description = $derived(str(state?.description));
	const disabled = $derived(bool(state?.disabled));
	// ipywidgets: false ⇒ only sync on release (change), not during a drag.
	const continuous = $derived(state?.continuous_update !== false);
	const isFloat = $derived(isFloatWidget(name));

	function parseNum(raw: string): number {
		const v = parseFloat(raw);
		if (!Number.isFinite(v)) return 0;
		return isFloat ? v : Math.round(v);
	}

	// --- outgoing interaction ------------------------------------------------
	// Optimistically reflect the change locally, then push to the kernel. Continuous
	// controls throttle mid-drag and flush the final value on release.
	function onContinuous(patch: WidgetState) {
		setWidgetTrait(modelId, patch);
		if (continuous) throttledWidgetUpdate(modelId, patch);
	}
	function onCommit(patch: WidgetState) {
		setWidgetTrait(modelId, patch);
		flushWidgetUpdate(modelId, patch);
	}

	// --- derived control values ---------------------------------------------
	const children = $derived(childIds(state));
	const options = $derived(optionLabels(state));
	const index = $derived(selectedIndex(state));
	// SelectMultiple: `index` is a tuple of selected slots. Combobox: free-text
	// with `options` suggestions rendered via a <datalist>.
	const indices = $derived(selectedIndices(state));
	const comboOpts = $derived(comboOptions(state));
	const comboListId = $derived(`wl-${modelId}`);
	const step = $derived(widgetStep(state, name));
	const minV = $derived(num(state?.min, 0));
	const maxV = $derived(num(state?.max, 100));
	const numValue = $derived(num(state?.value, 0));
	const boolValue = $derived(bool(state?.value));
	const strValue = $derived(str(state?.value));
	const range = $derived(rangeValue(state));

	// Progress bar geometry (display-only).
	const bar = $derived(barGeometry(state));
	const barClass = $derived(progressBarClass(state));

	// An HTML widget may carry markup (sanitized); Label is plain text.
	const safeHtml = $derived(browser ? DOMPurify.sanitize(strValue) : '');

	// Radio/toggle groups need a stable name to group inputs.
	const groupName = $derived(`w-${modelId}`);

	// Output widget's captured outputs (interact's result area).
	const outputList = $derived(Array.isArray(state?.outputs) ? (state!.outputs as unknown[]) : []);

	function rangeLow(e: Event) {
		const hi = range[1];
		let lo = parseNum((e.target as HTMLInputElement).value);
		if (lo > hi) lo = hi;
		onContinuous({ value: [lo, hi] });
	}
	function rangeHigh(e: Event) {
		const lo = range[0];
		let hi = parseNum((e.target as HTMLInputElement).value);
		if (hi < lo) hi = lo;
		onContinuous({ value: [lo, hi] });
	}

	// SelectMultiple: collect every selected <option> slot → `index` tuple. The
	// kernel derives `value`/`label` from `index`, so `.get()` reflects the choice.
	function onMultiChange(e: Event) {
		const chosen = Array.from((e.target as HTMLSelectElement).selectedOptions).map((o) =>
			Number(o.value)
		);
		onCommit({ index: chosen });
	}
</script>

{#if state === undefined}
	<!-- Model not yet received (comm_open still in flight): render nothing. -->
{:else if kind === 'progress'}
	<div class="flex items-center gap-2" data-testid="widget-progress-wrap">
		{#if description}<span class="text-xs text-base-content/60">{description}</span>{/if}
		<progress
			class="progress {barClass} w-64 align-middle"
			value={bar.barValue}
			max={bar.span}
			data-testid="widget-progress"
		></progress>
	</div>
{:else if kind === 'slider'}
	<label class="flex items-center gap-2 text-sm" data-testid="widget-slider">
		{#if description}<span class="min-w-16 text-xs text-base-content/70">{description}</span>{/if}
		<input
			type="range"
			class="range range-primary range-sm w-56"
			min={minV}
			max={maxV}
			{step}
			value={numValue}
			{disabled}
			oninput={(e) => onContinuous({ value: parseNum((e.target as HTMLInputElement).value) })}
			onchange={(e) => onCommit({ value: parseNum((e.target as HTMLInputElement).value) })}
		/>
		<span class="min-w-10 font-mono text-xs tabular-nums text-base-content/80" data-testid="widget-slider-readout">{numValue}</span>
	</label>
{:else if kind === 'rangeslider'}
	<div class="flex flex-col gap-1 text-sm" data-testid="widget-rangeslider">
		<div class="flex items-center gap-2">
			{#if description}<span class="min-w-16 text-xs text-base-content/70">{description}</span>{/if}
			<span class="font-mono text-xs tabular-nums text-base-content/80">{range[0]} – {range[1]}</span>
		</div>
		<div class="flex items-center gap-2">
			<input type="range" class="range range-primary range-sm w-28" min={minV} max={maxV} {step} value={range[0]} {disabled} oninput={rangeLow} onchange={rangeLow} />
			<input type="range" class="range range-primary range-sm w-28" min={minV} max={maxV} {step} value={range[1]} {disabled} oninput={rangeHigh} onchange={rangeHigh} />
		</div>
	</div>
{:else if kind === 'numbertext'}
	<label class="flex items-center gap-2 text-sm" data-testid="widget-numbertext">
		{#if description}<span class="min-w-16 text-xs text-base-content/70">{description}</span>{/if}
		<input
			type="number"
			class="input input-bordered input-sm w-28"
			min={state?.min != null ? minV : undefined}
			max={state?.max != null ? maxV : undefined}
			{step}
			value={numValue}
			{disabled}
			oninput={(e) => onContinuous({ value: parseNum((e.target as HTMLInputElement).value) })}
			onchange={(e) => onCommit({ value: parseNum((e.target as HTMLInputElement).value) })}
		/>
	</label>
{:else if kind === 'checkbox'}
	<label class="flex cursor-pointer items-center gap-2 text-sm" data-testid="widget-checkbox">
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-primary"
			checked={boolValue}
			{disabled}
			onchange={(e) => onCommit({ value: (e.target as HTMLInputElement).checked })}
		/>
		{#if description}<span>{description}</span>{/if}
	</label>
{:else if kind === 'togglebutton'}
	<button
		type="button"
		class="btn btn-sm {boolValue ? buttonClass(state?.button_style) || 'btn-primary' : 'btn-ghost border-base-300'}"
		{disabled}
		data-testid="widget-togglebutton"
		data-pressed={boolValue ? 'true' : undefined}
		onclick={() => onCommit({ value: !boolValue })}
	>
		{description || (boolValue ? 'On' : 'Off')}
	</button>
{:else if kind === 'valid'}
	<span class="flex items-center gap-1.5 text-sm" data-testid="widget-valid">
		{#if description}<span class="text-xs text-base-content/70">{description}</span>{/if}
		{#if boolValue}
			<span class="text-success" aria-label="valid">✓ {str(state?.readout) || 'Valid'}</span>
		{:else}
			<span class="text-error" aria-label="invalid">✗ {str(state?.readout) || 'Invalid'}</span>
		{/if}
	</span>
{:else if kind === 'dropdown'}
	<label class="flex items-center gap-2 text-sm" data-testid="widget-dropdown">
		{#if description}<span class="min-w-16 text-xs text-base-content/70">{description}</span>{/if}
		<select
			class="select select-bordered select-sm"
			{disabled}
			value={index}
			onchange={(e) => onCommit({ index: Number((e.target as HTMLSelectElement).value) })}
		>
			{#each options as opt, i (i)}
				<option value={i} selected={i === index}>{opt}</option>
			{/each}
		</select>
	</label>
{:else if kind === 'radio'}
	<div class="flex flex-col gap-1 text-sm" data-testid="widget-radio">
		{#if description}<span class="text-xs text-base-content/70">{description}</span>{/if}
		{#each options as opt, i (i)}
			<label class="flex cursor-pointer items-center gap-2">
				<input
					type="radio"
					class="radio radio-sm radio-primary"
					name={groupName}
					checked={i === index}
					{disabled}
					onchange={() => onCommit({ index: i })}
				/>
				<span>{opt}</span>
			</label>
		{/each}
	</div>
{:else if kind === 'togglebuttons'}
	<div class="flex flex-col gap-1 text-sm" data-testid="widget-togglebuttons">
		{#if description}<span class="text-xs text-base-content/70">{description}</span>{/if}
		<div class="join">
			{#each options as opt, i (i)}
				<button
					type="button"
					class="btn join-item btn-sm {i === index ? 'btn-primary' : 'btn-ghost border-base-300'}"
					{disabled}
					aria-pressed={i === index}
					onclick={() => onCommit({ index: i })}>{opt}</button
				>
			{/each}
		</div>
	</div>
{:else if kind === 'select'}
	<label class="flex items-start gap-2 text-sm" data-testid="widget-select">
		{#if description}<span class="min-w-16 pt-1 text-xs text-base-content/70">{description}</span>{/if}
		<select
			class="select select-bordered select-sm"
			size={Math.min(Math.max(options.length, 2), 6)}
			{disabled}
			onchange={(e) => onCommit({ index: Number((e.target as HTMLSelectElement).value) })}
		>
			{#each options as opt, i (i)}
				<option value={i} selected={i === index}>{opt}</option>
			{/each}
		</select>
	</label>
{:else if kind === 'multiselect'}
	<!-- A native <select multiple> listbox, NOT daisyUI's `.select` (that class is
	     tuned for a single-line dropdown and collapses the options); styled to
	     match the bordered inputs while staying a proper vertical multi-select. -->
	<label class="flex items-start gap-2 text-sm" data-testid="widget-multiselect">
		{#if description}<span class="min-w-16 pt-1 text-xs text-base-content/70">{description}</span>{/if}
		<select
			class="min-w-32 rounded-md border border-base-300 bg-base-100 px-1 py-1 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
			multiple
			size={Math.min(Math.max(options.length, 2), 6)}
			{disabled}
			onchange={onMultiChange}
		>
			{#each options as opt, i (i)}
				<option class="rounded px-1" value={i} selected={indices.includes(i)}>{opt}</option>
			{/each}
		</select>
	</label>
{:else if kind === 'combobox'}
	<label class="flex items-center gap-2 text-sm" data-testid="widget-combobox">
		{#if description}<span class="min-w-16 text-xs text-base-content/70">{description}</span>{/if}
		<input
			type="text"
			class="input input-bordered input-sm"
			list={comboListId}
			placeholder={str(state?.placeholder)}
			value={strValue}
			{disabled}
			oninput={(e) => onContinuous({ value: (e.target as HTMLInputElement).value })}
			onchange={(e) => onCommit({ value: (e.target as HTMLInputElement).value })}
		/>
		<datalist id={comboListId}>
			{#each comboOpts as opt (opt)}
				<option value={opt}></option>
			{/each}
		</datalist>
	</label>
{:else if kind === 'text' || kind === 'password'}
	<label class="flex items-center gap-2 text-sm" data-testid="widget-{kind}">
		{#if description}<span class="min-w-16 text-xs text-base-content/70">{description}</span>{/if}
		<input
			type={kind === 'password' ? 'password' : 'text'}
			class="input input-bordered input-sm"
			placeholder={str(state?.placeholder)}
			value={strValue}
			{disabled}
			oninput={(e) => onContinuous({ value: (e.target as HTMLInputElement).value })}
			onchange={(e) => onCommit({ value: (e.target as HTMLInputElement).value })}
		/>
	</label>
{:else if kind === 'textarea'}
	<label class="flex items-start gap-2 text-sm" data-testid="widget-textarea">
		{#if description}<span class="min-w-16 pt-1 text-xs text-base-content/70">{description}</span>{/if}
		<textarea
			class="textarea textarea-bordered textarea-sm w-64"
			placeholder={str(state?.placeholder)}
			value={strValue}
			{disabled}
			oninput={(e) => onContinuous({ value: (e.target as HTMLTextAreaElement).value })}
			onchange={(e) => onCommit({ value: (e.target as HTMLTextAreaElement).value })}
		></textarea>
	</label>
{:else if kind === 'button'}
	<button
		type="button"
		class="btn btn-sm {buttonClass(state?.button_style)}"
		{disabled}
		data-testid="widget-button"
		onclick={() => sendWidgetCustom(modelId, { event: 'click' })}
	>
		{str(state?.description) || 'Button'}
	</button>
{:else if kind === 'html'}
	<span class="cellar-widget-html text-sm" data-testid="widget-html">{@html safeHtml}</span>
{:else if kind === 'label'}
	<span class="text-sm" data-testid="widget-label">{strValue}</span>
{:else if kind === 'output'}
	<div data-testid="widget-output">
		<WidgetOutputArea outputs={outputList} />
	</div>
{:else if kind === 'vbox'}
	<div class="flex flex-col items-start gap-2" data-testid="widget-vbox">
		{#each children as childId (childId)}
			<Self modelId={childId} />
		{/each}
	</div>
{:else if kind === 'hbox'}
	<div class="flex flex-row flex-wrap items-center gap-2" data-testid="widget-hbox">
		{#each children as childId (childId)}
			<Self modelId={childId} />
		{/each}
	</div>
{:else}
	<span class="text-xs text-base-content/40" data-testid="widget-unsupported"
		>[unsupported widget: {name || 'unknown'}]</span
	>
{/if}

<style>
	/* Keep tqdm's inline text spans on one line beside the bar. */
	.cellar-widget-html :global(*) {
		display: inline;
	}
</style>
