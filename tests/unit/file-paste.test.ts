/**
 * The file explorer's Paste and Duplicate: the naming rule, where a paste
 * lands, which clipboard a paste reads, and the chunked upload a paste from
 * another app goes through. The server half runs over a real temp workspace.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyName, freeName, pasteSource, pasteTargetDir, uploadChunks, UPLOAD_CHUNK_BYTES } from '$lib/filePaste';

/**
 * The one seam into the filesystem: a test can make the next hard link fail the
 * way a link across filesystems does (EXDEV), after running `before` first.
 * Everything else in `node:fs` stays real.
 */
const link = vi.hoisted(() => ({ crossDevice: null as null | ((dest: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs')>();
	return {
		...real,
		linkSync: (from: string, to: string) => {
			if (!link.crossDevice) return real.linkSync(from, to);
			link.crossDevice(to);
			throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
		}
	};
});

/** A test can point the OS temp dir at a scratch folder, so the staging root is its own. */
const os = vi.hoisted(() => ({ tmp: null as null | string }));
vi.mock('node:os', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:os')>();
	return { ...real, tmpdir: () => os.tmp ?? real.tmpdir() };
});

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
	let POST: (evt: { request: Request; url: URL }) => Promise<Response>;
	let DELETE: (evt: { request: Request; url: URL }) => Response;
	const prev = process.env.CELLAR_WORKSPACE;

	/** Every entry under the workspace, hidden ones included. */
	const allEntries = () => (readdirSync(WS, { recursive: true }) as string[]).sort();
	const stagedParts = () => (existsSync(fs.uploadStagingDir()) ? readdirSync(fs.uploadStagingDir()) : []);

	const send = (method: 'POST' | 'DELETE', query: Record<string, string>, headers: Record<string, string>, body?: string) => {
		const href = `http://localhost:4000/api/fs/upload?${new URLSearchParams(query)}`;
		return { request: new Request(href, { method, headers, body }), url: new URL(href) };
	};

	beforeAll(async () => {
		WS = mkdtempSync(join(tmpdir(), 'cellar-file-paste-'));
		process.env.CELLAR_WORKSPACE = WS;
		fs = await import('../../src/lib/server/fstree');
		const route = await import('../../src/routes/api/fs/upload/+server.js');
		POST = route.POST as unknown as typeof POST;
		DELETE = route.DELETE as unknown as typeof DELETE;
	});
	afterAll(() => {
		fs.sweepStagedUploads();
		rmSync(WS, { recursive: true, force: true });
		if (prev === undefined) delete process.env.CELLAR_WORKSPACE;
		else process.env.CELLAR_WORKSPACE = prev;
	});
	beforeEach(() => {
		process.env.CELLAR_WORKSPACE = WS;
		link.crossDevice = null;
		fs.sweepStagedUploads();
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
		expect(stagedParts()).toEqual([`${id}.part`]);
		fs.abortUpload(id);
		expect(stagedParts()).toEqual([]);
		expect(readdirSync(join(WS, 'src'))).toEqual(['pkg', 'utils.py']);
	});

	it('stages an unfinished paste outside the project folder', () => {
		const before = allEntries();
		fs.writeUploadChunk({
			dir: 'src',
			name: 'big.bin',
			id: 'dddddddd',
			offset: 0,
			bytes: Buffer.from('ab'),
			last: false
		});
		expect(allEntries()).toEqual(before);
		expect(fs.uploadStagingDir().startsWith(WS)).toBe(false);
	});

	it('clears a cut-short paste at server start', () => {
		const id = 'eeeeeeee';
		fs.writeUploadChunk({
			dir: 'src',
			name: 'big.bin',
			id,
			offset: 0,
			bytes: Buffer.from('ab'),
			last: false
		});
		fs.sweepStagedUploads();
		expect(stagedParts()).toEqual([]);
		expect(() =>
			fs.writeUploadChunk({
				dir: 'src',
				name: 'big.bin',
				id,
				offset: 2,
				bytes: Buffer.from('c'),
				last: true
			})
		).toThrow(/out of order/);
		expect(existsSync(join(WS, 'src/big.bin'))).toBe(false);
	});

	describe('staging root', () => {
		let TMP: string;
		const firstChunk = () =>
			fs.writeUploadChunk({
				dir: 'src',
				name: 'big.bin',
				id: 'jjjjjjjj',
				offset: 0,
				bytes: Buffer.from('ab'),
				last: false
			});

		beforeEach(() => {
			TMP = mkdtempSync(join(tmpdir(), 'cellar-file-paste-tmp-'));
			os.tmp = TMP;
		});
		afterEach(() => {
			os.tmp = null;
			rmSync(TMP, { recursive: true, force: true });
		});

		it.skipIf(process.getuid === undefined)('shares no folder with another user of the temp dir', () => {
			firstChunk();
			const [root, ...others] = readdirSync(TMP);
			expect(others).toEqual([]);
			expect(root.endsWith(`-${process.getuid!()}`)).toBe(true);
			expect(dirname(fs.uploadStagingDir())).toBe(join(TMP, root));
			for (const dir of [join(TMP, root), fs.uploadStagingDir()]) {
				expect(statSync(dir).mode & 0o777).toBe(0o700);
			}
			expect(statSync(join(fs.uploadStagingDir(), 'jjjjjjjj.part')).mode & 0o777).toBe(0o600);
		});

		it('clears the staged part at server start', () => {
			firstChunk();
			expect(stagedParts()).toEqual(['jjjjjjjj.part']);
			fs.sweepStagedUploads();
			expect(stagedParts()).toEqual([]);
		});

		it('refuses a staging root that someone else planted', () => {
			const elsewhere = mkdtempSync(join(tmpdir(), 'cellar-file-paste-planted-'));
			try {
				symlinkSync(elsewhere, dirname(fs.uploadStagingDir()));
				expect(firstChunk).toThrow(/not a folder owned by this user/);
				expect(readdirSync(elsewhere)).toEqual([]);
			} finally {
				rmSync(elsewhere, { recursive: true, force: true });
			}
		});
	});

	it('steps past a broken symlink that holds the name', () => {
		symlinkSync('no-such-target', join(WS, 'src/shot.png'));
		const res = fs.writeUploadChunk({
			dir: 'src',
			name: 'shot.png',
			id: 'ffffffff',
			offset: 0,
			bytes: Buffer.from('png'),
			last: true
		});
		expect(res).toEqual({ path: 'src/shot copy.png' });
		expect(readFileSync(join(WS, 'src/shot copy.png'), 'utf8')).toBe('png');
		expect(lstatSync(join(WS, 'src/shot.png')).isSymbolicLink()).toBe(true);
	});

	it('copies when a hard link is not possible, and never replaces a file made meanwhile', () => {
		link.crossDevice = (dest) => {
			if (!existsSync(dest)) writeFileSync(dest, 'made meanwhile');
			link.crossDevice = () => {};
		};
		const res = fs.writeUploadChunk({
			dir: 'src',
			name: 'report.txt',
			id: 'gggggggg',
			offset: 0,
			bytes: Buffer.from('pasted'),
			last: true
		});
		expect(res).toEqual({ path: 'src/report copy.txt' });
		expect(readFileSync(join(WS, 'src/report.txt'), 'utf8')).toBe('made meanwhile');
		expect(readFileSync(join(WS, 'src/report copy.txt'), 'utf8')).toBe('pasted');
		expect(stagedParts()).toEqual([]);
	});

	it('refuses a hidden destination folder', () => {
		mkdirSync(join(WS, '.venv/lib'), { recursive: true });
		mkdirSync(join(WS, 'src/.cache'), { recursive: true });
		for (const dir of ['.venv', '.venv/lib', 'src/.cache']) {
			expect(() =>
				fs.writeUploadChunk({
					dir,
					name: 'sitecustomize.py',
					id: 'hhhhhhhh',
					offset: 0,
					bytes: Buffer.from('x'),
					last: true
				})
			).toThrow(/hidden folders/);
		}
		expect(readdirSync(join(WS, '.venv/lib'))).toEqual([]);
		expect(readdirSync(join(WS, 'src/.cache'))).toEqual([]);
		expect(stagedParts()).toEqual([]);
	});

	describe('upload route', () => {
		const query = { dir: 'src', name: 'note.txt', id: 'iiiiiiii', offset: '0', last: '1' };
		const octet = { 'content-type': 'application/octet-stream' };

		it('writes a same-origin octet-stream paste', async () => {
			const res = await POST(send('POST', query, { ...octet, origin: 'http://localhost:4000' }, 'hi'));
			expect(await res.json()).toEqual({ ok: true, path: 'src/note.txt' });
			expect(readFileSync(join(WS, 'src/note.txt'), 'utf8')).toBe('hi');
		});

		it('writes when the client sends no Origin header', async () => {
			const res = await POST(send('POST', query, octet, 'hi'));
			expect(await res.json()).toEqual({ ok: true, path: 'src/note.txt' });
		});

		it('refuses a body a cross-site page can send without a preflight', async () => {
			for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'multipart/form-data' }]) {
				await expect(POST(send('POST', query, headers, 'hi'))).rejects.toMatchObject({ status: 415 });
			}
			expect(existsSync(join(WS, 'src/note.txt'))).toBe(false);
			expect(stagedParts()).toEqual([]);
		});

		it('refuses a paste from another origin', async () => {
			for (const origin of ['http://evil.example', 'http://localhost:4001', 'null']) {
				await expect(POST(send('POST', query, { ...octet, origin }, 'hi'))).rejects.toMatchObject({ status: 403 });
			}
			expect(existsSync(join(WS, 'src/note.txt'))).toBe(false);
			expect(stagedParts()).toEqual([]);
		});

		it('refuses a hidden destination folder', async () => {
			mkdirSync(join(WS, '.venv'));
			await expect(POST(send('POST', { ...query, dir: '.venv' }, octet, 'hi'))).rejects.toMatchObject({
				status: 400,
				body: { message: expect.stringMatching(/hidden folders/) }
			});
			expect(readdirSync(join(WS, '.venv'))).toEqual([]);
		});

		it('aborts only for its own origin', async () => {
			await POST(send('POST', { ...query, last: '0' }, octet, 'hi'));
			expect(stagedParts()).toEqual(['iiiiiiii.part']);
			expect(() => DELETE(send('DELETE', { id: 'iiiiiiii' }, { origin: 'http://evil.example' }))).toThrow(
				expect.objectContaining({ status: 403 })
			);
			expect(stagedParts()).toEqual(['iiiiiiii.part']);
			DELETE(send('DELETE', { id: 'iiiiiiii' }, { origin: 'http://localhost:4000' }));
			expect(stagedParts()).toEqual([]);
		});
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
