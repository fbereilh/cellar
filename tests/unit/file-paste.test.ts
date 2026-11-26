/**
 * The file explorer's Paste and Duplicate: the naming rule, where a paste
 * lands, which clipboard a paste reads, and the chunked upload a paste from
 * another app goes through. The server half runs over a real temp workspace.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyName, freeName, pasteSource, pasteTargetDir, uploadChunks, UPLOAD_CHUNK_BYTES } from '$lib/filePaste';

describe('copyName / freeName', () => {
	it('keeps the extension last', () => {
		expect(copyName('utils.py', 1)).toBe('utils copy.py');
		expect(copyName('utils.py', 2)).toBe('utils copy 2.py');
		expect(copyName('archive.tar.gz', 1)).toBe('archive.tar copy.gz');
	});
	it('handles names without an extension', () => {
		expect(copyName('utils', 1)).toBe('utils copy');
		expect(copyName('Makefile', 3)).toBe('Makefile copy 3');
	});
	it('takes the first free candidate', () => {
		const taken = new Set(['utils.py', 'utils copy.py']);
		expect(freeName('utils.py', (n) => taken.has(n))).toBe('utils copy 2.py');
		expect(freeName('new.py', (n) => taken.has(n))).toBe('new.py');
	});
});

describe('pasteTargetDir', () => {
	it('pastes into a folder, beside a file, or at the root', () => {
		expect(pasteTargetDir({ type: 'dir', path: 'src/lib' })).toBe('src/lib');
		expect(pasteTargetDir({ type: 'file', path: 'src/lib/a.py' })).toBe('src/lib');
		expect(pasteTargetDir({ type: 'file', path: 'top.py' })).toBe('');
		expect(pasteTargetDir({ type: 'root', path: '' })).toBe('');
		expect(pasteTargetDir(null)).toBe('');
	});
});

describe('pasteSource', () => {
	it('reads the explorer clipboard when the system one has no files', () => {
		expect(
			pasteSource({
				cellar: true,
				cellarOnSystemClipboard: true,
				osFiles: false
			})
		).toBe('cellar');
		expect(
			pasteSource({
				cellar: true,
				cellarOnSystemClipboard: false,
				osFiles: false
			})
		).toBe('cellar');
	});
	it('reads system files copied after the explorer copy', () => {
		expect(
			pasteSource({
				cellar: true,
				cellarOnSystemClipboard: true,
				osFiles: true
			})
		).toBe('os');
	});
	it('keeps the explorer clipboard first when its copy is unconfirmed', () => {
		expect(
			pasteSource({
				cellar: true,
				cellarOnSystemClipboard: false,
				osFiles: true
			})
		).toBe('cellar');
	});
	it('reads system files when the explorer holds nothing, else nothing', () => {
		expect(
			pasteSource({
				cellar: false,
				cellarOnSystemClipboard: false,
				osFiles: true
			})
		).toBe('os');
		expect(
			pasteSource({
				cellar: false,
				cellarOnSystemClipboard: false,
				osFiles: false
			})
		).toBe('none');
	});
});

describe('uploadChunks', () => {
	it('splits into ranges that cover the file exactly', () => {
		expect(uploadChunks(0)).toEqual([[0, 0]]);
		expect(uploadChunks(10, 4)).toEqual([
			[0, 4],
			[4, 8],
			[8, 10]
		]);
		expect(uploadChunks(UPLOAD_CHUNK_BYTES)).toEqual([[0, UPLOAD_CHUNK_BYTES]]);
	});
});

describe('server: duplicate and paste from another app (fstree)', () => {
	let WS: string;
	let fs: typeof import('../../src/lib/server/fstree');
	const prev = process.env.CELLAR_WORKSPACE;

	beforeAll(async () => {
		WS = mkdtempSync(join(tmpdir(), 'cellar-file-paste-'));
		process.env.CELLAR_WORKSPACE = WS;
		fs = await import('../../src/lib/server/fstree');
	});
	afterAll(() => {
		rmSync(WS, { recursive: true, force: true });
		if (prev === undefined) delete process.env.CELLAR_WORKSPACE;
		else process.env.CELLAR_WORKSPACE = prev;
	});
	beforeEach(() => {
		process.env.CELLAR_WORKSPACE = WS;
		for (const n of readdirSync(WS)) rmSync(join(WS, n), { recursive: true, force: true });
		mkdirSync(join(WS, 'src/pkg'), { recursive: true });
		writeFileSync(join(WS, 'src/utils.py'), 'x = 1\n');
		writeFileSync(join(WS, 'src/pkg/a.py'), 'a\n');
	});

	it('duplicates a file beside itself with the next free name', () => {
		expect(fs.copyEntry('src/utils.py', 'src').path).toBe('src/utils copy.py');
		expect(fs.copyEntry('src/utils.py', 'src').path).toBe('src/utils copy 2.py');
		expect(readFileSync(join(WS, 'src/utils copy 2.py'), 'utf8')).toBe('x = 1\n');
	});

	it('duplicates a folder with its contents', () => {
		expect(fs.copyEntry('src/pkg', 'src').path).toBe('src/pkg copy');
		expect(readFileSync(join(WS, 'src/pkg copy/a.py'), 'utf8')).toBe('a\n');
	});

	it('assembles chunks into the file and de-duplicates the name', () => {
		const id = 'abcdef0123456789';
		expect(
			fs.writeUploadChunk({
				dir: 'src',
				name: 'utils.py',
				id,
				offset: 0,
				bytes: Buffer.from('he'),
				last: false
			})
		).toEqual({ received: 2 });
		const res = fs.writeUploadChunk({
			dir: 'src',
			name: 'utils.py',
			id,
			offset: 2,
			bytes: Buffer.from('llo'),
			last: true
		});
		expect(res).toEqual({ path: 'src/utils copy.py' });
		expect(readFileSync(join(WS, 'src/utils copy.py'), 'utf8')).toBe('hello');
		expect(readdirSync(join(WS, 'src')).filter((n) => n.startsWith('.'))).toEqual([]);
	});

	it('writes an empty file in one request', () => {
		const res = fs.writeUploadChunk({
			dir: '',
			name: 'empty.txt',
			id: 'aaaaaaaa',
			offset: 0,
			bytes: new Uint8Array(),
			last: true
		});
		expect(res).toEqual({ path: 'empty.txt' });
		expect(readFileSync(join(WS, 'empty.txt'), 'utf8')).toBe('');
	});

	it('refuses an out-of-order chunk and leaves no file', () => {
		const id = 'bbbbbbbb';
		fs.writeUploadChunk({
			dir: 'src',
			name: 'x.bin',
			id,
			offset: 0,
			bytes: Buffer.from('ab'),
			last: false
		});
		expect(() =>
			fs.writeUploadChunk({
				dir: 'src',
				name: 'x.bin',
				id,
				offset: 5,
				bytes: Buffer.from('c'),
				last: true
			})
		).toThrow(/out of order/);
		fs.abortUpload('src', id);
		expect(readdirSync(join(WS, 'src'))).toEqual(['pkg', 'utils.py']);
	});

	it('keeps every path inside the workspace', () => {
		const bytes = Buffer.from('x');
		const escapee = `escaped-${Date.now()}`;
		expect(() =>
			fs.writeUploadChunk({
				dir: '../',
				name: escapee,
				id: 'cccccccc',
				offset: 0,
				bytes,
				last: true
			})
		).toThrow(/escapes/);
		expect(() =>
			fs.writeUploadChunk({
				dir: 'src',
				name: '../x',
				id: 'cccccccc',
				offset: 0,
				bytes,
				last: true
			})
		).toThrow(/invalid name/);
		expect(() =>
			fs.writeUploadChunk({
				dir: 'src',
				name: 'x',
				id: '../../x',
				offset: 0,
				bytes,
				last: true
			})
		).toThrow(/invalid upload id/);
		expect(() =>
			fs.writeUploadChunk({
				dir: 'src/utils.py',
				name: 'x',
				id: 'cccccccc',
				offset: 0,
				bytes,
				last: true
			})
		).toThrow(/not a folder/);
		expect(existsSync(join(WS, '..', escapee))).toBe(false);
	});
});
