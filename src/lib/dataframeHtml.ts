// Parse pandas' `text/html` DataFrame repr into the structured `DataFramePayload`
// that DataFrameGrid renders, so a *saved* notebook (whose live
// `application/vnd.cellar.dataframe+json` MIME clean-on-save strips) still shows
// the interactive grid instead of a static HTML table.
//
// Only pandas' own `_repr_html_` output is recognized: it renders
// `<table border="1" class="dataframe">` with a `<thead>` header row (leading
// empty `<th>` = the index), `<tbody>` rows of `<th>index</th><td>…</td>`, and
// an optional `<p>N rows × M columns</p>` truncation footer. `class="dataframe"`
// is the reliable, deliberately narrow signal — a pandas *Styler* (`id="T_…"`,
// no `dataframe` class) or an arbitrary HTML `<table>` is NOT matched and keeps
// rendering via HtmlOutput unchanged.
//
// Everything is best-effort and never throws: any shape we can't confidently map
// (no `class="dataframe"` table, MultiIndex column headers with colspans, an
// empty body) returns null so the caller falls back to HtmlOutput.

// Mirror of DataFrameGrid's payload. Cells are strings/numbers/null; the grid's
// DfValue already tolerates string cells, so HTML text is a valid value.
export interface DataFramePayload {
	columns: string[];
	dtypes: string[];
	index: (string | number | null)[];
	index_name: string;
	data: (string | number | null)[][];
	total_rows: number;
	total_cols: number;
	shown_rows: number;
	shown_cols: number;
	truncated_rows: boolean;
	truncated_cols: boolean;
}

// pandas' string tokens for missing values, mapped to null (the grid renders
// null as an italic "NaN", matching the live grid).
const NULLISH = new Set(['NaN', 'nan', 'None', 'NaT', '<NA>', '']);

// pandas' truncation marker, as a literal "..." (or a unicode ellipsis).
function isEllipsis(s: string): boolean {
	const t = s.trim();
	return t === '...' || t === '…';
}

// Coerce a cell's text to a number when it is unambiguously numeric, so the grid
// right-aligns it and sorts it numerically (matching the live, dtype-aware grid).
// Anything else stays a string; pandas' missing-value tokens become null.
function coerceCell(raw: string): string | number | null {
	const s = raw.trim();
	if (NULLISH.has(s)) return s === '' ? '' : null;
	// Strict numeric: optional sign, digits with optional decimal, optional
	// exponent. Guards against "123abc" / "1,234" (a real string value) being read
	// as a number — pandas' default repr uses no thousands separators.
	if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) {
		const n = Number(s);
		if (!Number.isNaN(n)) return n;
	}
	return s;
}

// Best-effort per-column dtype from the coerced values: all-numeric → int/float,
// otherwise object. An all-null column has no signal, so it stays blank (the grid
// tolerates a blank dtype). Purely cosmetic — the header's small dtype line.
function inferDtype(data: (string | number | null)[][], col: number): string {
	let sawValue = false;
	let allNumeric = true;
	let allInteger = true;
	for (const row of data) {
		const v = row[col];
		if (v == null || v === '') continue;
		sawValue = true;
		if (typeof v === 'number') {
			if (!Number.isInteger(v)) allInteger = false;
		} else {
			allNumeric = false;
			break;
		}
	}
	if (!sawValue) return '';
	if (allNumeric) return allInteger ? 'int64' : 'float64';
	return 'object';
}

/**
 * Parse a pandas DataFrame `text/html` repr into a DataFramePayload, or return
 * null when the HTML is not a recognizable pandas dataframe table (so the caller
 * renders it via HtmlOutput). Browser-only (uses DOMParser); returns null in a
 * non-DOM context.
 */
export function parsePandasDataFrameHtml(html: string | null | undefined): DataFramePayload | null {
	if (!html || typeof DOMParser === 'undefined') return null;
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return null;
	}

	const table = doc.querySelector('table.dataframe');
	if (!table) return null;
	const thead = table.querySelector('thead');
	const tbody = table.querySelector('tbody');
	if (!thead || !tbody) return null;

	const headerRows = Array.from(thead.querySelectorAll(':scope > tr'));
	if (headerRows.length === 0) return null;

	// MultiIndex columns render header cells with colspan > 1 (and stacked header
	// rows) — too ambiguous to flatten reliably. Bail to HtmlOutput.
	for (const hr of headerRows) {
		for (const th of Array.from(hr.querySelectorAll('th'))) {
			if (parseInt(th.getAttribute('colspan') || '1', 10) > 1) return null;
		}
	}

	// Columns come from the first header row; drop the leading empty index header.
	const firstThs = Array.from(headerRows[0].querySelectorAll('th'));
	if (firstThs.length < 2) return null;
	const rawColumns = firstThs.slice(1).map((th) => th.textContent?.trim() ?? '');
	// When pandas truncates columns it inserts a literal "..." ellipsis column;
	// drop it so the grid shows real columns (its own header already flags the
	// truncation) and dtype inference isn't poisoned by "..." cells.
	const keepCol = rawColumns.map((c) => !isEllipsis(c));
	const columns = rawColumns.filter((_, i) => keepCol[i]);

	// A named index renders as a second header row: [indexName, '', '', …].
	let indexName = '';
	if (headerRows.length >= 2) {
		const secondThs = Array.from(headerRows[1].querySelectorAll('th'));
		const first = secondThs[0]?.textContent?.trim() ?? '';
		const restEmpty = secondThs.slice(1).every((th) => (th.textContent?.trim() ?? '') === '');
		if (first && restEmpty) indexName = first;
	}

	const index: (string | number | null)[] = [];
	const data: (string | number | null)[][] = [];
	for (const tr of Array.from(tbody.querySelectorAll(':scope > tr'))) {
		const ths = Array.from(tr.querySelectorAll('th'));
		const tds = Array.from(tr.querySelectorAll('td'));
		if (tds.length === 0) continue; // skip a stray/blank body row
		// The row header(s) are the index label; a MultiIndex row has several — join
		// them so the label stays meaningful.
		const label = ths
			.map((th) => th.textContent?.trim() ?? '')
			.filter((s) => s !== '')
			.join(' / ');
		// Skip pandas' truncation "..." row (index and every cell are ellipses).
		if (isEllipsis(label) && tds.every((td) => isEllipsis(td.textContent ?? ''))) continue;
		index.push(coerceCell(label));
		// Drop cells under the ellipsis column so rows stay aligned with `columns`.
		data.push(tds.filter((_, i) => keepCol[i] ?? true).map((td) => coerceCell(td.textContent ?? '')));
	}
	if (data.length === 0 || columns.length === 0) return null;

	const dtypes = columns.map((_, ci) => inferDtype(data, ci));

	// Truncation footer: "<p>N rows × M columns</p>" (× is ×; accept a plain
	// 'x' too). Present only when pandas truncated the frame.
	let totalRows = data.length;
	let totalCols = columns.length;
	const footer = doc.body?.textContent ?? '';
	const m = footer.match(/([\d,]+)\s*rows?\s*[×x]\s*([\d,]+)\s*columns?/i);
	if (m) {
		const r = parseInt(m[1].replace(/,/g, ''), 10);
		const c = parseInt(m[2].replace(/,/g, ''), 10);
		if (Number.isFinite(r) && r >= data.length) totalRows = r;
		if (Number.isFinite(c) && c >= columns.length) totalCols = c;
	}

	return {
		columns,
		dtypes,
		index,
		index_name: indexName,
		data,
		total_rows: totalRows,
		total_cols: totalCols,
		shown_rows: data.length,
		shown_cols: columns.length,
		truncated_rows: totalRows > data.length,
		truncated_cols: totalCols > columns.length
	};
}
