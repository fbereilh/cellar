<script lang="ts">
	import { highlightLines, type StaticLang } from '$lib/staticHighlight';

	interface Props {
		source: string;
		lang: StaticLang;
	}
	let { source, lang }: Props = $props();

	// Per-line highlighted HTML. Recomputed when the (doc-backed) source changes,
	// so an agent/MCP edit to a cell whose editor isn't built still updates what the
	// user sees. Empty lines keep their line box via a CSS `min-height` (see
	// `.cm-static-line` in app.css), so their line number still aligns.
	const lines = $derived(highlightLines(source, lang));
</script>

<!-- A read-only stand-in for the CodeMirror editor, shown until the cell is first
     focused. Mirrors CM's layout (a sticky line-number gutter + a no-wrap content
     column on the same editor surface) so building the real editor on focus does
     not shift the code. `aria-hidden`: the real editor is the accessible control;
     this is a visual placeholder the user clicks to summon it. -->
<div class="cm-static font-mono" aria-hidden="true" data-lang={lang}>
	<div class="cm-static-gutter select-none">
		{#each lines as _, i (i)}
			<div class="cm-static-lineno">{i + 1}</div>
		{/each}
	</div>
	<div class="cm-static-content">
		{#each lines as line, i (i)}
			<div class="cm-static-line">{@html line}</div>
		{/each}
	</div>
</div>
