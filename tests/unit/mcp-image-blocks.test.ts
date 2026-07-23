import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { base64Bytes, buildImageBlocks, IMG_MAX_EDGE, MAX_IMAGE_BLOCKS } from '../../src/lib/server/mcp/image';
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
		expect(omitted).toHaveLength(3);
		expect(omitted.every((o) => o.reason === 'limit')).toBe(true);
		// The route to the ones that did not fit is named, so the cap costs no capability.
		expect(omitted[0].note).toMatch(/get_full_output/);
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
