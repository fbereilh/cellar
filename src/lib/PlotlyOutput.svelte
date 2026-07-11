<script lang="ts">
	// Renders a Plotly figure output (mimetype `application/vnd.plotly.v1+json`,
	// whose payload is `{data, layout, config}`) as a live, interactive chart.
	//
	// plotly.js is ~4.9MB, so it is **lazily loaded** via a dynamic import — Vite
	// emits it as its own chunk that is fetched only the first time a notebook
	// actually contains a plotly output, never on startup. The import promise is
	// module-level so a notebook with many plots loads the bundle once.
	//
	// The figure JSON is the persisted output (real Jupyter keeps it in the
	// .ipynb too); we only render it, adding no volatile state, so the on-disk
	// notebook stays git-clean.
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	// The plotly payload `{data, layout, config}`. plotly.js ships no types we
	// depend on here, so the figure is a loose structural shape.
	interface PlotlyFigure {
		data?: unknown[];
		layout?: Record<string, any>;
		config?: Record<string, unknown>;
	}

	let { figure }: { figure: PlotlyFigure | null | undefined } = $props();

	let el = $state<HTMLDivElement | null>(null);
	let error = $state('');

	// The container needs an explicit height: plotly's `responsive` mode sizes the
	// plot to its container, so a height-auto container would collapse to 0 on the
	// first re-layout (resize / theme redraw). Honor the figure's own layout height
	// when it sets one, else a sensible default.
	const plotHeight = $derived(Number(figure?.layout?.height) || 450);

	// One shared, lazily-triggered import of the bundled plotly.js.
	// plotly.js-dist-min ships no type declarations, so the module is `any` at
	// this dynamic-import boundary.
	let plotlyPromise: Promise<any> | undefined;
	function loadPlotly(): Promise<any> {
		if (!plotlyPromise) {
			plotlyPromise = import('plotly.js-dist-min' as any).then((m) => m.default ?? m);
		}
		return plotlyPromise;
	}

	// Resolve the app's active scheme so plotly text/gridlines stay legible in both
	// themes. The figure's own layout always wins over these defaults.
	function isDark(): boolean {
		return browser && document.documentElement.getAttribute('data-color-scheme') === 'dark';
	}
	function themedLayout(layout: Record<string, any> | undefined): Record<string, any> {
		const dark = isDark();
		const base = layout || {};
		// Transparent backgrounds so the plot sits on the app's output surface;
		// plotly's default (white) gridlines then vanish on a light surface, so
		// supply scheme-appropriate grid/zeroline colors as a default the figure's
		// own axis settings still override.
		const axis = {
			gridcolor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)',
			zerolinecolor: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)'
		};
		return {
			paper_bgcolor: 'rgba(0,0,0,0)',
			plot_bgcolor: 'rgba(0,0,0,0)',
			...base,
			font: { color: dark ? '#c9d1d9' : '#1f2937', ...(base.font || {}) },
			xaxis: { ...axis, ...(base.xaxis || {}) },
			yaxis: { ...axis, ...(base.yaxis || {}) }
		};
	}

	// plotly.js-dist-min is untyped; the module handle is `any` at this boundary.
	let Plotly: any;
	let resizeObs: ResizeObserver | undefined;
	let themeObs: MutationObserver | undefined;

	async function draw() {
		if (!browser || !el) return;
		try {
			Plotly = Plotly || (await loadPlotly());
			const data = figure?.data ?? [];
			const layout = themedLayout(figure?.layout);
			const config = { responsive: true, displaylogo: false, ...(figure?.config || {}) };
			await Plotly.react(el, data, layout, config);
			error = '';
		} catch (e) {
			error = String((e as Error)?.message || e);
		}
	}

	onMount(() => {
		draw();
		// Container-resize responsiveness: plotly's `responsive` only tracks the
		// window, so re-layout when the output column itself changes width.
		if (browser && 'ResizeObserver' in window && el) {
			resizeObs = new ResizeObserver(() => {
				if (Plotly && el) Plotly.Plots.resize(el);
			});
			resizeObs.observe(el);
		}
		// Re-theme on a light/dark toggle so text/gridlines stay legible.
		if (browser && 'MutationObserver' in window) {
			themeObs = new MutationObserver(() => draw());
			themeObs.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['data-color-scheme']
			});
		}
		return () => {
			resizeObs?.disconnect();
			themeObs?.disconnect();
			if (Plotly && el) Plotly.purge(el);
		};
	});

	// Redraw when the figure payload changes (a re-run replaces it).
	$effect(() => {
		figure;
		if (Plotly) draw();
	});
</script>

{#if error}
	<pre class="overflow-x-auto whitespace-pre-wrap break-words border-l-2 border-error/60 py-1 pl-3 font-mono text-sm text-error" data-testid="output-plotly-error">Failed to render Plotly figure: {error}</pre>
{/if}
<div bind:this={el} class="w-full" style="height: {plotHeight}px;" data-testid="output-plotly"></div>
