import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { base64Bytes, buildImageBlocks, canInlineImage, IMG_MAX_EDGE, MAX_DECODE_PIXELS, MAX_FULL_OUTPUT_IMAGE_BLOCKS, MAX_IMAGE_BLOCKS, MAX_IMAGE_EDGE_HARD } from '../../src/lib/server/mcp/image';
import type { ImageOutputRef } from '../../src/lib/server/mcp/image';
import { textWithImages } from '../../src/lib/server/mcp/server';

/**
 * The agent must SEE the figures its cells draw.
 *
 * Before this, every MCP path returned `[image/png, 978×536, 44 KB]` — a text
 * placeholder — so an agent authoring plots was blind to its own charts and had
 * to savefig to a scratch file, read the PNG, and delete the cell just to look at
 * what it had drawn. Now a run result carries the rendered image as a real MCP
 * image content block.
 *
 * Two halves, tested here; the whole loop (matplotlib → add_and_run → an image
 * block over the real wire) is `tests/e2e/mcp-agent-sees-figures.spec.ts`:
 *
 *  - the POLICY (`buildImageBlocks`), which is the single cost bound: what may
 *    ship as an image at all, at what size, and how many per result. Its refusals
 *    matter as much as its acceptances — an `image/svg+xml` block would be
 *    REJECTED by the host and fail the entire tool call it rode in, so declining
 *    to inline is what keeps an svg figure from breaking the run that drew it.
 *  - the TRANSPORT (`textWithImages`), which lifts the base64 out of the JSON
 *    text into image blocks, so a raster is never billed twice.
 */

/** A deterministic RGBA PNG of the given size, base64-encoded. */
function makePngB64(w: number, h: number, seed = 0): string {
	const png = new PNG({ width: w, height: h });
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			png.data[i] = (x + seed) % 256;
			png.data[i + 1] = (y * 3) % 256;
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

const ref = (output_index: number, mime: string, b64: string): ImageOutputRef => ({ output_index, mime, b64 });

/**
 * A PNG signature + IHDR claiming `w×h`, with no image data behind it — the shape
 * of the attack the pixel bound exists for. Decoding one really is a
 * width*height*4 allocation, so the policy must refuse it from the HEADER; a
 * fixture that actually contained 49 MP would take the test to allocate what the
 * test is asserting we never allocate.
 */
function fakePngHeader(w: number, h: number): string {
	const buf = Buffer.alloc(32);
	buf.writeUInt32BE(0x89504e47, 0);
	buf.writeUInt32BE(0x0d0a1a0a, 4);
	buf.write('IHDR', 12, 'ascii');
	buf.writeUInt32BE(w, 16);
	buf.writeUInt32BE(h, 20);
	return buf.toString('base64');
}

/** A GIF header claiming `w×h` — a non-PNG, i.e. one the policy cannot resample. */
function gifHeader(w: number, h: number): string {
	const buf = Buffer.alloc(13);
	buf.write('GIF89a', 0, 'ascii');
	buf.writeUInt16LE(w, 6);
	buf.writeUInt16LE(h, 8);
	return buf.toString('base64');
}

describe('image block policy', () => {
	it('ships a PNG figure as an image block, downscaled, naming the output it came from', () => {
		const { images, omitted } = buildImageBlocks([ref(2, 'image/png', makePngB64(1600, 1200))]);
		expect(omitted).toEqual([]);
		expect(images).toHaveLength(1);
		expect(images[0].mime).toBe('image/png');
		// The index is the agent's link back to `outputs[2]`, whose text placeholder
		// says which output the picture belongs to.
		expect(images[0].output_index).toBe(2);
		expect(Math.max(dimsOf(images[0].data).width, dimsOf(images[0].data).height)).toBe(IMG_MAX_EDGE);
		expect(images[0].downscaled).toEqual(expect.objectContaining({ from: '1600×1200', to: '768×576' }));
	});

	it('leaves an already-small figure byte-for-byte alone (no re-encode, no note)', () => {
		const b64 = makePngB64(400, 300);
		const { images } = buildImageBlocks([ref(0, 'image/png', b64)]);
		expect(images[0].data).toBe(b64);
		expect(images[0].downscaled).toBeUndefined();
	});

	it('does NOT inline svg — the host rejects it, which would fail the whole tool call', () => {
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
		const { images, omitted } = buildImageBlocks([ref(0, 'image/svg+xml', svg)]);
		expect(images).toEqual([]);
		expect(omitted).toEqual([expect.objectContaining({ output_index: 0, mime: 'image/svg+xml', reason: 'unsupported_mime' })]);
	});

	it('passes a JPEG/GIF through as an image block (only PNG is resampled)', () => {
		const jpeg = Buffer.from('fake jpeg bytes').toString('base64');
		const { images, omitted } = buildImageBlocks([ref(0, 'image/jpeg', jpeg)]);
		expect(omitted).toEqual([]);
		expect(images[0]).toEqual(expect.objectContaining({ mime: 'image/jpeg', data: jpeg }));
	});

	it('caps the images per result and REPORTS the rest rather than dropping them silently', () => {
		const many = Array.from({ length: MAX_IMAGE_BLOCKS + 3 }, (_, i) => ref(i, 'image/png', makePngB64(60, 40, i)));
		const { images, omitted } = buildImageBlocks(many);
		expect(images).toHaveLength(MAX_IMAGE_BLOCKS);
		expect(images.map((i) => i.output_index)).toEqual([0, 1, 2, 3]);
		// ONE entry for the whole run, not one per figure: the cap is a single bound
		// hit once, so a note per declined image is repetition, not information.
		expect(omitted).toHaveLength(1);
		expect(omitted[0]).toEqual(expect.objectContaining({ output_index: MAX_IMAGE_BLOCKS, reason: 'limit', count: 3 }));
		// Nothing is declined silently even so: the entry says HOW MANY did not fit,
		// and the route to them is named AND resumable - it points at the very output
		// that was declined first, so the cap costs no capability.
		expect(omitted[0].note).toMatch(/3 further images were not included/);
		expect(omitted[0].note).toMatch(/get_full_output\(id, images_from: 4\)/);
	});

	it('collapses the flood a loop-plotting cell would otherwise produce, at constant cost', () => {
		// 60 figures in a loop is ordinary. Per-image notes made the omission text
		// ~8 KB on the exact path the 4-cap exists to keep cheap, and because paging
		// with images_from re-emits the shrinking tail on every call, the text over a
		// full page-through was quadratic in the number of figures.
		const many = Array.from({ length: 60 }, (_, i) => ref(i, 'image/png', makePngB64(20, 20, i)));
		const { images, omitted } = buildImageBlocks(many);
		expect(images).toHaveLength(MAX_IMAGE_BLOCKS);
		expect(omitted).toHaveLength(1);
		expect(omitted[0].count).toBe(60 - MAX_IMAGE_BLOCKS);
		expect(JSON.stringify(omitted).length).toBeLessThan(400);

		// A SPECIFIC reason names a specific figure and a specific cause, so it is
		// never merged into a run - and it also breaks one, since the images either
		// side of it were declined for unrelated reasons.
		const mixed = buildImageBlocks([ref(0, 'image/png', makePngB64(20, 20)), ref(1, 'image/png', makePngB64(20, 20, 1)), ref(2, 'image/svg+xml', Buffer.from('<svg/>').toString('base64')), ref(3, 'image/png', makePngB64(20, 20, 3))], { limit: 1 });
		expect(mixed.omitted.map((o) => [o.reason, o.output_index, o.count])).toEqual([
			['limit', 1, undefined],
			['unsupported_mime', 2, undefined],
			['limit', 3, undefined]
		]);
	});

	it('gives an EXPLICIT per-cell request a far larger cap, so the run result\'s omission note is a real route', () => {
		// The 4-cap bounds an AUTOMATIC run result, where the agent never asked to pay
		// for figures. get_full_output(id) is the explicit request the omission note
		// points at, so it must reach well past the 5th figure.
		const many = Array.from({ length: MAX_IMAGE_BLOCKS + 3 }, (_, i) => ref(i, 'image/png', makePngB64(60, 40, i)));
		const { images, omitted } = buildImageBlocks(many, { limit: MAX_FULL_OUTPUT_IMAGE_BLOCKS });
		expect(images).toHaveLength(MAX_IMAGE_BLOCKS + 3);
		expect(omitted).toEqual([]);
		expect(MAX_FULL_OUTPUT_IMAGE_BLOCKS).toBeGreaterThan(MAX_IMAGE_BLOCKS);
	});

	it('stays FINITE even there, and pages the remainder rather than stalling on a hundred-figure cell', () => {
		// Uncapping this path would leave it with no aggregate bound at all: each image
		// over IMG_MAX_EDGE is a synchronous decode + resample + re-encode on the same
		// event loop that streams SSE frames and services every other kernel and MCP
		// session, so a cell that plotted in a loop would stall the whole process.
		const many = Array.from({ length: MAX_FULL_OUTPUT_IMAGE_BLOCKS + 2 }, (_, i) => ref(i, 'image/png', makePngB64(20, 20, i)));
		const { images, omitted } = buildImageBlocks(many, { limit: MAX_FULL_OUTPUT_IMAGE_BLOCKS });
		expect(images).toHaveLength(MAX_FULL_OUTPUT_IMAGE_BLOCKS);
		expect(omitted.map((o) => o.output_index)).toEqual([MAX_FULL_OUTPUT_IMAGE_BLOCKS]);
		expect(omitted[0].count).toBe(2);
		expect(omitted[0].note).toMatch(new RegExp(`images_from: ${MAX_FULL_OUTPUT_IMAGE_BLOCKS}`));
	});

	it('stops on the aggregate BYTE budget, reporting where to resume - one result never returns unbounded raster', () => {
		const b64 = makePngB64(200, 150);
		const bytes = base64Bytes(b64);
		const many = Array.from({ length: 5 }, (_, i) => ref(i, 'image/png', b64));
		// Room for two, not five.
		const { images, omitted } = buildImageBlocks(many, { limit: 100, maxTotalBytes: bytes * 2 + 1 });
		expect(images).toHaveLength(2);
		expect(omitted).toHaveLength(1);
		expect(omitted[0]).toEqual(expect.objectContaining({ output_index: 2, reason: 'budget', count: 3 }));
		expect(omitted[0].note).toMatch(/get_full_output\(id, images_from: 2\)/);
	});

	it('stops on the aggregate DECODE budget - the CPU spent resampling is bounded per result, not just the bytes returned', () => {
		// A downscaled output is small however big its source was, so a byte budget
		// alone cannot bound the decode cost. This charges the SOURCE pixels.
		const big = makePngB64(1000, 900); // 0.9 MP, over IMG_MAX_EDGE ⇒ really decoded
		const many = Array.from({ length: 4 }, (_, i) => ref(i, 'image/png', big));
		const { images, omitted } = buildImageBlocks(many, { limit: 100, maxDecodePixels: 1000 * 900 * 2 });
		expect(images).toHaveLength(2);
		expect(omitted.every((o) => o.reason === 'budget')).toBe(true);
		expect(omitted[0].output_index).toBe(2);

		// A small image costs no decode, so it is never charged against that budget.
		const small = Array.from({ length: 4 }, (_, i) => ref(i, 'image/png', makePngB64(40, 30, i)));
		expect(buildImageBlocks(small, { limit: 100, maxDecodePixels: 1 }).images).toHaveLength(4);
	});

	it('will not START an unpredictable decode once the budget is gone', () => {
		// A header that would not parse hides its decode cost until pngjs has read the
		// raster, so it cannot be pre-charged. Refusing to begin one on a spent budget
		// is what bounds the overshoot to a single image rather than letting a run of
		// unreadable headers decode without limit.
		const junk = Buffer.from('\x89PNG\r\n\x1a\n corrupt tail').toString('base64');
		const { images, omitted } = buildImageBlocks([ref(0, 'image/png', junk)], { maxDecodePixels: 0 });
		expect(images).toEqual([]);
		expect(omitted).toEqual([expect.objectContaining({ output_index: 0, reason: 'budget' })]);
	});

	it('reports the pixel size on every block, not only the ones a downscale happened to decode', () => {
		// width/height used to be a side effect of the downscale decode, so a `full`
		// block and every JPEG/GIF block carried none while a downscaled one did - an
		// avoidable gap, since the header dimensions are already parsed and in scope.
		const b64 = makePngB64(1600, 1200);
		expect(buildImageBlocks([ref(0, 'image/png', b64)], { full: true }).images[0]).toEqual(expect.objectContaining({ width: 1600, height: 1200 }));
		expect(buildImageBlocks([ref(0, 'image/gif', gifHeader(600, 400))]).images[0]).toEqual(expect.objectContaining({ width: 600, height: 400 }));
		// An unreadable header simply has none to report - never a bogus size.
		const opaque = Buffer.from('fake jpeg bytes').toString('base64');
		expect(buildImageBlocks([ref(0, 'image/jpeg', opaque)]).images[0].width).toBeUndefined();
	});

	it('emits the REGISTERED jpeg mime for an `image/jpg` bundle key, which a host would otherwise reject', () => {
		// image/jpg is an unregistered spelling: a block carrying it fails the WHOLE
		// tool result, the exact failure the allowlist exists to prevent. Such an
		// output is still shown — only the emitted type is corrected.
		const jpeg = Buffer.from('fake jpeg bytes').toString('base64');
		const { images, omitted } = buildImageBlocks([ref(0, 'image/jpg', jpeg)]);
		expect(omitted).toEqual([]);
		expect(images[0]).toEqual(expect.objectContaining({ mime: 'image/jpeg', data: jpeg }));
	});

	it('refuses a raster past the pixel bound WITHOUT decoding it (an OOM would kill the whole server)', () => {
		// 7000×7000 = 49 MP: past MAX_DECODE_PIXELS but with both edges UNDER the
		// host's 8000px ceiling — so only a pre-decode bound can catch it. Decoding
		// would ask pngjs for ~196 MB of RGBA (and a real 30000×30000 typo, for
		// gigabytes) inside the request that just ran the cell, and an OOM takes down
		// every kernel websocket, SSE stream and agent session in the process.
		expect(7000 * 7000).toBeGreaterThan(MAX_DECODE_PIXELS);
		const { images, omitted } = buildImageBlocks([ref(3, 'image/png', fakePngHeader(7000, 7000))]);
		expect(images).toEqual([]);
		expect(omitted).toEqual([expect.objectContaining({ output_index: 3, reason: 'too_large' })]);
	});

	it('SHIPS a tall figure whose long edge is over the host ceiling but whose pixels are not — it downscales to fit', () => {
		// A stacked-subplot / FacetGrid plot (plt.subplots(30,1,figsize=(8,60),dpi=150))
		// is ~1200×9000: past MAX_IMAGE_EDGE_HARD on one edge, but ~11 MP, far under the
		// decode bound. The decode is what w*h*4 makes dangerous, and this one is cheap;
		// refusing it pre-decode would hand back a placeholder for a figure that
		// downscales to 768px and ships fine. The edge ceiling belongs on the raster we
		// EMIT, which withinHostLimits already enforces.
		const b64 = makePngB64(30, 9000); // same aspect problem, ~0.3 MP to build
		expect(30 * 9000).toBeLessThan(MAX_DECODE_PIXELS);
		expect(9000).toBeGreaterThan(MAX_IMAGE_EDGE_HARD);

		const { images, omitted } = buildImageBlocks([ref(0, 'image/png', b64)]);
		expect(omitted).toEqual([]);
		expect(dimsOf(images[0].data).height).toBe(IMG_MAX_EDGE);
		expect(images[0].downscaled).toEqual(expect.objectContaining({ from: '30×9000' }));

		// Even asked for at full resolution it degrades to that downscaled copy — the
		// ship ceiling is enforced on the emitted raster — never to nothing.
		const full = buildImageBlocks([ref(0, 'image/png', b64)], { full: true });
		expect(full.omitted).toEqual([]);
		expect(dimsOf(full.images[0].data).height).toBe(IMG_MAX_EDGE);

		// And the batch flag agrees: has_image must not promise a figure the policy declines.
		expect(canInlineImage('image/png', b64)).toBe(true);
	});

	it('canInlineImage declines exactly what the policy declines, from the header alone', () => {
		// The batch path never decodes (see runCell's skipImages), so has_image is
		// decided on headers. It must agree with buildImageBlocks or the agent spends a
		// get_full_output round trip to receive the same placeholder it already had.
		const svg = Buffer.from('<svg/>').toString('base64');
		expect(canInlineImage('image/svg+xml', svg)).toBe(false);
		expect(canInlineImage('image/webp', Buffer.from('RIFF....WEBP').toString('base64'))).toBe(false);
		expect(canInlineImage('image/png', fakePngHeader(7000, 7000))).toBe(false); // pixel bomb
		expect(canInlineImage('image/png', makePngB64(40, 30))).toBe(true);
		// A non-PNG cannot be resampled, so one past the host's edge ceiling is a no.
		expect(canInlineImage('image/gif', gifHeader(9000, 100))).toBe(false);
		expect(canInlineImage('image/gif', gifHeader(600, 400))).toBe(true);
	});

	it('does NOT inline webp — its header is unreadable here, so the ceilings could not be enforced on it', () => {
		// The module only ships a raster it has VERIFIED is inside the host's ceilings.
		// With no webp header parser an oversized one would sail through and fail the
		// entire tool result, so it keeps its text placeholder like svg.
		const webp = Buffer.from('RIFF....WEBPVP8 ').toString('base64');
		const { images, omitted } = buildImageBlocks([ref(0, 'image/webp', webp)]);
		expect(images).toEqual([]);
		expect(omitted).toEqual([expect.objectContaining({ output_index: 0, mime: 'image/webp', reason: 'unsupported_mime' })]);
	});

	it('applies the pixel bound on the `full` path too — asking for detail is not a licence to ship (or decode) an unbounded raster', () => {
		// `full` skips the routine downscale, so without a pre-decode bound this one
		// would sail past the host ceilings on its edges alone; an oversized original
		// that DID trip them falls back to a downscale, which is a decode.
		const { images, omitted } = buildImageBlocks([ref(0, 'image/png', fakePngHeader(7000, 7000))], { full: true });
		expect(images).toEqual([]);
		expect(omitted).toEqual([expect.objectContaining({ reason: 'too_large' })]);
	});

	it('an explicit `full` request skips the downscale and returns the original raster', () => {
		const b64 = makePngB64(1600, 1200);
		const { images } = buildImageBlocks([ref(0, 'image/png', b64)], { full: true });
		expect(images[0].data).toBe(b64);
		expect(images[0].downscaled).toBeUndefined();
	});

	it('an oversized `full` image degrades to a downscaled copy, never to a block the host would reject', () => {
		// Drive the byte ceiling from the fixture's own size rather than building a
		// multi-megabyte one: the decision under test is "over the ceiling", not the
		// ceiling's value.
		const b64 = makePngB64(1600, 1200);
		const { images, omitted } = buildImageBlocks([ref(0, 'image/png', b64)], { full: true, maxBytes: base64Bytes(b64) - 1 });
		expect(omitted).toEqual([]);
		expect(images[0].data).not.toBe(b64);
		expect(Math.max(dimsOf(images[0].data).width, dimsOf(images[0].data).height)).toBe(IMG_MAX_EDGE);
		expect(images[0].downscaled?.note).toMatch(/exceeds the inline image size limit/);
	});

	it('charges that degradation to the DECODE budget too - `full` is not a way to spend unbounded CPU', () => {
		// The fallback above is a real PNG.sync.read + resample + re-encode, and it is
		// no cheaper for having been asked for at full size. It also emits a SMALL
		// block, so the byte budget cannot catch it: without charging the source
		// pixels here, one get_full_output(size:'full') over a cell of oversized
		// figures runs MAX_FULL_OUTPUT_IMAGE_BLOCKS decodes free of charge and stalls
		// the event loop that streams SSE frames and serves every other kernel.
		const b64 = makePngB64(1000, 900);
		const many = Array.from({ length: 4 }, (_, i) => ref(i, 'image/png', b64));
		const overByte = { full: true as const, limit: 100, maxBytes: base64Bytes(b64) - 1 };

		const { images, omitted } = buildImageBlocks(many, { ...overByte, maxDecodePixels: 1000 * 900 * 2 });
		expect(images).toHaveLength(2);
		expect(images.every((i) => i.downscaled)).toBe(true);
		expect(omitted).toHaveLength(1);
		expect(omitted[0]).toEqual(expect.objectContaining({ reason: 'budget', output_index: 2, count: 2 }));
		expect(omitted[0].note).toMatch(/get_full_output\(id, images_from: 2\)/);

		// A `full` image already inside the ceilings ships untouched, so it decodes
		// nothing and is never charged - the budget bounds decodes, not images.
		const small = Array.from({ length: 4 }, (_, i) => ref(i, 'image/png', makePngB64(40, 30, i)));
		expect(buildImageBlocks(small, { full: true, limit: 100, maxDecodePixels: 1 }).images).toHaveLength(4);
	});

	it('omits (with a reason) an image no downscale can bring under the ceiling', () => {
		// A non-PNG cannot be resampled, so an oversized one has nowhere to go.
		const big = Buffer.alloc(5000, 7).toString('base64');
		const { images, omitted } = buildImageBlocks([ref(1, 'image/jpeg', big)], { maxBytes: 1000 });
		expect(images).toEqual([]);
		expect(omitted).toEqual([expect.objectContaining({ output_index: 1, reason: 'too_large' })]);
	});

	it('an undecodable PNG is still shown, not corrupted or dropped', () => {
		const junk = Buffer.from('\x89PNG\r\n\x1a\n corrupt tail').toString('base64');
		const { images, omitted } = buildImageBlocks([ref(0, 'image/png', junk)]);
		expect(omitted).toEqual([]);
		expect(images[0].data).toBe(junk);
	});

	it('a cell with no image outputs produces nothing at all', () => {
		expect(buildImageBlocks([])).toEqual({ images: [], omitted: [] });
	});
});

describe('tool-result transport', () => {
	it('lifts each image out of the JSON into a real MCP image block, keeping its metadata in the text', () => {
		const data = makePngB64(40, 30);
		const res = textWithImages({
			id: 'abc12345',
			status: 'ok',
			outputs: [{ type: 'display_data', image: 'image/png', text: '[image/png, 40×30, 1 KB]' }],
			images: [{ output_index: 0, mime: 'image/png', data, width: 40, height: 30 }]
		});

		expect(res.content).toHaveLength(2);
		const [textBlock, imageBlock] = res.content as [{ type: string; text: string }, { type: string; data: string; mimeType: string }];
		expect(imageBlock).toEqual({ type: 'image', data, mimeType: 'image/png' });

		// The raster is NOT stringified into the text too (that would bill the same
		// bytes twice and show the agent nothing), but the metadata that tells the
		// agent which output it is survives.
		expect(textBlock.text).not.toContain(data);
		const parsed = JSON.parse(textBlock.text);
		expect(parsed.images).toEqual([{ output_index: 0, mime: 'image/png', width: 40, height: 30 }]);
		expect(parsed.status).toBe('ok');
		expect(parsed.outputs[0].text).toBe('[image/png, 40×30, 1 KB]');
	});

	it('is a plain text result when the run produced no figure (text/table/error unchanged)', () => {
		const result = { id: 'abc12345', status: 'ok', outputs: [{ type: 'stream', text: 'hello' }] };
		expect(textWithImages(result)).toEqual({ content: [{ type: 'text', text: JSON.stringify(result) }] });
	});

	it('emits one block per image, in output order', () => {
		const a = makePngB64(20, 20, 1);
		const b = makePngB64(20, 20, 2);
		const res = textWithImages({ images: [{ output_index: 0, mime: 'image/png', data: a }, { output_index: 3, mime: 'image/png', data: b }] });
		expect(res.content.map((c) => c.type)).toEqual(['text', 'image', 'image']);
		expect((res.content[1] as { data: string }).data).toBe(a);
		expect((res.content[2] as { data: string }).data).toBe(b);
	});
});
