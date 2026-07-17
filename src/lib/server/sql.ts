/**
 * Cellar - SQL cell execution (compile SQL → the Python that runs it).
 *
 * A SQL cell stores raw SQL as its source (see `$lib/cellLanguage.js`), but the
 * kernel is a Python kernel. So at RUN time - and only at run time - the SQL is
 * compiled to a small Python wrapper that executes it against the live `spark`
 * session (bound in the kernel when Databricks is connected) and yields a bounded
 * pandas DataFrame as the cell's result, which Cellar's DataFrame formatter
 * (`kernel.js`) then renders as the interactive grid. The cell's stored source
 * stays SQL; this compilation is invisible to the document and to git.
 *
 * DESIGN NOTES (documented for the PR):
 *  - Engine: `spark.sql(...)`. Spark is the target; there is no local
 *    duckdb/sqlite fallback in v1 - a SQL cell run with no Spark session raises a
 *    clear "connect Databricks" message rather than silently using another engine.
 *  - Row cap: the result is collected with `.limit(ROW_CAP)` BEFORE `.toPandas()`,
 *    so a huge query never pulls a million rows into the driver or the browser.
 *    ROW_CAP matches the DataFrame formatter's own MAX_ROWS so the grid shows the
 *    whole fetched set. The underlying Spark DataFrame is left un-collected.
 *  - Result binding: the (lazy, un-limited) Spark DataFrame is bound to `_sql_df`
 *    in the kernel namespace, so a following Python cell can chain off the last SQL
 *    result (`_sql_df.groupBy(...)`, `_sql_df.write...`). `_sql_df` is LAST-WRITE-
 *    WINS across the notebook - two SQL cells and the second clobbers the first -
 *    which is why a cell may NAME its own binding with a prefix line (below).
 *  - Robustness: the query is embedded as a JSON-encoded string literal
 *    (`JSON.stringify`), which is a valid Python `str` literal for any input, so a
 *    query containing quotes, backslashes, or newlines needs no hand-escaping.
 *
 * THE BINDING PREFIX LINE (`-- >> sales_df`).
 * A SQL cell may open with `-- >> <name>` to bind its result to `<name>` instead of
 * only the shared `_sql_df`. The syntax is a plain SQL line comment on purpose: the
 * cell still parses as SQL in any other tool, survives a round-trip through plain
 * Jupyter (it is just part of the source), the CodeMirror `sql()` grammar
 * highlights it as a comment, and an agent reading the cell over MCP sees the
 * binding without a new tool. It is recognized ONLY as the first non-blank line and
 * is stripped before the query reaches `spark.sql`.
 *
 *  - A named cell binds BOTH: `<name>` AND `_sql_df`. `_sql_df` is documented to
 *    agents (`mcp/server.ts`) as "the last SQL result" chain-off point, and that
 *    contract must keep holding for a named cell too; the named binding is the
 *    stable one, `_sql_df` stays the (last-write-wins) alias it has always been.
 *  - No prefix line ⇒ byte-for-byte today's output. Existing notebooks are unmoved.
 *  - The name is interpolated into generated Python, so it is VALIDATED (a strict
 *    ASCII identifier, not a Python keyword, and not one of the names Cellar itself
 *    binds in the kernel - `spark`/`w`), never merely quoted. An unusable name
 *    compiles to a `raise` - the cell fails with an actionable message instead of
 *    emitting broken Python, rebinding the live Spark session, or silently ignoring
 *    the line.
 *
 * `parseSqlCell` is the single source of truth for both halves: `sqlToPython`
 * compiles from it, and `dataflow.ts` reads `resultVars` from it to give a SQL cell
 * its synthetic `defines` (SQL never reaches the `symtable` probe).
 */

/** Rows fetched for display. Matches kernel.js's DataFrame formatter MAX_ROWS. */
export const SQL_ROW_CAP = 500;

/** Kernel variable the last SQL result's (lazy) Spark DataFrame is bound to. */
export const SQL_RESULT_VAR = '_sql_df';

/** The marker that opens a binding prefix line: `-- >> name`. */
export const SQL_BIND_MARKER = '-- >>';

const NO_SPARK_MESSAGE =
	'No Spark session is connected. Open the Databricks panel in the Cellar sidebar and connect a cluster to run SQL cells.';

/**
 * The binding prefix line, matched against the cell's first non-blank line only.
 * Whitespace around the `--`, the `>>`, and the name is tolerated; the captured
 * tail is validated separately so a malformed tail produces a real message rather
 * than a silent non-match.
 */
const BIND_LINE_RE = /^[ \t]*--[ \t]*>>(.*)$/;

/**
 * A name we will interpolate into generated Python must be provably safe, so this
 * is deliberately STRICTER than Python's own identifier rule (which allows
 * unicode): ASCII letters/underscore, then letters/digits/underscore. Anything else
 * - a dotted path, a subscript, a space, a quote, a newline - fails validation and
 * never reaches the generated source.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Python 3 hard keywords. Soft keywords (`match`, `case`, `type`, `_`) are legal names, so they are absent. */
const PYTHON_KEYWORDS = new Set([
	'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
	'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
	'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
	'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

/**
 * Names Cellar itself binds in the kernel on Databricks connect (`databricks.ts`),
 * mapped to what rebinding one would destroy. Legal Python names, so they pass the
 * identifier + keyword checks - but a cell that took one would silently replace the
 * live session/client with a DataFrame, which is why they are reserved here.
 */
const RESERVED_KERNEL_NAMES = new Map([
	['spark', 'the live Spark session'],
	['w', 'the Databricks WorkspaceClient']
]);

/** Options for `sqlToPython`. */
export interface SqlToPythonOptions {
	/** Rows fetched for display; defaults to SQL_ROW_CAP. */
	rowCap?: number;
	/** Kernel variable the result binds to when the cell has NO prefix line; defaults to SQL_RESULT_VAR. */
	resultVar?: string;
}

/** What a SQL cell's source says about its query and its result binding. */
export interface SqlCellBinding {
	/** The SQL actually sent to `spark.sql` - the prefix line stripped, terminator trimmed. */
	query: string;
	/** The name from the prefix line, or null when the cell has none (or it is unusable). */
	boundVar: string | null;
	/**
	 * Every kernel name this cell binds, in assignment order - `[]` for an empty or
	 * failing cell. This is exactly what the staleness graph must treat the cell as
	 * DEFINING, which is why it is computed here rather than re-derived downstream.
	 */
	resultVars: string[];
	/** Set when the prefix line is present but unusable; the cell must FAIL with this. */
	error: string | null;
}

/**
 * Read a SQL cell's source into its query + result binding. Pure; never throws.
 *
 * @param sqlSource the cell's raw SQL source
 * @param defaultVar the binding for a cell with no prefix line (defaults to `_sql_df`)
 */
export function parseSqlCell(
	sqlSource: string | null | undefined,
	defaultVar: string = SQL_RESULT_VAR
): SqlCellBinding {
	const raw = String(sqlSource ?? '');
	const lines = raw.split('\n');
	// The prefix line is the FIRST non-blank line or nothing: we never scan the body,
	// so a `-- >> x` sitting in the middle of a query stays an ordinary SQL comment.
	const first = lines.findIndex((l) => l.trim() !== '');
	const match = first >= 0 ? BIND_LINE_RE.exec(lines[first]) : null;

	if (!match) {
		const query = trimQuery(raw);
		return { query, boundVar: null, resultVars: query ? [defaultVar] : [], error: null };
	}

	const query = trimQuery(lines.slice(first + 1).join('\n'));
	const name = match[1].trim();
	const error = bindingError(name);
	if (error) return { query, boundVar: null, resultVars: [], error };

	// A named cell binds its own name AND keeps `defaultVar` (`_sql_df` in production)
	// as the documented "last SQL result" alias. `resultVars` de-duplicates so
	// `-- >> _sql_df` (legal, if pointless) does not claim to bind the same name twice.
	const resultVars = query ? [...new Set([name, defaultVar])] : [];
	return { query, boundVar: name, resultVars, error: null };
}

/** Trim surrounding whitespace and a single trailing `;` (`spark.sql` runs ONE statement and rejects it). */
function trimQuery(text: string): string {
	return text.replace(/;\s*$/, '').trim();
}

/** Why this prefix-line name is unusable, or null when it is fine. */
function bindingError(name: string): string | null {
	const where = `Fix the \`${SQL_BIND_MARKER} <name>\` line at the top of this SQL cell, or remove it to bind the result to \`${SQL_RESULT_VAR}\`.`;
	if (!name) {
		return `This SQL cell's \`${SQL_BIND_MARKER}\` line names no variable. Write \`${SQL_BIND_MARKER} my_df\` to bind the result to \`my_df\`. ${where}`;
	}
	if (/\s/.test(name)) {
		return `This SQL cell's \`${SQL_BIND_MARKER}\` line must name exactly ONE variable, but got ${JSON.stringify(name)}. ${where}`;
	}
	if (!IDENTIFIER_RE.test(name)) {
		return `${JSON.stringify(name)} is not a valid Python variable name, so this SQL cell's result cannot be bound to it. Use letters, digits and underscores, starting with a letter or underscore. ${where}`;
	}
	if (PYTHON_KEYWORDS.has(name)) {
		return `\`${name}\` is a Python keyword, so this SQL cell's result cannot be bound to it. Pick another name. ${where}`;
	}
	const reserved = RESERVED_KERNEL_NAMES.get(name);
	if (reserved) {
		return `\`${name}\` is reserved: Cellar binds it in the kernel when you connect Databricks, where it is ${reserved}. Binding this SQL cell's result to it would destroy ${reserved}. Pick another name. ${where}`;
	}
	return null;
}

/**
 * Compile a SQL cell's source into the Python that executes it. Returns '' for an
 * empty cell (nothing to run, no error). The generated code:
 *   1. asserts `spark` exists, raising a friendly message if not;
 *   2. binds the query's Spark DataFrame to every name `parseSqlCell` reports, in
 *      order - the cell's own name, then the `_sql_df` alias when it named one;
 *   3. leaves `<var>.limit(N).toPandas()` as the trailing expression, so the grid
 *      renders it.
 * A cell whose `-- >>` line is unusable compiles to a single `raise` carrying the
 * reason, so it fails visibly instead of running against the wrong binding.
 */
export function sqlToPython(
	sqlSource: string | null | undefined,
	{ rowCap = SQL_ROW_CAP, resultVar = SQL_RESULT_VAR }: SqlToPythonOptions = {}
): string {
	const { query, resultVars, error } = parseSqlCell(sqlSource, resultVar);
	if (error) return `raise RuntimeError(${JSON.stringify(error)})\n`;
	if (!query) return '';

	// `resultVars` IS the binding list, in assignment order: the target first, then any
	// alias. Compiling from it is what makes `parseSqlCell` the single source of truth -
	// the graph is told exactly the names this code binds, and no more. A cell with no
	// prefix line yields one name, keeping the legacy shape exactly (no alias line).
	const [target, ...aliases] = resultVars;
	const literal = JSON.stringify(query);
	const lines = [
		'try:',
		'    spark',
		'except NameError:',
		`    raise RuntimeError(${JSON.stringify(NO_SPARK_MESSAGE)}) from None`,
		`${target} = spark.sql(${literal})`,
		...aliases.map((alias) => `${alias} = ${target}`),
		`${target}.limit(${rowCap}).toPandas()`,
		''
	];
	return lines.join('\n');
}
