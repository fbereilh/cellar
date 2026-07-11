<script lang="ts">
	// Renders a rich `text/html` cell output (Bokeh, Altair, folium, ipywidgets'
	// HTML reprs, plotly's HTML renderer, styled DataFrames, …) inside a **sandboxed
	// iframe**. The iframe uses `sandbox="allow-scripts"` WITHOUT `allow-same-origin`,
	// so embedded JS runs (interactive viz work) in a unique opaque origin that
	// cannot touch the app's DOM, cookies, or storage.
	//
	// The content renders on an explicit **white** card with dark text, in both app
	// themes — the same convention as classic Jupyter / nbconvert. Rich HTML outputs
	// (pandas Styler, folium, bokeh, sklearn's estimator repr, …) are authored
	// assuming a light background, so painting them on the dark app surface would
	// break them; a consistent white card is both readable and what the content
	// expects, and it sidesteps re-running the embedded scripts on a theme toggle.
	//
	// Auto-sizing: since we own the srcdoc wrapper we inject a tiny reporter that
	// posts the content's scrollHeight up via postMessage (on load + on every
	// ResizeObserver tick, covering async-rendered viz). The parent clamps that to
	// a max and lets the iframe scroll internally past it. Cross-origin postMessage
	// is the only channel an opaque-origin iframe has, which is exactly why it is
	// safe.
	import { browser } from '$app/environment';

	let { html }: { html: string | null | undefined } = $props();

	let height = $state(120); // sensible pre-measurement default
	const MAX = 600; // px; taller content scrolls within the iframe

	// A per-instance token so we only react to *our* iframe's height messages.
	const token = browser ? 'h' + Math.random().toString(36).slice(2) : 'h';

	// Wrap the user HTML in a minimal white document (viz libs assume a light
	// background) plus the height reporter.
	function buildSrcdoc(userHtml: string): string {
		return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
html,body{margin:0;padding:8px;background:#ffffff;color:#1f2937;font-family:system-ui,-apple-system,sans-serif;font-size:14px;}
img,svg,canvas,table{max-width:100%;}
</style></head><body>${userHtml}
<script>(function(){
  function send(){ try{ parent.postMessage({__cellarHtml:'${token}', height: Math.ceil(document.documentElement.scrollHeight)}, '*'); }catch(e){} }
  if ('ResizeObserver' in window){ new ResizeObserver(send).observe(document.documentElement); }
  window.addEventListener('load', send);
  document.addEventListener('DOMContentLoaded', send);
  setTimeout(send, 0); setTimeout(send, 300);
})();<\/script></body></html>`;
	}

	const srcdoc = $derived(browser ? buildSrcdoc(html ?? '') : '');

	$effect(() => {
		if (!browser) return;
		function onMessage(e: MessageEvent) {
			const d = e.data;
			if (d && d.__cellarHtml === token && typeof d.height === 'number') {
				height = Math.max(40, Math.min(MAX, d.height));
			}
		}
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});
</script>

<iframe
	title="rich html output"
	{srcdoc}
	sandbox="allow-scripts allow-popups"
	class="w-full rounded border border-base-300 bg-white"
	style="height: {height}px;"
	data-testid="output-html"
></iframe>
