/**
 * The text the per-cell "copy output" button puts on the clipboard.
 *
 * The rule under test is the one stated in `$lib/copyCell`: copy gives you, as
 * TEXT, what the cell SHOWS - so the mime priority mirrors `renderOutput` in
 * Cell.svelte and a rendered picture / chart / live widget contributes nothing,
 * which is what makes an image-only cell's button honestly disabled rather than
 * a silent no-op. The suite therefore asserts the SKIPS as hard as the hits.
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
	it('prefers text/plain, the form a live and a re-opened notebook share', () => {
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

	it('flattens the structured DataFrame payload when no text/plain came with it', () => {
		const df = display({
			'application/vnd.cellar.dataframe+json': {
				columns: ['a', 'b'],
				index: [0, 1],
				index_name: '',
				data: [
					[1, 'x'],
					[2, null]
				]
			}
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

	it('returns nothing for markup that carries no text (an html-wrapped image)', () => {
		expect(htmlToPlainText('<div><img src="x.png"/></div>')).toBe('');
		expect(hasCopyableOutput([result({ 'text/html': '<div><img src="x.png"/></div>' })])).toBe(true);
		// ...and the click path then copies nothing rather than markup.
		expect(copyOutputText([result({ 'text/html': '<div><img src="x.png"/></div>' })])).toBe('');
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
		expect(hasCopyableOutput([display({ 'application/vnd.cellar.dataframe+json': { columns: [] } })])).toBe(true);
		expect(hasCopyableOutput([result({ 'text/html': '<i>v</i>' })])).toBe(true);
	});

	it('is false for an empty stream (a run that printed nothing)', () => {
		expect(hasCopyableOutput([stream('')])).toBe(false);
		expect(hasCopyableOutput([stream([])])).toBe(false);
	});
});
