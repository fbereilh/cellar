/**
 * nbdev's valued `#| export <module>`: a cell that goes into ANOTHER notebook's
 * module instead of its own notebook's.
 *
 * The model under test: a module is composed from every notebook that feeds it.
 * The notebook whose own export target the module is writes first, then every
 * `#| export <module>` cell naming that file follows, notebook by notebook in
 * workspace-relative path order. Their public names join `__all__`. Exporting ANY
 * of those notebooks rebuilds the whole file, so a repeated export never appends.
 * A cell whose module cannot be resolved, or that no notebook owns, goes into no
 * module and says why.
 *
 * Driven through the REAL document layer (`exportPy`, `getNotebook`), so the
 * workspace scan that finds the other notebooks is part of what is tested. Each
 * test works in its own folder and names its modules after it, so the scan never
 * sees another test's notebooks as owners.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let role: typeof import('../../src/lib/exportRole');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-export-othermod-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	role = await import('../../src/lib/exportRole');
});

type CellSpec = { id: string; source: string; cellar?: Record<string, unknown> };

/** A notebook written by hand, the way nbdev or a git pull would leave it. */
function writeNb(rel: string, cells: CellSpec[], nbCellar?: Record<string, unknown>) {
	const abs = join(WS, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(
		abs,
		JSON.stringify({
			cells: cells.map((c) => ({
				id: c.id,
				cell_type: 'code',
				source: c.source.split(/(?<=\n)/),
				metadata: c.cellar ? { cellar: c.cellar } : {},
				outputs: [],
				execution_count: null
			})),
			metadata: nbCellar ? { cellar: nbCellar } : {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return rel;
}

const read = (rel: string) => readFileSync(join(WS, rel), 'utf8');

let seq = 0;
/** This test's own folder, which is also the package its modules live in. */
let T: string;
beforeEach(() => {
	T = `t${seq++}`;
});

describe('reading the directive', () => {
	const cell = (source: string, extra: Record<string, unknown> = {}) => ({ cell_type: 'code', source, ...extra });

	it('names the module from the first token of a valued #| export', () => {
		expect(role.exportOtherModuleName(cell('#| export other\ndef a(): pass'))).toBe('other');
		expect(role.exportOtherModuleName(cell('#|export pkg.utils\nX = 1'))).toBe('pkg.utils');
		expect(role.exportOtherModuleName(cell('#| export: other\nX = 1'))).toBe('other');
		expect(role.exportOtherModuleName(cell('#| export other # a note\nX = 1'))).toBe('other');
	});

	it('names none for a bare mark, a directive nbdev ignores, or a non-code cell', () => {
		expect(role.exportOtherModuleName(cell('#| export\nX = 1'))).toBeNull();
		expect(role.exportOtherModuleName(cell('#| export: true\nX = 1'))).toBeNull();
		expect(role.exportOtherModuleName(cell('x = 1\n#| export other'))).toBeNull();
		expect(role.exportOtherModuleName(cell('# note\n#| export other'))).toBeNull();
		expect(role.exportOtherModuleName({ cell_type: 'markdown', source: '#| export other' })).toBeNull();
		expect(role.exportOtherModuleName(cell('#| exporti other\nX = 1'))).toBeNull();
	});

	it('follows nbdev last-wins between a bare and a valued line in one block', () => {
		expect(role.exportOtherModuleName(cell('#| export\n#| export other\nX = 1'))).toBe('other');
		expect(role.exportOtherModuleName(cell('#| export other\n#| export\nX = 1'))).toBeNull();
	});

	it('keeps the cell out of its own notebook module, even with Cellar flag set', () => {
		const valued = cell('#| export other\nX = 1', { metadata: { cellar: { export: true } } });
		expect(role.isExportCell(valued)).toBe(false);
		expect(role.exportDirectiveOwnsCell(valued)).toBe(true);
		expect(role.exportDirectiveOwnsCell(cell('#| export other\nX = 1'))).toBe(true);
	});
});

describe('two notebooks into one module', () => {
	it('writes the owner cells first, then the fed cells, with every name in __all__', () => {
		const core = writeNb(`${T}/core.ipynb`, [
			{ id: 'c1', source: '#| default_exp ' + T + '.core' },
			{ id: 'c2', source: '#| export\ndef base(): return 1' }
		]);
		writeNb(`${T}/extra.ipynb`, [
			{ id: 'e1', source: `#| export ${T}.core\ndef extra(): return base() + 1` },
			{ id: 'e2', source: 'def scratch(): pass' }
		]);
		const res = nbmod.exportPy(core);
		expect(res).toMatchObject({
			written: true,
			target: `${T}/core.py`,
			count: 1,
			contributors: [`${T}/extra.ipynb`],
			contributed: 1
		});
		expect(read(`${T}/core.py`)).toBe(
			[
				'# AUTOGENERATED BY CELLAR! DO NOT EDIT!',
				'# Source notebook: core.ipynb',
				`# Also from notebook: ${T}/extra.ipynb`,
				'',
				"__all__ = ['base', 'extra']",
				'',
				`#| export\ndef base(): return 1`,
				'',
				`#| export ${T}.core\ndef extra(): return base() + 1`,
				''
			].join('\n')
		);
	});

	it('rebuilds the same bytes from either notebook, and never appends twice', () => {
		const core = writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		nbmod.exportPy(core);
		const first = read(`${T}/core.py`);
		// The contributor's export rebuilds the owner's module from all contributors.
		const fromExtra = nbmod.exportPy(extra);
		expect(fromExtra.reason).toBe('no-target');
		expect(fromExtra.modules).toEqual([
			{ target: `${T}/core.py`, owner: `${T}/core.ipynb`, written: false, count: 1, reason: 'unchanged', hazards: [] }
		]);
		expect(nbmod.exportPy(core)).toMatchObject({ written: false, reason: 'unchanged' });
		expect(nbmod.exportPy(extra).modules?.[0]).toMatchObject({ written: false, reason: 'unchanged' });
		expect(read(`${T}/core.py`)).toBe(first);
		expect(first.match(/B = 2/g)).toHaveLength(1);
	});

	it('drops a fed cell from the module once its directive is gone', () => {
		const core = writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		nbmod.exportPy(core);
		expect(read(`${T}/core.py`)).toContain('B = 2');
		nbmod.setSource('e', 'B = 2', extra);
		expect(nbmod.exportPy(core)).toMatchObject({ written: true, count: 1 });
		const text = read(`${T}/core.py`);
		expect(text).not.toContain('B = 2');
		expect(text).not.toContain('Also from notebook');
	});

	it('orders fed notebooks by workspace-relative path, whichever notebook exports', () => {
		const owner = writeNb(`${T}/m/owner.ipynb`, [{ id: 'o', source: `#| default_exp ${T}.mod\n#| export\nO = 0` }]);
		const b = writeNb(`${T}/b.ipynb`, [{ id: 'b', source: `#| export ${T}.mod\nB = 2` }]);
		writeNb(`${T}/a.ipynb`, [{ id: 'a', source: `#| export ${T}.mod\nA = 1` }]);
		nbmod.exportPy(b);
		const text = read(`${T}/mod.py`);
		expect(text).toContain(`# Also from notebook: ${T}/a.ipynb\n# Also from notebook: ${T}/b.ipynb\n`);
		expect(text).toContain("__all__ = ['O', 'A', 'B']");
		expect(text.indexOf('O = 0')).toBeLessThan(text.indexOf('A = 1'));
		expect(text.indexOf('A = 1')).toBeLessThan(text.indexOf('B = 2'));
		expect(nbmod.exportPy(owner)).toMatchObject({ written: false, reason: 'unchanged' });
	});

	it('keeps a fed cell out of its own notebook module', () => {
		writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const extra = writeNb(`${T}/extra.ipynb`, [
			{ id: 'x1', source: `#| default_exp ${T}.extra\n#| export\nOWN = 1` },
			{ id: 'x2', source: `#| export ${T}.core\ndef fed(): pass`, cellar: { export: true } }
		]);
		const res = nbmod.exportPy(extra);
		expect(res).toMatchObject({ written: true, target: `${T}/extra.py`, count: 1 });
		expect(read(`${T}/extra.py`)).not.toContain('def fed');
		expect(res.modules).toMatchObject([{ target: `${T}/core.py`, written: true, count: 1 }]);
		expect(read(`${T}/core.py`)).toContain('def fed');
	});

	it('takes an explicit export target as the owner too', () => {
		writeNb(`${T}/lib.ipynb`, [{ id: 'l', source: 'L = 1', cellar: { export: true } }], {
			export_target: `${T}/lib.py`
		});
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.lib\nE = 2` }]);
		expect(nbmod.exportPy(extra).modules).toMatchObject([{ target: `${T}/lib.py`, owner: `${T}/lib.ipynb`, written: true }]);
		expect(read(`${T}/lib.py`)).toContain("__all__ = ['L', 'E']");
	});

	it('leaves a module Cellar did not write untouched', () => {
		writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		writeFileSync(join(WS, T, 'core.py'), '# hand written\n');
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		expect(nbmod.exportPy(extra).modules).toMatchObject([{ written: false, reason: 'foreign-module', hazards: [] }]);
		expect(read(`${T}/core.py`)).toBe('# hand written\n');
	});
});

describe('a module is the same bytes whichever notebook exports', () => {
	// Oracle for this block: nbdev's `nbglob` skips `_`-prefixed notebooks, and the
	// design rule that a module's bytes never depend on which notebook exported.

	it('a notebook the workspace walk skips feeds no module, and says why', () => {
		const core = writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const draft = writeNb(`${T}/_draft.ipynb`, [{ id: 'draftcell1', source: `#| export ${T}.core\nD = 4` }]);
		nbmod.exportPy(core);
		const fromOwner = read(`${T}/core.py`);
		expect(fromOwner).not.toContain('D = 4');

		const res = nbmod.exportPy(draft);
		expect(res.modules).toBeUndefined();
		expect(res.refused).toHaveLength(1);
		expect(res.refused?.[0]).toMatchObject({ cell: 'draftcel', module: `${T}.core` });
		expect(res.refused?.[0].reason).toContain('"_draft.ipynb" starts with "_"');
		expect(read(`${T}/core.py`)).toBe(fromOwner);
		expect(nbmod.getNotebook(draft).exportOtherModules).toEqual([
			{ id: 'draftcell1', module: `${T}.core`, target: null, owner: null, error: res.refused?.[0].reason }
		]);
	});

	it('names the skipped folder when the notebook sits inside one', () => {
		writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const nb = writeNb(`${T}/_wip/extra.ipynb`, [{ id: 'w', source: `#| export ${T}.core\nW = 1` }]);
		expect(nbmod.exportPy(nb).refused?.[0].reason).toContain('"_wip" starts with "_"');
		expect(existsSync(join(WS, T, 'core.py'))).toBe(false);
	});

	it('a skipped owner writes only its own cells, matching the badge its contributors show', () => {
		const owner = writeNb(`${T}/_core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		const res = nbmod.exportPy(owner);
		expect(res).toMatchObject({ written: true, target: `${T}/core.py`, count: 1 });
		expect(res.contributors).toBeUndefined();
		const fromOwner = read(`${T}/core.py`);
		expect(fromOwner).not.toContain('B = 2');
		expect(fromOwner).not.toContain('Also from notebook');

		const fed = nbmod.exportPy(extra);
		expect(fed.modules).toBeUndefined();
		expect(fed.refused?.[0].reason).toContain(`no notebook in this workspace has ${T}/core.py`);
		expect(read(`${T}/core.py`)).toBe(fromOwner);
	});

	it('drops a fed cell when the contributor removes its line and exports itself', () => {
		const core = writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		nbmod.exportPy(extra);
		expect(read(`${T}/core.py`)).toContain(`# Also from notebook: ${T}/extra.ipynb`);

		nbmod.setSource('e', 'B = 2', extra);
		const res = nbmod.exportPy(extra);
		expect(res.modules).toEqual([
			{ target: `${T}/core.py`, owner: `${T}/core.ipynb`, written: true, count: 0, hazards: [] }
		]);
		const text = read(`${T}/core.py`);
		expect(text).not.toContain('B = 2');
		expect(text).not.toContain('Also from notebook');
		// The owner's export then has nothing left to change.
		expect(nbmod.exportPy(core)).toMatchObject({ written: false, reason: 'unchanged' });
		expect(nbmod.exportPy(extra).modules).toBeUndefined();
	});

	it('moves a fed cell when the contributor retargets its line and exports itself', () => {
		writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		writeNb(`${T}/io.ipynb`, [{ id: 'i', source: `#| default_exp ${T}.io\n#| export\nI = 1` }]);
		const extra = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		nbmod.exportPy(extra);
		nbmod.setSource('e', `#| export ${T}.io\nB = 2`, extra);
		expect(nbmod.exportPy(extra).modules).toMatchObject([
			{ target: `${T}/core.py`, written: true, count: 0 },
			{ target: `${T}/io.py`, written: true, count: 1 }
		]);
		expect(read(`${T}/core.py`)).not.toContain('B = 2');
		expect(read(`${T}/core.py`)).not.toContain('Also from notebook');
		expect(read(`${T}/io.py`)).toContain('B = 2');
	});

	it('claims no fed cells for an own module it declined to overwrite', () => {
		const core = writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core\n#| export\nA = 1` }]);
		writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		writeFileSync(join(WS, T, 'core.py'), '# hand written\n');
		const res = nbmod.exportPy(core);
		expect(res).toMatchObject({ written: false, reason: 'foreign-module' });
		expect(res.contributors).toBeUndefined();
		expect(res.contributed).toBeUndefined();
		expect(role.otherModulesReport(res)).toBe('');
	});
});

describe('marking a cell its own line sends elsewhere', () => {
	// Oracle: nbdev sends a valued `#| export <module>` cell to that module INSTEAD
	// of the notebook's own, so a mark for the own module can never be satisfied.

	it('refuses the mark in the document layer and names the module', () => {
		const nb = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		expect(nbmod.setCellExport('e', true, nb)).toEqual({ ok: false, reason: 'export-other-module', module: `${T}.core` });
		expect(nbmod.getNotebook(nb).cells[0].metadata?.cellar?.export).toBeUndefined();
	});

	it('refuses the mark through the MCP service, for the whole batch', async () => {
		const svc = await import('../../src/lib/server/mcp/service');
		const nb = writeNb(
			`${T}/extra.ipynb`,
			[
				{ id: 'plain', source: 'P = 1' },
				{ id: 'valued', source: `#| export ${T}.core\nB = 2` }
			],
			{ export_target: `${T}/extra.py` }
		);
		expect(svc.setCellExport(['plain', 'valued'], true, join(WS, nb))).toEqual({
			ok: false,
			otherModule: 'valued',
			module: `${T}.core`
		});
		expect(nbmod.getNotebook(nb).cells[0].metadata?.cellar?.export).toBeUndefined();
	});
});

describe('a fed cell that cannot go anywhere is refused, with the reason', () => {
	it('refuses a module no notebook owns, and writes nothing for it', () => {
		const nb = writeNb(`${T}/lonely.ipynb`, [{ id: 'abcdef1234', source: `#| export ${T}.nowhere\nX = 1` }]);
		const res = nbmod.exportPy(nb);
		expect(res.modules).toBeUndefined();
		expect(res.refused).toEqual([
			{ cell: 'abcdef12', module: `${T}.nowhere`, reason: expect.stringContaining(`no notebook in this workspace has ${T}/nowhere.py`) }
		]);
		expect(existsSync(join(WS, T, 'nowhere.py'))).toBe(false);
		expect(nbmod.getNotebook(nb).exportOtherModules).toEqual([
			{ id: 'abcdef1234', module: `${T}.nowhere`, target: null, owner: null, error: res.refused?.[0].reason }
		]);
	});

	it('refuses a module two notebooks own', () => {
		writeNb(`${T}/one.ipynb`, [{ id: 'o1', source: `#| default_exp ${T}.dup\n#| export\nA = 1` }]);
		writeNb(`${T}/two.ipynb`, [{ id: 'o2', source: `#| default_exp ${T}.dup\n#| export\nB = 1` }]);
		const nb = writeNb(`${T}/fed.ipynb`, [{ id: 'f', source: `#| export ${T}.dup\nC = 1` }]);
		const [refusal] = nbmod.exportPy(nb).refused ?? [];
		expect(refusal.reason).toContain(`more than one notebook (${T}/one.ipynb, ${T}/two.ipynb)`);
	});

	it('refuses a module that resolves outside the workspace', () => {
		const nb = writeNb(`${T}/esc.ipynb`, [{ id: 'f', source: '#| export ...up\nC = 1' }]);
		expect(nbmod.exportPy(nb).refused?.[0].reason).toMatch(/escapes workspace/);
	});

	it('refuses the valued form in a Mojo notebook', () => {
		const nb = writeNb(`${T}/m.ipynb`, [{ id: 'm', source: `#| export ${T}.core\nfn f(): pass` }], { language: 'mojo' });
		const view = nbmod.getNotebook(nb).exportOtherModules;
		expect(view).toHaveLength(1);
		expect(view[0].error).toContain('only in a Python notebook - this one is Mojo');
	});

	it('reports where an accepted cell goes, for an owner that only names its module', () => {
		writeNb(`${T}/core.ipynb`, [{ id: 'c', source: `#| default_exp ${T}.core` }]);
		const nb = writeNb(`${T}/extra.ipynb`, [{ id: 'e', source: `#| export ${T}.core\nB = 2` }]);
		expect(nbmod.getNotebook(nb).exportOtherModules).toEqual([
			{ id: 'e', module: `${T}.core`, target: `${T}/core.py`, owner: `${T}/core.ipynb`, error: null }
		]);
	});

	it('costs an ordinary notebook nothing: no such cell, no entry', () => {
		const nb = writeNb(`${T}/plain.ipynb`, [{ id: 'p', source: '#| export\nP = 1' }]);
		expect(nbmod.getNotebook(nb).exportOtherModules).toEqual([]);
	});
});

describe('the export report', () => {
	it('says what each other module got, and how many cells went nowhere', () => {
		const report = role.otherModulesReport({
			modules: [
				{ target: 'pkg/core.py', owner: 'nbs/core.ipynb', written: true, count: 2, hazards: [] },
				{ target: 'pkg/io.py', owner: 'nbs/io.ipynb', written: false, count: 1, reason: 'unchanged', hazards: [] }
			],
			refused: [{}]
		}, () => 'the module will not import');
		expect(report).toBe(
			'Wrote 2 cells into pkg/core.py, the module of nbs/core.ipynb. pkg/io.py, the module of nbs/io.ipynb, already holds this cell. 1 cell went into no module - hover the "not exported" badge on it for why.'
		);
		expect(role.otherModulesReport({})).toBe('');
		// A module the notebook used to feed: rebuilt, and holding none of its cells.
		expect(
			role.otherModulesReport({ modules: [{ target: 'm.py', owner: 'o.ipynb', written: true, count: 0, hazards: [] }] })
		).toBe("Rebuilt m.py, the module of o.ipynb, without this notebook's cells.");
		// A fed module WITH a hazard says so; one without never borrows the clause.
		expect(
			role.otherModulesReport(
				{ modules: [{ target: 'm.py', owner: 'o.ipynb', written: true, count: 1, hazards: [{}] }] },
				() => 'the module will not import'
			)
		).toBe('Wrote 1 cell into m.py, the module of o.ipynb, but the module will not import.');
	});
});
