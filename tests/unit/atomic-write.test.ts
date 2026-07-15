import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../src/lib/server/atomic-write';
import {
	serializeWriteSync,
	withPathLock,
	pendingWriteCount
} from '../../src/lib/server/write-lock';
import { writeNotebook, readNotebook } from '../../src/lib/server/ipynb';

/**
 * Tier-1 data-safety: notebook writes are atomic (temp + fsync + rename) and
 * serialized per path, so a crash mid-write never truncates the user's primary
 * data and two rapid saves of the same notebook cannot corrupt or lose each
 * other.
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-atomic-'));
});
afterEach(() => {
	// Restore perms so a read-only-dir test can be cleaned up.
	try {
		chmodSync(dir, 0o700);
	} catch {
		/* ignore */
	}
	rmSync(dir, { recursive: true, force: true });
});

/** No stray temp files left behind in a directory. */
function tempFiles(d: string): string[] {
	return readdirSync(d).filter((f) => f.endsWith('.tmp'));
}

/** Drain the microtask queue so the async lock's post-settle cleanup runs. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('atomicWriteFileSync', () => {
	it('round-trips a normal write and leaves no temp file', () => {
		const p = join(dir, 'out.txt');
		atomicWriteFileSync(p, 'hello world');
		expect(readFileSync(p, 'utf8')).toBe('hello world');
		expect(tempFiles(dir)).toEqual([]);
	});

	it('replaces existing content atomically', () => {
		const p = join(dir, 'out.txt');
		writeFileSync(p, 'old');
		atomicWriteFileSync(p, 'new');
		expect(readFileSync(p, 'utf8')).toBe('new');
		expect(tempFiles(dir)).toEqual([]);
	});

	it('leaves the pre-existing file intact when the write fails (unwritable dir)', () => {
		const sub = join(dir, 'ro');
		mkdirSync(sub);
		const p = join(sub, 'keep.txt');
		writeFileSync(p, 'ORIGINAL');
		// Read-only directory: creating the temp file fails (EACCES/EPERM). The
		// original is never touched (the rename that would replace it never runs).
		chmodSync(sub, 0o500);
		try {
			expect(() => atomicWriteFileSync(p, 'CORRUPT')).toThrow();
		} finally {
			chmodSync(sub, 0o700);
		}
		expect(readFileSync(p, 'utf8')).toBe('ORIGINAL');
		expect(tempFiles(sub)).toEqual([]);
	});

	it('cleans up the temp file and leaves the target intact when the rename fails', () => {
		// Target is a NON-EMPTY directory: the temp is created and fsync'd, then
		// renameSync(temp, target) fails (ENOTEMPTY/EISDIR). The catch must remove
		// the temp and leave the directory untouched.
		const target = join(dir, 'targetdir');
		mkdirSync(target);
		writeFileSync(join(target, 'inside'), 'child');
		expect(() => atomicWriteFileSync(target, 'data')).toThrow();
		expect(readFileSync(join(target, 'inside'), 'utf8')).toBe('child');
		expect(tempFiles(dir)).toEqual([]);
	});
});

describe('per-path write lock', () => {
	it('does not retain map entries for completed writes (sync fast path)', () => {
		const p = join(dir, 'a.txt');
		serializeWriteSync(resolve(p), () => atomicWriteFileSync(p, 'x'));
		serializeWriteSync(resolve(p), () => atomicWriteFileSync(p, 'y'));
		expect(readFileSync(p, 'utf8')).toBe('y');
		expect(pendingWriteCount()).toBe(0);
	});

	it('serializes overlapping async writes to the same key in order', async () => {
		const key = resolve(join(dir, 'seq.txt'));
		const order: number[] = [];
		const write = (n: number, delay: number) =>
			withPathLock(key, async () => {
				await new Promise((r) => setTimeout(r, delay));
				order.push(n);
			});
		// Issue three at once; despite decreasing delays they must run in issue order.
		await Promise.all([write(1, 30), write(2, 10), write(3, 1)]);
		expect(order).toEqual([1, 2, 3]);
		await flush();
		expect(pendingWriteCount()).toBe(0);
	});

	it('lets writes to DIFFERENT keys proceed concurrently', async () => {
		const events: string[] = [];
		const a = withPathLock(resolve(join(dir, 'a')), async () => {
			await new Promise((r) => setTimeout(r, 20));
			events.push('a-done');
		});
		const b = withPathLock(resolve(join(dir, 'b')), async () => {
			events.push('b-done'); // no delay: finishes first if truly concurrent
		});
		await Promise.all([a, b]);
		expect(events[0]).toBe('b-done'); // b did not wait behind a's 20ms
		await flush();
		expect(pendingWriteCount()).toBe(0);
	});

	it('a rejected async write does not wedge the chain or leak an entry', async () => {
		const key = resolve(join(dir, 'r.txt'));
		const boom = withPathLock(key, () => Promise.reject(new Error('boom')));
		await expect(boom).rejects.toThrow('boom');
		// The next write to the same key still runs.
		let ran = false;
		await withPathLock(key, () => {
			ran = true;
		});
		expect(ran).toBe(true);
		await flush();
		expect(pendingWriteCount()).toBe(0);
	});
});

describe('writeNotebook (atomic + serialized)', () => {
	const cell = (id: string, source: string) => ({
		id,
		cell_type: 'code' as const,
		source,
		outputs: [],
		metadata: {}
	});

	it('round-trips: write then read back equals the cleaned doc', () => {
		const p = join(dir, 'nb.ipynb');
		writeNotebook(p, { path: p, cells: [cell('a', 'x = 1'), cell('b', 'y = 2')] });
		const back = readNotebook(p);
		expect(back?.nbformat).toBe(4);
		expect(back?.cells.map((c) => c.id)).toEqual(['a', 'b']);
		// Deterministic clean-on-save: execution_count nulled.
		expect(back?.cells.every((c) => c.execution_count === null)).toBe(true);
		expect(tempFiles(dir)).toEqual([]);
	});

	it('two rapid saves of the same notebook keep it valid, complete, and last-write-wins', () => {
		const p = join(dir, 'nb.ipynb');
		writeNotebook(p, { path: p, cells: [cell('a', 'first = 1')] });
		writeNotebook(p, { path: p, cells: [cell('a', 'second = 2')] });
		const back = readNotebook(p);
		expect(back).toBeTruthy();
		expect(back?.cells).toHaveLength(1);
		expect(back?.cells[0].source).toContain('second = 2');
		expect(tempFiles(dir)).toEqual([]);
		expect(pendingWriteCount()).toBe(0);
	});

	it('saves of DIFFERENT notebooks are independent and both valid', () => {
		const p1 = join(dir, 'one.ipynb');
		const p2 = join(dir, 'two.ipynb');
		writeNotebook(p1, { path: p1, cells: [cell('a', 'a = 1')] });
		writeNotebook(p2, { path: p2, cells: [cell('b', 'b = 2')] });
		expect(readNotebook(p1)?.cells[0].id).toBe('a');
		expect(readNotebook(p2)?.cells[0].id).toBe('b');
		expect(tempFiles(dir)).toEqual([]);
	});

	it('a failed notebook write leaves the previous notebook intact and parseable', () => {
		const sub = join(dir, 'ro');
		mkdirSync(sub);
		const p = join(sub, 'nb.ipynb');
		writeNotebook(p, { path: p, cells: [cell('a', 'kept = 1')] });
		const original = readFileSync(p, 'utf8');

		// Read-only directory: the atomic temp write fails, so the persist throws
		// and the previously-saved notebook is left byte-for-byte intact.
		chmodSync(sub, 0o500);
		try {
			expect(() => writeNotebook(p, { path: p, cells: [cell('a', 'lost = 2')] })).toThrow();
		} finally {
			chmodSync(sub, 0o700);
		}

		expect(readFileSync(p, 'utf8')).toBe(original);
		expect(readNotebook(p)?.cells[0].source).toContain('kept = 1');
		expect(tempFiles(sub)).toEqual([]);
	});
});
