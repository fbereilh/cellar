/**
 * A chat cell's reply exported to HTML reads as PROSE, not as escaped markup.
 *
 * The reply is persisted as a `display_data` carrying `text/markdown` (plus an
 * identical `text/plain` twin so a consumer with no markdown renderer still
 * shows it). Falling straight through to that twin exported the whole content of
 * a chat cell as literal `**bold**`, `##` headings and `- ` bullets inside a
 * `<pre>` - markup where the app shows a rendered answer.
 *
 * The exported HTML is this module's own generated artifact (a single-file,
 * offline-safe document), so asserting on its bytes is asserting on the contract
 * the module exists to produce.
 */
import { describe, it, expect } from 'vitest';
import { renderNotebookHtml } from '../../src/lib/server/export-html';
import type { CellView, CellOutput } from '../../src/lib/server/types';

const REPLY = '## Findings\n\n**x** is 1, because:\n\n- the cell above assigns it\n- nothing rebinds it\n';

function chatCell(reply: string): CellView {
	const out: CellOutput = {
		output_type: 'display_data',
		data: { 'text/markdown': reply, 'text/plain': reply },
		metadata: {}
	};
	return {
		id: 'chat1',
		cell_type: 'code',
		source: 'Why is x one?',
		outputs: [out],
		metadata: { cellar: { language: 'chat' } }
	};
}

/** The rendered document body for one cell, both view modes. */
const render = (cell: CellView, hideAllCode = false) => renderNotebookHtml({ cells: [cell], hideAllCode });

describe('a text/markdown output exports as rendered prose', () => {
	it('renders headings, emphasis and lists as real elements, not escaped source', () => {
		const html = render(chatCell(REPLY));
		expect(html).toContain('<h2>Findings</h2>');
		expect(html).toContain('<strong>x</strong>');
		expect(html).toContain('<li>the cell above assigns it</li>');
		// And NOT as the text/plain twin inside a <pre>.
		expect(html).not.toContain('## Findings');
		expect(html).not.toContain('**x**');
	});

	it('survives report view, where the reply is all the cell contributes', () => {
		const html = render(chatCell(REPLY), true);
		expect(html).not.toContain('class="cell-input"');
		expect(html).not.toContain('Why is x one?');
		expect(html).toContain('<h2>Findings</h2>');
	});

	it('is not math-aware: `$…$` stays literal text (this module ships no KaTeX)', () => {
		const html = render(chatCell('Revenue was $5 vs $1,200 last year.'));
		expect(html).toContain('$5 vs $1,200');
		expect(html).not.toContain('katex');
	});

	it('renders no raw HTML from the model (html:false is what makes the sanitizer unnecessary)', () => {
		const html = render(chatCell('Careful: <img src=x onerror=alert(1)> and <script>alert(2)</script>'));
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<script>alert(2)');
		expect(html).toContain('&lt;script&gt;');
	});
});

describe('every other output priority is unchanged', () => {
	it('an image still beats a markdown payload', () => {
		const cell: CellView = {
			id: 'c',
			cell_type: 'code',
			source: 'plot()',
			outputs: [
				{ output_type: 'display_data', data: { 'image/png': 'AAAABBBB', 'text/markdown': '**not this**' }, metadata: {} }
			],
			metadata: {}
		};
		const html = render(cell);
		expect(html).toContain('data:image/png;base64,AAAABBBB');
		expect(html).not.toContain('<strong>not this</strong>');
	});

	it('a plain-only result still renders as preformatted text', () => {
		const cell: CellView = {
			id: 'c',
			cell_type: 'code',
			source: 'df.head()',
			outputs: [{ output_type: 'display_data', data: { 'text/plain': '   a  b\n0  1  2' }, metadata: {} }],
			metadata: {}
		};
		const html = render(cell);
		expect(html).toContain('output-text tone-result');
		expect(html).toContain('0  1  2');
	});
});
