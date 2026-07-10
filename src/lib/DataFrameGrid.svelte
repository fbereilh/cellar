<script>
	// Interactive DataFrame grid for cell outputs. Renders the bounded, structured
	// payload emitted by the kernel-side formatter (see kernel.js): column names +
	// dtypes, a capped page of rows, and the true row/column counts. All sort /
	// filter / pagination is client-side over the rows already in the payload, so
	// it never round-trips to the kernel and never dumps an unbounded table into
	// the DOM — a large DataFrame is truncated to `shown_rows`, flagged in the
	// header. Purely a render of the output; carries no state into the .ipynb.
	let { payload } = $props();

	const columns = $derived(payload?.columns ?? []);
	const dtypes = $derived(payload?.dtypes ?? []);
	const indexName = $derived(payload?.index_name ?? '');
	const index = $derived(payload?.index ?? []);
	const rawData = $derived(payload?.data ?? []);

	// Pair each row with its index label once, so sorting/filtering keep them together.
	const rows = $derived(rawData.map((cells, i) => ({ idx: index[i], cells })));

	// ---- Global search -------------------------------------------------------
	let query = $state('');
	const needle = $derived(query.trim().toLowerCase());
	const filtered = $derived(
		needle === ''
			? rows
			: rows.filter(
					(r) =>
						String(r.idx).toLowerCase().includes(needle) ||
						r.cells.some((c) => c != null && String(c).toLowerCase().includes(needle))
				)
	);

	// ---- Sort ----------------------------------------------------------------
	// -1 = the index column; 0..n-1 = data columns. dir cycles none → asc → desc.
	let sortCol = $state(null);
	let sortDir = $state('asc');
	function toggleSort(col) {
		if (sortCol !== col) {
			sortCol = col;
			sortDir = 'asc';
		} else if (sortDir === 'asc') {
			sortDir = 'desc';
		} else {
			sortCol = null;
			sortDir = 'asc';
		}
	}
	// Numeric-aware comparison: numbers sort numerically, nulls sink last.
	function compare(a, b) {
		if (a == null && b == null) return 0;
		if (a == null) return 1;
		if (b == null) return -1;
		const na = typeof a === 'number' ? a : Number(a);
		const nb = typeof b === 'number' ? b : Number(b);
		if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb;
		return String(a).localeCompare(String(b));
	}
	const sorted = $derived.by(() => {
		if (sortCol == null) return filtered;
		const dir = sortDir === 'asc' ? 1 : -1;
		const get = sortCol === -1 ? (r) => r.idx : (r) => r.cells[sortCol];
		// Copy before sort: never mutate the derived `filtered` array in place.
		return [...filtered].sort((ra, rb) => dir * compare(get(ra), get(rb)));
	});

	// ---- Pagination ----------------------------------------------------------
	const PAGE_SIZES = [10, 25, 50, 100];
	let pageSize = $state(25);
	let page = $state(0);
	const pageCount = $derived(Math.max(1, Math.ceil(sorted.length / pageSize)));
	// Keep the current page in range as the filter/sort/pageSize change.
	$effect(() => {
		if (page > pageCount - 1) page = pageCount - 1;
		if (page < 0) page = 0;
	});
	const pageRows = $derived(sorted.slice(page * pageSize, page * pageSize + pageSize));
	const firstRow = $derived(sorted.length === 0 ? 0 : page * pageSize + 1);
	const lastRow = $derived(Math.min(sorted.length, (page + 1) * pageSize));

	// Reset to the first page whenever the query changes.
	$effect(() => {
		needle;
		page = 0;
	});

	function fmt(v) {
		if (v == null) return '';
		return String(v);
	}
	const isNull = (v) => v == null;
</script>

<div
	class="cellar-df not-prose overflow-hidden rounded-md border border-base-300 bg-(--cellar-surface-cell)"
	data-testid="dataframe-grid"
>
	<!-- Header: counts, truncation note, search -->
	<div class="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 bg-base-200/60 px-3 py-1.5">
		<div class="flex items-center gap-2 text-[11px] text-base-content/70">
			<span class="badge badge-xs badge-primary badge-soft font-medium" data-testid="df-badge">DataFrame</span>
			<span data-testid="df-counts">
				{payload?.total_rows?.toLocaleString?.() ?? payload?.total_rows} rows ×
				{payload?.total_cols} cols
			</span>
			{#if payload?.truncated_rows || payload?.truncated_cols}
				<span class="text-warning" title="The grid shows a bounded slice of the full DataFrame" data-testid="df-truncated">
					· showing first {payload.shown_rows.toLocaleString()}{payload.truncated_cols ? ` × ${payload.shown_cols}` : ''}
				</span>
			{/if}
		</div>
		<label class="input input-xs flex h-6 items-center gap-1 bg-(--cellar-surface-cell)">
			<svg class="h-3 w-3 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
			<input
				type="text"
				class="grow text-[11px]"
				placeholder="Filter rows…"
				bind:value={query}
				data-testid="df-search"
			/>
		</label>
	</div>

	<!-- Grid -->
	<div class="max-h-[26rem] overflow-auto" data-testid="df-scroll">
		<table class="cellar-df-table w-full border-collapse text-xs">
			<thead class="sticky top-0 z-10">
				<tr class="bg-base-200 text-base-content">
					<!-- index column -->
					<th
						class="cursor-pointer select-none border-b border-base-300 px-2 py-1 text-left font-semibold whitespace-nowrap hover:bg-base-300/70"
						onclick={() => toggleSort(-1)}
						data-testid="df-th-index"
						title="Index{indexName ? ` · ${indexName}` : ''}"
					>
						<span class="flex items-center gap-1">
							<span class="text-base-content/50">{indexName || ''}</span>
							{#if sortCol === -1}<span class="text-primary">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
						</span>
					</th>
					{#each columns as col, ci}
						<th
							class="cursor-pointer select-none border-b border-l border-base-300 px-2 py-1 text-left align-top whitespace-nowrap hover:bg-base-300/70"
							onclick={() => toggleSort(ci)}
							data-testid="df-th"
							title={`${col} · ${dtypes[ci] ?? ''}`}
						>
							<span class="flex items-center gap-1">
								<span class="font-semibold">{col}</span>
								{#if sortCol === ci}<span class="text-primary">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}
							</span>
							<span class="block font-mono text-[10px] font-normal text-base-content/45">{dtypes[ci] ?? ''}</span>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each pageRows as row (row.idx)}
					<tr class="odd:bg-base-100 even:bg-base-200/40 hover:bg-primary/5">
						<td class="border-b border-base-300 px-2 py-1 font-mono text-base-content/50 whitespace-nowrap" data-testid="df-index-cell">{fmt(row.idx)}</td>
						{#each row.cells as cell, ci}
							<td
								class="border-b border-l border-base-300 px-2 py-1 whitespace-nowrap {typeof cell === 'number' ? 'text-right font-mono tabular-nums' : ''} {isNull(cell) ? 'text-base-content/30 italic' : ''}"
								data-testid="df-cell"
							>
								{isNull(cell) ? 'NaN' : fmt(cell)}
							</td>
						{/each}
					</tr>
				{/each}
				{#if pageRows.length === 0}
					<tr>
						<td class="px-3 py-4 text-center text-base-content/50" colspan={columns.length + 1} data-testid="df-empty">
							No rows match “{query}”.
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>

	<!-- Footer: pagination -->
	<div class="flex flex-wrap items-center justify-between gap-2 border-t border-base-300 bg-base-200/60 px-3 py-1.5 text-[11px] text-base-content/70">
		<div data-testid="df-range">
			{#if sorted.length}{firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {sorted.length.toLocaleString()}{needle ? ' (filtered)' : ''}{:else}0 rows{/if}
		</div>
		<div class="flex items-center gap-2">
			<label class="flex items-center gap-1">
				<span>Rows</span>
				<select class="select select-xs h-6 min-h-0 bg-(--cellar-surface-cell)" bind:value={pageSize} data-testid="df-page-size">
					{#each PAGE_SIZES as n}<option value={n}>{n}</option>{/each}
				</select>
			</label>
			<div class="join">
				<button class="btn btn-xs join-item" onclick={() => (page = 0)} disabled={page === 0} aria-label="First page" data-testid="df-first">«</button>
				<button class="btn btn-xs join-item" onclick={() => (page -= 1)} disabled={page === 0} aria-label="Previous page" data-testid="df-prev">‹</button>
				<span class="btn btn-xs join-item pointer-events-none" data-testid="df-page">{page + 1} / {pageCount}</span>
				<button class="btn btn-xs join-item" onclick={() => (page += 1)} disabled={page >= pageCount - 1} aria-label="Next page" data-testid="df-next">›</button>
				<button class="btn btn-xs join-item" onclick={() => (page = pageCount - 1)} disabled={page >= pageCount - 1} aria-label="Last page" data-testid="df-last">»</button>
			</div>
		</div>
	</div>
</div>

<style>
	/* Keep the grid's own table styling isolated from the markdown-table rules. */
	.cellar-df-table :global(th),
	.cellar-df-table :global(td) {
		max-width: 22rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
