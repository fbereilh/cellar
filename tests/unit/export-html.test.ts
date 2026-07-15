import { describe, it, expect } from 'vitest';
import { renderNotebookHtml, exportFilename } from '../../src/lib/server/export-html';
import type { CellView, CellOutput } from '../../src/lib/server/types';

// Minimal CellView builders for the render tests.
function code(source: string, opts: { outputs?: CellOutput[]; hide_input?: boolean } = {}): CellView {
	const cellar: Record<string, unknown> = {};
	if (opts.hide_input !== undefined) cellar.hide_input = opts.hide_input;
	return {
		id: Math.random().toString(36).slice(2),
		cell_type: 'code',
		source,
		outputs: opts.outputs ?? [],
		metadata: { cellar }
	};
}

function markdown(source: string): CellView {
	return { id: Math.random().toString(36).slice(2), cell_type: 'markdown', source, outputs: [], metadata: {} };
}

const streamOut = (text: string): CellOutput => ({ output_type: 'stream', name: 'stdout', text });
const imageOut = (b64: string): CellOutput => ({
	output_type: 'display_data',
	data: { 'image/png': b64 },
	metadata: {}
});

describe('renderNotebookHtml — default (code shown)', () => {
	it('renders markdown, code input, and outputs when hideAllCode is off', () => {
		const html = renderNotebookHtml({
			cells: [markdown('# Report'), code('x = 1\nprint(x)', { outputs: [streamOut('1\n')] })],
			hideAllCode: false
		});
		expect(html).toContain('<h1>Report</h1>');
		expect(html).toContain('class="cell-input"'); // the code editor block is present
		expect(html).toContain('print'); // the source is rendered
		expect(html).toContain('class="cell-output"');
	});
});

describe('renderNotebookHtml — hideAllCode (report view)', () => {
	it('hides every code cell input but keeps markdown and all outputs', () => {
		const html = renderNotebookHtml({
			cells: [
				markdown('# Results'),
				code('df.describe()', { outputs: [streamOut('mean 3.0\n')] }),
				code('plt.plot(xs)', { outputs: [imageOut('AAAABBBB')] })
			],
			hideAllCode: true
		});
		// Markdown survives.
		expect(html).toContain('<h1>Results</h1>');
		// No code input block anywhere.
		expect(html).not.toContain('class="cell-input"');
		expect(html).not.toContain('df.describe');
		expect(html).not.toContain('plt.plot');
		// Every output survives: text + image.
		expect(html).toContain('mean 3.0');
		expect(html).toContain('data:image/png;base64,AAAABBBB');
		// Output-only cells still render as cells.
		expect(html).toContain('code-hidden');
	});

	it('drops a code cell with no output entirely from the report', () => {
		const html = renderNotebookHtml({
			cells: [markdown('## Setup'), code('import pandas as pd')],
			hideAllCode: true
		});
		expect(html).toContain('<h2>Setup</h2>');
		expect(html).not.toContain('import pandas');
		expect(html).not.toContain('class="cell code-cell');
	});
});

describe('renderNotebookHtml — per-cell hide_input overrides the notebook default', () => {
	it('a cell with hide_input:false shows its code even under hideAllCode', () => {
		const html = renderNotebookHtml({
			cells: [code('keep = 1', { hide_input: false, outputs: [streamOut('1\n')] })],
			hideAllCode: true
		});
		expect(html).toContain('keep'); // source shown despite report view
		expect(html).toContain('class="cell-input"');
	});

	it('a cell with hide_input:true hides its code even when hideAllCode is off', () => {
		const html = renderNotebookHtml({
			cells: [code('secret = 1', { hide_input: true, outputs: [streamOut('1\n')] })],
			hideAllCode: false
		});
		expect(html).not.toContain('secret');
		expect(html).not.toContain('class="cell-input"');
		expect(html).toContain('code-hidden');
	});
});

describe('exportFilename', () => {
	it('derives <name>.html from a notebook path', () => {
		expect(exportFilename('analysis.ipynb')).toBe('analysis.html');
		expect(exportFilename('dir/sub/report.ipynb')).toBe('report.html');
		expect(exportFilename(null)).toBe('notebook.html');
	});
});
