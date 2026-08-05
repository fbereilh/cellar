// @vitest-environment jsdom
//
/**
 * The text the per-cell "copy output" button puts on the clipboard.
 *
 * The rule under test is the one stated in `$lib/copyCell`: copy gives you, as
 * TEXT, what the cell SHOWS - so the mime priority mirrors `renderOutput` in
 * Cell.svelte and a rendered picture / chart / live widget contributes nothing,
 * which is what makes an image-only cell's button honestly disabled rather than
 * a silent no-op. The suite therefore asserts the SKIPS as hard as the hits.
 *
 * It runs under jsdom rather than the suite's default `node` environment because
 * a SAVED DataFrame is recognized through `parsePandasDataFrameHtml`, which is
 * browser-only (it uses DOMParser and returns null with no DOM). Under `node`
 * those cases would silently take the text/plain fallback and pass for the wrong
 * reason; the node behavior is pinned separately, in its own block below.
 */
import { describe, it, expect } from 'vitest';
import {
	outputCopyText,
	copyOutputText,
	hasCopyableOutput,
	htmlToPlainText
} from '../../src/lib/copyCell';
import type { CellOutput } from '../../src/lib/server/types';

const stream = (text: string | string[], name: 'stdout' | 'stderr' = 'stdout'): CellOutput =>
	({ output_type: 'stream', name, text }) as CellOutput;
const result = (data: Record<string, unknown>): CellOutput =>
	({ output_type: 'execute_result', data, metadata: {}, execution_count: 1 }) as unknown as CellOutput;
const display = (data: Record<string, unknown>): CellOutput =>
	({ output_type: 'display_data', data, metadata: {} }) as unknown as CellOutput;
const error = (traceback: string[]): CellOutput =>
	({ output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback }) as CellOutput;

const ESC = String.fromCharCode(27);

describe('outputCopyText - stream', () => {
	it('copies stdout text', () => {
		expect(outputCopyText(stream('hello world\n'))).toBe('hello world\n');
	});

	it('joins nbformat multiline arrays (they are line lists, not separate outputs)', () => {
		expect(outputCopyText(stream(['a\n', 'b\n']))).toBe('a\nb\n');
	});

	it('copies stderr the same way - the clipboard has no tone', () => {
		expect(outputCopyText(stream('warned\n', 'stderr'))).toBe('warned\n');
	});
});

describe('outputCopyText - error', () => {
	it('copies the traceback with ANSI SGR colors stripped', () => {
		const tb = [`${ESC}[0;31mValueError${ESC}[0m: boom`, '  File "<stdin>", line 1'];
		expect(outputCopyText(error(tb))).toBe('ValueError: boom\n  File "<stdin>", line 1');
	});

	it('falls back to "ename: evalue" when a kernel sent no traceback', () => {
		expect(outputCopyText({ output_type: 'error', ename: 'KeyError', evalue: "'x'", traceback: [] } as CellOutput)).toBe(
			"KeyError: 'x'"
		);
	});
});

describe('outputCopyText - rich bundles', () => {
	it('prefers text/plain over ordinary rich html', () => {
		expect(outputCopyText(result({ 'text/plain': '42', 'text/html': '<b>42</b>' }))).toBe('42');
	});

	it('copies NOTHING for an image, not its "<Figure …>" placeholder repr', () => {
		const png = display({ 'image/png': 'iVBORw0KGgo=', 'text/plain': '<Figure size 640x480 with 1 Axes>' });
		expect(outputCopyText(png)).toBe('');
		expect(hasCopyableOutput([png])).toBe(false);
	});

	it('copies nothing for an SVG image either', () => {
		expect(outputCopyText(display({ 'image/svg+xml': '<svg/>' }))).toBe('');
	});

	it('copies nothing for a plotly figure or a live widget view', () => {
		expect(outputCopyText(display({ 'application/vnd.plotly.v1+json': { data: [], layout: {} } }))).toBe('');
		const widget = display({
			'application/vnd.jupyter.widget-view+json': { model_id: 'abc' },
			'text/plain': 'HBox(children=(FloatProgress(value=0.0),))'
		});
		expect(outputCopyText(widget)).toBe('');
		expect(hasCopyableOutput([widget])).toBe(false);
	});

	it('flattens the structured DataFrame payload, which OUTRANKS the elided text/plain repr', () => {
		// The grid is what the cell shows (up to 500 rows), so copy gives the table,
		// not the ~10-row repr pandas ships alongside it.
		const df = display({
			'application/vnd.cellar.dataframe+json': {
				columns: ['a', 'b'],
				index: [0, 1],
				index_name: '',
				data: [
					[1, 'x'],
					[2, null]
				]
			},
			'text/plain': '   a  b\n0  1  x\n1  2  NaN\n\n[500 rows x 2 columns]'
		});
		expect(outputCopyText(df)).toBe('\ta\tb\n0\t1\tx\n1\t2\t');
	});

	it('names a genuinely unhandled mimetype as nothing to copy', () => {
		expect(outputCopyText(display({ 'application/x-weird': 'zzz' }))).toBe('');
	});
});

describe('outputCopyText - text/html (the pandas Styler case: no text/plain)', () => {
	it('renders a table as tab-separated rows, never raw markup', () => {
		const html =
			'<table><thead><tr><th>name</th><th>qty</th></tr></thead>' +
			'<tbody><tr><td>apple</td><td>3</td></tr><tr><td>pear</td><td>5</td></tr></tbody></table>';
		const text = outputCopyText(result({ 'text/html': html }));
		expect(text).toBe('name\tqty\napple\t3\npear\t5');
		expect(text).not.toContain('<');
	});

	it('decodes entities and drops script/style bodies', () => {
		const html = '<style>td{color:red}</style><p>a &amp; b &lt;ok&gt;</p><script>evil()</script>';
		expect(htmlToPlainText(html)).toBe('a & b <ok>');
	});

	it('returns nothing for markup that carries no text, and the button is then DISABLED', () => {
		expect(htmlToPlainText('<div><img src="x.png"/></div>')).toBe('');
		// The enabled test reads the CONVERTED text, so html that strips to nothing
		// disables the button rather than admitting a click that copies nothing.
		expect(hasCopyableOutput([result({ 'text/html': '<div><img src="x.png"/></div>' })])).toBe(false);
		expect(copyOutputText([result({ 'text/html': '<div><img src="x.png"/></div>' })])).toBe('');
	});

	it('disables the button for an all-script bundle (Bokeh / Altair / fig.show())', () => {
		const bundle = '<div id="c1"></div><script>Bokeh.embed.embed_item({"target_id":"c1"});</script>';
		expect(htmlToPlainText(bundle)).toBe('');
		expect(hasCopyableOutput([display({ 'text/html': bundle })])).toBe(false);
	});

	it('turns <br> into line breaks', () => {
		expect(htmlToPlainText('one<br>two')).toBe('one\ntwo');
	});
});

describe('copyOutputText - a whole cell', () => {
	it('concatenates several outputs in document order, one newline apart', () => {
		expect(copyOutputText([stream('first\n'), result({ 'text/plain': 'second' }), stream('third\n')])).toBe(
			'first\nsecond\nthird'
		);
	});

	it('skips the outputs with no text form (an image beside a print copies the print)', () => {
		const outs = [stream('printed\n'), display({ 'image/png': 'iVBOR', 'text/plain': '<Figure>' })];
		expect(copyOutputText(outs)).toBe('printed');
		expect(hasCopyableOutput(outs)).toBe(true);
	});

	it('handles no outputs at all without throwing', () => {
		expect(copyOutputText([])).toBe('');
		expect(copyOutputText(undefined)).toBe('');
		expect(copyOutputText(null)).toBe('');
	});
});

describe('outputCopyText - a SAVED DataFrame (structured MIME stripped by clean-on-save)', () => {
	// pandas' own `_repr_html_`, which is all a re-opened notebook carries. It is
	// what renderOutput re-parses back into the grid, so copy runs it through the
	// SAME parser ($lib/dataframeHtml) and produces the same table a live one does.
	const PANDAS_HTML =
		'<div><table border="1" class="dataframe"><thead>' +
		'<tr style="text-align: right;"><th></th><th>a</th><th>b</th></tr></thead><tbody>' +
		'<tr><th>0</th><td>1</td><td>x</td></tr>' +
		'<tr><th>1</th><td>2</td><td>y</td></tr>' +
		'</tbody></table></div>';
	const LIVE = {
		'application/vnd.cellar.dataframe+json': {
			columns: ['a', 'b'],
			index: [0, 1],
			index_name: '',
			data: [
				[1, 'x'],
				[2, 'y']
			]
		}
	};

	it('parses the repr into the same table, so it OUTRANKS the elided text/plain', () => {
		const saved = display({ 'text/html': PANDAS_HTML, 'text/plain': '   a  b\n0  1  x\n1  2  y' });
		expect(outputCopyText(saved)).toBe('\ta\tb\n0\t1\tx\n1\t2\ty');
	});

	it('copies identically live and re-opened', () => {
		expect(outputCopyText(display({ 'text/html': PANDAS_HTML }))).toBe(outputCopyText(display(LIVE)));
	});

	it('leaves a non-dataframe table to text/plain, then to the tag-strip', () => {
		const styler = '<table id="T_x"><thead><tr><th>name</th></tr></thead><tbody><tr><td>apple</td></tr></tbody></table>';
		// A pandas Styler carries no `class="dataframe"`, so it does not parse: with a
		// text/plain sibling that still wins, and alone it falls to the tag-strip.
		expect(outputCopyText(display({ 'text/html': styler, 'text/plain': 'plain wins' }))).toBe('plain wins');
		expect(outputCopyText(display({ 'text/html': styler }))).toBe('name\napple');
	});

	it('falls back to text/plain outside a browser (the parser needs DOMParser)', () => {
		// Pinned explicitly so the jsdom-only path above can never pass for the wrong
		// reason in a `node` environment: with no DOMParser the parse returns null.
		const saved = display({ 'text/html': PANDAS_HTML, 'text/plain': 'repr fallback' });
		const savedParser = globalThis.DOMParser;
		try {
			// @ts-expect-error - simulating the non-DOM environment the parser guards for.
			delete globalThis.DOMParser;
			expect(outputCopyText(saved)).toBe('repr fallback');
		} finally {
			globalThis.DOMParser = savedParser;
		}
	});
});

describe('hasCopyableOutput - the button-disabled rule', () => {
	it('is false with no outputs, and for an image-only cell', () => {
		expect(hasCopyableOutput([])).toBe(false);
		expect(hasCopyableOutput(undefined)).toBe(false);
		expect(hasCopyableOutput([display({ 'image/png': 'iVBOR' })])).toBe(false);
	});

	it('is true for stream, error, text/plain, dataframe and html outputs', () => {
		expect(hasCopyableOutput([stream('x')])).toBe(true);
		expect(hasCopyableOutput([error(['boom'])])).toBe(true);
		expect(hasCopyableOutput([result({ 'text/plain': 'v' })])).toBe(true);
		expect(
			hasCopyableOutput([display({ 'application/vnd.cellar.dataframe+json': { columns: ['a'], index: [0], data: [[1]] } })])
		).toBe(true);
		expect(hasCopyableOutput([result({ 'text/html': '<i>v</i>' })])).toBe(true);
	});

	it('is false for an empty stream (a run that printed nothing)', () => {
		expect(hasCopyableOutput([stream('')])).toBe(false);
		expect(hasCopyableOutput([stream([])])).toBe(false);
	});

	it('is false for a bare print() - stream text that is only a newline', () => {
		expect(hasCopyableOutput([stream('\n')])).toBe(false);
		expect(hasCopyableOutput([stream(['\n', '  \n'])])).toBe(false);
	});
});

describe('the enabled rule and the copy can never disagree', () => {
	// THE invariant: hasCopyableOutput(outs) === (copyOutputText(outs) !== ''). An
	// enabled button that copies nothing is indistinguishable from a denied
	// clipboard, which is exactly the silent no-op the disabled rule exists to
	// prevent - so it is asserted over the table rather than case by case.
	const cases: Array<[string, CellOutput[]]> = [
		['no outputs', []],
		['a print with text', [stream('hello\n')]],
		['a bare print (newline only)', [stream('\n')]],
		['whitespace-only stream', [stream('   \n\t')]],
		['an empty stream', [stream('')]],
		['an error', [error(['boom'])]],
		['text/plain', [result({ 'text/plain': '42' })]],
		['an image with its <Figure> repr', [display({ 'image/png': 'iVBOR', 'text/plain': '<Figure>' })]],
		['a plotly figure', [display({ 'application/vnd.plotly.v1+json': { data: [] } })]],
		['a live widget view', [display({ 'application/vnd.jupyter.widget-view+json': { model_id: 'm' } })]],
		['an all-script html bundle', [display({ 'text/html': '<div id="c"></div><script>go()</script>' })]],
		['an html-wrapped image', [result({ 'text/html': '<div><img src="x.png"/></div>' })]],
		['a Styler table', [display({ 'text/html': '<table><tbody><tr><td>a</td></tr></tbody></table>' })]],
		[
			'a live DataFrame',
			[display({ 'application/vnd.cellar.dataframe+json': { columns: ['a'], index: [0], data: [[1]] } })]
		],
		[
			'a saved DataFrame repr',
			[
				display({
					'text/html':
						'<table border="1" class="dataframe"><thead><tr><th></th><th>a</th></tr></thead>' +
						'<tbody><tr><th>0</th><td>1</td></tr></tbody></table>'
				})
			]
		],
		['an image beside a print', [stream('printed\n'), display({ 'image/png': 'iVBOR' })]],
		['an image beside a bare print', [stream('\n'), display({ 'image/png': 'iVBOR' })]],
		['an unhandled mimetype', [display({ 'application/x-weird': 'zzz' })]]
	];

	for (const [name, outs] of cases) {
		it(name, () => {
			expect(hasCopyableOutput(outs)).toBe(copyOutputText(outs) !== '');
		});
	}
});
