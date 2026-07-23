import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { IMG_MAX_EDGE } from '../../src/lib/server/mcp/image';

/**
 * Token diet: downscale high-DPI plot images on the DEFAULT read path.
 *
 * A retina/high-DPI figure (~1600×1200) costs ~1,600 image tokens as an MCP
 * image block. Downscaling it to ~768px on the longest edge before it becomes the
 * block cuts that to ~590 WITHOUT losing capability: `get_full_output(size:'full')`
 * still hands back the original raster, and the non-image read paths still tell
 * the agent an image is there (enriched placeholder with dimensions + bytes).
 *
 * The pure image helpers are tested directly; the default-vs-full contract is
 * driven through the real service + notebook singletons against a scratch
 * workspace (an image output injected straight onto a cell, so nothing touches
 * the kernel).
 */

// A deterministic RGBA PNG of the given size, base64-encoded (a diagonal gradient
// so the resample has real content to average, not a flat fill).
function makePngB64(w: number, h: number): string {
	const png = new PNG({ width: w, height: h });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			png.data[i] = (x * 255) / w;
			png.data[i + 1] = (y * 255) / h;
			png.data[i + 2] = 128;
			png.data[i + 3] = 255;
		}
	}
	return PNG.sync.write(png).toString('base64');
}

const dimsOf = (b64: string) => {
	const p = PNG.sync.read(Buffer.from(b64, 'base64'));
	return { width: p.width, height: p.height };
};

describe('image module', () => {
	let img: typeof import('../../src/lib/server/mcp/image');
	beforeAll(async () => {
		img = await import('../../src/lib/server/mcp/image');
	});

	it('downscales a PNG whose longest side exceeds the threshold to that edge (aspect preserved)', () => {
		const b64 = makePngB64(1600, 1200);
		const r = img.downscaleImageForBlock('image/png', b64, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(true);
		expect(r.width).toBe(1600);
		expect(r.height).toBe(1200);
		const d = dimsOf(r.data);
		expect(Math.max(d.width, d.height)).toBe(img.IMG_MAX_EDGE); // 768 on the long edge
		expect(d.width).toBe(768);
		expect(d.height).toBe(576); // 1200 * 768/1600, aspect preserved
		expect(r.data).not.toBe(b64); // re-encoded, smaller
		expect(img.base64Bytes(r.data)).toBeLessThan(img.base64Bytes(b64));
	});

	it('downscales a portrait image on its true longest edge (height)', () => {
		const b64 = makePngB64(1000, 2000);
		const r = img.downscaleImageForBlock('image/png', b64, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(true);
		const d = dimsOf(r.data);
		expect(d.height).toBe(768);
		expect(d.width).toBe(384);
	});

	it('leaves a small image byte-for-byte untouched', () => {
		const b64 = makePngB64(640, 480);
		const r = img.downscaleImageForBlock('image/png', b64, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(false);
		expect(r.data).toBe(b64); // identical bytes, no re-encode
		expect(dimsOf(r.data)).toEqual({ width: 640, height: 480 });
	});

	it('passes a non-PNG image through untouched (only PNG is downscaled)', () => {
		const fake = Buffer.from('not really a jpeg but big').toString('base64');
		const r = img.downscaleImageForBlock('image/jpeg', fake, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(false);
		expect(r.data).toBe(fake);
	});

	it('returns the original, undamaged, when the PNG cannot be decoded', () => {
		const junk = Buffer.from('\x89PNG\r\n\x1a\n corrupt tail').toString('base64');
		const r = img.downscaleImageForBlock('image/png', junk, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(false);
		expect(r.data).toBe(junk);
	});

	it('reads PNG dimensions from the header', () => {
		expect(img.imageDimensions('image/png', makePngB64(320, 240))).toEqual({ width: 320, height: 240 });
	});

	it('builds an enriched placeholder with mime + dimensions + bytes', () => {
		const b64 = makePngB64(1600, 1200);
		const p = img.imagePlaceholder('image/png', b64);
		expect(p).toMatch(/^\[image\/png, 1600×1200, \d+ (B|KB|MB)\]$/);
	});

	it('formats bytes readably', () => {
		expect(img.formatBytes(812)).toBe('812 B');
		expect(img.formatBytes(46 * 1024)).toBe('46 KB');
		expect(img.formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
	});
});

describe('get_full_output default-vs-full image contract', () => {
	let WS: string;
	let svc: typeof import('../../src/lib/server/mcp/service');
	let nbmod: typeof import('../../src/lib/server/notebook');

	beforeAll(async () => {
		WS = mkdtempSync(join(tmpdir(), 'cellar-img-'));
		process.env.CELLAR_WORKSPACE = WS;
		svc = await import('../../src/lib/server/mcp/service');
		nbmod = await import('../../src/lib/server/notebook');
	});

	it('medium downscales the image block; full returns the original bytes; placeholder is enriched', async () => {
		const NB = 'plot.ipynb';
		svc.useNotebook('imgSess', NB); // open-or-create so the doc exists on disk
		const nb = nbmod.resolveNotebookPath(NB);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'fig' }], null, { nb, routeImports: false });
		// addCells emits a short handle; setOutputs below is a UUID-keyed notebook op,
		// so resolve to the full id (getFullOutput accepts either).
		const id = svc.resolveRef(nb, ids[0]);

		const bigB64 = makePngB64(1600, 1200);
		nbmod.setOutputs(id, [{ output_type: 'display_data', data: { 'image/png': bigB64 }, metadata: {} }], nb);

		// Default (medium): the image ships in `images` (the transport turns it into a
		// real MCP image block), downscaled to the threshold, carrying a
		// downscaled:{from,to} note so the agent knows it can fetch more. It names the
		// output it came from, and that output still carries its text placeholder.
		const med = svc.getFullOutput(id, 'medium', nb)!;
		const medImg = med.images![0];
		expect(medImg.output_index).toBe(0);
		expect(medImg.mime).toBe('image/png');
		expect(Math.max(dimsOf(medImg.data).width, dimsOf(medImg.data).height)).toBe(IMG_MAX_EDGE);
		expect(medImg.downscaled).toEqual(expect.objectContaining({ from: '1600×1200', to: '768×576' }));
		expect((med.outputs[0] as { text?: string }).text).toMatch(/^\[image\/png, 1600×1200, /);

		// Full: the ORIGINAL raster, byte-for-byte, no downscale note.
		const full = svc.getFullOutput(id, 'full', nb)!;
		const fullImg = full.images![0];
		expect(fullImg.data).toBe(bigB64);
		expect(dimsOf(fullImg.data)).toEqual({ width: 1600, height: 1200 });
		expect(fullImg.downscaled).toBeUndefined();

		// A non-image read path shows the enriched, image-token-free placeholder.
		const read = await svc.readCell(id, nb);
		const out = read!.outputs[0] as { image?: string; text?: string };
		expect(out.image).toBe('image/png');
		expect(out.text).toMatch(/^\[image\/png, 1600×1200, \d+ (B|KB|MB)\]$/);
	});
});
