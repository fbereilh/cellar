import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { IMG_MAX_EDGE, MAX_FULL_OUTPUT_IMAGE_BLOCKS, MAX_IMAGE_BLOCKS } from '../../src/lib/server/mcp/image';

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

/**
 * A JPEG whose SOF0 sits behind `padSegments` maximum-size APPn segments - the
 * knob for pushing the frame header past the bounded read window (each segment is
 * ~64 KB, an EXIF/thumbnail block's real size).
 */
function jpegWithPaddedHeader(padSegments: number, w: number, h: number): string {
	const SEG = 65533;
	const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
	for (let i = 0; i < padSegments; i++) {
		const seg = Buffer.alloc(2 + SEG);
		seg[0] = 0xff;
		seg[1] = 0xe1; // APP1
		seg.writeUInt16BE(SEG, 2);
		parts.push(seg);
	}
	const sof = Buffer.alloc(11);
	sof[0] = 0xff;
	sof[1] = 0xc0; // SOF0
	sof.writeUInt16BE(9, 2);
	sof[4] = 8; // precision
	sof.writeUInt16BE(h, 5);
	sof.writeUInt16BE(w, 7);
	parts.push(sof);
	return Buffer.concat(parts).toString('base64');
}

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

	it('declines to decode a raster past the pixel bound (pngjs would allocate w*h*4 up front)', () => {
		// Header-only fixture: 30000×30000 claimed, no pixels behind it. Building a
		// real one would allocate the 3.6 GB the bound exists to refuse.
		const buf = Buffer.alloc(32);
		buf.writeUInt32BE(0x89504e47, 0);
		buf.writeUInt32BE(0x0d0a1a0a, 4);
		buf.write('IHDR', 12, 'ascii');
		buf.writeUInt32BE(30000, 16);
		buf.writeUInt32BE(30000, 20);
		const huge = buf.toString('base64');
		expect(img.exceedsDecodeBound('image/png', huge)).toBe(true);
		const r = img.downscaleImageForBlock('image/png', huge, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(false);
		expect(r.data).toBe(huge); // untouched, never decoded
	});

	it('bounds the decode on TOTAL PIXELS, not on one long edge — a tall figure is decoded and shrunk', () => {
		// w*h*4 is the allocation, so it is the whole risk. A 30×9000 stacked-subplot
		// plot is over the host's per-edge ship ceiling but ~0.3 MP, and refusing it
		// pre-decode would return a placeholder for a figure that downscales fine.
		const tall = makePngB64(30, 9000);
		expect(Math.max(30, 9000)).toBeGreaterThan(img.MAX_IMAGE_EDGE_HARD);
		expect(img.exceedsDecodeBound('image/png', tall)).toBe(false);
		const r = img.downscaleImageForBlock('image/png', tall, img.IMG_MAX_EDGE);
		expect(r.resized).toBe(true);
		expect(dimsOf(r.data).height).toBe(img.IMG_MAX_EDGE);
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

	it('reads dimensions from a bounded PREFIX, never by decoding the whole raster', () => {
		// The header check runs for every image of every result, so decoding megabytes
		// to read a 24-byte header is the cost this avoids. A PNG truncated to its
		// first few hundred base64 chars still yields its dimensions: the prefix is all
		// that is consulted.
		const b64 = makePngB64(1600, 1200);
		expect(img.imageDimensions('image/png', b64.slice(0, 200))).toEqual({ width: 1600, height: 1200 });

		// And the window is genuinely BOUNDED, not merely sufficient - JPEG is the case
		// that can prove it, since its SOF sits after however many APPn segments the
		// encoder wrote. Inside the window the dimensions are found; a SOF pushed past
		// it reads as unknown (the same graceful degrade as any unparseable header)
		// rather than dragging the whole payload through the decoder.
		expect(img.imageDimensions('image/jpeg', jpegWithPaddedHeader(2, 800, 600))).toEqual({ width: 800, height: 600 });
		expect(img.imageDimensions('image/jpeg', jpegWithPaddedHeader(6, 800, 600))).toBeNull();

		// nbformat stores a raster as lines, so the payload can arrive with newlines in
		// it; the prefix decode and the byte count must both discount them.
		const wrapped = (b64.match(/.{1,76}/g) || []).join('\n');
		expect(img.imageDimensions('image/png', wrapped)).toEqual({ width: 1600, height: 1200 });
		expect(img.base64Bytes(wrapped)).toBe(img.base64Bytes(b64));
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

	it('picks the viewable rasterization when one bundle carries several (png + svg)', async () => {
		// matplotlib with figure_formats={'png','svg'} emits BOTH for one figure. Taking
		// the first image/* key can land on the svg, which the block policy correctly
		// declines — leaving the agent with no picture while a viewable PNG sits in the
		// same output.
		const NB = 'png-and-svg.ipynb';
		svc.useNotebook('imgSessMulti', NB);
		const nb = nbmod.resolveNotebookPath(NB);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'fig' }], null, { nb, routeImports: false });
		const id = svc.resolveRef(nb, ids[0]);

		const png = makePngB64(120, 90);
		nbmod.setOutputs(id, [{ output_type: 'display_data', data: { 'image/svg+xml': Buffer.from('<svg/>').toString('base64'), 'image/png': png }, metadata: {} }], nb);

		const res = svc.getFullOutput(id, 'medium', nb)!;
		expect(res.images_omitted).toBeUndefined();
		expect(res.images![0]).toEqual(expect.objectContaining({ output_index: 0, mime: 'image/png', data: png }));
		// The placeholder names the SAME mime, so images[i] and outputs[i] cannot disagree.
		expect((res.outputs[0] as { image?: string }).image).toBe('image/png');
	});

	it('returns EVERY figure of the cell — the per-result cap bounds a run, not this explicit request', async () => {
		const NB = 'many-plots.ipynb';
		svc.useNotebook('imgSessMany', NB);
		const nb = nbmod.resolveNotebookPath(NB);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'figs' }], null, { nb, routeImports: false });
		const id = svc.resolveRef(nb, ids[0]);

		const COUNT = MAX_IMAGE_BLOCKS + 2;
		nbmod.setOutputs(
			id,
			Array.from({ length: COUNT }, () => ({ output_type: 'display_data', data: { 'image/png': makePngB64(40, 30) }, metadata: {} })),
			nb
		);

		// This is the route the run path's `limit` omission names; stopping at four
		// here would leave the 5th figure unreachable by any tool.
		const res = svc.getFullOutput(id, 'medium', nb)!;
		expect(res.images).toHaveLength(COUNT);
		expect(res.images!.map((i) => i.output_index)).toEqual([...Array(COUNT).keys()]);
		expect(res.images_omitted).toBeUndefined();
	});

	it('pages past its own bound with images_from, so a figure is never unreachable', async () => {
		// The explicit path is larger than a run result's but still FINITE (each image
		// costs a synchronous decode+resample on the shared event loop). What that
		// bound leaves out has to be fetchable, or the omission note is a promise
		// nothing keeps.
		const NB = 'loop-plots.ipynb';
		svc.useNotebook('imgSessPaged', NB);
		const nb = nbmod.resolveNotebookPath(NB);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'for i in range(n): plot(i)' }], null, { nb, routeImports: false });
		const id = svc.resolveRef(nb, ids[0]);

		const COUNT = MAX_FULL_OUTPUT_IMAGE_BLOCKS + 2;
		nbmod.setOutputs(
			id,
			Array.from({ length: COUNT }, () => ({ output_type: 'display_data', data: { 'image/png': makePngB64(40, 30) }, metadata: {} })),
			nb
		);

		const first = svc.getFullOutput(id, 'medium', nb)!;
		expect(first.images).toHaveLength(MAX_FULL_OUTPUT_IMAGE_BLOCKS);
		expect(first.images_omitted).toHaveLength(2);
		expect(first.images_omitted![0].note).toMatch(new RegExp(`images_from: ${MAX_FULL_OUTPUT_IMAGE_BLOCKS}`));

		// Following that note really does return the ones that did not fit.
		const rest = svc.getFullOutput(id, 'medium', nb, MAX_FULL_OUTPUT_IMAGE_BLOCKS)!;
		expect(rest.images!.map((i) => i.output_index)).toEqual([MAX_FULL_OUTPUT_IMAGE_BLOCKS, MAX_FULL_OUTPUT_IMAGE_BLOCKS + 1]);
		expect(rest.images_omitted).toBeUndefined();
	});

	it('joins a multiline (string[]) raster instead of comma-joining it into corrupt base64', async () => {
		// nbformat stores an image as an ARRAY of lines, and deserialize copies outputs
		// through verbatim - so an externally-authored .ipynb reaches here as string[].
		// String(['ab','cd']) is 'ab,cd': base64 with commas in it, which a strict host
		// validator rejects, failing the ENTIRE tool result.
		const NB = 'multiline-image.ipynb';
		svc.useNotebook('imgSessLines', NB);
		const nb = nbmod.resolveNotebookPath(NB);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'fig' }], null, { nb, routeImports: false });
		const id = svc.resolveRef(nb, ids[0]);

		const b64 = makePngB64(320, 240);
		const lines = b64.match(/.{1,64}/g)!;
		nbmod.setOutputs(id, [{ output_type: 'display_data', data: { 'image/png': lines }, metadata: {} }], nb);

		const res = svc.getFullOutput(id, 'full', nb)!;
		expect(res.images![0].data).toBe(b64);
		expect(res.images![0].data).not.toContain(',');
		expect(dimsOf(res.images![0].data)).toEqual({ width: 320, height: 240 });
		// The placeholder is built from the same joined payload, so its size and
		// dimensions describe the real raster rather than a comma-joined string.
		expect((res.outputs[0] as { text?: string }).text).toMatch(/^\[image\/png, 320×240, /);
	});
});
