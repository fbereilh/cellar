/**
 * Databricks Connect version reconciliation — the pure, dependency-free core.
 *
 * Databricks Connect requires the CLIENT version to be **≤** the target cluster's
 * Databricks Runtime (DBR): a client newer than the runtime hard-fails the
 * session with "Unsupported combination of Databricks Runtime & Databricks
 * Connect versions". Cellar's fix is to pin `databricks-connect` to the cluster's
 * DBR **major.minor line** (`databricks-connect==17.3.*`, newest patch of that
 * minor) instead of the latest — see `databricks.ts` `connect()`.
 *
 * These four helpers are the pure decisions that flow drives on; they are kept in
 * their own module (like `sql.ts`/`imports.js`) so they are unit-testable with no
 * kernel, no venv, and no SDK — see `tests/unit/dbr-version.test.ts`. `databricks.ts`
 * owns the impure parts (probing the cluster's `spark_version`, reinstalling, and
 * restarting the kernel).
 */

/**
 * The DBR **major.minor** line of a cluster `spark_version` string, or `null`
 * when it is not a classic-runtime string we can pin against.
 *
 * Classic DBR `spark_version` values start with `<major>.<minor>.` and carry a
 * variant tail: `17.3.x-scala2.12`, `15.4.x-photon-scala2.12`,
 * `13.3.x-cpu-ml-scala2.12`, `14.3.x-aarch64-scala2.12`. Only the leading
 * `<major>.<minor>` matters for pinning; the patch is always `x` (a placeholder),
 * so we resolve the newest patch of the minor line at install time via `==X.Y.*`.
 *
 * Anything that does NOT start with `<digits>.<digits>.` (a serverless/warehouse
 * marker, a `custom:` image, an empty/None value) returns `null` — the caller
 * then leaves the client untouched rather than guessing a pin. Serverless is not
 * pinned this way (and Cellar is cluster-only today anyway), so `null` is the
 * correct, safe answer there.
 */
export function dbrMajorMinor(sparkVersion: string | null | undefined): string | null {
	if (typeof sparkVersion !== 'string') return null;
	const m = /^(\d+)\.(\d+)\./.exec(sparkVersion.trim());
	return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * The **major.minor** of an installed `databricks-connect` version, e.g.
 * `"18.3.2"` → `"18.3"`. `null` when the version is absent/unparseable (treated
 * by the caller as "does not match", so a reinstall is attempted).
 */
export function connectMajorMinor(version: string | null | undefined): string | null {
	if (typeof version !== 'string') return null;
	const m = /^(\d+)\.(\d+)/.exec(version.trim());
	return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Given the cluster's DBR line (`dbrMajorMinor`) and the currently-installed
 * `databricks-connect` version, return the DBR line to **pin to**, or `null` when
 * no reinstall is needed.
 *
 *   - `dbr` unknown (`null`) ⇒ `null` (serverless / unresolvable — never guess).
 *   - installed client's major.minor already equals `dbr` ⇒ `null` (no-op; the
 *     newest patch of the right minor is fine, a patch-level move is never forced).
 *   - otherwise ⇒ `dbr` (e.g. `"17.3"`), the line to `databricks-connect==17.3.*`.
 *
 * Note this is symmetric: a client that is TOO OLD for the cluster is repinned to
 * the cluster's line just as a too-new one is, which is the correct client either
 * way.
 */
export function pinTargetForConnect(
	dbr: string | null | undefined,
	installedConnect: string | null | undefined
): string | null {
	if (!dbr) return null;
	return connectMajorMinor(installedConnect) === dbr ? null : dbr;
}

/**
 * Parse the runtime/client versions out of Databricks Connect's version-mismatch
 * error, or `null` if the message is not that error. The SDK phrases it as:
 *
 *   Unsupported combination of Databricks Runtime & Databricks Connect versions:
 *   17.3 (Databricks Runtime) < 18.3.2 (Databricks Connect).
 *
 * `runtime` is `major.minor` (what to pin the client to); `client` is the full
 * offending client version (for the user-facing message). Matched
 * case-insensitively and tolerant of surrounding whitespace/newlines, since it
 * arrives wrapped in an exception repr.
 */
export function parseVersionMismatch(
	message: string | null | undefined
): { runtime: string; client: string } | null {
	if (typeof message !== 'string') return null;
	const m =
		/(\d+\.\d+)\s*\(Databricks Runtime\)\s*<\s*(\d+(?:\.\d+)+)\s*\(Databricks Connect\)/i.exec(
			message
		);
	return m ? { runtime: m[1], client: m[2] } : null;
}

/**
 * The user-facing, actionable message for a version mismatch. Reflects that
 * Cellar manages the venv and can pin the matching client itself, and always
 * names the exact `databricks-connect==X.Y.*` line so the fix is unambiguous.
 */
export function versionMismatchMessage({
	runtime,
	client
}: {
	runtime: string;
	client: string;
}): string {
	return (
		`Databricks Connect (${client}) is newer than your cluster's runtime (DBR ${runtime}). ` +
		`Cellar needs a client that matches — pin \`databricks-connect==${runtime}.*\` ` +
		`(Cellar re-pins this automatically on your next connect, or set "${runtime}" in the ` +
		`Databricks panel's runtime-version field and reinstall).`
	);
}
