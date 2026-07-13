<script lang="ts">
	// Renders a minimal ipywidgets model tree — exactly the subset `tqdm.notebook`
	// / `tqdm.auto` use for a progress bar — from the live client widget store.
	// A `application/vnd.jupyter.widget-view+json` output names a `model_id`; this
	// looks the model up and renders it by its `_model_name`, recursing through the
	// layout boxes:
	//
	//   IntProgress / FloatProgress → an HTML progress bar (value/min/max, bar_style)
	//   HTML / HTMLMath / Label     → sanitized inline text (the count/rate/percent)
	//   HBox / VBox                 → flex row/column of `children` (IPY_MODEL refs)
	//
	// Display-only and live: `widget:update` events tick the store's `value`, and
	// the `$derived` lookup below repaints the bar with no rerun. Any widget type
	// outside this set degrades to a small muted note — never a crash. Both themes
	// are handled by daisyUI semantic classes.
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';
	import { getWidgetState, widgetModelName, type WidgetState } from '$lib/widgetStore.svelte';
	import Self from '$lib/WidgetOutput.svelte';

	let { modelId }: { modelId: string } = $props();

	const state = $derived<WidgetState | undefined>(getWidgetState(modelId));
	const name = $derived(widgetModelName(state));

	function num(v: unknown, fallback: number): number {
		return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
	}

	// ipywidgets `children` are `"IPY_MODEL_<id>"` references into the store.
	const children = $derived(
		Array.isArray(state?.children)
			? (state.children as unknown[])
					.filter((c): c is string => typeof c === 'string')
					.map((c) => c.replace(/^IPY_MODEL_/, ''))
			: []
	);

	// Progress bar geometry, normalized so a non-zero `min` still starts at 0.
	const min = $derived(num(state?.min, 0));
	const max = $derived(num(state?.max, 100));
	const value = $derived(num(state?.value, 0));
	const span = $derived(Math.max(1e-9, max - min));
	const barValue = $derived(Math.min(span, Math.max(0, value - min)));

	// bar_style → daisyUI progress color (default reads as an ordinary progress bar).
	const BAR_STYLE: Record<string, string> = {
		success: 'progress-success',
		info: 'progress-info',
		warning: 'progress-warning',
		danger: 'progress-error'
	};
	const barClass = $derived(BAR_STYLE[String(state?.bar_style ?? '')] ?? 'progress-primary');

	// An HTML/Label widget's text. HTML may carry markup (sanitized); Label is text.
	const safeHtml = $derived(browser ? DOMPurify.sanitize(String(state?.value ?? '')) : '');
</script>

{#if state === undefined}
	<!-- Model not yet received (comm_open still in flight): render nothing. -->
{:else if name === 'IntProgress' || name === 'FloatProgress'}
	<progress
		class="progress {barClass} w-64 align-middle"
		value={barValue}
		max={span}
		data-testid="widget-progress"
	></progress>
{:else if name === 'HTML' || name === 'HTMLMath'}
	<span class="cellar-widget-html text-sm" data-testid="widget-html">{@html safeHtml}</span>
{:else if name === 'Label'}
	<span class="text-sm" data-testid="widget-label">{String(state.value ?? '')}</span>
{:else if name === 'HBox' || name === 'VBox'}
	<div
		class="flex {name === 'VBox' ? 'flex-col items-start' : 'flex-row flex-wrap items-center'} gap-2"
		data-testid="widget-{name === 'VBox' ? 'vbox' : 'hbox'}"
	>
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
