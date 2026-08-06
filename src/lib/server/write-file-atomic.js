/**
 * `writeFileAtomic` - replace a file's contents with no window in which a reader
 * can see a half-written one, preserving the target's identity as a symlink and
 * its permission bits.
 *
 * Lifted out of `harness.js` once `json-store.ts` needed the same guarantees for
 * the preference stores. Node builtins ONLY, and in `package.json` `files`, so
 * `bin/cellar.js` can still reach it through `harness.js` (see that module's
 * header) while the bundled SvelteKit server imports it directly.
 *
 * ## Two atomic writers coexist, deliberately
 *
 * `atomic-write.ts`'s `atomicWriteFileSync` is the `.ipynb` path's writer. It does
 * NOT resolve a symlink and does NOT carry the target's mode across, so the two
 * are not interchangeable: this one is the strictly safer of the pair, and the
 * config/preference files it serves are exactly the ones a dotfile manager
 * symlinks and a user `chmod 600`s. Unifying them means touching the write path
 * for the user's PRIMARY data, which is a deliberate follow-up rather than a
 * detail of this module - until then, a new caller should reach for this one.
 */
import { join, dirname, basename } from 'node:path';
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Write `text` to `file` atomically: a unique temp in the TARGET's own directory
 * (a cross-device rename is not atomic), fsync, then rename over the target.
 * These files are the user's - they hold other MCP servers, `model`,
 * `approval_policy`, cross-project defaults - so a crash / full disk mid-write
 * must never leave a truncated one behind: a reader sees the complete old bytes
 * or the complete new ones. On any failure the temp is removed and the original
 * is untouched, which is the same never-clobber contract the successful path
 * keeps.
 *
 * It FOLLOWS a symlink: these are plausible dotfile-manager symlinks into a
 * managed repo, and rename installs a new inode over whatever it lands on, so
 * staging beside the LINK would replace the link itself with a regular file and
 * silently detach that setup. Resolving the target first keeps both properties -
 * the link survives and the real file is still replaced atomically. A target that
 * does not exist yet resolves to nothing and is written in place.
 *
 * @param {string} file
 * @param {string} text
 */
export function writeFileAtomic(file, text) {
	let target = file;
	try {
		target = realpathSync(file);
	} catch {}
	const dir = dirname(target);
	mkdirSync(dir, { recursive: true });
	// Carry the TARGET's permissions onto the replacement. temp+rename installs a
	// NEW inode, so without this the file comes back at the default `0o666 & ~umask`
	// (typically 0644) — whereas the in-place write this replaced truncated the
	// existing file and kept whatever mode the user had set. An MCP config commonly
	// holds another server's `env` block with an API token, so silently widening a
	// `chmod 600` config to world-readable is a disclosure, not a cosmetic change.
	// A missing target (first write) simply inherits the default.
	let mode;
	try {
		mode = statSync(target).mode & 0o7777;
	} catch {}
	const tmp = join(dir, `.${basename(target)}.cellar-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
	try {
		const fd = openSync(tmp, 'wx');
		try {
			// BEFORE the write, and via the fd. The obvious reading - set the mode on the
			// finished file - is the wrong one: the temp lives in the TARGET's directory,
			// so writing first leaves a complete copy of the merged config (another
			// server's `env` block, API token included) readable at the default
			// `0o666 & ~umask` for as long as the write takes. It goes through the fd
			// because `openSync`'s mode argument is masked by the umask, so a 0600 target
			// would still come back 0600 & ~umask.
			if (mode !== undefined) fchmodSync(fd, mode);
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, target);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw err;
	}
}
