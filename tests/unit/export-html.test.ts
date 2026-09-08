import { describe, it, expect } from 'vitest';
import { renderNotebookHtml, exportFilename } from '../../src/lib/server/export-html';
import { pagePayloadOutputs } from '../../src/lib/server/execPayload';
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

function raw(source: string): CellView {
	return { id: Math.random().toString(36).slice(2), cell_type: 'raw', source, outputs: [], metadata: {} };
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

describe('renderNotebookHtml - raw cells', () => {
	// The export shows what the notebook CONTAINS, so a raw cell is rendered - but
	// muted and unhighlighted, since it is neither code nor prose.
	it('renders a raw cell as a muted pre block', () => {
		const html = renderNotebookHtml({ cells: [raw('---\ntitle: Post\n---'), code('x = 1')] });
		expect(html).toContain('class="cell raw-cell"');
		expect(html).toContain('pre class="code raw"');
		expect(html).toContain('title: Post');
		// No output block and no code-input block: a raw cell holds neither.
		expect(html).not.toContain('<section class="cell raw-cell"><div class="cell-input"');
	});

	// The load-bearing one: a raw cell's source reaches the report ESCAPED. It is
	// arbitrary text from a downloaded notebook, and this file is meant to be
	// shared - rendering it as HTML would make the export an XSS surface.
	it('escapes a raw cell rather than emitting it as HTML', () => {
		const html = renderNotebookHtml({ cells: [raw('<script>alert(1)</script>\n<b>x</b>')] });
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).not.toContain('<b>x</b>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	// Report view hides CODE inputs; a raw cell is not code, and dropping it would
	// silently remove content from the report. It renders either way.
	it('keeps a raw cell under report view, and drops an empty one', () => {
		// Match the SECTION, not the string: the stylesheet always names the class.
		expect(renderNotebookHtml({ cells: [raw('---\n---'), code('x = 1')], hideAllCode: true })).toContain(
			'<section class="cell raw-cell">'
		);
		expect(renderNotebookHtml({ cells: [raw('   \n')] })).not.toContain('<section class="cell raw-cell">');
	});
});

// --- `func?` / `func??` documentation tone ----------------------------------

const ESC = String.fromCharCode(27);

/**
 * VERBATIM from a live ipykernel (`len?`) - the SGR-coloured pager text IPython
 * really returns on `execute_reply`'s `content.payload`.
 */
const LEN_PAGE_REPLY = {
	status: 'ok',
	execution_count: 1,
	payload: [
		{
			source: 'page',
			data: {
				'text/plain':
					`${ESC}[31mSignature:${ESC}[39m len(obj, /)\n` +
					`${ESC}[31mDocstring:${ESC}[39m Return the number of items in a container.`
			},
			start: 0
		}
	]
};

/**
 * The tone class the export gave the `<pre>` whose text contains `needle`, read
 * back out of the emitted HTML. Returns the tone alone, so a test can compare two
 * outputs' tones without naming either.
 */
function toneOf(html: string, needle: string): string {
	const matches = [...html.matchAll(/<pre class="output-text tone-([a-z]+)">([\s\S]*?)<\/pre>/g)];
	const hit = matches.filter((m) => m[2].includes(needle));
	expect(hit, `no single output-text block contains ${JSON.stringify(needle)}`).toHaveLength(1);
	return hit[0][1];
}

describe('renderNotebookHtml - documentation tone', () => {
	// The export is a second render surface for the SAME outputs, so it has to pick
	// tones by the same rule `Cell.svelte` does: documentation reads as INFORMATION
	// (the plain treatment a `print` gets), never as the green semibold value tone.
	// Asserted as a RELATIONSHIP between three outputs rendered in one document, so
	// it states "the report agrees with the app" and cannot drift back by renaming
	// a class.
	it('gives a `func?` doc output the stream tone, not the value tone', () => {
		const [doc] = pagePayloadOutputs(LEN_PAGE_REPLY);
		const html = renderNotebookHtml({
			cells: [
				code('len?', { outputs: [doc] }),
				code('print("hello")', { outputs: [streamOut('hello\n')] }),
				code('42', {
					outputs: [{ output_type: 'display_data', data: { 'text/plain': 'the value 42' }, metadata: {} }]
				})
			]
		});

		const docTone = toneOf(html, 'Return the number of items');
		const streamTone = toneOf(html, 'hello');
		const valueTone = toneOf(html, 'the value 42');

		expect(docTone).toBe(streamTone);
		expect(docTone).not.toBe(valueTone);
	});

	// The ANSI strip is the server's, so the report carries the clean text a
	// terminal-less reader can actually read - never raw escapes.
	it('exports the documentation text with its terminal escapes already gone', () => {
		const [doc] = pagePayloadOutputs(LEN_PAGE_REPLY);
		const html = renderNotebookHtml({ cells: [code('len?', { outputs: [doc] })] });
		expect(html).toContain('Signature: len(obj, /)');
		expect(html).not.toContain(ESC);
	});
});

describe('exportFilename', () => {
	it('derives <name>.html from a notebook path', () => {
		expect(exportFilename('analysis.ipynb')).toBe('analysis.html');
		expect(exportFilename('dir/sub/report.ipynb')).toBe('report.html');
		expect(exportFilename(null)).toBe('notebook.html');
	});
});
