/**
 * RUST as a notebook language: the pure rules every surface asks.
 *
 * The rule that decides the most is `notebookKernelLanguage`: Python and Mojo
 * share ipykernel, Rust runs on Evcxr. Everything Python-shaped (the dataflow
 * graph, the imports cell, the variable inspector, module export) must answer
 * "no" for a Rust notebook, and unchanged for the other two.
 */
import { describe, it, expect } from 'vitest';
import {
	NOTEBOOK_LANGUAGES,
	NOTEBOOK_LANGUAGE_LABELS,
	RUST_LANGUAGE,
	RUST_UNSUPPORTED_REASON,
	TEXT_NOTEBOOK_RUST_MESSAGE,
	cellLanguage,
	isMojoCell,
	isPythonCodeCell,
	isRustCell,
	notebookHasPythonNamespace,
	notebookKernelLanguage,
	notebookLanguageOf
} from '../../src/lib/cellLanguage';
import {
	canExportCell,
	exportLanguageOf,
	exportModuleLanguage,
	languageGeneratesModule,
	moduleExtension,
	noModuleLanguageMessage
} from '../../src/lib/exportRole';
import { notebookUsesImportsCell } from '../../src/lib/importsRole';

const code = { cell_type: 'code', source: 'let x = 1;', metadata: {} };
const markdown = { cell_type: 'markdown', source: '# hi', metadata: {} };
const sql = { cell_type: 'code', source: 'select 1', metadata: { cellar: { language: 'sql' } } };

describe('the language itself', () => {
	it('is one of exactly three, with a label', () => {
		expect([...NOTEBOOK_LANGUAGES]).toEqual(['python', 'mojo', 'rust']);
		expect(NOTEBOOK_LANGUAGE_LABELS.rust).toBe('Rust');
	});

	it('is read off notebook metadata, and anything unknown stays Python', () => {
		expect(notebookLanguageOf({ cellar: { language: RUST_LANGUAGE } })).toBe('rust');
		expect(notebookLanguageOf({ cellar: { language: 'Rust' } })).toBe('python');
		expect(notebookLanguageOf({})).toBe('python');
	});
});

describe('which kernel a notebook runs on', () => {
	it('puts Python and Mojo on one kernel and Rust on its own', () => {
		expect(notebookKernelLanguage('python')).toBe('python');
		expect(notebookKernelLanguage('mojo')).toBe('python');
		expect(notebookKernelLanguage('rust')).toBe('rust');
	});
});

describe('a code cell in a Rust notebook', () => {
	it('is a Rust cell and nothing else', () => {
		expect(isRustCell(code, 'rust')).toBe(true);
		expect(isMojoCell(code, 'rust')).toBe(false);
		expect(isPythonCodeCell(code, 'rust')).toBe(false);
		expect(cellLanguage(code, 'rust')).toBe('rust');
	});

	it('leaves markdown and SQL cells what they were', () => {
		expect(isRustCell(markdown, 'rust')).toBe(false);
		expect(isRustCell(sql, 'rust')).toBe(false);
	});

	it('is not a Rust cell in a Python or Mojo notebook', () => {
		expect(isRustCell(code)).toBe(false);
		expect(isRustCell(code, 'mojo')).toBe(false);
	});
});

describe('the Python-only machinery', () => {
	it('has no Python namespace to inspect', () => {
		expect(notebookHasPythonNamespace('rust')).toBe(false);
		expect(notebookHasPythonNamespace('python')).toBe(true);
	});

	it('uses no imports cell', () => {
		expect(notebookUsesImportsCell('rust')).toBe(false);
		expect(notebookUsesImportsCell('python')).toBe(true);
	});
});

describe('module export', () => {
	it('generates no module for Rust, and still does for the other two', () => {
		expect(languageGeneratesModule('rust')).toBe(false);
		expect(languageGeneratesModule('python')).toBe(true);
		expect(languageGeneratesModule('mojo')).toBe(true);
	});

	it('makes every cell of a Rust notebook ineligible', () => {
		expect(exportLanguageOf(code, 'rust')).toBeNull();
		expect(canExportCell(code, 'rust')).toBe(false);
		// The control: the same cell in a Python notebook is eligible.
		expect(canExportCell(code, 'python')).toBe(true);
	});

	it('names no module language for a Rust notebook, even with a target kept from before the switch', () => {
		expect(exportModuleLanguage('rust', true)).toBeNull();
		expect(exportModuleLanguage('rust', false)).toBeNull();
		// The control: a named module in the other two languages is in that language.
		expect(exportModuleLanguage('python', true)).toBe('python');
		expect(exportModuleLanguage('mojo', true)).toBe('mojo');
	});

	it('says why, naming the language', () => {
		expect(noModuleLanguageMessage('rust')).toContain('Rust');
	});

	it('still names an extension per language', () => {
		expect(moduleExtension('python')).toBe('.py');
		expect(moduleExtension('mojo')).toBe('.mojo');
		expect(moduleExtension('rust')).toBe('.rs');
	});
});

describe('the .py text-notebook refusal', () => {
	it('has its own message and reason code', () => {
		expect(TEXT_NOTEBOOK_RUST_MESSAGE).toContain('Rust');
		expect(TEXT_NOTEBOOK_RUST_MESSAGE).toContain('.ipynb');
		expect(RUST_UNSUPPORTED_REASON).toBe('rust-in-py-notebook');
	});
});
