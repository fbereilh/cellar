/**
 * Perf Tier 3, item 5: the MCP text search bounds how much of a cell's output it
 * stringifies per query.
 *
 * `searchCells` used to `(c.outputs||[]).map(outputText).join('\n')` in FULL for
 * every cell, so one query over an output-heavy notebook serialized megabytes.
 * `scanOutputText` caps the scanned text at `SEARCH_SCAN_CAP` while leaving WHICH
 * cells are searched untouched. These tests pin: ordinary output is scanned whole
 * (matches still found), and the scan is bounded (a match past the cap is the
 * accepted miss, and the returned string never exceeds the cap).
 */
import { describe, it, expect } from 'vitest';
import { scanOutputText, SEARCH_SCAN_CAP } from '../../src/lib/server/mcp/service';
import type { CellOutput } from '../../src/lib/server/types';

const stream = (text: string): CellOutput => ({ output_type: 'stream', name: 'stdout', text } as unknown as CellOutput);

describe('scanOutputText — bounded search scan', () => {
	it('scans ordinary output in full (a normal match is still found)', () => {
		const text = scanOutputText([stream('hello world\nNEEDLE is here\ndone')]);
		expect(text).toContain('NEEDLE');
	});

	it('finds a match anywhere within the cap', () => {
		// A match sitting just under the cap is still scanned.
		const filler = 'a'.repeat(SEARCH_SCAN_CAP - 20);
		const text = scanOutputText([stream(filler + 'NEEDLE')]);
		expect(text).toContain('NEEDLE');
	});

	it('caps the scanned text: a match PAST the cap is not scanned (the accepted trade)', () => {
		const filler = 'a'.repeat(SEARCH_SCAN_CAP + 5000);
		const text = scanOutputText([stream(filler + 'NEEDLE')]);
		expect(text.length).toBeLessThanOrEqual(SEARCH_SCAN_CAP);
		expect(text).not.toContain('NEEDLE'); // beyond the cap → not serialized
	});

	it('bounds the TOTAL across many outputs (the megabyte-per-cell blowup it fixes)', () => {
		// 50 outputs × 100k chars = ~5MB unbounded; the scan stops at the cap.
		const outputs = Array.from({ length: 50 }, () => stream('z'.repeat(100_000)));
		const text = scanOutputText(outputs);
		expect(text.length).toBeLessThanOrEqual(SEARCH_SCAN_CAP);
	});

	it('early outputs before the cap are fully scannable across output boundaries', () => {
		// The needle lives in the second output, still under the cap → found.
		const text = scanOutputText([stream('x'.repeat(1000)), stream('SECOND-NEEDLE')]);
		expect(text).toContain('SECOND-NEEDLE');
	});

	it('handles empty / missing outputs', () => {
		expect(scanOutputText(undefined)).toBe('');
		expect(scanOutputText([])).toBe('');
	});
});
