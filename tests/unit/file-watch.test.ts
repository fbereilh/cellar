import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	watch
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SETTLE_MS,
	MAX_WATCHED_FILES,
	MAX_WATCHED_FILE_BYTES,
	MAX_INLINE_EVENT_BYTES,
	watchFileForChanges,
	unwatchFile,
	unwatchUnder,
	unwatchAll,
	noteKnownContent,
	resyncKnownContent,
	onExternalChange,
	fileChangedEvent,
	watchStats,
	type ExternalChange
} from '../../src/lib/server/fileWatch';

/**
 * The external-file watcher, against a REAL filesystem and the REAL write
 * patterns - no `fs` mocking anywhere, because the whole question this module
 * answers is what the platform actually does. A mocked `fs.watch` would have
 * happily "passed" the design that is measurably broken (see the CONTROL test).
 *
 * Three of these tests pin a decision that cost a measurement to reach:
 *
 *  - the agent write pattern (temp file + `rename()` over the target) is what
 *    Claude Code's own `Edit`/`Write` do, and it kills a per-FILE watcher for
 *    good after the first edit;
 *  - a burst of writes coalesces unevenly, so the settle debounce is what makes
 *    the delivered content a whole document;
 *  - macOS reports every directory event as `rename`, so only a content hash can
 *    tell a real change from a touch - and that same hash is what stops Cellar's
 *    own save bouncing back into the tab that made it.
 */

let ws = '';
let seen: ExternalChange[] = [];
let off: () => void = () => {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long `fs.watch` needs before it is observing (see `arm`). */
const WATCH_ARM_MS = 40;

/** How long ONE wait may spend before it gives up. */
const WAIT_MS = 4000;

/**
 * The per-test allowance a test that does SEVERAL waits in a row must be given.
 *
 * Vitest's default is 5s, which is LESS than the budget one three-write loop below
 * may legitimately spend (`arm` + 3 x `WAIT_MS`), so a slow-but-CORRECT watcher -
 * three real temp+rename writes, each behind the 120ms settle debounce, on a
 * machine running the whole suite in parallel - reported a vitest timeout instead
 * of the waiter's own assertion. That is arithmetic in the harness, not a defect in
 * the watcher, and it is what made these tests flaky under load; the waits
 * themselves are unchanged, so a genuinely lost change still fails fast on the
 * assertion rather than by running out the clock.
 */
const MULTI_WAIT_TIMEOUT_MS = 20_000;

/** Wait until `n` changes have been delivered (or give up). */
async function waitForChanges(n: number, timeout = WAIT_MS): Promise<ExternalChange[]> {
	const started = Date.now();
	while (seen.length < n && Date.now() - started < timeout) await sleep(15);
	return seen;
}

/**
 * Write a file the way an LLM edit tool does: a sibling temp, then `rename()`
 * over the target. The inode changes - which is precisely what a per-file watch
 * cannot survive.
 */
function agentWrite(abs: string, text: string): void {
	const temp = `${abs}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	writeFileSync(temp, text, 'utf8');
	renameSync(temp, abs);
}

/**
 * Arm the watch and let the platform actually install it. Measured on macOS: a
 * write issued in the same tick as `fs.watch(dir)` returning is LOST outright a
 * few percent of the time (60-trial probe: 2 lost when written immediately, 0
 * when the watch was armed first), and a lost event never arrives - so under a
 * loaded full-suite run this surfaced as whichever test wrote first timing out.
 * Real use arms the watch when the file is OPENED, long before any external
 * write, so waiting here reproduces that rather than papering over anything.
 */
async function arm(rel: string, content?: string): Promise<void> {
	watchFileForChanges(rel, content);
	await sleep(WATCH_ARM_MS);
}

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), 'cellar-filewatch-'));
	process.env.CELLAR_WORKSPACE = ws;
	seen = [];
	off = onExternalChange((c) => seen.push(c));
});

afterEach(() => {
	off();
	unwatchAll();
	delete process.env.CELLAR_WORKSPACE;
	try {
		rmSync(ws, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('external file watcher', () => {
	it('survives repeated temp+rename writes (the agent write pattern)', async () => {
		const abs = join(ws, 'doc.md');
		writeFileSync(abs, '# v0\n');
		await arm('doc.md', '# v0\n');

		// Three edits in a row. This is the regression a per-file watcher passes
		// once and then fails forever: the second and third never arrive.
		for (const v of ['# v1\n', '# v2\n', '# v3\n']) {
			agentWrite(abs, v);
			await waitForChanges(seen.length + 1);
		}

		expect(seen.map((c) => c.content)).toEqual(['# v1\n', '# v2\n', '# v3\n']);
		expect(seen.every((c) => c.path === 'doc.md')).toBe(true);
		// Every change carries a hash of its own content.
		expect(new Set(seen.map((c) => c.hash)).size).toBe(3);
	}, MULTI_WAIT_TIMEOUT_MS);

	it('catches a plain in-place overwrite too', async () => {
		const abs = join(ws, 'notes.md');
		writeFileSync(abs, 'one\n');
		await arm('notes.md', 'one\n');

		writeFileSync(abs, 'two\n');
		await waitForChanges(1);

		expect(seen).toHaveLength(1);
		expect(seen[0].content).toBe('two\n');
	});

	it('debounces a burst into ONE notification carrying the final content', async () => {
		const abs = join(ws, 'burst.md');
		writeFileSync(abs, 'start\n');
		await arm('burst.md', 'start\n');

		for (let i = 1; i <= 6; i++) {
			writeFileSync(abs, `burst-${i}\n`);
			await sleep(5);
		}
		await sleep(SETTLE_MS * 5);

		expect(seen).toHaveLength(1);
		expect(seen[0].content).toBe('burst-6\n');
	});

	it("suppresses Cellar's own write as an echo, and still delivers the next real edit", async () => {
		const abs = join(ws, 'saved.md');
		writeFileSync(abs, 'v0\n');
		await arm('saved.md', 'v0\n');

		// What `PUT /api/fs/file` does: declare the content, then write it.
		noteKnownContent('saved.md', 'from-cellar\n');
		writeFileSync(abs, 'from-cellar\n');
		await sleep(SETTLE_MS * 5);
		expect(seen).toHaveLength(0);

		// The suppression is per-content, not a mute: a genuine edit right after
		// this one is still delivered.
		agentWrite(abs, 'from-agent\n');
		await waitForChanges(1);
		expect(seen.map((c) => c.content)).toEqual(['from-agent\n']);
	});

	it('re-seeds the known hash when the write that declared it never landed', async () => {
		// `PUT /api/fs/file` declares the content BEFORE writing (the event can arrive
		// as soon as the bytes do), so a write that then FAILS - refused for size,
		// EACCES, ENOSPC - leaves the hash describing bytes disk never got. Left
		// there, echo suppression would silently drop a later genuine external change
		// producing exactly those bytes: the everyday agent shape, where the agent
		// writes the very edit the user was racing to save. And nothing else corrects
		// it, since an existing entry now wins over a re-read's content.
		const abs = join(ws, 'failed.md');
		writeFileSync(abs, 'on-disk\n');
		await arm('failed.md', 'on-disk\n');

		noteKnownContent('failed.md', 'never-written\n'); // the PUT's declaration...
		resyncKnownContent('failed.md'); // ...and its write throwing

		// An agent now writes exactly what that failed save would have.
		agentWrite(abs, 'never-written\n');
		await waitForChanges(1);
		expect(seen.map((c) => c.content)).toEqual(['never-written\n']);
	});

	it('re-seeding an unwatched path adds no entry', () => {
		// Same rule as `noteKnownContent`: an entry no directory watcher backs is a
		// leak the LRU cannot prune.
		writeFileSync(join(ws, 'stray.md'), 'x\n');
		resyncKnownContent('stray.md');
		expect(watchStats().tracked).toBe(0);
	});

	it('says nothing when the file is touched but its content did not change', async () => {
		const abs = join(ws, 'same.md');
		writeFileSync(abs, 'unchanged\n');
		await arm('same.md', 'unchanged\n');

		// A rewrite with identical bytes, and an atomic one - both produce watcher
		// events (macOS calls them `rename` either way) and neither is a change.
		writeFileSync(abs, 'unchanged\n');
		await sleep(SETTLE_MS * 3);
		agentWrite(abs, 'unchanged\n');
		await sleep(SETTLE_MS * 3);

		expect(seen).toHaveLength(0);
	});

	it('a re-read inside a pending settle window does NOT swallow the change', async () => {
		// The multi-window property, and the reason an EXISTING known-hash entry wins
		// over the content a caller hands in. Registration is on READ, and every
		// window's focus revalidation issues that same read - so a read landing
		// mid-settle used to re-seed the hash to the very content settle was about to
		// deliver, `settle` found no change, and NOTHING was published. The reading
		// tab was fine (it had the content in its own response); every other browser
		// window on the workspace silently missed the edit until its own focus, which
		// is exactly the live sync `watchFileForChanges`'s no-unwatch-on-close rule
		// exists to keep working.
		const abs = join(ws, 'shared.md');
		writeFileSync(abs, 'v0\n');
		await arm('shared.md', 'v0\n');

		agentWrite(abs, 'from-agent\n');
		// One window's GET, inside the quiet period - it reads the NEW content and
		// hands it back to the watcher, exactly as `GET /api/fs/file` does.
		await sleep(SETTLE_MS / 3);
		watchFileForChanges('shared.md', 'from-agent\n');

		await waitForChanges(1);
		expect(seen.map((c) => c.content)).toEqual(['from-agent\n']);
	});

	it('a re-read of an UNCHANGED file still reports nothing', async () => {
		// The other half: giving the existing entry precedence must not turn an
		// ordinary revalidating read into a phantom change.
		const abs = join(ws, 'quiet.md');
		writeFileSync(abs, 'v0\n');
		await arm('quiet.md', 'v0\n');

		watchFileForChanges('quiet.md', 'v0\n');
		writeFileSync(abs, 'v0\n'); // a touch, so a settle really runs
		await sleep(SETTLE_MS * 4);

		expect(seen).toHaveLength(0);
	});

	it('a FIRST registration still seeds from the caller, so the open is not a change', async () => {
		// The seed's original purpose, unaffected by the precedence rule: with no
		// existing entry the caller's content is what stops the file's CURRENT state
		// reading as an edit the first time anything touches the directory.
		const abs = join(ws, 'fresh.md');
		writeFileSync(abs, 'already-here\n');
		await arm('fresh.md', 'already-here\n');

		writeFileSync(join(ws, 'sibling.md'), 'x\n'); // stirs the directory watcher
		writeFileSync(abs, 'already-here\n');
		await sleep(SETTLE_MS * 4);

		expect(seen).toHaveLength(0);
	});

	it('unwatchUnder drops a deleted path and everything nested below it', async () => {
		// What the explorer's delete/rename/move ops call, beside their existing
		// `dropDocs`/`shutdownKernelsUnder`: the name is gone, so its entry can only
		// settle into a deletion nobody is listening for, and it would hold an LRU
		// slot a genuinely open file could use.
		mkdirSync(join(ws, 'dir', 'nested'), { recursive: true });
		writeFileSync(join(ws, 'dir', 'a.md'), 'a');
		writeFileSync(join(ws, 'dir', 'nested', 'b.md'), 'b');
		writeFileSync(join(ws, 'keep.md'), 'keep');
		watchFileForChanges('dir/a.md', 'a');
		watchFileForChanges('dir/nested/b.md', 'b');
		await arm('keep.md', 'keep');
		expect(watchStats().tracked).toBe(3);

		unwatchUnder('dir');

		// The folder took every file under it; the sibling outside is untouched.
		expect(watchStats().tracked).toBe(1);
		agentWrite(join(ws, 'keep.md'), 'keep2');
		await waitForChanges(1);
		expect(seen.map((c) => c.path)).toEqual(['keep.md']);
	});

	it('a NO-OP rename/move through the explorer route leaves the watch intact', async () => {
		// The explorer unwatches the OLD path because it is gone - but both ops have
		// a no-op form that moves nothing: `renameEntry` returns no `from` for a
		// rename to the same name, and `moveEntry` returns `from === path` for a
		// same-parent move. The file is still open there, and the tab cannot repair
		// the loss (it never remaps, so it never remounts and never re-issues the
		// read that is the sole registration point) - so live sync would be switched
		// off silently, with no user-visible signal. Driven through the REAL route,
		// because the guard is the route's.
		const { POST } = await import('../../src/routes/api/fs/op/+server.js');
		const call = (body: unknown) =>
			POST({
				request: new Request('http://x/api/fs/op', { method: 'POST', body: JSON.stringify(body) })
			} as never);

		mkdirSync(join(ws, 'sub'), { recursive: true });
		writeFileSync(join(ws, 'sub', 'open.md'), 'v0\n');
		await arm('sub/open.md', 'v0\n');
		expect(watchStats().tracked).toBe(1);

		await call({ op: 'rename', path: 'sub/open.md', name: 'open.md' }); // same name
		await call({ op: 'move', path: 'sub/open.md', dest: 'sub' }); // same parent
		expect(watchStats().tracked).toBe(1);

		agentWrite(join(ws, 'sub', 'open.md'), 'v1\n');
		await waitForChanges(1);
		expect(seen.map((c) => c.content)).toEqual(['v1\n']);

		// A rename that really moves the file still drops the dead entry.
		seen = [];
		await call({ op: 'rename', path: 'sub/open.md', name: 'renamed.md' });
		expect(watchStats().tracked).toBe(0);
	});

	it('reports a delete as content:null', async () => {
		const abs = join(ws, 'gone.md');
		writeFileSync(abs, 'here\n');
		await arm('gone.md', 'here\n');

		unlinkSync(abs);
		await waitForChanges(1);

		expect(seen).toHaveLength(1);
		expect(seen[0].content).toBeNull();
		expect(seen[0].hash).toBe('');
	});

	it('ignores sibling files in the watched directory', async () => {
		const abs = join(ws, 'watched.md');
		writeFileSync(abs, 'watched\n');
		await arm('watched.md', 'watched\n');

		// Including the `<name>.tmp.<pid>.<hex>` shape an atomic writer stages.
		writeFileSync(join(ws, 'other.md'), 'other\n');
		writeFileSync(join(ws, 'watched.md.tmp.999.deadbeef'), 'staging\n');
		await sleep(SETTLE_MS * 4);

		expect(seen).toHaveLength(0);
	});

	it('CONTROL: the directory watch delivers every one of three temp+rename writes', async () => {
		const abs = join(ws, 'control.md');
		writeFileSync(abs, 'v0\n');
		await arm('control.md', 'v0\n');

		for (const v of ['a\n', 'b\n', 'c\n']) {
			agentWrite(abs, v);
			await waitForChanges(seen.length + 1);
		}

		// The portable, load-bearing half: three rename-replaces in a row ALL
		// arrive, which is what a per-file watch cannot be relied on to do. The
		// comparison against a per-file watch lives in the darwin-only suite at the
		// bottom of this file, because whether it fails is PLATFORM behaviour - so
		// asserting it here would either be a false claim on Linux or a tautology
		// weak enough to pass against a broken implementation.
		expect(seen.map((c) => c.content)).toEqual(['a\n', 'b\n', 'c\n']);
	}, MULTI_WAIT_TIMEOUT_MS);

	it('watches one fs.watch per DIRECTORY, and drops it when the last file closes', async () => {
		mkdirSync(join(ws, 'sub'));
		writeFileSync(join(ws, 'a.md'), 'a');
		writeFileSync(join(ws, 'b.md'), 'b');
		writeFileSync(join(ws, 'sub', 'c.md'), 'c');

		watchFileForChanges('a.md', 'a');
		watchFileForChanges('b.md', 'b');
		watchFileForChanges('sub/c.md', 'c');
		// Three files, two directories - the handle count is bounded by where the
		// open files live, not by how many there are.
		expect(watchStats()).toEqual({ dirs: 2, files: 3, tracked: 3 });

		unwatchFile('a.md');
		expect(watchStats().dirs).toBe(2); // b.md still holds the root open
		unwatchFile('b.md');
		expect(watchStats().dirs).toBe(1);
		unwatchFile('sub/c.md');
		expect(watchStats()).toEqual({ dirs: 0, files: 0, tracked: 0 });
	});

	it('bounds the watched set with an LRU, keeping the most recently opened', async () => {
		// Registration happens on READ and nothing tells the server a tab closed,
		// so this cap is what makes that safe.
		const total = MAX_WATCHED_FILES + 5;
		for (let i = 0; i < total; i++) {
			const rel = `f${i}.md`;
			writeFileSync(join(ws, rel), `${i}\n`);
			watchFileForChanges(rel, `${i}\n`);
		}
		expect(watchStats().files).toBe(MAX_WATCHED_FILES);
		await sleep(WATCH_ARM_MS);

		// The newest survived and still reports changes…
		const newest = `f${total - 1}.md`;
		agentWrite(join(ws, newest), 'edited\n');
		await waitForChanges(1);
		expect(seen.map((c) => c.path)).toEqual([newest]);

		// …while the coldest was evicted (its edit is not reported).
		agentWrite(join(ws, 'f0.md'), 'edited\n');
		await sleep(SETTLE_MS * 4);
		expect(seen.map((c) => c.path)).toEqual([newest]);
	});

	it('stops reporting a file once it is unwatched', async () => {
		const abs = join(ws, 'closed.md');
		writeFileSync(abs, 'v0\n');
		await arm('closed.md', 'v0\n');
		unwatchFile('closed.md');

		agentWrite(abs, 'v1\n');
		await sleep(SETTLE_MS * 4);
		expect(seen).toHaveLength(0);
	});

	it('refuses to watch a path outside the workspace', () => {
		watchFileForChanges('../escape.md', 'x');
		expect(watchStats()).toEqual({ dirs: 0, files: 0, tracked: 0 });
	});

	it('refuses to watch a file past the size ceiling', async () => {
		// Every settled event costs a synchronous read + sha256 of the WHOLE file on
		// the process that also carries the kernel sockets and the SSE fan-out, so
		// the ceiling is a hard bound rather than a hint. Nothing is recorded for a
		// refused file - no watcher, and no LRU entry the LRU could never prune.
		const abs = join(ws, 'huge.md');
		const huge = 'x'.repeat(MAX_WATCHED_FILE_BYTES + 1);
		writeFileSync(abs, huge);

		await arm('huge.md', huge);
		expect(watchStats()).toEqual({ dirs: 0, files: 0, tracked: 0 });

		agentWrite(abs, `${huge}y`);
		await sleep(SETTLE_MS * 4);
		expect(seen).toHaveLength(0);
	});

	it('stops watching a file that GROWS past the ceiling while open', async () => {
		const abs = join(ws, 'grows.md');
		writeFileSync(abs, 'small\n');
		await arm('grows.md', 'small\n');

		// Under the ceiling it syncs like anything else…
		agentWrite(abs, 'still small\n');
		await waitForChanges(1);
		expect(seen.map((c) => c.content)).toEqual(['still small\n']);

		// …and once it is over, it is dropped outright rather than being stat'd,
		// read and hashed on every event for the rest of the session.
		agentWrite(abs, 'y'.repeat(MAX_WATCHED_FILE_BYTES + 1));
		await sleep(SETTLE_MS * 6);
		expect(seen).toHaveLength(1);
		expect(watchStats()).toEqual({ dirs: 0, files: 0, tracked: 0 });
	});

	it('records nothing when the directory cannot be watched at all', () => {
		// `fs.watch` throwing is not hypothetical - some network mounts and container
		// overlays never support it, and there the registration retries on every
		// read. A known-hash entry survives that only as dead state no watcher backs
		// and no LRU eviction reaches, so the map would grow for the life of the
		// process. A missing directory reproduces the throw exactly.
		for (let i = 0; i < 8; i++) watchFileForChanges(`nodir/f${i}.md`, `${i}`);
		expect(watchStats()).toEqual({ dirs: 0, files: 0, tracked: 0 });
	});
});

/**
 * The defect this whole module exists to route around, pinned where it actually
 * reproduces. Keep it - without it nothing stops someone "simplifying" the
 * directory watch into a per-file one, which is the change that looks obviously
 * equivalent and silently breaks live sync after a single agent edit.
 *
 * It is DARWIN-ONLY, and that is a platform fact rather than a Cellar one. On
 * macOS `fs.watch(<file>)` is bound to the inode, so a rename-replace orphans it
 * and it goes quiet - measured by the scout, and the reason for the directory
 * watch. On the Linux CI runner the same watcher reported ALL THREE
 * rename-replaces (measured: this assertion failed there with 3, not <3), the
 * usual explanation being that libuv's inotify backend watches the containing
 * directory and filters by name, i.e. Linux already does what this module does
 * by hand. So the assertion is scoped rather than deleted or weakened into
 * something that would pass everywhere by saying nothing.
 *
 * The skip reason is IN THE SUITE NAME on purpose (the convention this repo uses
 * for the pandas-dependent probes): a green Linux run must never read as though
 * the defect was checked and found absent.
 */
describe.skipIf(process.platform !== 'darwin')(
	'per-file fs.watch, on darwin only (Linux libuv watches the parent dir, so the defect does not reproduce there)',
	() => {
		it('loses the file to temp+rename while the directory watch keeps every write', async () => {
			const abs = join(ws, 'control-darwin.md');
			writeFileSync(abs, 'v0\n');

			const perFile: string[] = [];
			const naive = watch(abs, () => perFile.push('event'));
			await arm('control-darwin.md', 'v0\n');

			for (const v of ['a\n', 'b\n', 'c\n']) {
				agentWrite(abs, v);
				await waitForChanges(seen.length + 1);
			}
			naive.close();

			expect(seen.map((c) => c.content)).toEqual(['a\n', 'b\n', 'c\n']);
			// HOW MANY it catches before going silent is not stable even across macOS
			// filesystems (zero under $TMPDIR, one under /private/tmp), so the
			// assertion is only what holds either way: it misses changes the
			// directory watch delivered.
			expect(perFile.length).toBeLessThan(3);
		}, MULTI_WAIT_TIMEOUT_MS);
	}
);

describe('fileChangedEvent (the bus projection)', () => {
	it('inlines a small file and omits a large one, without either reading as a deletion', () => {
		const small = fileChangedEvent({ path: 'a.md', content: '# hi\n', hash: 'h1' });
		expect(small).toEqual({
			type: 'file:changed',
			path: 'a.md',
			hash: 'h1',
			deleted: false,
			content: '# hi\n'
		});

		// Over the ceiling the SSE stream carries the announcement only - it also
		// carries kernel output deltas at ~40ms and pays per byte.
		const big = fileChangedEvent({
			path: 'big.md',
			content: 'x'.repeat(MAX_INLINE_EVENT_BYTES + 1),
			hash: 'h2'
		});
		expect(big.content).toBeUndefined();
		// …and that omission must not be mistaken for the file being gone.
		expect(big.deleted).toBe(false);
	});

	it('marks a deletion explicitly', () => {
		expect(fileChangedEvent({ path: 'gone.md', content: null, hash: '' })).toEqual({
			type: 'file:changed',
			path: 'gone.md',
			hash: '',
			deleted: true
		});
	});

	it('measures the inline gate in BYTES, not characters', () => {
		// A multi-byte document just inside the character count but past the byte
		// ceiling must not be inlined.
		const content = '€'.repeat(MAX_INLINE_EVENT_BYTES / 2);
		expect(content.length).toBeLessThan(MAX_INLINE_EVENT_BYTES);
		expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(MAX_INLINE_EVENT_BYTES);
		expect(fileChangedEvent({ path: 'utf.md', content, hash: 'h' }).content).toBeUndefined();
	});
});
