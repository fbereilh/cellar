/**
 * Server-side image handling for the MCP agent surface.
 *
 * Two jobs, both about IMAGE TOKENS:
 *
 *  1. `downscaleImageForBlock` shrinks an oversized PNG (a retina / high-DPI
 *     matplotlib figure) down to a bounded longest edge BEFORE it becomes an MCP
 *     image content block on the DEFAULT read path (`get_full_output` medium).
 *     A ~1600×1200 plot costs ~1,600 image tokens; at ~768px it is ~590. The
 *     original bytes are never touched — `get_full_output(id, size:'full')`
 *     re-encodes nothing and hands back the raw raster, so an agent that needs
 *     pixel detail still opts in and gets it.
 *
 *  2. `imagePlaceholder` builds the terse, image-token-free marker the non-image
 *     read paths (map / read / run) show instead of the raster:
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
	try {
		const src = PNG.sync.read(Buffer.from(b64, 'base64'));
		const { width: sw, height: sh } = src;
		if (Math.max(sw, sh) <= maxEdge) return { data: b64, resized: false, width: sw, height: sh };

		const scale = maxEdge / Math.max(sw, sh);
		const dw = Math.max(1, Math.round(sw * scale));
		const dh = Math.max(1, Math.round(sh * scale));

		const out = new PNG({ width: dw, height: dh });
		out.data = resizeRGBA(src.data, sw, sh, dw, dh);
		const encoded = PNG.sync.write(out).toString('base64');
		return { data: encoded, resized: true, width: sw, height: sh, scaledWidth: dw, scaledHeight: dh };
	} catch {
		// Undecodable / unexpected raster: hand back the original, never a corrupt one.
		return { data: b64, resized: false };
	}
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
