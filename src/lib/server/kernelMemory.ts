/**
 * Per-kernel resident-memory (RSS) sampling.
 *
 * Cellar has NO OS pid for a kernel: `@jupyterlab/services` connects to the shared
 * `jupyter_server` sidecar over REST + WebSocket, so the only handle it holds is
 * the Jupyter `kernel.id` (a UUID). The kernel itself is a grandchild the sidecar
 * spawns from the kernelspec, and its argv carries the connection file
 * `kernel-<id>.json` — so the id we DO have appears verbatim in the process command
 * line. That is the bridge: scan host processes once, map each `kernel.id` back to
 * its pid by matching the id in the command line, and read that process's RSS.
 *
 * Why measure from the HOST and not inside the kernel: an in-kernel probe rides the
 * shell channel and QUEUES behind a running cell (the same reason `kernel.ts`'s
 * liveness probe uses the REST API, not an `execute`), so it could never report
 * memory for a BUSY kernel — exactly when memory matters (a cell allocating a large
 * array). Reading RSS out-of-band from the OS works whether the kernel is idle or
 * mid-run.
 *
 * Portability: Node has no built-in way to read another process's RSS, so we shell
 * to `ps` — the same POSIX pattern `instances.js` already uses for pid scanning.
 * `ps -eo rss=` reports resident set size in KiB on both macOS and Linux, so the
 * reading is cross-platform with no per-OS branching. Windows has no `ps`; there we
 * return nothing (the UI blanks the figure gracefully).
 *
 * Scope: this reports the MAIN kernel process's RSS only. Child processes it may
 * spawn (multiprocessing/joblib workers) are NOT summed in — Databricks Spark work
 * runs on the remote cluster, not local children, so the main process is the whole
 * story for the common case. A future enhancement could add direct children by
 * matching `ppid`.
 */
import { execFile } from 'node:child_process';

/** Cap on `ps` stdout so a pathological process table can't blow up heap. */
const MAX_PS_BUFFER = 8 * 1024 * 1024;

/**
 * Sample resident memory (bytes) for the given Jupyter kernel ids.
 *
 * Returns a map of `kernel.id → rssBytes` containing only the ids whose process was
 * found. A missing id (kernel gone, or a platform without `ps`) is simply absent, so
 * the caller distinguishes "no reading" from a real zero. Never throws for an
 * unmatched id; only rejects if `ps` itself cannot be run (the caller keeps its last
 * readings and retries on the next tick).
 */
export function sampleKernelMemory(kernelIds: Iterable<string>): Promise<Map<string, number>> {
	const ids = [...kernelIds].filter((id) => typeof id === 'string' && id.length > 0);
	if (ids.length === 0 || process.platform === 'win32') {
		return Promise.resolve(new Map());
	}
	return new Promise((resolve, reject) => {
		// `pid`/`rss`/`command` in one scan: rss is KiB on macOS AND Linux, and the
		// full command carries the `kernel-<id>.json` connection-file argument we match.
		execFile(
			'ps',
			['-eo', 'pid=,rss=,command='],
			{ encoding: 'utf8', maxBuffer: MAX_PS_BUFFER },
			(err, stdout) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(parsePsOutput(stdout, ids));
			}
		);
	});
}

/**
 * Pure parser (exported for unit tests): map each kernel id to the RSS (bytes) of the
 * process whose command line contains it. `ps -eo rss=` is KiB, so we scale by 1024.
 * A line is `  <pid> <rssKiB> <command…>`; we match on the id appearing anywhere in
 * the command (it only ever shows up in the `-f …/kernel-<id>.json` argument).
 */
export function parsePsOutput(stdout: string, kernelIds: string[]): Map<string, number> {
	const out = new Map<string, number>();
	if (!stdout) return out;
	for (const line of stdout.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		const rssKiB = parseInt(m[2], 10);
		if (!Number.isFinite(rssKiB)) continue;
		const command = m[3];
		for (const id of kernelIds) {
			if (out.has(id)) continue; // first match wins — the id is unique to one process
			if (command.includes(id)) out.set(id, rssKiB * 1024);
		}
	}
	return out;
}
