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
     focused. Mirrors CM's layout (a sticky gutter group + a no-wrap content
     column on the same editor surface) so building the real editor on focus does
     not shift the code. `aria-hidden`: the real editor is the accessible control;
     this is a visual placeholder the user clicks to summon it. -->
<div class="cm-static font-mono" aria-hidden="true" data-lang={lang}>
	<!-- The sticky gutter group, mirroring CodeMirror's `.cm-gutters`: a line-number
	     column plus an empty fold-gutter column. The fold column reserves the space
	     `basicSetup`'s fold gutter (the ⌄/› marker) will occupy to the right of the
	     line numbers, so the code sits at the exact x-position the live editor places
	     it - without it the content shifts right by the gutter's width the instant
	     the editor is summoned on first click. The whole group is one sticky box so
	     the fold column follows the line numbers even when they widen (3-digit
	     lines); the fold column's width is the shared `--cellar-cm-fold-width`,
	     pinned identically in `editorTheme.ts`. -->
	<div class="cm-static-gutters select-none">
		<div class="cm-static-gutter">
			{#each lines as _, i (i)}
				<div class="cm-static-lineno">{i + 1}</div>
			{/each}
		</div>
		<div class="cm-static-foldgutter"></div>
	</div>
	<div class="cm-static-content">
		{#each lines as line, i (i)}
			<div class="cm-static-line">{@html line}</div>
		{/each}
	</div>
</div>
