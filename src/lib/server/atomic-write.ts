/**
 * Cellar — atomic, durable file writes.
 *
 * A notebook is the user's PRIMARY data. Overwriting it with a single in-place
 * `writeFileSync` means a crash / disk-full / SIGKILL mid-write truncates it: a
 * reader (or the next launch) then sees a half-written, unparseable `.ipynb`.
 *
 * `atomicWriteFileSync` closes that window. It writes the full payload to a
 * UNIQUE temp file IN THE SAME DIRECTORY as the target, `fsync`s it (so the
 * bytes are on stable storage, not just in the page cache), then `renameSync`s
 * it over the target. `rename(2)` within one filesystem is atomic, so a reader
 * observes either the complete old file or the complete new one — never a
 * partial. On ANY error the temp file is removed and the original is left
 * untouched (the target is only ever replaced by a fully written, fsync'd file).
 *
 * The temp lives in the target's directory (not `/tmp`) because a cross-device
 * rename is NOT atomic — it degrades to copy+unlink, reintroducing the very
 * truncation window this exists to remove.
 */
import { openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Monotonic per-process counter so concurrent writes never share a temp name. */
let tempSeq = 0;

/**
 * Atomically write `data` to `path` (temp-in-same-dir + fsync + rename).
 *
 * The temp name is unique per (process, call), so two writes racing to the same
 * target each own a private temp — neither can observe or clobber the other's
 * half-written bytes; the two renames simply race and the last complete file
 * wins. Synchronous and durable: the bytes are fsync'd and the rename has
 * returned before this call does.
 */
export function atomicWriteFileSync(path: string, data: string | Uint8Array): void {
	const dir = dirname(path);
	// Hidden, unique, .tmp-suffixed so a stray temp (should a hard-kill land
	// between write and rename) is easy to spot and never mistaken for content.
	const temp = join(dir, `.${basename(path)}.${process.pid}.${tempSeq++}.tmp`);
	let fd: number | null = null;
	try {
		fd = openSync(temp, 'w');
		// Branch so each `writeSync` overload gets a concretely-typed argument.
		if (typeof data === 'string') writeSync(fd, data);
		else writeSync(fd, data);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temp, path);
	} catch (err) {
		// Leave the original intact: the target was never touched (rename is the
		// only thing that replaces it, and it either fully succeeded or never ran).
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* already closed / invalid fd */
			}
		}
		try {
			rmSync(temp, { force: true });
		} catch {
			/* best-effort temp cleanup; nothing else to do */
		}
		throw err;
	}
}
