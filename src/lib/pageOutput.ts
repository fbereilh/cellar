/**
 * Cellar - the marker on a `func?` / `func??` documentation output.
 *
 * ONE rule, read by the two halves that would otherwise drift: `execPayload.ts`
 * WRITES it when it turns IPython's `page` payload into an nbformat output, and
 * `Cell.svelte` READS it to pick that output's tone. Browser-safe and pure so both
 * can import it (the `$lib/hideInput` / `$lib/agentVisibility` precedent).
 *
 * WHY A MARKER AT ALL. `Cell.svelte` picks an output's tone from its nbformat
 * TYPE, and `display_data` means `result` - green, semibold, with a green rail -
 * because that is Cellar's way of saying "this is the value the cell evaluated
 * to" (it has no `Out[N]:` prefix to say it with). Documentation is not the cell's
 * value, and at `func??` length it is several KB of bold green source, which is
 * both a miscue and hard to read. So a doc output takes the PLAIN tone instead:
 * body text, no rail, the same treatment a `print` gets - which is also what
 * classic Jupyter's pager looks like, and what the kernel's own "Object `x` not
 * found." answer already renders as, so the found and not-found cases match.
 *
 * That is deliberately NOT a fifth tone invented for this feature: nothing is
 * added to the palette, an existing one is chosen.
 *
 * It rides the output's `metadata`, which `clean.ts` preserves verbatim, so the
 * tone survives a save and a reload - without that a reopened notebook would show
 * the same output in a different colour. It is deterministic and tiny, so it costs
 * no git churn, and a FORGED marker in a foreign notebook can only ever change a
 * colour, which is why nothing here needs to defend against one.
 */

/** The metadata a documentation output carries. */
export const PAGE_OUTPUT_METADATA = { cellar: { page: true } } as const;

/** True for an output `execPayload.ts` built from a `page` payload. */
export function isPageOutput(output: { metadata?: unknown } | null | undefined): boolean {
	const meta = output?.metadata;
	if (!meta || typeof meta !== 'object') return false;
	const cellar = (meta as { cellar?: unknown }).cellar;
	if (!cellar || typeof cellar !== 'object') return false;
	return (cellar as { page?: unknown }).page === true;
}
