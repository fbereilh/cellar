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
	MAX_INLINE_EVENT_BYTES,
	watchFileForChanges,
	unwatchFile,
	unwatchAll,
	noteKnownContent,
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

/** Wait until `n` changes have been delivered (or give up). */
async function waitForChanges(n: number, timeout = 4000): Promise<ExternalChange[]> {
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
		watchFileForChanges('doc.md', '# v0\n');

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
	});

	it('catches a plain in-place overwrite too', async () => {
		const abs = join(ws, 'notes.md');
		writeFileSync(abs, 'one\n');
		watchFileForChanges('notes.md', 'one\n');

		writeFileSync(abs, 'two\n');
		await waitForChanges(1);

		expect(seen).toHaveLength(1);
		expect(seen[0].content).toBe('two\n');
	});

	it('debounces a burst into ONE notification carrying the final content', async () => {
		const abs = join(ws, 'burst.md');
		writeFileSync(abs, 'start\n');
		watchFileForChanges('burst.md', 'start\n');

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
		watchFileForChanges('saved.md', 'v0\n');

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

	it('says nothing when the file is touched but its content did not change', async () => {
		const abs = join(ws, 'same.md');
		writeFileSync(abs, 'unchanged\n');
		watchFileForChanges('same.md', 'unchanged\n');

		// A rewrite with identical bytes, and an atomic one - both produce watcher
		// events (macOS calls them `rename` either way) and neither is a change.
		writeFileSync(abs, 'unchanged\n');
		await sleep(SETTLE_MS * 3);
		agentWrite(abs, 'unchanged\n');
		await sleep(SETTLE_MS * 3);

		expect(seen).toHaveLength(0);
	});

	it('reports a delete as content:null', async () => {
		const abs = join(ws, 'gone.md');
		writeFileSync(abs, 'here\n');
		watchFileForChanges('gone.md', 'here\n');

		unlinkSync(abs);
		await waitForChanges(1);

		expect(seen).toHaveLength(1);
		expect(seen[0].content).toBeNull();
		expect(seen[0].hash).toBe('');
	});

	it('ignores sibling files in the watched directory', async () => {
		const abs = join(ws, 'watched.md');
		writeFileSync(abs, 'watched\n');
		watchFileForChanges('watched.md', 'watched\n');

		// Including the `<name>.tmp.<pid>.<hex>` shape an atomic writer stages.
		writeFileSync(join(ws, 'other.md'), 'other\n');
		writeFileSync(join(ws, 'watched.md.tmp.999.deadbeef'), 'staging\n');
		await sleep(SETTLE_MS * 4);

		expect(seen).toHaveLength(0);
	});

	it('CONTROL: a per-file fs.watch loses the file to temp+rename', async () => {
		const abs = join(ws, 'control.md');
		writeFileSync(abs, 'v0\n');

		const perFile: string[] = [];
		const naive = watch(abs, () => perFile.push('event'));
		watchFileForChanges('control.md', 'v0\n');

		for (const v of ['a\n', 'b\n', 'c\n']) {
			agentWrite(abs, v);
			await waitForChanges(seen.length + 1);
		}
		naive.close();

		// The directory watch caught every edit…
		expect(seen.map((c) => c.content)).toEqual(['a\n', 'b\n', 'c\n']);
		// …and the per-file watch did not. HOW MANY it catches before going silent
		// is not even stable across filesystems (zero under $TMPDIR, one under
		// /private/tmp), so the assertion is only what holds either way: it misses
		// changes. Anyone tempted to "simplify" the directory watch away has to
		// make this pass first.
		expect(perFile.length).toBeLessThan(3);
	});

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
		expect(watchStats()).toEqual({ dirs: 2, files: 3 });

		unwatchFile('a.md');
		expect(watchStats().dirs).toBe(2); // b.md still holds the root open
		unwatchFile('b.md');
		expect(watchStats().dirs).toBe(1);
		unwatchFile('sub/c.md');
		expect(watchStats()).toEqual({ dirs: 0, files: 0 });
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
		watchFileForChanges('closed.md', 'v0\n');
		unwatchFile('closed.md');

		agentWrite(abs, 'v1\n');
		await sleep(SETTLE_MS * 4);
		expect(seen).toHaveLength(0);
	});

	it('refuses to watch a path outside the workspace', () => {
		watchFileForChanges('../escape.md', 'x');
		expect(watchStats()).toEqual({ dirs: 0, files: 0 });
	});
});

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
