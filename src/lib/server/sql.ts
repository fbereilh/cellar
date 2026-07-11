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
 *  - Result binding: the (lazy, un-limited) Spark DataFrame is bound to
 *    `_sql_df` in the kernel namespace, so a following Python cell can chain off
 *    the last SQL result (`_sql_df.groupBy(...)`, `_sql_df.write...`).
 *  - Robustness: the query is embedded as a JSON-encoded string literal
 *    (`JSON.stringify`), which is a valid Python `str` literal for any input, so a
 *    query containing quotes, backslashes, or newlines needs no hand-escaping.
 */

/** Rows fetched for display. Matches kernel.js's DataFrame formatter MAX_ROWS. */
export const SQL_ROW_CAP = 500;

/** Kernel variable the last SQL result's (lazy) Spark DataFrame is bound to. */
export const SQL_RESULT_VAR = '_sql_df';

const NO_SPARK_MESSAGE =
	'No Spark session is connected. Open the Databricks panel in the Cellar sidebar and connect a cluster to run SQL cells.';

/** Options for `sqlToPython`. */
export interface SqlToPythonOptions {
	/** Rows fetched for display; defaults to SQL_ROW_CAP. */
	rowCap?: number;
	/** Kernel variable the result's Spark DataFrame is bound to; defaults to SQL_RESULT_VAR. */
	resultVar?: string;
}

/**
 * Compile a SQL cell's source into the Python that executes it. Returns '' for an
 * empty cell (nothing to run, no error). The generated code:
 *   1. asserts `spark` exists, raising a friendly message if not;
 *   2. binds the query's Spark DataFrame to `_sql_df`;
 *   3. leaves `_sql_df.limit(N).toPandas()` as the trailing expression, so the
 *      grid renders it.
 */
export function sqlToPython(
	sqlSource: string | null | undefined,
	{ rowCap = SQL_ROW_CAP, resultVar = SQL_RESULT_VAR }: SqlToPythonOptions = {}
): string {
	// Strip a single trailing statement terminator + surrounding whitespace:
	// `spark.sql` executes ONE statement and rejects a trailing `;`.
	const query = String(sqlSource ?? '')
		.replace(/;\s*$/, '')
		.trim();
	if (!query) return '';
	const literal = JSON.stringify(query);
	return [
		'try:',
		'    spark',
		'except NameError:',
		`    raise RuntimeError(${JSON.stringify(NO_SPARK_MESSAGE)}) from None`,
		`${resultVar} = spark.sql(${literal})`,
		`${resultVar}.limit(${rowCap}).toPandas()`,
		''
	].join('\n');
}
