/**
 * Dataflow probe: payload transport is STDIN, not argv.
 *
 * The staleness probe used to embed the whole notebook JSON as a command-line
 * argument (`python -c PROBE <json>`). A large notebook's JSON exceeds the OS
 * `ARG_MAX` ceiling, so the spawn failed and staleness silently died for exactly
 * the biggest notebooks. Moving the payload to the child's stdin removes the
 * ceiling. These tests prove:
 *   - a payload far larger than any ARG_MAX is analyzed correctly (the core fix),
 *   - a small notebook produces the same result as before (parity),
 *   - a probe/interpreter failure still degrades to an empty map (never throws).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import type { CellView } from '../../src/lib/server/types';

// Control the interpreter the probe spawns. `null` ⇒ dataflow falls back to the
// real `python3`; a bogus path ⇒ spawn errors, exercising the degrade path.
let mockPythonOverride: string | null = null;
vi.mock('../../src/lib/server/databricks', () => ({
	projectPython: () => mockPythonOverride
}));

// Imported AFTER the mock is registered (vitest hoists vi.mock above imports).
import { analyzeDataflow } from '../../src/lib/server/dataflow';

const cell = (id: string, source: string): CellView =>
	({ id, cell_type: 'code', source, metadata: {}, outputs: [] }) as unknown as CellView;

/** The OS `ARG_MAX` (bytes). Used only to assert the big payload really exceeds it. */
function argMax(): number {
	try {
		return parseInt(execSync('getconf ARG_MAX').toString().trim(), 10) || 1 << 18;
	} catch {
		return 1 << 18; // 256KB fallback — every mainstream OS is at least this
	}
}

describe('analyzeDataflow — payload over stdin', () => {
	beforeEach(() => {
		mockPythonOverride = null; // real python3 by default
	});

	it('analyzes a payload far larger than ARG_MAX (the argv regression it fixes)', async () => {
		// Build a genuinely big notebook whose serialized JSON dwarfs ARG_MAX. ARG_MAX
		// is a limit on the total *bytes* of a command line, so heavy per-cell source
		// (not a huge cell count) is what blows it — and we keep the distinct-cell
		// count under the dataflow cache bound so this test isolates the transport,
		// not the cache. As an argv argument this spawn would have failed with E2BIG
		// and staleness would silently vanish.
		const pad = 'x'.repeat(14000); // heavy per-cell comment padding
		const N = 300;
		const cells: CellView[] = [];
		for (let i = 0; i < N; i++) {
			cells.push(cell(`c${i}`, `# ${pad} ${i}\nvar_${i} = ${i}\n`));
		}
		// A downstream cell that reads two upstream defines → a real dependency edge.
		cells.push(cell('sink', 'total = var_0 + var_299\n'));

		const payloadBytes = JSON.stringify({
			cells: cells.map((c) => ({ key: c.source, source: c.source }))
		}).length;
		expect(payloadBytes).toBeGreaterThan(argMax()); // proves argv would have blown up

		const df = await analyzeDataflow(cells);

		// Every upstream cell's define is captured...
		expect(df.c0.defines).toContain('var_0');
		expect(df.c299.defines).toContain('var_299');
		// ...and the downstream cell's uses link back to them (staleness can connect them).
		expect(df.sink.uses).toEqual(expect.arrayContaining(['var_0', 'var_299']));
		expect(df.sink.defines).toContain('total');
	});

	it('a small notebook yields the expected defines/uses (parity)', async () => {
		const df = await analyzeDataflow([
			cell('a', 'import pandas as pd\ntable = pd.DataFrame()'),
			cell('b', 'summary = table.describe()')
		]);
		expect(df.a.defines).toEqual(expect.arrayContaining(['pd', 'table']));
		expect(df.b.uses).toContain('table'); // b depends on a
		expect(df.b.defines).toContain('summary');
	});

	it('degrades gracefully when the interpreter cannot be spawned (never throws)', async () => {
		mockPythonOverride = '/nonexistent/cellar-no-such-python';
		// A large payload too, to prove the stdin write can't crash the app on EPIPE
		// when the child never comes up (the write races the failed spawn).
		const cells = Array.from({ length: 200 }, (_, i) =>
			cell(`c${i}`, `# ${'y'.repeat(500)} ${i}\nname_${i} = ${i}`)
		);
		// No throw, and every cell degrades to empty defines/uses (the probe produced
		// nothing), so downstream staleness sees no dependencies rather than crashing.
		const df = await analyzeDataflow(cells);
		expect(Object.keys(df)).toHaveLength(cells.length);
		for (const c of cells) expect(df[c.id]).toEqual({ defines: [], uses: [] });
	});
});
