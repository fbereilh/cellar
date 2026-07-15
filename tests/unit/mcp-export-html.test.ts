import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CellOutput } from '../../src/lib/server/types';

/**
 * Agent-facing `export_html` (MCP): the tool exports the working notebook to a
 * self-contained HTML FILE on disk and returns its LOCATION + metadata, never
 * the HTML body. It reuses the SAME render (`buildNotebookHtml`) the HTTP export
 * route uses, honors the `hide_code` report-style override, and confines the
 * output path to the workspace.
 *
 * The tests exercise the real service + notebook singletons against a scratch
 * workspace, addressing plain non-import sources so nothing touches the kernel.
 */

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let exportmod: typeof import('../../src/lib/server/export-html');

const streamOut = (text: string): CellOutput => ({ output_type: 'stream', name: 'stdout', text });

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-export-html-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	exportmod = await import('../../src/lib/server/export-html');
});

/** Build a notebook with a markdown cell + a code cell carrying an output. */
async function seed(rel: string): Promise<string> {
	svc.useNotebook('s', rel);
	const abs = nbmod.resolveNotebookPath(rel);
	await svc.addCells(
		[
			{ cell_type: 'markdown', source: '# Report Title' },
			{ cell_type: 'code', source: 'render_chart()' }
		],
		null,
		{ nb: abs, routeImports: false }
	);
	// Attach a persisted output to the code cell (no kernel involved).
	const codeCell = nbmod.listCells(abs).find((c) => c.cell_type === 'code')!;
	nbmod.setOutputs(codeCell.id, [streamOut('the-plot-output\n')], abs);
	return abs;
}

describe('export_html — writes a file and returns its location, not the body', () => {
	it('default export writes <name>.html alongside the notebook and returns {path, bytes, hide_code}', async () => {
		const abs = await seed('reports/analysis.ipynb');
		const res = svc.exportHtml({ nb: abs });

		// Location, not body.
		expect(res).not.toHaveProperty('html');
		expect(Object.keys(res).sort()).toEqual(['bytes', 'hide_code', 'path']);
		expect(res.path).toBe('reports/analysis.html');
		expect(res.hide_code).toBe(false); // notebook has no hide_all_code setting

		// The file exists and its byte size matches the reported count.
		const outAbs = join(WS, 'reports', 'analysis.html');
		expect(existsSync(outAbs)).toBe(true);
		const bytes = readFileSync(outAbs);
		expect(res.bytes).toBe(bytes.length);
		expect(bytes.length).toBeGreaterThan(100);
		expect(bytes.toString('utf8')).toContain('<!doctype html>');
	});

	it('the written file is byte-identical to the shared render (same as the route)', async () => {
		const abs = await seed('shared.ipynb');
		const res = svc.exportHtml({ nb: abs });
		const onDisk = readFileSync(join(WS, 'shared.html'), 'utf8');
		// buildNotebookHtml is what BOTH the route and the tool call.
		const { html } = exportmod.buildNotebookHtml({ nb: abs });
		expect(onDisk).toBe(html);
	});
});

describe('export_html — hide_code report style', () => {
	it('hide_code:true drops code input, keeps markdown + outputs', async () => {
		const abs = await seed('rpt.ipynb');
		const res = svc.exportHtml({ nb: abs, hideCode: true });
		expect(res.hide_code).toBe(true);
		const html = readFileSync(join(WS, 'rpt.html'), 'utf8');
		expect(html).toContain('<h1>Report Title</h1>'); // markdown survives
		expect(html).not.toContain('class="cell-input"'); // no code input block
		expect(html).not.toContain('render_chart'); // source is gone
		expect(html).toContain('the-plot-output'); // output survives
	});

	it('hide_code:false forces code shown regardless of the saved setting', async () => {
		const abs = await seed('shown.ipynb');
		nbmod.setHideAllCode(true, abs); // notebook saved as report view
		const res = svc.exportHtml({ nb: abs, hideCode: false });
		expect(res.hide_code).toBe(false);
		const html = readFileSync(join(WS, 'shown.html'), 'utf8');
		expect(html).toContain('class="cell-input"');
		expect(html).toContain('render_chart');
	});

	it('omitting hide_code follows the notebook’s saved hide_all_code setting', async () => {
		const abs = await seed('follow.ipynb');
		nbmod.setHideAllCode(true, abs);
		const res = svc.exportHtml({ nb: abs }); // no hide_code → follow saved
		expect(res.hide_code).toBe(true);
		const html = readFileSync(join(WS, 'follow.html'), 'utf8');
		expect(html).not.toContain('class="cell-input"');
		expect(html).not.toContain('render_chart');
	});
});

describe('export_html — path safety', () => {
	it('rejects a traversal attempt that escapes the workspace', async () => {
		const abs = await seed('guard.ipynb');
		expect(() => svc.exportHtml({ nb: abs, path: '../evil.html' })).toThrow(/escapes workspace/);
		expect(existsSync(join(WS, '..', 'evil.html'))).toBe(false);
	});

	it('an explicit path without .html gets the extension and lands inside the workspace', async () => {
		const abs = await seed('explicit.ipynb');
		const res = svc.exportHtml({ nb: abs, path: 'out/custom-report' });
		expect(res.path).toBe('out/custom-report.html');
		expect(existsSync(join(WS, 'out', 'custom-report.html'))).toBe(true);
	});
});
