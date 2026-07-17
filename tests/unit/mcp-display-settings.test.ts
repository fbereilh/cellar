/**
 * The notebook-level DISPLAY settings over MCP: header numbering and report view.
 *
 * Both are display-only - they change what the human sees and never touch a cell's
 * source - and both were previously invisible to the agent, which is why agents
 * hand-numbered their headers ("## 1. Setup") on top of the numbers Cellar was
 * already rendering. These tests pin the whole contract: the setters sanitize and
 * clear, they respect per-session notebook targeting, the read surface reports the
 * state AND the computed numbers, and NOTHING leaks into any cell source.
 *
 * They drive the real service + notebook singletons against a scratch workspace,
 * stubbing only the Python staleness subprocess (get_notebook_map awaits it) so no
 * kernel or subprocess is involved.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);
const sources = (rel: string) => nbmod.listCells(abs(rel)).map((c) => c.source);

/** The map's section tree flattened to `{title, number, level}`, in document order. */
type Section = { title: string; number?: string; level: number; children: unknown[] };
function sectionsOf(map: { sections: unknown[] }): Array<{ title: string; number?: string; level: number }> {
	const out: Array<{ title: string; number?: string; level: number }> = [];
	const walk = (nodes: unknown[]) => {
		for (const n of nodes) {
			const s = n as Section;
			if (s.children) {
				out.push({ title: s.title, number: s.number, level: s.level });
				walk(s.children);
			}
		}
	};
	walk(map.sections);
	return out;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-display-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');

	// A small notebook with a real heading hierarchy to number.
	svc.useNotebook('sessA', 'report.ipynb');
	const nb = svc.targetFor('sessA');
	await svc.addCells(
		[
			{ cell_type: 'markdown', source: '# Analysis' },
			{ cell_type: 'markdown', source: '## Setup' },
			{ cell_type: 'code', source: 'x = 1' },
			{ cell_type: 'markdown', source: '## Load data' },
			{ cell_type: 'code', source: 'y = 2' },
			{ cell_type: 'markdown', source: '# Results' }
		],
		null,
		{ nb, routeImports: false }
	);
});

describe('set_header_numbering', () => {
	it('sets levels, and get_notebook_map reports them with each section number', async () => {
		const nb = svc.targetFor('sessA');
		const res = svc.setHeaderNumbering([1, 2], nb);
		expect(res.levels).toEqual([1, 2]);
		expect(res.numbered_headings).toBe(4); // every heading is H1 or H2

		const map = await svc.getNotebookMap(nb);
		expect(map.display.header_numbering).toEqual([1, 2]);
		// Hierarchical over the enabled levels, exactly as the human's Outline reads.
		expect(sectionsOf(map)).toEqual([
			{ title: 'Analysis', number: '1', level: 1 },
			{ title: 'Setup', number: '1.1', level: 2 },
			{ title: 'Load data', number: '1.2', level: 2 },
			{ title: 'Results', number: '2', level: 1 }
		]);
	});

	it('numbers only the enabled levels', async () => {
		const nb = svc.targetFor('sessA');
		expect(svc.setHeaderNumbering([2], nb).levels).toEqual([2]);
		const map = await svc.getNotebookMap(nb);
		// H1s carry no number and consume no counter; the H2s number flat.
		expect(sectionsOf(map)).toEqual([
			{ title: 'Analysis', number: undefined, level: 1 },
			{ title: 'Setup', number: '1', level: 2 },
			{ title: 'Load data', number: '2', level: 2 },
			{ title: 'Results', number: undefined, level: 1 }
		]);
	});

	it('sanitizes through the MCP path: unique, 1-6, ascending', () => {
		const nb = svc.targetFor('sessA');
		expect(svc.setHeaderNumbering([3, 1, 3, 2, 1], nb).levels).toEqual([1, 2, 3]);
		expect(svc.setHeaderNumbering([9, 0, -1, 2, 7], nb).levels).toEqual([2]);
		expect(svc.setHeaderNumbering([2.5, 4], nb).levels).toEqual([4]);
	});

	it('an empty list clears the setting, and the map reports it off', async () => {
		const nb = svc.targetFor('sessA');
		svc.setHeaderNumbering([1, 2], nb);
		expect(svc.setHeaderNumbering([], nb)).toEqual({ levels: [], numbered_headings: 0 });
		expect(nbmod.getHeaderNumbering(nb)).toEqual([]);

		const map = await svc.getNotebookMap(nb);
		expect(map.display.header_numbering).toEqual([]);
		// Off means no section carries a number at all.
		expect(sectionsOf(map).every((s) => s.number === undefined)).toBe(true);
	});

	it('read_section carries the header number, and the cell source it returns does not', async () => {
		const nb = svc.targetFor('sessA');
		svc.setHeaderNumbering([1, 2], nb);
		const setupId = nbmod.listCells(nb).find((c) => c.source === '## Setup')!.id;
		const sec = await svc.readSection(setupId, nb);
		expect(sec!.header.number).toBe('1.1');
		expect(sec!.header.title).toBe('Setup');
		// The number is rendered, not stored: the source the agent reads back is clean.
		expect(sec!.cells[0].source).toBe('## Setup');
		svc.setHeaderNumbering([], nb);
	});
});

describe('set_report_view', () => {
	it('turns on and off, and the map reports it', async () => {
		const nb = svc.targetFor('sessA');
		expect(svc.setReportView(true, nb)).toEqual({ report_view: true });
		expect((await svc.getNotebookMap(nb)).display.report_view).toBe(true);

		expect(svc.setReportView(false, nb)).toEqual({ report_view: false });
		expect((await svc.getNotebookMap(nb)).display.report_view).toBe(false);
		// Cleared, not stored as false - clean-on-save keeps the metadata minimal.
		expect(nbmod.getHideAllCode(nb)).toBe(false);
	});
});

describe('per-session notebook targeting', () => {
	it('each session sets ITS OWN notebook, and an explicit notebook overrides for one call', async () => {
		svc.useNotebook('sessB', 'other.ipynb');
		const A = svc.targetFor('sessA');
		const B = svc.targetFor('sessB');
		expect(A).not.toBe(B);

		svc.setHeaderNumbering([2], A);
		svc.setReportView(true, A);
		expect(nbmod.getHeaderNumbering(B)).toEqual([]);
		expect(nbmod.getHideAllCode(B)).toBe(false);

		svc.setHeaderNumbering([3], B);
		expect(nbmod.getHeaderNumbering(A)).toEqual([2]); // A untouched by B's call

		// The user focusing B must not redirect session A's settings.
		nbmod.setActiveNotebook('other.ipynb');
		svc.setHeaderNumbering([1], svc.targetFor('sessA'));
		expect(nbmod.getHeaderNumbering(A)).toEqual([1]);
		expect(nbmod.getHeaderNumbering(B)).toEqual([3]);

		// An explicit per-call notebook wins for that call only, leaving the pin alone.
		svc.setHeaderNumbering([4], svc.targetFor('sessA', 'other.ipynb'));
		expect(nbmod.getHeaderNumbering(B)).toEqual([4]);
		expect(svc.targetFor('sessA')).toBe(A);

		svc.setHeaderNumbering([], A);
		svc.setReportView(false, A);
		svc.setHeaderNumbering([], B);
	});
});

describe('persistence', () => {
	it('both settings round-trip through the .ipynb and NO number reaches a cell source', () => {
		const nb = svc.targetFor('sessA');
		const before = sources('report.ipynb');
		svc.setHeaderNumbering([1, 2], nb);
		svc.setReportView(true, nb);

		const disk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(disk.metadata.cellar.header_numbering).toEqual([1, 2]);
		expect(disk.metadata.cellar.hide_all_code).toBe(true);
		// The whole point: numbering is display-only. Not one heading gained a number.
		expect(sources('report.ipynb')).toEqual(before);
		for (const c of disk.cells) expect(String(c.source)).not.toMatch(/^#+\s+\d/m);
	});

	it('re-saving the same settings is byte-identical (zero git diff)', () => {
		const nb = svc.targetFor('sessA');
		svc.setHeaderNumbering([1, 2], nb);
		svc.setReportView(true, nb);
		const first = readFileSync(nb, 'utf8');
		// Same values again, and the same values arriving unsorted/duplicated.
		svc.setHeaderNumbering([2, 1, 2], nb);
		svc.setReportView(true, nb);
		expect(readFileSync(nb, 'utf8')).toBe(first);
	});

	it('clearing removes the keys rather than persisting empty/false', () => {
		const nb = svc.targetFor('sessA');
		svc.setHeaderNumbering([], nb);
		svc.setReportView(false, nb);
		const disk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(disk.metadata.cellar?.header_numbering).toBeUndefined();
		expect(disk.metadata.cellar?.hide_all_code).toBeUndefined();
	});
});
