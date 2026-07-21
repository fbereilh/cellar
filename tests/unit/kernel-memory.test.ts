/**
 * Per-kernel resident-memory sampling + display.
 *
 * Cellar has no OS pid for a kernel, only the Jupyter `kernel.id`, which appears in
 * the kernel process's `-f …/kernel-<id>.json` connection-file argument. `parsePsOutput`
 * maps each id back to that process's RSS by scanning `ps -eo pid=,rss=,command=`
 * output; `formatMemory` renders the byte figure for the navbar/sidebar. Both are
 * pure, so they are unit-testable with no kernel and no `ps` call.
 */
import { describe, it, expect } from 'vitest';
import { parsePsOutput } from '../../src/lib/server/kernelMemory';
import { formatMemory } from '../../src/lib/kernelBadge';

// A realistic slice of `ps -eo pid=,rss=,command=` output: leading pid, RSS in KiB,
// then the full command. The kernel launcher carries the connection file whose name
// embeds the kernel id.
const KID = 'a1b2c3d4-0000-1111-2222-333344445555';
const OTHER = 'ffffffff-9999-8888-7777-666655554444';
const PS = [
	'  501 123456 /usr/bin/some-daemon --flag',
	`  777  40960 /proj/.venv/bin/python -m ipykernel_launcher -f /run/jupyter/kernel-${KID}.json`,
	`  888 102400 /proj/.venv/bin/python -m ipykernel_launcher -f /run/jupyter/kernel-${OTHER}.json`,
	'  999   2048 -zsh'
].join('\n');

describe('parsePsOutput', () => {
	it('maps a kernel id to its process RSS in bytes (KiB × 1024)', () => {
		const m = parsePsOutput(PS, [KID]);
		expect(m.get(KID)).toBe(40960 * 1024);
	});

	it('resolves several kernels from one scan, ignoring unrelated processes', () => {
		const m = parsePsOutput(PS, [KID, OTHER]);
		expect(m.get(KID)).toBe(40960 * 1024);
		expect(m.get(OTHER)).toBe(102400 * 1024);
		expect(m.size).toBe(2);
	});

	it('omits an id with no matching process rather than inventing a zero', () => {
		const m = parsePsOutput(PS, ['no-such-kernel-id']);
		expect(m.has('no-such-kernel-id')).toBe(false);
		expect(m.size).toBe(0);
	});

	it('is empty for empty output', () => {
		expect(parsePsOutput('', [KID]).size).toBe(0);
	});

	it('takes the first match — a kernel id is unique to one process', () => {
		const dup = `  100 1024 python kernel-${KID}.json\n  200 4096 python kernel-${KID}.json`;
		expect(parsePsOutput(dup, [KID]).get(KID)).toBe(1024 * 1024);
	});
});

describe('formatMemory', () => {
	it('renders MB below a gigabyte', () => {
		expect(formatMemory(312 * 1000 * 1000)).toBe('312 MB');
		expect(formatMemory(40960 * 1024)).toBe('42 MB'); // 41.9 MB → 42
	});

	it('renders GB at scale, one decimal', () => {
		expect(formatMemory(1_400_000_000)).toBe('1.4 GB');
		expect(formatMemory(2_000_000_000)).toBe('2.0 GB');
	});

	it('renders small readings as KB, never a bare "0 B"', () => {
		expect(formatMemory(4096)).toBe('4 KB');
		expect(formatMemory(1)).toBe('1 KB');
	});

	it('returns null for a missing or invalid reading (so callers hide it)', () => {
		expect(formatMemory(null)).toBeNull();
		expect(formatMemory(undefined)).toBeNull();
		expect(formatMemory(NaN)).toBeNull();
		expect(formatMemory(-5)).toBeNull();
	});
});
