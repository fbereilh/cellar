/**
 * Imports-cell edits must stale only what the import DELTA actually touched.
 *
 * THE BUG. The definer graph is per-name, but the staleness rule was per-CELL:
 * an edge (i ← j) transmitted staleness whenever `editedAt(j) > lastRun(i).at`,
 * `j` re-ran after `i`, or `j` was itself stale - regardless of WHICH names the
 * edge carried. An imports cell defines `pd`, `np`, `os`, … i.e. a name almost
 * every downstream cell uses, so ANY touch of it (adding one unused import, or
 * agent import-routing re-adding a line that was already there, or simply
 * re-running it) stales the whole notebook below. Correct by the old rules, and
 * useless: in a typical agent session routing rewrites the imports cell
 * constantly, so "stale" stopped carrying information.
 *
 * THE RULE THIS PINS. A name bound by a module-level import is a pure function of
 * its import statement: re-executing `import pandas as pd` rebinds the same
 * module object, so such an edge transmits change only when THAT name's import
 * spec actually changed (added / removed / rebound) since the downstream cell ran.
 * Everything else is untouched and stays conservative.
 *
 * These tests run the REAL probe and the REAL `setSource` stamping - the two
 * halves that have to agree - rather than hand-written dataflow fixtures.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStaleness, STALE_STATE, type StalenessMap } from '../../src/lib/staleness';
import type { LastRun } from '../../src/lib/server/types';

vi.mock('../../src/lib/server/events', () => ({
	publish: (e: Record<string, unknown>) => ({ ...e, seq: 1 }),
	publishGlobal: (e: Record<string, unknown>) => e
}));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
// The probe spawns `projectPython() || 'python3'`; null ⇒ the real python3 (ast +
// symtable are stdlib, so this needs no venv).
vi.mock('../../src/lib/server/databricks', () => ({ projectPython: () => null }));

let WS: string;
let nb: typeof import('../../src/lib/server/notebook');
let analyzeDataflow: typeof import('../../src/lib/server/dataflow').analyzeDataflow;

const SID = 7;
/** Wall-clock the whole notebook "last ran" at; every edit below lands after it. */
const RAN_AT = 1_000_000;
const ranStamp = (at = RAN_AT): LastRun => ({ at, durationMs: 1, actor: 'user', status: 'ok', session: SID });

let NB: string;
let abs: string;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-imports-stale-'));
	process.env.CELLAR_WORKSPACE = WS;
	nb = await import('../../src/lib/server/notebook');
	({ analyzeDataflow } = await import('../../src/lib/server/dataflow'));
});

let seq = 0;
beforeEach(() => {
	NB = `stale-${seq++}.ipynb`;
	nb.createNotebook(NB, null, { focus: false });
	abs = nb.resolveNotebookPath(NB);
	vi.useFakeTimers();
	vi.setSystemTime(RAN_AT + 1000); // every edit is "after" the last run
});
afterEach(() => vi.useRealTimers());

/** Add a code cell after `after` and mark it as having run this session. */
function ran(after: string | null, source: string, at = RAN_AT): string {
	const c = nb.addCell(after, 'code', abs, null, source);
	const cell = nb.listCells(abs).find((x) => x.id === c.id)!;
	cell.metadata.cellar = { ...(cell.metadata.cellar ?? {}), lastRun: ranStamp(at) };
	return c.id;
}

async function staleness(): Promise<StalenessMap> {
	const cells = nb.listCells(abs);
	return computeStaleness(cells, await analyzeDataflow(cells), SID);
}

const state = (m: StalenessMap, id: string) => m[id]?.state;

/**
 * The canonical shape: an imports cell providing two independent names, one
 * consumer of each, and a cell that joins them.
 */
function notebook() {
	const imports = ran(null, 'import pandas as pd\nimport numpy as np');
	const usesPd = ran(imports, 'x = pd.DataFrame()');
	const usesNp = ran(usesPd, 'y = np.zeros(3)');
	const joins = ran(usesNp, 'z = str(x) + str(y)');
	return { imports, usesPd, usesNp, joins };
}

describe('an imports-cell edit stales only the affected dependents', () => {
	it('adding an unused import stales nothing downstream', async () => {
		const { imports, usesPd, usesNp, joins } = notebook();
		nb.setSource(imports, 'import pandas as pd\nimport numpy as np\nimport re', abs);

		const m = await staleness();
		// The imports cell itself is genuinely stale - it was edited after it ran.
		expect(state(m, imports)).toBe(STALE_STATE.STALE);
		expect(m[imports].self).toBe(true);
		// Nothing downstream reads `re`, so nothing downstream is affected.
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH);
		expect(state(m, usesNp)).toBe(STALE_STATE.FRESH);
		expect(state(m, joins)).toBe(STALE_STATE.FRESH);
	});

	it('a no-op rewrite (routing re-adding what was already there) stales nothing downstream', async () => {
		const { imports, usesPd, usesNp, joins } = notebook();
		// Same bindings, reordered + re-rendered - exactly what import routing does.
		nb.setSource(imports, 'import numpy as np\nimport pandas as pd', abs);

		const m = await staleness();
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH);
		expect(state(m, usesNp)).toBe(STALE_STATE.FRESH);
		expect(state(m, joins)).toBe(STALE_STATE.FRESH);
	});

	it('re-running the imports cell with no source change stales nothing downstream', async () => {
		const { imports, usesPd, usesNp, joins } = notebook();
		// A plain re-run: `lastRun.at` moves past every downstream cell's.
		const cell = nb.listCells(abs).find((c) => c.id === imports)!;
		cell.metadata.cellar!.lastRun = ranStamp(RAN_AT + 5000);

		const m = await staleness();
		expect(state(m, imports)).toBe(STALE_STATE.FRESH);
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH);
		expect(state(m, usesNp)).toBe(STALE_STATE.FRESH);
		expect(state(m, joins)).toBe(STALE_STATE.FRESH);
	});

	it('REBINDING a name stales exactly its consumers and their dependents', async () => {
		const { imports, usesPd, usesNp, joins } = notebook();
		// `np` now resolves to something else entirely; `pd` is untouched.
		nb.setSource(imports, 'import pandas as pd\nimport numpy.random as np', abs);

		const m = await staleness();
		expect(state(m, usesNp)).toBe(STALE_STATE.STALE);
		expect(state(m, joins)).toBe(STALE_STATE.STALE); // reads y, defined by the stale cell
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH); // reads only pd, unchanged
	});

	it('REMOVING an import stales its consumers (never a false fresh)', async () => {
		const { imports, usesPd, usesNp, joins } = notebook();
		nb.setSource(imports, 'import pandas as pd', abs);

		const m = await staleness();
		expect(state(m, usesNp)).toBe(STALE_STATE.STALE);
		expect(state(m, joins)).toBe(STALE_STATE.STALE);
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH);
	});

	it('a MIXED cell (imports + other code) keeps the conservative behavior throughout', async () => {
		// A cell holding `import pandas as pd` AND ordinary statements is not
		// imports-only, so nothing proves those statements do not rebind `pd`
		// (`os = shim`, `for os in …`, `del os`). Enumerating every Python binding form
		// with a regex is how a MISSED shadow becomes a false `fresh`, so the whole cell
		// is treated as providing no stable import binding - today's behavior, kept for
		// exactly this case rather than for the notebook.
		const head = ran(null, 'import pandas as pd\nSEED = 42');
		const usesPd = ran(head, 'x = pd.DataFrame()');
		const usesSeed = ran(usesPd, 'y = SEED + 1');
		nb.setSource(head, 'import pandas as pd\nSEED = 43', abs);

		const m = await staleness();
		expect(state(m, usesSeed)).toBe(STALE_STATE.STALE);
		expect(state(m, usesPd)).toBe(STALE_STATE.STALE);
	});

	it('a star-import is unanalyzable, so it stays conservative', async () => {
		const head = ran(null, 'import pandas as pd\nfrom os.path import *');
		const consumer = ran(head, 'x = join(pd.__name__, "a")');
		nb.setSource(head, 'import pandas as pd\nfrom os.path import *\nimport re', abs);

		const m = await staleness();
		expect(state(m, consumer)).toBe(STALE_STATE.STALE);
	});
});

describe('the reported scenario: agent import routing', () => {
	it('routing a new import into the imports cell stales only the cells that read it', async () => {
		// The real write path an MCP tool takes (`routeImports` → `setSource`), not a
		// synthesized edit. This is the flow the bug report is about: routing touches
		// the imports cell on nearly every agent write.
		const { routeImports } = await import('../../src/lib/server/imports-cell');
		const { imports, usesPd, usesNp, joins } = notebook();
		nb.setCellRole(imports, 'imports', abs);

		// The agent writes a cell that needs `re`; its import is lifted into the
		// imports cell, whose `pd` / `np` bindings are untouched.
		const routed = routeImports('import re\nm = re.compile("a")', abs);
		expect(routed.added).toEqual(['import re']);
		expect(routed.importsCellId).toBe(imports);
		nb.addCell(joins, 'code', abs, null, routed.source);

		const m = await staleness();
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH);
		expect(state(m, usesNp)).toBe(STALE_STATE.FRESH);
		expect(state(m, joins)).toBe(STALE_STATE.FRESH);
	});

	it('routing an import that was ALREADY there does not touch the document at all', async () => {
		const { routeImports } = await import('../../src/lib/server/imports-cell');
		const { imports, usesPd, usesNp, joins } = notebook();
		nb.setCellRole(imports, 'imports', abs);

		const routed = routeImports('import pandas as pd\nq = pd.DataFrame()', abs);
		expect(routed.added).toEqual([]); // already present ⇒ nothing merged, nothing run
		nb.addCell(joins, 'code', abs, null, routed.source);

		const m = await staleness();
		expect(state(m, imports)).toBe(STALE_STATE.FRESH); // not even edited
		expect(state(m, usesPd)).toBe(STALE_STATE.FRESH);
		expect(state(m, usesNp)).toBe(STALE_STATE.FRESH);
		expect(state(m, joins)).toBe(STALE_STATE.FRESH);
	});
});

describe('ordinary staleness propagation is unchanged', () => {
	it('editing a data cell stales its dependents transitively', async () => {
		const a = ran(null, 'df = 1');
		const b = ran(a, 'e = df + 1');
		const c = ran(b, 'f = e + 1');
		nb.setSource(a, 'df = 2', abs);

		const m = await staleness();
		expect(state(m, a)).toBe(STALE_STATE.STALE);
		expect(state(m, b)).toBe(STALE_STATE.STALE);
		expect(state(m, c)).toBe(STALE_STATE.STALE);
	});

	it('an unrun upstream still stales its dependents', async () => {
		const imports = ran(null, 'import pandas as pd');
		const consumer = ran(imports, 'x = pd.DataFrame()');
		// The imports cell never ran this session.
		const cell = nb.listCells(abs).find((c) => c.id === imports)!;
		delete cell.metadata.cellar!.lastRun;

		const m = await staleness();
		expect(state(m, imports)).toBe(STALE_STATE.NOT_RUN);
		expect(state(m, consumer)).toBe(STALE_STATE.STALE);
	});

	it('an unanalyzable cell (probe unavailable) is still conservative-stale', async () => {
		const imports = ran(null, 'import pandas as pd');
		const consumer = ran(imports, 'x = pd.DataFrame()');
		const cells = nb.listCells(abs);
		const m = computeStaleness(cells, await analyzeDataflow(cells), SID, new Set([consumer]));
		expect(state(m, consumer)).toBe(STALE_STATE.STALE);
		expect(state(m, imports)).toBe(STALE_STATE.FRESH);
	});
});
