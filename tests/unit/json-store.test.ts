import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **The mechanism behind both preference stores** (`$lib/server/json-store.ts`).
 *
 * The per-project `ui-state` and the cross-project `user-settings` share this one
 * implementation, so what is asserted here holds for both. Two properties are the
 * reason the module is worth its own suite, and neither is visible from the stores'
 * own tests:
 *
 *   1. **A concurrent write may cost a redundant re-read; it may never be missed.**
 *      The cache is re-read when an mtime+size stamp says the file moved, and the
 *      global store is one file every running instance writes. A stamp taken AFTER
 *      the read records content this cache does not hold as already loaded - and
 *      since nothing else moves the stamp, the store is then stale permanently,
 *      which is precisely the failure the reload exists to prevent.
 *   2. **The write is atomic.** A truncated file reads as an EMPTY store (correct in
 *      itself, since it is read during SSR), so a half-written flush is a silent
 *      loss of the user's settings rather than a visible error.
 *
 * `readFileSync` is wrapped so a write can be driven INTO the read window
 * deterministically - the race is otherwise unobservable, which is exactly why it
 * would survive a suite that only wrote files one after another.
 */

const hooks = vi.hoisted(() => ({ duringRead: null as (() => void) | null }));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
			const out = actual.readFileSync(...args);
			const hook = hooks.duringRead;
			hooks.duringRead = null;
			hook?.();
			return out;
		}) as typeof actual.readFileSync
	};
});

import { createJsonStore } from '../../src/lib/server/json-store';

let dir = '';
let file = '';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-json-store-'));
	file = join(dir, 'store.json');
	hooks.duringRead = null;
});

afterEach(() => {
	hooks.duringRead = null;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('re-reading a store another instance is writing', () => {
	it('picks up a write that landed INSIDE the read it raced, on the next read', () => {
		const store = createJsonStore(() => file);
		writeFileSync(file, JSON.stringify({ k: 'first' }));
		expect(store.get().k).toBe('first');

		// Another instance writes, so the next read reloads - and a THIRD write lands
		// while that reload is in flight, i.e. after the bytes were read but before the
		// stamp could be taken. Stamped afterwards, `third-3333` would be recorded as
		// loaded while the cache still held `second-22`, and no later read would ever
		// correct it.
		writeFileSync(file, JSON.stringify({ k: 'second-22' }));
		hooks.duringRead = () => writeFileSync(file, JSON.stringify({ k: 'third-3333' }));

		store.get();
		expect(store.get().k).toBe('third-3333');
	});

	it('does not re-read when nothing moved', () => {
		const store = createJsonStore(() => file);
		writeFileSync(file, JSON.stringify({ k: 'v' }));
		expect(store.get().k).toBe('v');

		// A read that reloaded here would fire the hook and see the swap; a quiet file
		// must cost a `stat` and nothing else.
		hooks.duringRead = () => writeFileSync(file, JSON.stringify({ k: 'should-not-be-read' }));
		expect(store.get().k).toBe('v');
		expect(hooks.duringRead).not.toBeNull();
	});

	it('catches another instance whose write kept the mtime AND the size', () => {
		// The shape a coarse-granularity filesystem (NFS, some container overlays)
		// produces: a same-size write inside one timestamp tick. On mtime+size alone
		// the stamp compares EQUAL and nothing else ever moves it, so the cache would
		// be stale for good - the permanent staleness the reload exists to prevent, and
		// the module's own `GLOBAL_` → `OTHER_` example is same-length. Every writer
		// here goes through temp+rename, so the inode moves even when neither of the
		// other two does.
		const ours = createJsonStore(() => file);
		const theirs = createJsonStore(() => file);
		// A whole second, so pinning it back is exact rather than truncated - the point
		// is a timestamp that genuinely does not move between the two writes.
		const tick = new Date(1_700_000_000_000);

		theirs.set({ k: 'AAA' });
		theirs.flush();
		utimesSync(file, tick, tick);
		expect(ours.get().k).toBe('AAA');
		const before = statSync(file, { bigint: true });

		theirs.set({ k: 'BBB' });
		theirs.flush();
		utimesSync(file, tick, tick);
		const after = statSync(file, { bigint: true });
		expect(after.size).toBe(before.size);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(after.ino).not.toBe(before.ino);

		expect(ours.get().k).toBe('BBB');
	});

	it('still catches an external write made after our OWN flush', () => {
		// The flush stamps the file it just wrote so its own bytes are not a change to
		// catch up on - that must not blind the store to somebody else's.
		const store = createJsonStore(() => file);
		store.set({ k: 'ours' });
		store.flush();
		expect(store.get().k).toBe('ours');

		writeFileSync(file, JSON.stringify({ k: 'theirs' }));
		expect(store.get().k).toBe('theirs');
	});
});

describe('persisting the store', () => {
	it('replaces the file atomically, so a crash mid-write cannot truncate it', () => {
		// temp+fsync+rename installs a NEW inode; an in-place `writeFileSync` truncates
		// and keeps the old one, which is the window this closes.
		const store = createJsonStore(() => file);
		store.set({ k: 'a' });
		store.flush();
		const first = statSync(file).ino;

		store.set({ k: 'b' });
		store.flush();
		expect(statSync(file).ino).not.toBe(first);
	});

	it('keeps a symlinked store a symlink, and writes through to the real file', () => {
		// `~/.cellar/settings.json` is a plausible dotfile-manager symlink, and rename
		// installs a new inode over whatever it lands on - so staging beside the LINK
		// would replace the setup with a regular file and silently detach it.
		const real = join(dir, 'real-store.json');
		writeFileSync(real, JSON.stringify({ k: 'old' }));
		const link = join(dir, 'linked.json');
		symlinkSync(real, link);

		const store = createJsonStore(() => link);
		store.set({ k: 'new' });
		store.flush();

		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(real, 'utf8')).k).toBe('new');
	});

	it("carries the target's permission bits across the replacement", () => {
		// temp+rename installs a NEW inode, so without carrying the mode a `chmod 600`
		// store comes back at the umask default. And the temp sits in the target's own
		// directory, so the mode has to be on it BEFORE the bytes go in.
		const store = createJsonStore(() => file);
		store.set({ k: 'a' });
		store.flush();
		chmodSync(file, 0o600);

		store.set({ k: 'b' });
		store.flush();
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it('leaves no temp file behind', () => {
		const store = createJsonStore(() => file);
		store.set({ k: 'a' });
		store.flush();
		expect(readdirSync(dir)).toEqual(['store.json']);
	});

	it('creates the directory it needs, and an unwritable one degrades quietly', () => {
		const nested = createJsonStore(() => join(dir, 'deep', 'store.json'));
		nested.set({ k: 'v' });
		expect(() => nested.flush()).not.toThrow();
		expect(readdirSync(join(dir, 'deep'))).toEqual(['store.json']);

		// A directory where the file belongs: the rename fails, nothing escapes, and no
		// stray temp is left in its place.
		const blockedDir = join(dir, 'blocked');
		const blocked = createJsonStore(() => join(blockedDir, 'store.json'));
		mkdirSync(join(blockedDir, 'store.json'), { recursive: true });
		blocked.set({ k: 'v' });
		expect(() => blocked.flush()).not.toThrow();
		expect(readdirSync(blockedDir)).toEqual(['store.json']);
	});
});
