/**
 * Image tabs — the shared path identity/content-type helper and the raw-bytes
 * route (`/api/fs/raw`).
 *
 * The helper is the single source of truth for "does the shell open this in an
 * image tab" and "what Content-Type does the route serve it as". The route
 * serves raw bytes with that type, workspace-guarded — a traversal must be
 * rejected before any read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isImagePath, imageContentType, IMAGE_CONTENT_TYPES } from '../../src/lib/imagePath';

describe('isImagePath / imageContentType', () => {
	it('recognizes every supported image extension (case-insensitive)', () => {
		for (const ext of Object.keys(IMAGE_CONTENT_TYPES)) {
			expect(isImagePath(`a.${ext}`)).toBe(true);
			expect(isImagePath(`A.${ext.toUpperCase()}`)).toBe(true);
			expect(isImagePath(`dir/sub/photo.${ext}`)).toBe(true);
		}
	});

	it('maps each extension to the right Content-Type', () => {
		expect(imageContentType('x.png')).toBe('image/png');
		expect(imageContentType('x.jpg')).toBe('image/jpeg');
		expect(imageContentType('x.jpeg')).toBe('image/jpeg');
		expect(imageContentType('x.gif')).toBe('image/gif');
		expect(imageContentType('x.webp')).toBe('image/webp');
		expect(imageContentType('x.svg')).toBe('image/svg+xml');
		expect(imageContentType('x.bmp')).toBe('image/bmp');
		expect(imageContentType('x.ico')).toBe('image/x-icon');
		expect(imageContentType('x.avif')).toBe('image/avif');
		expect(imageContentType('X.PNG')).toBe('image/png');
	});

	it('rejects non-image and extension-less paths', () => {
		for (const p of ['a.py', 'a.txt', 'a.ipynb', 'notes.md', 'README', 'archive.tar.gz', '.gitignore']) {
			expect(isImagePath(p)).toBe(false);
			expect(imageContentType(p)).toBeNull();
		}
	});
});

describe('/api/fs/raw route', () => {
	let dir: string;
	// The route's GET; called with just { url } (the only field it reads).
	let GET: (evt: { url: URL }) => Response;
	const PNG = Buffer.from(
		'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f2f0000000049454e44ae426082',
		'hex'
	);

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-raw-'));
		process.env.CELLAR_WORKSPACE = dir;
		writeFileSync(join(dir, 'pixel.png'), PNG);
		writeFileSync(join(dir, 'note.txt'), 'hello');
		mkdirSync(join(dir, 'sub'));
		writeFileSync(join(dir, 'sub', 'vec.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
		// Import after the workspace env is set (fstree reads it at call time, but
		// import order shouldn't matter either). The route's GET has a full
		// RequestEvent signature; narrow it to the one field the handler reads.
		const mod = await import('../../src/routes/api/fs/raw/+server.js');
		GET = mod.GET as unknown as (evt: { url: URL }) => Response;
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.CELLAR_WORKSPACE;
	});

	function call(path: string | null): Response {
		const url = new URL('http://x/api/fs/raw');
		if (path != null) url.searchParams.set('path', path);
		return GET({ url });
	}
	// @sveltejs/kit's error() throws an HttpError { status, body: { message } };
	// capture it so we can assert on status + message.
	function callErr(path: string | null): { status: number; message: string } {
		try {
			call(path);
		} catch (e) {
			const err = e as { status: number; body?: { message?: string } };
			return { status: err.status, message: err.body?.message ?? '' };
		}
		throw new Error('expected the route to throw');
	}

	it('serves PNG bytes with image/png + Content-Length', async () => {
		const res = call('pixel.png');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.headers.get('Content-Length')).toBe(String(PNG.length));
		expect(res.headers.get('Cache-Control')).toBe('no-cache');
		const body = Buffer.from(await res.arrayBuffer());
		expect(body.equals(PNG)).toBe(true);
	});

	it('serves nested SVG with image/svg+xml', () => {
		const res = call('sub/vec.svg');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
	});

	it('rejects a workspace-escape traversal (even with an image extension)', () => {
		const { status, message } = callErr('../../../etc/passwd.png');
		expect(status).toBe(400);
		expect(message).toMatch(/escapes workspace/);
	});

	it('rejects a non-image extension', () => {
		const { status, message } = callErr('note.txt');
		expect(status).toBe(400);
		expect(message).toMatch(/not an image/);
	});

	it('404s a missing image file', () => {
		const { status, message } = callErr('nope.png');
		expect(status).toBe(404);
		expect(message).toMatch(/not found/);
	});

	it('400s a missing path param', () => {
		const { status, message } = callErr(null);
		expect(status).toBe(400);
		expect(message).toMatch(/path required/);
	});
});
