/**
 * Server-side image handling for the MCP agent surface.
 *
 * Three jobs, all about IMAGE TOKENS:
 *
 *  1. `downscaleImageForBlock` shrinks an oversized PNG (a retina / high-DPI
 *     matplotlib figure) down to a bounded longest edge BEFORE it becomes an MCP
 *     image content block on the DEFAULT paths (a run result, `get_full_output`
 *     medium). A ~1600×1200 plot costs ~1,600 image tokens; at ~768px it is ~590.
 *     The original bytes are never touched — `get_full_output(id, size:'full')`
 *     re-encodes nothing and hands back the raw raster, so an agent that needs
 *     pixel detail still opts in and gets it.
 *
 *  2. `buildImageBlocks` is the ONE policy seam deciding which of a cell's image
 *     outputs actually become MCP image blocks, and at what size — the mime
 *     allowlist, the per-result count cap, and the byte/dimension ceilings. Every
 *     tool that ships images (run_cell / add_and_run / get_full_output) goes
 *     through it, so the cost bound cannot drift between them. Anything it
 *     declines is reported in `omitted` WITH a reason, never dropped silently.
 *     The count cap is the one knob that differs by caller: it bounds the
 *     AUTOMATIC result of a run, where the agent did not ask for figures and the
 *     token bill is unbudgeted, while `get_full_output(id)` — an explicit,
 *     per-cell request for exactly this — passes `limit: Infinity` and returns
 *     every image on the cell. That is what makes the `limit` omission note's
 *     route a real one rather than a promise nothing keeps.
 *
 *  3. `imagePlaceholder` builds the terse, image-token-free marker the scan read
 *     paths (map / read / search) show instead of the raster:
 *     `[image/png, 1600×1200, 46 KB]` — enough for the agent to decide whether to
 *     fetch it, spending zero image tokens.
 *
 * Robustness doctrine (matches the imports/traceback parsers): every path is
 * fallback-safe. Anything we cannot cleanly decode/resize is returned UNTOUCHED,
 * never corrupted — declining to shrink is always the safe direction.
 *
 * Dependency choice: `pngjs` is pure-JS with zero native modules, so it adds no
 * native-build / cross-platform packaging burden (cellar ships as an npm
 * package). It normalizes every PNG colour type (palette, grayscale, 16-bit,
 * interlaced) to 8-bit RGBA on read, so the resize path handles one pixel format
 * and can never mangle an exotic input. Only PNG is downscaled (matplotlib's
 * inline backend, and every other Cellar image path, emits PNG); JPEG/GIF/SVG
 * pass through and still get an enriched placeholder.
 */
import { PNG } from 'pngjs';

/** Longest-edge cap (px) for a downscaled image on the default read path. */
export const IMG_MAX_EDGE = 768;

/** Decoded byte length of a base64 payload (no allocation). */
export function base64Bytes(b64: string): number {
	const s = b64.replace(/\s+/g, '');
	if (!s) return 0;
	let pad = 0;
	if (s.endsWith('==')) pad = 2;
	else if (s.endsWith('=')) pad = 1;
	return Math.floor((s.length * 3) / 4) - pad;
}

/** Human byte size: `46 KB`, `1.2 MB`, `812 B`. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read pixel dimensions from an image header WITHOUT a full decode — cheap enough
 * to run on every read-path placeholder. Handles PNG / JPEG / GIF; returns null
 * for anything else (or a truncated/corrupt header), which just omits dimensions
 * from the placeholder.
 */
export function imageDimensions(mime: string, b64: string): { width: number; height: number } | null {
	let buf: Buffer;
	try {
		buf = Buffer.from(b64, 'base64');
	} catch {
		return null;
	}
	if (mime === 'image/png') return pngDimensions(buf);
	if (mime === 'image/jpeg' || mime === 'image/jpg') return jpegDimensions(buf);
	if (mime === 'image/gif') return gifDimensions(buf);
	return null;
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
	// 8-byte signature, then IHDR chunk: [len(4)][type(4)][width(4)][height(4)].
	if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifDimensions(buf: Buffer): { width: number; height: number } | null {
	// 'GIF' + version, then logical screen width/height as little-endian uint16.
	if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
	return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = buf[i + 1];
		// SOF0..SOF15 carry the frame dimensions (skip the arithmetic/RST/reserved
		// markers 0xC4/0xC8/0xCC which are not start-of-frame).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		// Otherwise skip this segment by its length field.
		const len = buf.readUInt16BE(i + 2);
		if (len < 2) return null;
		i += 2 + len;
	}
	return null;
}

/**
 * The enriched, image-token-free placeholder the non-image read paths show:
 * `[image/png, 1600×1200, 46 KB]` (dimensions omitted if the header won't parse,
 * so at worst `[image/png, 46 KB]`). Terse by design — it never forwards the
 * raster; the agent fetches that with `get_full_output`.
 */
export function imagePlaceholder(mime: string, b64: string): string {
	const bytes = base64Bytes(b64);
	const dim = imageDimensions(mime, b64);
	const parts = [mime];
	if (dim) parts.push(`${dim.width}×${dim.height}`);
	parts.push(formatBytes(bytes));
	return `[${parts.join(', ')}]`;
}

export interface ScaledImage {
	/** base64 payload for the MCP image block (original when not resized). */
	data: string;
	resized: boolean;
	/** Original pixel dimensions, when known. */
	width?: number;
	height?: number;
	/** Downscaled pixel dimensions, present only when `resized`. */
	scaledWidth?: number;
	scaledHeight?: number;
}

/**
 * Downscale a PNG whose longest side exceeds `maxEdge` down to that edge,
 * preserving aspect ratio, and re-encode as PNG. An image already within the
 * threshold (or any non-PNG, or anything that fails to decode) is returned
 * byte-for-byte untouched with `resized:false`.
 */
export function downscaleImageForBlock(mime: string, b64: string, maxEdge = IMG_MAX_EDGE): ScaledImage {
	if (mime !== 'image/png') return { data: b64, resized: false };
	// Refuse to decode a raster past the pixel bound (see `exceedsDecodeBound`):
	// pngjs allocates the whole RGBA buffer up front, and no try/catch survives an
	// OOM. Declining to shrink is the module's standard safe direction, and the
	// caller's host-limit check then omits it with a reason.
	if (exceedsDecodeBound(mime, b64)) return { data: b64, resized: false };
	try {
		const src = PNG.sync.read(Buffer.from(b64, 'base64'));
		const { width: sw, height: sh } = src;
		if (Math.max(sw, sh) <= maxEdge) return { data: b64, resized: false, width: sw, height: sh };

		const scale = maxEdge / Math.max(sw, sh);
		const dw = Math.max(1, Math.round(sw * scale));
		const dh = Math.max(1, Math.round(sh * scale));

		const out = new PNG({ width: dw, height: dh });
		out.data = resizeRGBA(src.data, sw, sh, dw, dh);
		// Cheap deflate: this runs synchronously on the shared event loop of the
		// process that also streams SSE frames and services every other kernel and
		// MCP session, and level 9 buys a few percent on a raster the agent only has
		// to READ. Time matters here; the last byte does not.
		const encoded = PNG.sync.write(out, { deflateLevel: 3 }).toString('base64');
		return { data: encoded, resized: true, width: sw, height: sh, scaledWidth: dw, scaledHeight: dh };
	} catch {
		// Undecodable / unexpected raster: hand back the original, never a corrupt one.
		return { data: b64, resized: false };
	}
}

/**
 * The mime types that may be shipped as an MCP image content block. The list is
 * an ALLOWLIST, not a filter of known-bad types: an LLM host accepts a bounded
 * raster set, and handing it anything else (notably `image/svg+xml`, which
 * matplotlib emits under the svg backend) is not "slightly worse output" — the
 * host rejects the whole tool result, so ONE svg figure would break the call that
 * carried it. Anything outside this set keeps its enriched text placeholder.
 */
export const INLINE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];

/** Whether a mime may ride as an image content block at all (the allowlist). */
export const isInlinableImageMime = (mime: unknown): boolean => typeof mime === 'string' && INLINE_IMAGE_MIMES.includes(mime);

/**
 * The mime an image BLOCK carries, which is not always the bundle key it came
 * from: `image/jpg` is a common but unregistered spelling that hosts do not
 * accept, and a rejected block fails the ENTIRE tool result — the exact failure
 * the allowlist exists to prevent. So such an output is still shown; only the
 * emitted type is corrected to the registered `image/jpeg`.
 */
export function blockMime(mime: string): string {
	return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

/**
 * How many image blocks ONE AUTOMATIC tool result may carry. A cell that plots in
 * a loop can emit dozens of figures; at ~590 image tokens each, an uncapped run
 * result is a five-figure token bill from a single `add_and_run` the agent never
 * asked to pay. Four covers the real cases (one figure, or a small subplot
 * series) and the rest are reported in `images_omitted` — bounded, never silently
 * truncated, and reachable in full because `get_full_output(id)` is EXPLICIT and
 * therefore runs uncapped (`limit: Infinity`).
 */
export const MAX_IMAGE_BLOCKS = 4;

/**
 * Decoded-byte ceiling for one image block. Hosts cap an inline image (~5 MB is
 * the common limit, measured on the base64 payload, which is 4/3 of this), and a
 * rejected block fails the entire tool result — so an image over the ceiling is
 * downscaled to fit, and omitted with a reason if even that will not fit. Chosen
 * well under the limit: the point is a figure the agent can READ, not a raster.
 */
export const IMAGE_BLOCK_MAX_BYTES = 3.5 * 1024 * 1024;

/** Hard pixel ceiling per edge (hosts reject beyond ~8000px). */
export const MAX_IMAGE_EDGE_HARD = 8000;

/**
 * Pixel-count ceiling above which a raster is refused WITHOUT ever being decoded.
 * `PNG.sync.read` allocates width×height×4 bytes of RGBA up front, so one
 * pathological figure (an agent typo like `plt.figure(figsize=(100,100),
 * dpi=300)` → 30000×30000) would ask pngjs for gigabytes inside the request that
 * just ran the cell — and a genuine OOM is not something a try/catch can save us
 * from: it kills the single shared Node process, taking every notebook's kernel
 * websocket, every SSE stream and every other agent session with it. So the
 * header dimensions are read first (`imageDimensions`, no decode) and anything
 * past this bound — or past `MAX_IMAGE_EDGE_HARD`, which the host would reject
 * anyway — is omitted `too_large` with the output keeping its text placeholder.
 * Set well beyond any real figure: a 300-dpi 20×12in plot is ~21 MP.
 */
export const MAX_DECODE_PIXELS = 32_000_000;

/**
 * Whether a raster is too big to safely hand to the decoder. Header-only, so it
 * costs nothing; an unparseable header is NOT treated as oversized (the decode
 * then fails cheaply on its own and the fallback returns the original untouched).
 */
export function exceedsDecodeBound(mime: string, b64: string): boolean {
	const dim = imageDimensions(mime, b64);
	if (!dim) return false;
	return dim.width * dim.height > MAX_DECODE_PIXELS || Math.max(dim.width, dim.height) > MAX_IMAGE_EDGE_HARD;
}

/** One image output of a cell, as the service hands it to the policy. */
export interface ImageOutputRef {
	/** Index of the output within the cell's `outputs` array. */
	output_index: number;
	mime: string;
	/** base64 raster as stored on the cell. */
	b64: string;
}

/** An image the transport turns into an MCP image block (`data` is base64). */
export interface ImageBlockPayload {
	output_index: number;
	mime: string;
	data: string;
	width?: number;
	height?: number;
	/** Present when the raster shipped is smaller than the one on the cell. */
	downscaled?: { from: string; to: string; note?: string };
}

/** An image that was NOT shipped, and why — always reported, never silent. */
export interface OmittedImage {
	output_index: number;
	mime: string;
	reason: 'unsupported_mime' | 'limit' | 'too_large';
	note: string;
}

export interface ImageBlocks {
	images: ImageBlockPayload[];
	omitted: OmittedImage[];
}

const FETCH_FULL = "get_full_output(id, size:'full') returns the original bytes";
/** The route named by the `limit` omission — and it is a real one: see MAX_IMAGE_BLOCKS. */
const FETCH_ALL = 'get_full_output(id) returns every image on this cell (that call is not capped)';

/**
 * Decide which of a cell's image outputs become MCP image blocks, and at what
 * size. The single cost bound for every tool that ships images.
 *
 * `full` (get_full_output size:'full') skips the routine downscale so an agent
 * that asked for pixel detail gets the original raster — but the byte/dimension
 * ceilings still apply, because they are about what the HOST will accept, not
 * about token thrift: an oversized original is downscaled to fit (with a note
 * saying so) rather than shipped as a block the host would reject.
 *
 * `limit` is the caller's token budget, not a capability bound: the run path
 * takes the MAX_IMAGE_BLOCKS default, `get_full_output` passes Infinity.
 */
export function buildImageBlocks(
	items: ImageOutputRef[],
	{ full = false, maxEdge = IMG_MAX_EDGE, limit = MAX_IMAGE_BLOCKS, maxBytes = IMAGE_BLOCK_MAX_BYTES }: { full?: boolean; maxEdge?: number; limit?: number; maxBytes?: number } = {}
): ImageBlocks {
	const images: ImageBlockPayload[] = [];
	const omitted: OmittedImage[] = [];
	for (const item of items) {
		const { output_index, mime, b64 } = item;
		if (!INLINE_IMAGE_MIMES.includes(mime)) {
			omitted.push({ output_index, mime, reason: 'unsupported_mime', note: `${mime} cannot be shown as an image; read the output text instead` });
			continue;
		}
		if (images.length >= limit) {
			omitted.push({ output_index, mime, reason: 'limit', note: `only the first ${limit} images ride in a run result; ${FETCH_ALL}` });
			continue;
		}
		const block = fitImageBlock(output_index, mime, b64, full, maxEdge, maxBytes);
		if (block) images.push(block);
		else omitted.push({ output_index, mime, reason: 'too_large', note: 'image too large to send as an image block; its size is in the outputs placeholder' });
	}
	return { images, omitted };
}

/**
 * One image, scaled to policy: downscale unless `full`, then enforce the host
 * ceilings — falling back to a downscale for an oversized `full` image, and
 * returning null only when even that does not fit (a huge non-PNG, which we
 * cannot resample). Never returns a payload we know the host would reject.
 *
 * The pixel bound is checked FIRST, before any decode: a raster past it is
 * declined outright rather than handed to pngjs (see `MAX_DECODE_PIXELS`).
 */
function fitImageBlock(output_index: number, mime: string, b64: string, full: boolean, maxEdge: number, maxBytes: number): ImageBlockPayload | null {
	if (exceedsDecodeBound(mime, b64)) return null;
	const scaled = full ? { data: b64, resized: false as const } : downscaleImageForBlock(mime, b64, maxEdge);
	const build = (s: ScaledImage, note?: string): ImageBlockPayload => ({
		output_index,
		mime: blockMime(mime),
		data: s.data,
		...(s.width != null ? { width: s.width, height: s.height } : {}),
		...(s.resized ? { downscaled: { from: `${s.width}×${s.height}`, to: `${s.scaledWidth}×${s.scaledHeight}`, ...(note ? { note } : { note: FETCH_FULL }) } } : {})
	});
	if (withinHostLimits(mime, scaled.data, maxBytes)) return build(scaled);
	// Over a host ceiling. A routine (already downscaled) image that still does not
	// fit is beyond what we can do; a `full` one gets the ordinary downscale as a
	// fallback, so "I asked for full res" degrades to a smaller figure, not to none.
	if (!full) return null;
	const retry = downscaleImageForBlock(mime, b64, maxEdge);
	if (retry.resized && withinHostLimits(mime, retry.data, maxBytes)) return build(retry, 'the original exceeds the inline image size limit, so a downscaled copy is shown');
	return null;
}

/** Whether a raster is small enough (bytes AND pixels) for a host to accept it. */
function withinHostLimits(mime: string, b64: string, maxBytes: number): boolean {
	if (base64Bytes(b64) > maxBytes) return false;
	const dim = imageDimensions(mime, b64);
	return !dim || Math.max(dim.width, dim.height) <= MAX_IMAGE_EDGE_HARD;
}

/**
 * Area-average (box filter) downscale of an 8-bit RGBA buffer. Each destination
 * pixel is the mean of the source pixels it covers, with alpha PREMULTIPLIED so a
 * transparent-background figure blends correctly (a straight average would bleed
 * fully-transparent colour into the edges). Box averaging is the right filter for
 * a pure downscale — bilinear would alias.
 */
function resizeRGBA(src: Buffer, sw: number, sh: number, dw: number, dh: number): Buffer {
	const dst = Buffer.alloc(dw * dh * 4);
	const xRatio = sw / dw;
	const yRatio = sh / dh;
	for (let dy = 0; dy < dh; dy++) {
		const sy0 = Math.floor(dy * yRatio);
		const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((dy + 1) * yRatio)));
		for (let dx = 0; dx < dw; dx++) {
			const sx0 = Math.floor(dx * xRatio);
			const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((dx + 1) * xRatio)));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				for (let sx = sx0; sx < sx1; sx++) {
					const i = (sy * sw + sx) * 4;
					const alpha = src[i + 3];
					r += src[i] * alpha;
					g += src[i + 1] * alpha;
					b += src[i + 2] * alpha;
					a += alpha;
					n++;
				}
			}
			const di = (dy * dw + dx) * 4;
			if (a > 0) {
				dst[di] = Math.round(r / a);
				dst[di + 1] = Math.round(g / a);
				dst[di + 2] = Math.round(b / a);
				dst[di + 3] = Math.round(a / n);
			}
			// a === 0 leaves the pixel fully transparent (alloc zero-fills).
		}
	}
	return dst;
}
