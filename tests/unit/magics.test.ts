import { describe, it, expect } from 'vitest';
import { cellMagicName, isCellMagicCell, normalizeForAnalysis } from '../../src/lib/server/magics';
import { analyzeDataflow } from '../../src/lib/server/dataflow';
import type { CellView } from '../../src/lib/server/types';

describe('cellMagicName', () => {
	it('names a leading cell magic', () => {
		expect(cellMagicName('%%time\ndf = load()')).toBe('time');
		expect(cellMagicName('%%bash\necho hi')).toBe('bash');
		expect(cellMagicName('%%writefile foo.py\nimport os')).toBe('writefile');
	});
	it('tolerates leading blank lines (IPython does)', () => {
		expect(cellMagicName('\n\n%%time\nx = 1')).toBe('time');
	});
	it('is null for plain code, line magics and shell escapes', () => {
		expect(cellMagicName('df = load()')).toBeNull();
		expect(cellMagicName('%matplotlib inline\nx = 1')).toBeNull();
		expect(cellMagicName('!pip install pandas')).toBeNull();
		expect(cellMagicName('x = a % b')).toBeNull(); // modulo, not a magic
	});
	it('isCellMagicCell mirrors it', () => {
		expect(isCellMagicCell('%%html\n<b>hi</b>')).toBe(true);
		expect(isCellMagicCell('x = 1')).toBe(false);
	});
});

describe('normalizeForAnalysis', () => {
	it('strips a Python-body cell magic header, keeping the body', () => {
		expect(normalizeForAnalysis('%%time\ndf = load()')).toBe('df = load()');
		expect(normalizeForAnalysis('%%timeit -n 3\ntotal = sum(range(10))')).toBe('total = sum(range(10))');
	});
	it('yields no Python for a non-Python cell magic', () => {
		expect(normalizeForAnalysis('%%bash\ndf=load')).toBe('');
		expect(normalizeForAnalysis('%%writefile mod.py\nimport os\nx = 1')).toBe('');
		expect(normalizeForAnalysis('%%html\n<b>hi</b>')).toBe('');
	});
	it('blanks line magics and shell escapes but keeps surrounding Python', () => {
		expect(normalizeForAnalysis('%matplotlib inline\ndf = load()')).toBe('\ndf = load()');
		expect(normalizeForAnalysis('%pip install pandas\ndf = load()')).toBe('\ndf = load()');
		expect(normalizeForAnalysis('!pip install pandas\ndf = load()')).toBe('\ndf = load()');
		expect(normalizeForAnalysis('%load_ext autoreload\n%autoreload 2\nx = 1')).toBe('\n\nx = 1');
	});
	it('keeps the binding of an assignment whose RHS is a magic/shell', () => {
		expect(normalizeForAnalysis('files = !ls')).toBe('files = None\n');
		expect(normalizeForAnalysis('a, b = %sx echo hi')).toBe('a, b = None\n');
	});
	it('leaves plain Python untouched', () => {
		expect(normalizeForAnalysis('import os\nx = os.getcwd()')).toBe('import os\nx = os.getcwd()');
		expect(normalizeForAnalysis('y = a % b')).toBe('y = a % b'); // modulo survives
	});
	it('does not misfire on a `%` continuation inside brackets', () => {
		const src = 'x = (a\n% b)';
		expect(normalizeForAnalysis(src)).toBe(src);
	});
});

// End-to-end through the real symtable subprocess: prove the normalized source
// actually yields the right defines/uses so staleness tracks magic cells.
describe('analyzeDataflow (magic-aware)', () => {
	const cell = (id: string, source: string): CellView =>
		({ id, cell_type: 'code', source, metadata: {}, outputs: [] }) as unknown as CellView;

	it("captures a %%time cell's body defines, and downstream uses", async () => {
		const df = await analyzeDataflow([cell('a', '%%time\ndf = load()'), cell('b', 'print(df)')]);
		expect(df.a.defines).toContain('df');
		expect(df.b.uses).toContain('df'); // b depends on a → staleness can link them
	});

	it('a %%bash cell defines nothing (no false dependencies)', async () => {
		const df = await analyzeDataflow([cell('a', '%%bash\ndf=load\necho hi')]);
		expect(df.a).toEqual({ defines: [], uses: [] });
	});

	it("a %pip line does not break a cell that also defines a name", async () => {
		const df = await analyzeDataflow([cell('a', '%pip install pandas\nimport pandas as pd\ntable = pd.DataFrame()')]);
		expect(df.a.defines).toEqual(expect.arrayContaining(['pd', 'table']));
	});
});
