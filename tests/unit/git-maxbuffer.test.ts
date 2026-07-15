/**
 * Perf Tier 3, item 2: a `git` subprocess whose stdout overflows `maxBuffer` is
 * SURFACED, not silently collapsed into the same `null` as "not a repo".
 *
 * Node's `execFile` rejects a maxBuffer overflow with a distinct error (and does
 * NOT return the bytes read so far). The old `err ? null` treated that identically
 * to an ordinary failure, so a legitimately huge tracked blob vanished with no
 * decoration and no trace. `runGit` now classifies the overflow via
 * `isMaxBufferError` and logs before degrading. This pins the classifier — the
 * discriminator the surfacing depends on.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { isMaxBufferError } from '../../src/lib/server/git';

describe('isMaxBufferError', () => {
	it('recognizes the Node maxBuffer overflow code', () => {
		expect(isMaxBufferError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe(true);
	});

	it('recognizes the overflow by message when the code is absent (older/edge builds)', () => {
		expect(isMaxBufferError({ message: 'stdout maxBuffer length exceeded' })).toBe(true);
	});

	it('does NOT flag an ordinary git failure (bad ref / not a repo)', () => {
		expect(isMaxBufferError({ code: 128, message: "fatal: path 'x' does not exist in 'HEAD'" })).toBe(false);
		expect(isMaxBufferError({ code: 'ENOENT', message: 'spawn git ENOENT' })).toBe(false);
	});

	it('is safe on null / non-error input', () => {
		expect(isMaxBufferError(null)).toBe(false);
		expect(isMaxBufferError(undefined)).toBe(false);
		expect(isMaxBufferError('nope')).toBe(false);
	});

	it('classifies a REAL execFile overflow (Node actually raises what the classifier expects)', async () => {
		// Drive Node's own overflow with a tiny buffer, proving the error shape the
		// classifier keys on is the shape Node produces — not a shape we invented.
		const err = await new Promise<unknown>((resolve) => {
			execFile('node', ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBuffer: 16 }, (e) => resolve(e));
		});
		expect(err).toBeTruthy();
		expect(isMaxBufferError(err)).toBe(true);
	});
});
