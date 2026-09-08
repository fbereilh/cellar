// Parse a tabular `text/html` DataFrame repr into the structured `DataFramePayload`
// that DataFrameGrid renders, so a *saved* notebook (whose live
// `application/vnd.cellar.dataframe+json` MIME clean-on-save strips) still shows
// the interactive grid instead of a static HTML table. It runs live too - any
// output carrying `text/html` and no structured MIME reaches it, which is the only
// grid a producer that emits no Cellar MIME at all (polars) ever gets.
//
// THREE dialects, told apart STRUCTURALLY rather than by a producer name:
//
//   pandas  `<table border="1" class="dataframe">`, a `<thead>` header row whose
//           FIRST `<th>` is the index placeholder, `<tbody>` rows of
//           `<th>index</th><td>…</td>`, and an optional `<p>N rows × M columns</p>`
//           truncation footer.
//   polars  the SAME `class="dataframe"` marker, but NO index column at all: the
//           first `<th>` is a real column, the second header row is `<td>` dtypes,
//           body rows are pure `<td>`, and the frame's true shape is declared
//           beside the table as `<small>shape: (rows, cols)</small>`.
//   Styler  `<table id="T_…">` with NO `dataframe` class at all, semantically
//           labelled instead: `th.col_heading`, `th.row_heading`, `th.index_name`,
//           `td.data`, and the caption in a `<caption>`.
//
// A pandas Styler is not a DataFrame, so the kernel-side formatter never fires for
// it and it used to miss both gates and render as a static table - live and
// reopened. It is read HERE rather than by teaching that formatter about `Styler`,
// because this is where MORE of it survives: the values in this HTML are the
// FORMATTED ones (`{:,.2f}` -> `1,234.50`) and the caption is right there, while
// the only PUBLIC handle the formatter would have is `styler.data`, the raw frame
// underneath - so that route would silently discard exactly the number formatting
// the user wrote `.style` to get (`_translate`/`_display_funcs`, which hold the
// rendered values, are private). What the grid structurally cannot express is the
// CSS: a background gradient, per-cell colours, bars. Those are dropped.
//
// WHICH Stylers get the grid, then: one whose data cells hold TEXT - formatted
// values and a caption, which is what `.style` is overwhelmingly written for. One
// whose cells hold MARKUP does NOT: `Styler.format` defaults to `escape=None`, so
// a formatter emitting `<a href=…>link</a>`, an `<img>` or an inline SVG sparkline
// puts real ELEMENT children in a `td`, and the grid reads a cell as
// `td.textContent` - which flattens the link to bare text and renders the image
// cell as the EMPTY STRING. That is content loss rather than a lost decoration, so
// such a Styler REFUSES and keeps the sandboxed iframe with its markup intact. The
// test is the cell's own CONTENT, never a guess about intent, and it is scoped by
// what the table IS - `th.col_heading`, which a Styler always emits - never by
// which selector resolved it: `set_table_attributes('class="dataframe"')` is a
// documented Styler idiom, so a Styler can be found by the `table.dataframe` lookup
// too. A plain `to_html(escape=False)` frame emits no `col_heading`, so the
// `class="dataframe"` path has always flattened the same way and is left alone.
//
// THE LAYOUT IS READ, NEVER ASSUMED, and that is this module's central rule.
// It used to hardcode pandas' leading index cell (`firstThs.slice(1)`), so every
// producer without one - polars, and `df.to_html(index=False)` - had its FIRST
// REAL COLUMN silently deleted and its values promoted to the row index, with the
// dtypes shifted one place along. That renders as an entirely normal grid showing
// the wrong data, which is worse than any refusal: measured against a real polars
// 1.44, a 17-column frame came back as 16 with `uuid` gone. So the index column is
// detected from the BODY (`<th>` row headers present or not) - never from the
// header, because pandas puts the *columns'* name in that first `<th>`
// (`df.columns.name = 'X'` renders `<th>X</th><th>a</th>…`) so a leading non-empty
// cell does NOT mean there is no index.
//
// AND THE ANSWER IS CHECKED AGAINST THE PRODUCER'S OWN DECLARED SHAPE. Where one
// is available (polars' `shape: (r, c)`) a parsed column count that disagrees with
// it REFUSES - returns null, falls back to the honest static table - rather than
// rendering a confident wrong grid. That is the guarantee this module exists to
// keep: silently-wrong must not be reachable, including by a shape nobody
// anticipated. A layout change in a future polars therefore costs the grid, never
// the data.
//
// MULTIINDEX COLUMNS ARE FLATTENED WITH ' / ', not refused. The grid is a flat
// table - one header row - so a nested header has to be flattened somehow, and
// `' / '` is already this module's separator for a flattened MultiIndex ROW label
// (see below), so columns and rows now read the same way. It is also strictly
// better than what the LIVE grid used to show for the same frame, which was
// python's tuple repr `('A', 'x')`: `kernel.ts`'s formatter flattens the same way
// now, so live and re-opened agree. Flattening can collide (two tuples onto one
// label) - harmless for a COLUMN, whose `{#each}` in DataFrameGrid is deliberately
// unkeyed, unlike the row `{#each}` that a duplicate label really would break.
//
// Everything is best-effort and never throws: any shape we can't confidently map
// (no recognizable table, no columns, a body row whose cell count disagrees with
// the header, a count that disagrees with the declared shape) returns null so the
// caller falls back to its own rendering. An EMPTY body is not one of those: a
// zero-row frame whose header parsed is a perfectly good frame, and it is what
// the live grid already shows for one.
//
// A pandas SERIES is the one shape deliberately left degrading. It has no
// `_repr_html_` AT ALL (measured), so a saved notebook carries only its
// `text/plain` repr and there is nothing here to parse: live it is a grid (the
// kernel formatter takes `Series` too, via `to_frame()`), re-opened it is plain
// text. Closing that needs one of two things, and both are worse than the gap:
// keeping the structured MIME through clean-on-save, which is the zero-git-diff
// doctrine that MIME is stripped for; or having the formatter emit an html repr
// pandas itself never produces, which would change what the saved `.ipynb`
// contains and how every OTHER tool renders it.
//
// TWO consumers, and this is deliberately the ONE parser they share: Cell.svelte's
// `renderOutput` (which falls back to HtmlOutput) and `$lib/copyCell` (which falls
// back to tag-stripped text), so a live and a re-opened DataFrame copy the same
// table the grid shows.

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
	/**
	 * Whether the frame has a row index at all. OPTIONAL, and absent means true:
	 * the kernel-side formatter emits pandas payloads that always carry one, so
	 * every producer predating this field keeps its index column unchanged. Only a
	 * literal `false` (polars, `to_html(index=False)`) hides the grid's index
	 * column - a blank one would be a phantom claiming an index that does not
	 * exist.
	 */
	has_index?: boolean;
	/**
	 * The table's own title, when it has one: a pandas Styler's
	 * `set_caption(...)`. OPTIONAL and usually absent - a plain `_repr_html_` has
	 * no caption - so a payload without it renders exactly as before.
	 */
	caption?: string;
}

// pandas' string tokens for missing values, mapped to null (the grid renders
// null as an italic "NaN", matching the live grid).
const NULLISH = new Set(['NaN', 'nan', 'None', 'NaT', '<NA>', '']);

// polars renders every missing value as a bare, unquoted `null` - unambiguous
// there, because a string column's values are QUOTED (`"null"` is the string), so
// this is applied only inside the polars dialect and never widens `NULLISH`, which
// a pandas cell holding the literal text `null` must keep as a string.
const POLARS_NULL = 'null';

// polars quotes the values of its string-like columns in the HTML repr (`"x"`),
// so the raw text carries quotes the grid must not show. Measured against polars
// 1.44: `str`, `cat` and `enum` are quoted; `binary` renders `b"ab"` and is left
// alone (stripping a prefixed form is fiddly and the dtype is rare).
const POLARS_QUOTED_DTYPES = new Set(['str', 'cat', 'enum']);

/**
 * Ceiling on the HTML of a Styler this parser will DOM-parse.
 *
 * The `class="dataframe"` path is bounded by pandas' own display options (60 rows
 * x 20 columns in a repr), so it needs none. A Styler's `_repr_html_` is not: it
 * renders every cell until pandas' `styler.render.max_elements` (262144) trips,
 * which measured at 21 MB of HTML for a 60000-row frame. Parsing that into a DOM
 * on the main thread - the thread also carrying the kernel websockets and the SSE
 * fan-out - to build a payload the grid then paginates is not worth it, so past
 * this the output keeps the sandboxed iframe it gets today. 2 MiB comfortably
 * admits any Styler a human is reading (~30k cells).
 */
const MAX_STYLER_HTML_CHARS = 2 * 1024 * 1024;

/** The HTML spec's own ceiling on `colspan`. */
const MAX_COLSPAN = 1000;

/**
 * Ceiling on how many `<tr>` a `<thead>` may hold.
 *
 * The sibling of `MAX_HEADER_COLUMNS` on the OTHER axis, and an allocation bound
 * over arbitrary output html rather than a claim about real frames: a MultiIndex's
 * levels are the only thing that adds header rows and a real one has a handful, so
 * this is orders of magnitude beyond anything a human reads. Unbounded, the
 * per-position `levels.map(...)` in the label loop is O(width x rows), so a
 * `<thead>` of ~130k empty `<tr>` (about 1.2 MB of html, well inside the
 * deliberately uncapped `class="dataframe"` admission) walked millions of positions
 * on the render path.
 */
const MAX_HEADER_ROWS = 256;

/**
 * Ceiling on how many column positions a header may expand to.
 *
 * An ALLOCATION BOUND over arbitrary output html, not a claim about real frames:
 * the live kernel payload caps at 100 columns and pandas' repr at 20, so nothing a
 * human reads comes near this. The per-cell `MAX_COLSPAN` clamp bounds ONE cell and
 * says nothing about the total, so ~50k `<th colspan="1000">` (about 1.3 MB of
 * html) expanded to a 50-million-entry array and then to that many joined label
 * strings, on the render path, before any refusal could fire. `expandRow` therefore
 * stops at this ceiling too - one past it, so the caller can still SEE the overflow
 * and refuse rather than silently truncating a header.
 */
const MAX_HEADER_COLUMNS = 4096;

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

/**
 * One polars cell, read against its DECLARED dtype - which is why the dtype row is
 * parsed rather than inferred. A string column's `"5006"` must stay the string
 * `5006` and never become the number 5006: polars' quotes are what say so, and
 * dropping them without honouring the dtype would silently retype the column.
 */
function coercePolarsCell(raw: string, dtype: string): string | number | null {
	const s = raw.trim();
	if (s === POLARS_NULL) return null;
	if (POLARS_QUOTED_DTYPES.has(dtype)) {
		// Exactly one matched pair - polars does NOT escape an embedded quote
		// (`say "hi"` renders as `"say "hi""`), so stripping one from each end is
		// what recovers the value.
		if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
		return s;
	}
	return coerceCell(s);
}

// Best-effort per-column dtype from the coerced values: all-numeric → int/float,
// otherwise object. An all-null column has no signal, so it stays blank (the grid
// tolerates a blank dtype). Purely cosmetic — the header's small dtype line.
// Used only where the producer declares none; polars declares real ones.
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
 * One header row as a FLAT array of column positions, `colspan` expanded - so a
 * MultiIndex level (`<th colspan="2">A</th>`) lines up with the level below it and
 * every level can be read at the same position.
 */
function expandRow(tr: Element): string[] {
	const out: string[] = [];
	for (const c of rowCells(tr)) {
		// Clamped to the HTML spec's own ceiling. This runs on arbitrary output html
		// on the render path, so an absurd `colspan="999999999"` must cost a bounded
		// array rather than the tab: a table that really is that wide is refused a
		// moment later by the row-width check anyway.
		const span = Math.min(MAX_COLSPAN, Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1));
		const text = cellText(c);
		for (let i = 0; i < span; i++) {
			// One PAST the ceiling, so the caller reads an overflow rather than a
			// header silently truncated to exactly the bound.
			if (out.length > MAX_HEADER_COLUMNS) return out;
			out.push(text);
		}
	}
	return out;
}

/** The `<th>`/`<td>` cells of one row, in document order. */
function rowCells(tr: Element): Element[] {
	return Array.from(tr.children).filter((el) => el.tagName === 'TH' || el.tagName === 'TD');
}

function cellText(el: Element): string {
	return el.textContent?.trim() ?? '';
}

/**
 * How many leading header cells belong to the INDEX when there is NO BODY to read
 * it from - or null when nothing says, which REFUSES the whole table.
 *
 * A zero-row frame still has a header, and that header alone cannot tell
 * `df.columns.name = 'X'` (an index IS present, its placeholder carrying the
 * columns' name) from `to_html(index=False)` (no index, first cell a real column) -
 * guessing either way silently drops a real column or invents a phantom index one,
 * which is the silently-wrong grid this module exists to make unreachable. So only
 * two positive signals answer:
 *
 *  - a DTYPE ROW (a header row of pure `<td>`) is polars, which has no index at
 *    all. A dialect fact rather than a guess.
 *  - otherwise an EMPTY leading header cell is pandas' index placeholder, which
 *    `_repr_html_` always emits. That keeps an ordinary empty pandas frame's grid.
 *
 * Anything else refuses, and the output keeps its honest static table.
 */
function emptyBodyIndexCols(firstLevel: string[] | undefined, hasDtypeRow: boolean): number | null {
	if (hasDtypeRow) return 0;
	if (firstLevel && firstLevel.length > 0 && firstLevel[0] === '') return 1;
	return null;
}

/**
 * Does a Styler-resolved table hold MARKUP in its data cells rather than text?
 *
 * The grid can express a formatted VALUE and a caption; it cannot express a link,
 * an image or an inline SVG - it reads a cell as `td.textContent`, which flattens
 * `<a href=…>link</a>` to bare unlinked text and renders an `<img>`/`<svg>` cell as
 * the EMPTY STRING. That is losing the user's CONTENT, not a decoration, so such a
 * table falls back to the sandboxed iframe, which keeps the markup intact.
 *
 * Decided on the cell's own content - real element children - never on a guess
 * about intent: `Styler.format` defaults to `escape=None`, so elements in a data
 * cell mean the user's own formatter emitted them (pandas escapes what it renders
 * itself).
 */
function holdsCellMarkup(bodyRows: Element[]): boolean {
	for (const tr of bodyRows) {
		for (const td of Array.from(tr.querySelectorAll('td'))) {
			if (td.children.length > 0) return true;
		}
	}
	return false;
}

/**
 * The frame's own statement of its size, when it makes one: polars writes
 * `<small>shape: (rows, cols)</small>` beside the table (a Series writes the
 * one-element `shape: (n,)`, whose table is one column wide). Returned so the
 * parsed column count can be CHECKED against it - the whole point of reading it.
 *
 * Deliberately NOT the pandas truncation footer (`N rows × M columns`), which is a
 * different sentence in a different place and is read separately below: it appears
 * only when pandas truncated, so it is a lower bound rather than a declaration.
 */
function declaredShape(doc: Document): { rows: number; cols: number } | null {
	for (const el of Array.from(doc.querySelectorAll('small'))) {
		const m = cellText(el).match(/^shape:\s*\((\d+)\s*,\s*(\d+)?\s*\)$/);
		if (!m) continue;
		const rows = parseInt(m[1], 10);
		// `(n,)` is a Series: n values in a single column.
		const cols = m[2] === undefined ? 1 : parseInt(m[2], 10);
		if (Number.isFinite(rows) && Number.isFinite(cols)) return { rows, cols };
	}
	return null;
}

/**
 * Parse a DataFrame `text/html` repr (pandas or polars) into a DataFramePayload,
 * or return null when the HTML is not a recognizable dataframe table (the caller
 * then falls back: HtmlOutput when rendering, tag-stripped text when copying).
 * Browser-only (uses DOMParser); returns null in a non-DOM context - which is why
 * a saved DataFrame repr copies as a stripped table outside a browser.
 */
export function parseDataFrameHtml(html: string | null | undefined): DataFramePayload | null {
	if (!html || typeof DOMParser === 'undefined') return null;
	// The table this parser requires is `table.dataframe`, so html that never says
	// "dataframe" cannot be one - answered here by a scan rather than by parsing a
	// possibly multi-MB Bokeh/Altair/folium bundle into a DOM only to reject it.
	// Case-insensitively, and with a regex (never `toLowerCase()`, which would copy
	// that whole bundle) because a fragment parsed without a doctype lands in quirks
	// mode, where class matching is case-insensitive.
	// A Styler carries no `dataframe` class at all, so it is admitted by its own
	// cheap token, `col_heading` - and only under a size ceiling, because unlike a
	// `_repr_html_` its HTML is not bounded by pandas' display options.
	//
	// THE CEILING IS DECIDED BY THAT SAME STRUCTURAL TOKEN, never by the ABSENCE of
	// the word "dataframe": a caption reading "Sales DataFrame", a cell value
	// mentioning it, a column named `dataframe_id`, a `set_table_styles` selector
	// copied from `.dataframe` CSS, or the documented
	// `set_table_attributes('class="dataframe"')` idiom all put that word in a
	// Styler's html - and keyed on it the ceiling was skipped while the Styler
	// branch below resolved the table anyway, so the multi-MB parse it exists to
	// prevent went ahead. The cheap length compare comes FIRST, so an oversized
	// bundle that is not a `class="dataframe"` table is refused without a second
	// full-string scan. The `class="dataframe"` admission itself stays uncapped.
	const dataframeClass = /dataframe/i.test(html);
	if (html.length > MAX_STYLER_HTML_CHARS) {
		if (!dataframeClass || /col_heading/.test(html)) return null;
	} else if (!dataframeClass && !/col_heading/.test(html)) {
		return null;
	}
	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return null;
	}

	// `table.dataframe` first (pandas/polars), then the Styler shape: the first
	// table carrying pandas' own semantic header class. Never keyed on the
	// `id="T_<hex>"`, which is a per-render uuid and settable by the user.
	const table =
		doc.querySelector('table.dataframe') ??
		Array.from(doc.querySelectorAll('table')).find((t) => t.querySelector('th.col_heading')) ??
		null;
	if (!table) return null;
	// What the table IS, never which selector answered: `set_table_attributes('class="dataframe"')`
	// is a documented Styler idiom, so a Styler can be resolved by the FIRST selector
	// and would then have skipped the markup refusal below. `col_heading` is pandas'
	// own semantic header class, which a Styler always emits and a plain
	// `to_html(escape=False)` frame never does - so the scoping the refusal needs is
	// a property of the markup rather than of the lookup order.
	const isStyler = table.querySelector('th.col_heading') !== null;
	const thead = table.querySelector('thead');
	const tbody = table.querySelector('tbody');
	if (!thead || !tbody) return null;

	const headerRows = Array.from(thead.querySelectorAll(':scope > tr'));
	if (headerRows.length === 0 || headerRows.length > MAX_HEADER_ROWS) return null;

	const shape = declaredShape(doc);

	// A header row made entirely of `<td>` is polars' dtype row - pandas puts only
	// `<th>` in its `<thead>`, so this both identifies the dialect and hands over
	// real declared dtypes instead of ones inferred from rendered text.
	const dtypeRow = headerRows.find((hr) => {
		const cells = rowCells(hr);
		return cells.length > 0 && cells.every((c) => c.tagName === 'TD');
	});
	// Expanded like the label rows, so the two line up by POSITION whatever a
	// producer does with colspan - a misaligned dtype is a silently wrong column type.
	const declaredDtypes = dtypeRow ? expandRow(dtypeRow) : null;

	// Classify the remaining header rows. A pandas NAMED INDEX renders as a second
	// row of `[indexName, '', '', …]` and a Styler as one carrying `th.index_name`;
	// everything else is a COLUMN LEVEL, of which a MultiIndex has several. Only a
	// row after the first can be the name row - a first row read as one would leave
	// no labels at all - and the `restEmpty` test is what tells it from a further
	// MultiIndex level, whose other positions carry real labels.
	const rest = headerRows.filter((hr) => hr !== dtypeRow);
	if (rest.length === 0) return null;
	let nameRow: Element | null = null;
	for (const hr of rest.slice(1)) {
		const cells = rowCells(hr);
		const first = cells[0] ? cellText(cells[0]) : '';
		const restEmpty = cells.slice(1).every((c) => cellText(c) === '');
		if (hr.querySelector('th.index_name') || (first !== '' && cells.length > 1 && restEmpty)) {
			nameRow = hr;
			break;
		}
	}
	const levelRows = rest.filter((hr) => hr !== nameRow);
	if (levelRows.length === 0) return null;

	const bodyRows = Array.from(tbody.querySelectorAll(':scope > tr')).filter(
		(tr) => tr.querySelectorAll('td').length > 0
	);

	// Scoped by `isStyler` deliberately: `to_html(escape=False)` on the
	// `class="dataframe"` path has flattened markup this way since long before this
	// parser, and changing that is a separate decision nobody asked for.
	if (isStyler && holdsCellMarkup(bodyRows)) return null;

	// How many leading header cells belong to the INDEX rather than to a column?
	// Read from the BODY, where pandas writes its index labels as `<th>` row headers
	// (one per index level, so a MultiIndex row has several) and polars writes none
	// at all. Never from the header: pandas puts the COLUMNS' name in that first
	// `<th>` (`df.columns.name = 'X'`), so a leading non-empty cell does not mean
	// there is no index. The first body row is the one to read - a MultiIndex
	// continuation row carries fewer `<th>`, its outer levels being spanned by a
	// `rowspan` above it. With no body to read at all, `emptyBodyIndexCols` decides -
	// and REFUSES rather than guessing.
	const levels = levelRows.map(expandRow);
	// Reduced rather than spread: one argument per header row would throw a
	// `RangeError` past the engine's call-argument limit, out of a module whose
	// contract is that it never throws.
	const width = levels.reduce((m, l) => (l.length > m ? l.length : m), 0);
	// Past the allocation bound nothing below may run: `rawColumns`, `keepCol` and
	// `columns` are each O(width) and the only refusal that would otherwise stop
	// them - the per-row width check - comes after all three.
	if (width > MAX_HEADER_COLUMNS) return null;
	const indexCols =
		bodyRows.length > 0
			? bodyRows[0].querySelectorAll('th').length
			: emptyBodyIndexCols(levels[0], declaredDtypes !== null);
	// No body, no dtype row and a labelled leading cell: nothing says whether that
	// cell is an index or a column, so there is no honest grid to render.
	if (indexCols === null) return null;
	const hasIndex = indexCols > 0;

	// One label per column position, joining that position's non-empty part from
	// each level. A truncated MultiIndex frame writes an ellipsis at every level of
	// its elided column, which must stay recognizable as one rather than becoming
	// "... / ...".
	const rawColumns: string[] = [];
	for (let i = indexCols; i < width; i++) {
		const parts = levels.map((l) => l[i] ?? '').filter((t) => t !== '');
		rawColumns.push(parts.length > 0 && parts.every(isEllipsis) ? '...' : parts.join(' / '));
	}
	if (rawColumns.length === 0) return null;
	// When a frame truncates columns it inserts a literal "..." ellipsis column
	// (pandas' "…" / polars' `&hellip;`); drop it so the grid shows real columns
	// (its own header already flags the truncation) and dtype inference isn't
	// poisoned by "..." cells.
	const keepCol = rawColumns.map((c) => !isEllipsis(c));
	const truncatedCols = keepCol.some((k) => !k);
	const columns = rawColumns.filter((_, i) => keepCol[i]);
	if (columns.length === 0) return null;

	const dtypes = declaredDtypes ? declaredDtypes.slice(indexCols).filter((_, i) => keepCol[i]) : null;

	const nameCells = nameRow ? rowCells(nameRow) : [];
	const indexName = nameCells[0] ? cellText(nameCells[0]) : '';

	const index: (string | number | null)[] = [];
	const data: (string | number | null)[][] = [];
	for (const tr of bodyRows) {
		const ths = Array.from(tr.querySelectorAll('th'));
		const tds = Array.from(tr.querySelectorAll('td'));
		// The row header(s) are the index label; a MultiIndex row has several — join
		// them so the label stays meaningful. The result is NOT unique: a pandas index
		// carries no uniqueness guarantee to begin with, and flattening a MultiIndex
		// tuple onto one string can collide on top of that - so a consumer must never
		// use `index` as an identity (DataFrameGrid keys its rows by position; keying
		// by the label throws Svelte's `each_key_duplicate` mid-render).
		const label = ths
			.map((th) => th.textContent?.trim() ?? '')
			.filter((s) => s !== '')
			.join(' / ');
		// Skip the truncation "..." row: every cell is an ellipsis, and the label is
		// one too (pandas) or absent (polars, whose truncation row carries no `<th>`).
		if ((label === '' || isEllipsis(label)) && tds.every((td) => isEllipsis(td.textContent ?? ''))) continue;
		// A row that does not line up with the header is a shape we cannot map, and
		// mapping it anyway is exactly how a column goes missing without anything
		// failing. Refuse the whole table rather than render a short row.
		if (tds.length !== rawColumns.length) return null;
		index.push(hasIndex ? coerceCell(label) : '');
		// Drop cells under the ellipsis column so rows stay aligned with `columns`.
		data.push(
			tds
				.filter((_, i) => keepCol[i])
				.map((td, i) => {
					const raw = td.textContent ?? '';
					return dtypes ? coercePolarsCell(raw, dtypes[i] ?? '') : coerceCell(raw);
				})
		);
	}

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

	// THE REFUSAL. A producer that declares its own shape is the one authority on
	// how many columns the frame has, so the parse is checked against it and a
	// disagreement falls back to the static table. Truncation is the one legitimate
	// way to hold fewer columns than were declared - and it is visible, as the
	// dropped ellipsis column - so it is required to be present exactly when the
	// counts differ, in BOTH directions: a missing column with no ellipsis is the
	// bug this exists to catch, and an ellipsis over a complete count means the
	// layout is not what we read it to be.
	if (shape) {
		if (truncatedCols ? shape.cols <= columns.length : shape.cols !== columns.length) return null;
		if (data.length > shape.rows) return null;
		totalRows = Math.max(totalRows, shape.rows);
		totalCols = Math.max(totalCols, shape.cols);
	}

	// A Styler's `set_caption(...)` is the one piece of its presentation the grid
	// can carry, so it does. `:scope >` keeps it this table's own caption rather
	// than a nested one's.
	const captionEl = table.querySelector(':scope > caption');
	const caption = captionEl ? cellText(captionEl) : '';

	return {
		columns,
		dtypes: dtypes ?? columns.map((_, ci) => inferDtype(data, ci)),
		index,
		index_name: indexName,
		data,
		total_rows: totalRows,
		total_cols: totalCols,
		shown_rows: data.length,
		shown_cols: columns.length,
		truncated_rows: totalRows > data.length,
		truncated_cols: totalCols > columns.length,
		has_index: hasIndex,
		...(caption ? { caption } : {})
	};
}
