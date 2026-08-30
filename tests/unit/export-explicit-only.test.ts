/**
 * The nbdev-style `.py` module is written by an EXPLICIT export action and by
 * nothing else.
 *
 * Cellar used to regenerate the module from `persist`, i.e. on every notebook
 * save - every debounced keystroke autosave, every run, every cell added or
 * moved. Writing a git-tracked file that often is the wrong default, and the
 * concrete harm was an ESTABLISHED nbdev repository: there the configured target
 * names a module nbdev generated, so every save reached for a file Cellar did not
 * write, `exportNotebookToPy`'s clobber guard correctly refused it, and the
 * refusal was recorded on `doc.lastExportError` - which only the agent surface
 * reads. A failure the user could never see, once per save, forever.
 *
 * So this file pins BOTH halves of the rule, because either alone is a defect:
 *
 *   - a save does NOT write the module (and does not touch `lastExportError`), so
 *     the nbdev repository above is never reached for at all; and
 *   - each of the THREE explicit actions still does - `exportPy` (the button and
 *     the `op:'export'` route), `setExportTarget` (naming the module's file) and
 *     `setCellExports` (choosing what is in it) - because an export that silently
 *     stopped happening would be the same defect with the sign flipped.
 *
 * The nbdev-repo case is pinned end to end here rather than only in the abstract:
 * the refusal must reach the CALLER of the explicit export (`exportPy` throws, so
 * the route answers 400 and the click that asked for it gets the message) instead
 * of being recorded where nobody looks.
 *
 * `export-py.test.ts` owns the generator, `export-py-future.test.ts` the compile
 * hazards, `export-hazard-report.test.ts` their reporting, and
 * `mcp-set-cell-export.test.ts` / `mcp-export-target.test.ts` the agent surface.
 * This file owns WHEN the write happens.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');
let svc: typeof import('../../src/lib/server/mcp/service');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-export-explicit-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
	svc = await import('../../src/lib/server/mcp/service');
});

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);
const modulePath = (rel: string) => join(WS, rel);
const readModule = (rel: string) => (existsSync(modulePath(rel)) ? readFileSync(modulePath(rel), 'utf8') : null);

/**
 * A notebook holding `source` in one code cell, with `target` named as its export
 * target and (unless told otherwise) that cell marked. Returns the pieces every
 * test below needs, including the module's workspace-relative path.
 */
async function exportingNotebook(
	name: string,
	source: string,
	opts: { module?: string; mark?: boolean } = {}
) {
	const nb = abs(name);
	const mod = opts.module ?? `lib/${name.replace('.ipynb', '')}.py`;
	svc.useNotebook(`sess-${name}`, name);
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, {
		nb,
		routeImports: false
	});
	const cell = svc.resolveRef(nb, ids[0]);
	nbmod.setExportTarget(mod, nb);
	if (opts.mark !== false) nbmod.setCellExports([cell], true, nb);
	return { nb, cell, mod };
}

describe('an ordinary SAVE never writes the module', () => {
	it('leaves it byte-for-byte and mtime-for-mtime as the last explicit export left it', async () => {
		const { nb, cell, mod } = await exportingNotebook('save.ipynb', 'X = 1');
		// The mark above was explicit, so the module IS on disk holding that cell.
		expect(readModule(mod)).toContain('X = 1');
		const before = readModule(mod);
		const mtimeBefore = statSync(modulePath(mod)).mtimeMs;

		// Every one of these persists the notebook. None of them is an export action.
		nbmod.setSource(cell, 'X = 999', nb);
		nbmod.addCell(cell, 'code', nb);
		nbmod.setHideAllCode(true, nb);
		nbmod.setHideAllCode(false, nb);

		expect(readModule(mod)).toBe(before);
		expect(readModule(mod)).toContain('X = 1'); // and emphatically NOT `X = 999`
		expect(statSync(modulePath(mod)).mtimeMs).toBe(mtimeBefore);
	});

	it('writes NO module at all when none has ever been exported explicitly', async () => {
		const nb = abs('never.ipynb');
		const mod = 'lib/never.py';
		svc.useNotebook('sess-never', 'never.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'Y = 1' }], null, {
			nb,
			routeImports: false
		});
		const cell = svc.resolveRef(nb, ids[0]);
		// Marking IS explicit, so mark first and then delete the module: from here on
		// only saves happen, and nothing may bring the file back.
		nbmod.setExportTarget(mod, nb);
		nbmod.setCellExports([cell], true, nb);
		writeFileSync(modulePath(mod), '');
		nbmod.setSource(cell, 'Y = 2', nb);
		nbmod.setSource(cell, 'Y = 3', nb);
		expect(readModule(mod)).toBe(''); // untouched by either save
	});
});

describe('each of the three EXPLICIT actions still writes it', () => {
	it('setCellExports - choosing what is IN the module', async () => {
		const { nb, cell, mod } = await exportingNotebook('mark.ipynb', 'A = 1', { mark: false });
		expect(readModule(mod)).toBe(null);
		nbmod.setCellExports([cell], true, nb);
		expect(readModule(mod)).toContain('A = 1');
	});

	it('setExportTarget - naming the module’s file, and re-naming the SAME file re-exports', async () => {
		const { nb, cell, mod } = await exportingNotebook('target.ipynb', 'B = 1');
		expect(readModule(mod)).toContain('B = 1');

		// A save moves the cell but not the module...
		nbmod.setSource(cell, 'B = 2', nb);
		expect(readModule(mod)).toContain('B = 1');

		// ...and re-setting the target to the value it already holds is the
		// always-regenerating explicit action INSTRUCTIONS clause 5 names as the
		// agent's route back to a current module. Unlike `set_cell_export`, it has no
		// change detection, so an unchanged value still rewrites.
		nbmod.setExportTarget(mod, nb);
		expect(readModule(mod)).toContain('B = 2');
	});

	it('exportPy - the manual button', async () => {
		const { nb, cell, mod } = await exportingNotebook('manual.ipynb', 'C = 1');
		nbmod.setSource(cell, 'C = 2', nb);
		expect(readModule(mod)).toContain('C = 1');

		const res = nbmod.exportPy(nb);
		expect(res.written).toBe(true);
		expect(res.count).toBe(1);
		expect(readModule(mod)).toContain('C = 2');
	});

	it('and an explicit export with nothing marked stays the documented no-op', async () => {
		const { nb, mod } = await exportingNotebook('nomark.ipynb', 'D = 1', { mark: false });
		const res = nbmod.exportPy(nb);
		expect(res.written).toBe(false);
		expect(res.reason).toBe('no-cells');
		expect(readModule(mod)).toBe(null);
	});
});

describe('an established nbdev repository - the case that made export explicit', () => {
	/**
	 * The target names a module some other tool generated, so Cellar's clobber
	 * guard declines it. That refusal is right; what was wrong was WHEN it happened
	 * and WHERE it went.
	 *
	 * It is a first-class not-written OUTCOME (`reason:'foreign-module'`), not a
	 * throw: with nbdev's `#| export` directive read as a mark, every notebook in
	 * such a repo HAS marks, so as an error it would record `lastExportError`
	 * forever on the two best-effort callers and answer the button with a failure -
	 * for a file no export of Cellar's could ever legitimately write.
	 */
	async function nbdevRepo(name: string) {
		const setup = await exportingNotebook(name, 'E = 1', { mark: false });
		mkdirSync(dirname(modulePath(setup.mod)), { recursive: true });
		writeFileSync(modulePath(setup.mod), '# AUTOGENERATED BY NBDEV\n\ndef existing():\n    pass\n');
		return setup;
	}

	it('a SAVE no longer reaches for it: the file is untouched and no failure is recorded', async () => {
		const { nb, cell, mod } = await nbdevRepo('nbdev-save.ipynb');
		nbmod.setCellExports([cell], true, nb); // explicit, so this one DOES try - and is declined
		// Declined as an OUTCOME, so nothing lands in the record only the agent
		// surface reads. The tools report it from `ExportResult.reason` instead.
		expect(nbmod.lastExportError(nb)).toBe(null);

		// The point is that a SAVE does not reach for the module at all - which is
		// what used to happen on every keystroke, invisibly.
		const before = readFileSync(modulePath(mod), 'utf8');
		nbmod.setSource(cell, 'E = 2', nb);
		nbmod.setSource(cell, 'E = 3', nb);
		expect(readFileSync(modulePath(mod), 'utf8')).toBe(before);
	});

	it('an EXPLICIT export reports the refusal to the caller that asked for it', async () => {
		const { nb, cell, mod } = await nbdevRepo('nbdev-explicit.ipynb');
		nbmod.setCellExports([cell], true, nb);

		// `exportPy` returns the refusal rather than a plain success, so the click
		// that asked gets a named reason on its notice channel and the button never
		// reads as a dead control. That is the whole point of making the export
		// explicit: the refusal has an obvious home.
		const res = nbmod.exportPy(nb);
		expect(res.written).toBe(false);
		expect(res.reason).toBe('foreign-module');
		expect(res.target).toBe(mod);
		// ...and the user's own file is intact.
		expect(readFileSync(modulePath(mod), 'utf8')).toContain('def existing():');
	});
});

describe('the failure record describes the last EXPLICIT export, not the last keystroke', () => {
	it('a save neither sets nor clears it', async () => {
		const { nb, cell, mod } = await exportingNotebook('record.ipynb', 'F = 1');
		expect(nbmod.lastExportError(nb)).toBe(null);

		// Break the target: a directory where the module file should be.
		mkdirSync(modulePath('lib/broken.py'), { recursive: true });
		nbmod.setExportTarget('lib/broken.py', nb); // explicit -> records the failure
		expect(nbmod.lastExportError(nb)).toBeTruthy();

		// Saves leave the record exactly as the last explicit export left it - they
		// neither retry the write nor clear a failure they did not resolve.
		const recorded = nbmod.lastExportError(nb);
		nbmod.setSource(cell, 'F = 2', nb);
		expect(nbmod.lastExportError(nb)).toBe(recorded);

		// A later explicit export that succeeds is what clears it.
		nbmod.setExportTarget(mod, nb);
		expect(nbmod.lastExportError(nb)).toBe(null);
	});
});

describe('hazards still reach the bar on a SAVE, even though a save does not export', () => {
	/**
	 * A hazard is a fact about the MARKED CELLS (`docExportHazards` reads the
	 * document, never the module), so it is honest whether or not an export has run
	 * - and a save is exactly what creates one. Dropping this push along with the
	 * auto-export would have left the export bar's warning stale until the next
	 * `load()`, i.e. usually never, and taken away the one signal that reaches the
	 * user BEFORE they press Export.
	 */
	const JOINED = 'from __future__ import annotations; x = 1';

	async function captured(fn: () => Promise<void> | void) {
		const seen: Array<{ nb: string; hazards: unknown[] }> = [];
		const off = events.subscribe((e: Record<string, unknown>) => {
			if (e.type === 'notebook:export-hazards') seen.push(e as never);
		});
		try {
			await fn();
		} finally {
			off();
		}
		return seen;
	}

	it('publishes when a save makes the module-to-be uncompilable, and clears it when fixed', async () => {
		const { nb, cell } = await exportingNotebook('hazard-save.ipynb', 'G = 1');
		const appeared = await captured(() => {
			nbmod.setSource(cell, JOINED, nb);
		});
		expect(appeared).toHaveLength(1);
		expect(appeared[0].hazards).toHaveLength(1);

		const cleared = await captured(() => {
			nbmod.setSource(cell, 'from __future__ import annotations\nG = 1', nb);
		});
		expect(cleared).toHaveLength(1);
		expect(cleared[0].hazards).toEqual([]);
	});
});
