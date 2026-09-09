import { describe, it, expect } from 'vitest';
import { cellMagicName, isCellMagicCell, normalizeForAnalysis, scanMagics } from '../../src/lib/server/magics';
import { logicalLines } from '../../src/lib/server/imports';
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

	it('answers the same for every line shape, walking rather than splitting', () => {
		// It runs once per CODE CELL on the export-eligibility path (`hasMojoHeader`),
		// which `getNotebook` and `persist` both sweep, so it reads the first non-blank
		// line without allocating an array of every line. The rewrite must be
		// behaviour-identical, including at the source edges a walk has and a split
		// does not: no trailing newline, ONLY blank lines, an empty source, and a source
		// that is a single unterminated line.
		expect(cellMagicName('%%mojo')).toBe('mojo');
		expect(cellMagicName('%%mojo\n')).toBe('mojo');
		expect(cellMagicName('\n \t \n%%mojo build -o m.so\nbody')).toBe('mojo');
		expect(cellMagicName('')).toBeNull();
		expect(cellMagicName('\n')).toBeNull();
		expect(cellMagicName('\n\n   \n')).toBeNull();
		expect(cellMagicName(null)).toBeNull();
		expect(cellMagicName(undefined)).toBeNull();
		expect(cellMagicName('x = 1')).toBeNull();
		// A CRLF source: the `\r` rides the line's tail, which `trimStart` never sees,
		// so the name is read exactly as it was before.
		expect(cellMagicName('\r\n%%time\r\nx = 1')).toBe('time');
		// The first non-blank line settles it however long the rest of the cell is, and
		// a magic further down is not one.
		expect(cellMagicName(`%%bash\n${'echo hi\n'.repeat(500)}`)).toBe('bash');
		expect(cellMagicName(`${'x = 1\n'.repeat(500)}%%bash`)).toBeNull();
	});
});

describe('scanMagics - every magic question in one pass', () => {
	const scan = (src: string) => scanMagics(logicalLines(src));

	it('agrees with cellMagicName about what opens a cell magic', () => {
		for (const src of ['%%time\nx = 1', '\n\n%%bash\necho hi', 'x = 1', '%matplotlib inline', 'x = a % b']) {
			expect(scan(src).cellMagic).toBe(cellMagicName(src) !== null);
		}
	});

	it('flags autoreload however it is armed, in any line', () => {
		expect(scan('import os\n%autoreload 2').autoreload).toBe(true);
		expect(scan('%load_ext autoreload').autoreload).toBe(true);
		expect(scan('%reload_ext autoreload').autoreload).toBe(true);
		expect(scan('%autoreload 0').autoreload).toBe(true); // disabling is still a mention
		expect(scan('%matplotlib inline\nimport os').autoreload).toBe(false);
	});

	it('flags every magic not PROVEN inert, unknown ones included', () => {
		expect(scan('%matplotlib inline\n%pip install x\n%config A.b = 1\nimport os').nonInert).toBe(false);
		expect(scan('%run setup.py').nonInert).toBe(true);
		expect(scan('%store -r pd').nonInert).toBe(true);
		expect(scan('%mystery_magic').nonInert).toBe(true);
		// An extension can push names of its own, so loading one is not provably inert.
		expect(scan('%load_ext sql').nonInert).toBe(true);
		expect(scan('%reload_ext line_profiler').nonInert).toBe(true);
		// A shell escape runs a subprocess; it binds nothing and is not a line magic.
		expect(scan('!ls\nimport os').nonInert).toBe(false);
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
