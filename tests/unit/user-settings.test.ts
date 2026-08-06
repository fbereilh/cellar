import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	getUserSettings,
	setUserSettings,
	__resetUserSettingsCache,
	UPLOAD_PREFIX_DEFAULT_KEY,
	UPLOAD_POSTFIX_DEFAULT_KEY
} from '../../src/lib/server/user-settings';
import * as shared from '../../src/lib/uploadDefaults';

/**
 * **The cross-project user-setting store** (`$lib/server/user-settings.ts`).
 *
 * The third and last store Cellar has, and the only one tied to neither a
 * workspace nor a browser origin. What matters about it:
 *
 *   1. It is **durable across launches** - the whole reason it is not
 *      `localStorage`, which is scoped to a dynamic port and empties every relaunch.
 *   2. It is **global** - the reason it is not the per-project `.cellar/` store,
 *      which cannot answer for a project it is not in.
 *   3. A **missing or corrupt file is an empty store, never a throw**: it is read
 *      during SSR, so bad JSON would take the whole page down rather than lose one
 *      preference.
 *
 * Every test redirects the store with `CELLAR_USER_SETTINGS`. Without it these
 * would read and REWRITE the real settings of whoever ran the suite - which is what
 * that override is for.
 */

let dir = '';
let file = '';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-user-settings-'));
	file = join(dir, 'settings.json');
	process.env.CELLAR_USER_SETTINGS = file;
	// Drop anything a previous test left in memory BEFORE this one reads.
	__resetUserSettingsCache();
});

afterEach(() => {
	// Flush while the directory still exists, then let go of it.
	__resetUserSettingsCache();
	delete process.env.CELLAR_USER_SETTINGS;
	if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('the cross-project user-setting store', () => {
	it('starts empty when nothing was ever written', () => {
		expect(getUserSettings()).toEqual({});
	});

	it('SURVIVES a relaunch - which is the entire reason it is not localStorage', () => {
		setUserSettings({ [UPLOAD_PREFIX_DEFAULT_KEY]: '{YYYYMM}_' });
		// Flush to disk, then forget: a different process, a different port, another day.
		__resetUserSettingsCache();
		expect(getUserSettings()[UPLOAD_PREFIX_DEFAULT_KEY]).toBe('{YYYYMM}_');
	});

	it('stores the PATTERN, not what it expanded to', () => {
		// A default is reused across projects and across days, so a resolved date would
		// stamp every later upload with the day the default happened to be set.
		setUserSettings({ [UPLOAD_PREFIX_DEFAULT_KEY]: '{YYYY-MM}_' });
		__resetUserSettingsCache();
		expect(readFileSync(file, 'utf8')).toContain('{YYYY-MM}_');
	});

	it('shallow-merges, and a null DELETES - an empty default is no default', () => {
		setUserSettings({ [UPLOAD_PREFIX_DEFAULT_KEY]: 'a_', [UPLOAD_POSTFIX_DEFAULT_KEY]: '_b' });
		setUserSettings({ [UPLOAD_PREFIX_DEFAULT_KEY]: null });
		const store = getUserSettings();
		expect(Object.prototype.hasOwnProperty.call(store, UPLOAD_PREFIX_DEFAULT_KEY)).toBe(false);
		expect(store[UPLOAD_POSTFIX_DEFAULT_KEY]).toBe('_b');
	});

	it('hands back a COPY, so a caller cannot mutate the store by accident', () => {
		setUserSettings({ k: 'v' });
		const snapshot = getUserSettings();
		snapshot.k = 'tampered';
		expect(getUserSettings().k).toBe('v');
	});

	it('reads a corrupt or non-object file as EMPTY rather than throwing', () => {
		// It is read during SSR: a throw takes the whole page down, while an empty store
		// costs one preference. Both shapes a hand-edit produces are covered.
		for (const bad of ['{not json', '[1,2,3]', '"a string"']) {
			writeFileSync(file, bad);
			__resetUserSettingsCache();
			expect(getUserSettings()).toEqual({});
		}
	});

	it('creates the directory it needs, so a first run has nowhere to fail', () => {
		const nested = join(dir, 'deep', 'settings.json');
		process.env.CELLAR_USER_SETTINGS = nested;
		__resetUserSettingsCache();
		setUserSettings({ k: 'v' });
		__resetUserSettingsCache();
		expect(existsSync(nested)).toBe(true);
	});

	it('an unwritable location degrades quietly instead of failing the request', () => {
		// The write is a side effect of a preference change; a read-only home must not
		// turn that into a 500 on a page load.
		const blocked = join(dir, 'blocked');
		mkdirSync(join(blocked, 'settings.json'), { recursive: true }); // a DIR where the file goes
		process.env.CELLAR_USER_SETTINGS = join(blocked, 'settings.json');
		__resetUserSettingsCache();
		expect(() => {
			setUserSettings({ k: 'v' });
			__resetUserSettingsCache();
		}).not.toThrow();
	});

	it('picks up a write by ANOTHER instance - the store is global, so it is shared', () => {
		// Cellar runs an instance per repo, and this store is one file under `~/.cellar/`
		// that all of them read. A cache that only ever loaded once made a default set in
		// one instance invisible to every instance already running, permanently - which is
		// the whole feature failing in exactly the multi-project case it exists for. So
		// what another writer put on disk is picked up on the next read, with no reset.
		writeFileSync(file, JSON.stringify({ [UPLOAD_PREFIX_DEFAULT_KEY]: 'at_boot_' }));
		__resetUserSettingsCache();
		expect(getUserSettings()[UPLOAD_PREFIX_DEFAULT_KEY]).toBe('at_boot_'); // now cached
		// Another instance sets the default. No reset here, deliberately: this instance is
		// still running, and "restart it" was the only way to see the change before.
		writeFileSync(file, JSON.stringify({ [UPLOAD_PREFIX_DEFAULT_KEY]: 'from_the_other_one_' }));
		expect(getUserSettings()[UPLOAD_PREFIX_DEFAULT_KEY]).toBe('from_the_other_one_');
	});

	it('our OWN pending change always wins over the file - it is the newer of the two', () => {
		// The write is debounced, so between setting a preference and it reaching disk the
		// cache is newer by definition. Re-reading there would revert what the user just
		// did, which is worse than the staleness the re-read exists to fix.
		writeFileSync(file, JSON.stringify({ k: 'on-disk' }));
		__resetUserSettingsCache();
		setUserSettings({ k: 'just-set' });
		writeFileSync(file, JSON.stringify({ k: 'changed-underneath' }));
		expect(getUserSettings().k).toBe('just-set');
	});

	it('a re-read that fails KEEPS the cache, rather than emptying it', () => {
		// A first load has nothing to keep, so a corrupt file is an empty store (above).
		// A RE-read is different: the likeliest way parsing fails on a file we already
		// read is catching another process mid-write, and wiping good settings over a
		// half-written byte range would then persist the wipe on the next change.
		setUserSettings({ k: 'good' });
		__resetUserSettingsCache();
		expect(getUserSettings().k).toBe('good');
		writeFileSync(file, '{"k": "half-writ');
		expect(getUserSettings().k).toBe('good');
	});

	it('keys are shared with the browser, never re-spelled here', () => {
		// Both writers are browser modules that cannot import this one, so the constants
		// live in `$lib/uploadDefaults` and are re-exported. A second spelling would not
		// throw - it would read as a default the user set and Cellar silently ignored.
		expect(UPLOAD_PREFIX_DEFAULT_KEY).toBe(shared.UPLOAD_PREFIX_DEFAULT_KEY);
		expect(UPLOAD_POSTFIX_DEFAULT_KEY).toBe(shared.UPLOAD_POSTFIX_DEFAULT_KEY);
	});
});
