/**
 * Server-side image handling for the MCP agent surface.
 *
 * Four jobs, all about IMAGE TOKENS:
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
 *     allowlist, the per-result count cap, the per-image byte/dimension ceilings,
 *     and the two AGGREGATE budgets that bound one whole reply
 *     (IMAGE_RESULT_MAX_BYTES of shipped raster, MAX_RESULT_DECODE_PIXELS of
 *     source pixels handed to the decoder - the ceilings bound ONE image, nothing
 *     else bounded N). Every tool that ships images (run_cell / add_and_run /
 *     get_full_output) goes through it, so the cost bound cannot drift between
 *     them. Anything it declines is reported in `omitted` WITH a reason, never
 *     dropped silently -
 *     though a consecutive run declined by the SAME aggregate bound collapses into
 *     one entry carrying a `count`, since dozens of identical notes are cost
 *     without information on the very path the caps exist to keep cheap.
 *     The count cap is the one knob that differs by caller: four bound the
 *     AUTOMATIC result of a run, where the agent did not ask for figures and the
 *     token bill is unbudgeted, while `get_full_output(id)` — an explicit,
 *     per-cell request for exactly this - ships up to
 *     MAX_FULL_OUTPUT_IMAGE_BLOCKS. Both stay FINITE (each image is a synchronous
 *     decode + resample on the shared event loop), so the bounds are made
 *     capability-free by the route rather than by being lifted: every omission
 *     names `get_full_output(id, images_from: <output_index>)`, which resumes at
 *     exactly the figure that did not fit.
 *
 *  3. `imagePlaceholder` builds the terse, image-token-free marker the scan read
 *     paths (map / read / search / errors) show instead of the raster:
 *     `[image/png, 1600×1200, 46 KB]` — enough for the agent to decide whether to
 *     fetch it, spending zero image tokens.
 *
 *  4. `canInlineImage` answers, from the header alone and with no decode, whether
 *     job 2 would really SHOW this output. It is what a batch run's `has_image`
 *     means: not "an image mime is present" but "a figure `get_full_output` can
 *     display", so the flag never sends the agent on a round trip that hands back
 *     the same placeholder it already had.
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
 * inline backend, and every other Cellar image path, emits PNG); a JPEG/GIF ships
 * unresampled when it is already inside the ceilings and is declined with a reason
 * when it is not, while an SVG is outside the allowlist entirely and only ever
 * shows its enriched placeholder.
 */
import { PNG } from 'pngjs';

/** Longest-edge cap (px) for a downscaled image on the default read path. */
export const IMG_MAX_EDGE = 768;

/**
 * Decoded byte length of a base64 payload, counted in place. nbformat stores a
 * raster as a multiline string, so the whitespace has to be discounted - but a
 * `replace(/\s+/g,'')` would copy the whole multi-megabyte payload just to count
 * it, and this runs several times per image per result. A char scan allocates
 * nothing.
 */
export function base64Bytes(b64: string): number {
	let chars = 0;
	let pad = 0;
	for (let i = 0; i < b64.length; i++) {
		const c = b64.charCodeAt(i);
		if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
		chars++;
		if (c === 0x3d) pad++; // '=' - padding, which base64 only carries at the end
	}
	if (!chars) return 0;
	return Math.floor((chars * 3) / 4) - Math.min(pad, 2);
}

/**
 * The base64 a block may actually SHIP: the same payload with every whitespace
 * character removed. nbformat splits a raster with `splitlines(True)`, so the line
 * terminators survive the `join('')` that reassembles it and land inside the
 * base64 - and a strict host validator rejects a non-alphabet character exactly as
 * it rejects the comma a `String()` join would have left, failing the ENTIRE tool
 * result. Unlike `base64Bytes` (which runs several times per image and so counts in
 * place) this copies, but only at most `limit` times per result, and only when
 * there is something to strip.
 */
function base64Payload(b64: string): string {
	return /\s/.test(b64) ? b64.replace(/\s+/g, '') : b64;
}

/** Human byte size: `46 KB`, `1.2 MB`, `812 B`. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pixel dimensions read off an image header, or null when it will not parse. */
export type ImageDims = { width: number; height: number } | null;

/**
 * How much of the base64 payload is decoded to read a header. PNG's IHDR and
 * GIF's logical screen descriptor live in the first ~24 bytes; JPEG's SOF sits
 * after the APPn segments, and one EXIF/thumbnail segment runs to 64 KB, so it
 * gets a larger (still bounded) window. Past the window the dimensions are simply
 * unknown, which every caller already handles.
 */
const HEADER_B64_CHARS = 4096;
const JPEG_HEADER_B64_CHARS = 262_144;

/** Decode only the leading `chars` of a base64 payload (a partial trailing group is dropped). */
function headerBuffer(b64: string, chars: number): Buffer | null {
	try {
		return Buffer.from(b64.length > chars ? b64.slice(0, chars) : b64, 'base64');
	} catch {
		return null;
	}
}

/**
 * Read pixel dimensions from an image header - genuinely header-only: it decodes
 * a bounded PREFIX of the base64, never the whole raster (that would allocate
 * megabytes to read 24 bytes, on a path that runs for every image of every
 * result). Handles PNG / JPEG / GIF; returns null for anything else (or a
 * truncated/corrupt header), which just omits dimensions from the placeholder.
 */
export function imageDimensions(mime: string, b64: string): ImageDims {
	if (mime === 'image/png') {
		const buf = headerBuffer(b64, HEADER_B64_CHARS);
		return buf ? pngDimensions(buf) : null;
	}
	if (mime === 'image/jpeg' || mime === 'image/jpg') {
		const buf = headerBuffer(b64, JPEG_HEADER_B64_CHARS);
		return buf ? jpegDimensions(buf) : null;
	}
	if (mime === 'image/gif') {
		const buf = headerBuffer(b64, HEADER_B64_CHARS);
		return buf ? gifDimensions(buf) : null;
	}
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
	/**
	 * SOURCE pixels actually handed to the decoder, 0 when nothing was decoded.
	 * Required, not optional, so every return path has to STATE its cost: this is
	 * what `buildImageBlocks` charges against `MAX_RESULT_DECODE_PIXELS`, and a path
	 * that quietly omitted it would be a decode nothing bounds.
	 */
	decodedPixels: number;
}

/**
 * Downscale a PNG whose longest side exceeds `maxEdge` down to that edge,
 * preserving aspect ratio, and re-encode as PNG. An image already within the
 * threshold (or any non-PNG, or anything that fails to decode) is returned
 * byte-for-byte untouched with `resized:false`.
 */
export function downscaleImageForBlock(mime: string, b64: string, maxEdge = IMG_MAX_EDGE, dim?: ImageDims): ScaledImage {
	if (mime !== 'image/png') return { data: b64, resized: false, decodedPixels: 0 };
	const d = dim === undefined ? imageDimensions(mime, b64) : dim;
	// Refuse to decode a raster past the pixel bound (see `exceedsDecodeBound`):
	// pngjs allocates the whole RGBA buffer up front, and no try/catch survives an
	// OOM. Declining to shrink is the module's standard safe direction, and the
	// caller's host-limit check then omits it with a reason.
	if (exceedsDecodeBound(mime, b64, d)) return { data: b64, resized: false, decodedPixels: 0 };
	// Already inside the edge, on dimensions the caller has ALREADY parsed from the
	// header: there is nothing to resample, so the raster never reaches pngjs.
	// Decoding it merely to re-read a width and height we were handed allocates the
	// whole width×height×4 buffer and discards it - precisely the work
	// MAX_RESULT_DECODE_PIXELS exists to bound, on the one path that would report
	// itself as having spent none of it.
	if (d && Math.max(d.width, d.height) <= maxEdge) return { data: b64, resized: false, width: d.width, height: d.height, decodedPixels: 0 };
	try {
		const src = PNG.sync.read(Buffer.from(b64, 'base64'));
		const { width: sw, height: sh } = src;
		// Charged from the raster pngjs really read, so a header that would not parse
		// (`d === null`, which no caller could pre-charge) still pays for its decode.
		const decodedPixels = sw * sh;
		if (Math.max(sw, sh) <= maxEdge) return { data: b64, resized: false, width: sw, height: sh, decodedPixels };

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
		return { data: encoded, resized: true, width: sw, height: sh, scaledWidth: dw, scaledHeight: dh, decodedPixels };
	} catch {
		// Undecodable / unexpected raster: hand back the original, never a corrupt one.
		// A known-size raster is still charged for the allocation the attempt made
		// (pngjs sizes its buffer from the IHDR before it fails on the pixel data);
		// with no header there is nothing to charge, and pngjs rejects such a payload
		// on the signature before allocating anything.
		return { data: b64, resized: false, decodedPixels: d ? d.width * d.height : 0 };
	}
}

/**
 * The mime types that may be shipped as an MCP image content block. The list is
 * an ALLOWLIST, not a filter of known-bad types: an LLM host accepts a bounded
 * raster set, and handing it anything else (notably `image/svg+xml`, which
 * matplotlib emits under the svg backend) is not "slightly worse output" — the
 * host rejects the whole tool result, so ONE svg figure would break the call that
 * carried it. Anything outside this set keeps its enriched text placeholder.
 *
 * `image/webp` is deliberately NOT here even though hosts accept it: this module
 * only ships a raster it has VERIFIED is inside the host's ceilings, and it has no
 * webp header reader (`imageDimensions` returns null), so an oversized webp would
 * pass the dimension check by default and fail the whole tool result — the exact
 * failure the allowlist exists to prevent. Nor could it be brought under the
 * ceiling: only PNG is resampleable here. Nothing in Cellar emits webp (it takes a
 * hand-written `display({'image/webp': …}, raw=True)`), so it keeps its text
 * placeholder like svg. Adding it back means adding a VP8/VP8L/VP8X header parse
 * to `imageDimensions` first — the ceilings must be genuinely enforced, not
 * vacuously true.
 */
export const INLINE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif'];

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
 * truncated, and reachable because `get_full_output(id)` is EXPLICIT and so runs
 * against the far larger `MAX_FULL_OUTPUT_IMAGE_BLOCKS`, from any starting output
 * (`images_from`).
 */
export const MAX_IMAGE_BLOCKS = 4;

/**
 * How many image blocks ONE EXPLICIT `get_full_output(id)` may carry. Much larger
 * than the automatic cap - this call IS the agent asking for this cell's figures,
 * so the ones past a run result's four have to be reachable here, or that result's
 * omission note is a promise nothing keeps.
 *
 * It is nonetheless FINITE, and that is the point. Every image over `IMG_MAX_EDGE`
 * is a synchronous decode + resample + re-encode on the shared event loop that also
 * streams SSE frames and services every other kernel and MCP session, so an
 * unbounded pass over a cell that plotted in a loop (30-50 figures is ordinary in
 * data work) would stall the whole process for seconds and, on `size:'full'`,
 * return tens of megabytes. Past this bound - or past either aggregate budget
 * below, whichever binds first - the remainder is reported in `images_omitted`
 * naming `images_from`, so paging through a hundred-figure cell costs several
 * calls but loses no capability.
 */
export const MAX_FULL_OUTPUT_IMAGE_BLOCKS = 20;

/**
 * Total decoded bytes of the rasters ONE result may ship, across all its images.
 * The per-image ceiling bounds one raster; nothing else bounds N of them, and on
 * `size:'full'` twenty images at that ceiling would be a 70 MB reply.
 */
export const IMAGE_RESULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Total SOURCE pixels one result may hand to the decoder, across all its images -
 * the CPU sibling of the byte budget, since decode+resize cost scales with w×h
 * while the downscaled output's size says nothing about what it cost to produce.
 * ~40 MP is roughly twenty 1600×1200 figures.
 */
export const MAX_RESULT_DECODE_PIXELS = 40_000_000;

/**
 * Decoded-byte ceiling for one image block. Hosts cap an inline image (~5 MB is
 * the common limit, measured on the base64 payload, which is 4/3 of this), and a
 * rejected block fails the entire tool result — so an image over the ceiling is
 * downscaled to fit, and omitted with a reason if even that will not fit. Chosen
 * well under the limit: the point is a figure the agent can READ, not a raster.
 */
export const IMAGE_BLOCK_MAX_BYTES = 3.5 * 1024 * 1024;

/**
 * Hard pixel ceiling per edge (hosts reject beyond ~8000px). It is a SHIP bound,
 * enforced by `withinHostLimits` on the raster actually emitted — deliberately NOT
 * a pre-decode refusal. A tall-but-modest figure (a stacked-subplot / FacetGrid
 * plot: `plt.subplots(30, 1, figsize=(8,60), dpi=150)` → 1200×9000, ~11 MP) is over
 * this edge yet nowhere near the decode bound, and downscaling resolves it to
 * ≤ IMG_MAX_EDGE on both axes — so it must be decoded and shipped, not refused.
 * A non-PNG over the edge cannot be resampled, so it is declined here instead.
 */
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
 * past this bound is omitted `too_large` with the output keeping its text
 * placeholder. TOTAL PIXELS is the whole rule, because w×h×4 is the whole risk:
 * a single long edge costs nothing to decode and is handled by the ship ceiling
 * (`MAX_IMAGE_EDGE_HARD`) on the emitted raster. Set well beyond any real figure:
 * a 300-dpi 20×12in plot is ~21 MP.
 */
export const MAX_DECODE_PIXELS = 32_000_000;

/**
 * Whether a raster is too big to safely hand to the decoder. Header-only, so it
 * costs nothing; an unparseable header is NOT treated as oversized (the decode
 * then fails cheaply on its own and the fallback returns the original untouched).
 * `dim` lets a caller that has already read the header pass it in rather than
 * re-parsing it.
 */
export function exceedsDecodeBound(mime: string, b64: string, dim: ImageDims = imageDimensions(mime, b64)): boolean {
	if (!dim) return false;
	return dim.width * dim.height > MAX_DECODE_PIXELS;
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
	reason: 'unsupported_mime' | 'limit' | 'too_large' | 'budget';
	/**
	 * How many CONSECUTIVE image outputs this entry stands for, starting at
	 * `output_index`; absent means exactly one. Only a `limit`/`budget` entry ever
	 * covers more than one (see `buildImageBlocks`) - those are one bound hit once,
	 * so a run of them says nothing per figure, whereas `unsupported_mime` /
	 * `too_large` each name a specific figure and a specific cause.
	 */
	count?: number;
	note: string;
}

export interface ImageBlocks {
	images: ImageBlockPayload[];
	omitted: OmittedImage[];
}

const FETCH_FULL = "get_full_output(id, size:'full') returns the original bytes";
/**
 * The route named by the `limit` / `budget` omissions - and it is a real one:
 * `get_full_output` ships up to MAX_FULL_OUTPUT_IMAGE_BLOCKS per call and takes an
 * `images_from` output_index, so however many figures a cell carries, every one of
 * them is reachable by starting there. Naming the very output that was declined is
 * what keeps the note honest on BOTH callers: on a run result it pages past the
 * four inline images, and on `get_full_output` itself it pages past this call's
 * own bound.
 */
const resumeAt = (output_index: number) => `get_full_output(id, images_from: ${output_index}) returns the rest, starting from this one`;

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
 * Three bounds, all of them finite and none of them a capability bound, because
 * `images_from` pages past every one of them:
 *  - `limit`, the caller's token budget (MAX_IMAGE_BLOCKS for an automatic run
 *    result, MAX_FULL_OUTPUT_IMAGE_BLOCKS for an explicit get_full_output),
 *  - `maxTotalBytes`, how much raster one reply may carry in total,
 *  - `maxDecodePixels`, how much decode+resample CPU one reply may spend on the
 *    shared event loop.
 */
export function buildImageBlocks(
	items: ImageOutputRef[],
	{
		full = false,
		maxEdge = IMG_MAX_EDGE,
		limit = MAX_IMAGE_BLOCKS,
		maxBytes = IMAGE_BLOCK_MAX_BYTES,
		maxTotalBytes = IMAGE_RESULT_MAX_BYTES,
		maxDecodePixels = MAX_RESULT_DECODE_PIXELS
	}: { full?: boolean; maxEdge?: number; limit?: number; maxBytes?: number; maxTotalBytes?: number; maxDecodePixels?: number } = {}
): ImageBlocks {
	const images: ImageBlockPayload[] = [];
	const omitted: OmittedImage[] = [];
	let spentBytes = 0;
	let spentPixels = 0;
	/**
	 * The bound-decline entry a further decline of the same reason may still be
	 * merged into - null the moment ANY other outcome intervenes. A run is only
	 * collapsible while it is genuinely uninterrupted: both budgets are
	 * `spent + cost > max` tests, so a large image can be declined and a smaller
	 * following one still fit, and merging across that would inflate the entry's
	 * `count` over an image the result actually DELIVERED.
	 */
	let openBound: OmittedImage | null = null;
	const shipped = (block: ImageBlockPayload) => {
		openBound = null;
		images.push(block);
	};
	const declineImage = (entry: OmittedImage) => {
		openBound = null;
		omitted.push(entry);
	};

	const boundNote = (reason: 'limit' | 'budget', from: number, count: number): string => {
		const why = reason === 'limit' ? `this result carries at most ${limit} images` : `this result's image budget is spent`;
		return `${count > 1 ? `${count} further images were not included: ` : ''}${why}; ${resumeAt(from)}`;
	};
	/**
	 * Report an image declined by one of the aggregate BOUNDS. A `limit`/`budget`
	 * decline says nothing about the individual figure - it is one bound, hit once,
	 * and every image after it goes the same way - so a CONSECUTIVE run of them
	 * collapses into ONE entry carrying the count and the first output to resume
	 * from. Per-image notes here are pure repetition on the exact path the count cap
	 * exists to keep cheap: a cell that plotted 60 figures in a loop would return 4
	 * blocks and 56 near-identical ~105-char notes, and because `images_from` pages
	 * re-emit the shrinking tail, the omission text over a full page-through grows
	 * quadratically in the number of figures. The contract is unweakened: the entry
	 * still says how many were declined and names the exact call that resumes at the
	 * first of them - which is only true while the run is UNBROKEN, hence `openBound`.
	 */
	const declineBound = (output_index: number, mime: string, reason: 'limit' | 'budget') => {
		if (openBound && openBound.reason === reason) {
			openBound.count = (openBound.count ?? 1) + 1;
			openBound.note = boundNote(reason, openBound.output_index, openBound.count);
			return;
		}
		const entry: OmittedImage = { output_index, mime, reason, note: boundNote(reason, output_index, 1) };
		omitted.push(entry);
		openBound = entry;
	};

	for (const item of items) {
		const { output_index, mime, b64 } = item;
		if (!isInlinableImageMime(mime)) {
			declineImage({ output_index, mime, reason: 'unsupported_mime', note: `${mime} cannot be shown as an image; read the output text instead` });
			continue;
		}
		if (images.length >= limit) {
			declineBound(output_index, mime, 'limit');
			continue;
		}
		const dim = imageDimensions(mime, b64);
		if (exceedsDecodeBound(mime, b64, dim)) {
			declineImage({ output_index, mime, reason: 'too_large', note: TOO_LARGE_NOTE });
			continue;
		}
		// Charge the decode budget BEFORE decoding whenever the cost is knowable, so a
		// decode that would blow the budget never runs at all.
		const decoding = willDecode(full, mime, b64, dim, maxEdge, maxBytes);
		const pixels = dim && decoding ? dim.width * dim.height : 0;
		if (pixels && spentPixels + pixels > maxDecodePixels) {
			declineBound(output_index, mime, 'budget');
			continue;
		}
		// A header that would not parse hides its decode cost until pngjs has read the
		// raster, so it can only be charged afterwards. Refusing to START one once the
		// budget is gone is what bounds the overshoot to a single image instead of
		// letting a run of unreadable headers decode without limit. Only a PNG is ever
		// handed to pngjs, and on the `full` path only one breaching a host ceiling is -
		// so this is gated on `willDecode`, which reports a decode really being about to
		// happen on either path. Withholding a figure that costs the decoder nothing
		// would charge it for CPU never spent.
		if (!dim && decoding && spentPixels >= maxDecodePixels) {
			declineBound(output_index, mime, 'budget');
			continue;
		}
		const fitted = fitImageBlock(output_index, mime, b64, full, maxEdge, maxBytes, dim);
		// Charge what was ACTUALLY decoded - including a decode the block is then
		// declined for, and including the unpredictable no-header case above. The CPU
		// is spent either way, and that is what this budget bounds.
		spentPixels += fitted.decodedPixels;
		if (!fitted.block) {
			declineImage({ output_index, mime, reason: 'too_large', note: TOO_LARGE_NOTE });
			continue;
		}
		const bytes = base64Bytes(fitted.block.data);
		if (spentBytes + bytes > maxTotalBytes) {
			declineBound(output_index, mime, 'budget');
			continue;
		}
		spentBytes += bytes;
		shipped(fitted.block);
	}
	return { images, omitted };
}

const TOO_LARGE_NOTE = 'image too large to send as an image block; its size is in the outputs placeholder';

/**
 * Whether shipping this image will cost a full decode. Only a PNG is ever
 * resampled, but `full` does NOT mean "no decode": `fitImageBlock` falls back to
 * the ordinary downscale whenever a full-size original breaches a host ceiling,
 * and that decode is not one byte cheaper for having been requested at full size.
 * Missing it left `size:'full'` charging nothing while running up to
 * MAX_FULL_OUTPUT_IMAGE_BLOCKS decodes of up to MAX_DECODE_PIXELS each - the
 * event-loop stall MAX_RESULT_DECODE_PIXELS exists to bound. Those retries also
 * emit SMALL blocks, so the byte budget cannot catch them either; this is the only
 * place that sees the cost.
 *
 * An UNPARSEABLE header on the default path counts as a decode: `downscaleImageForBlock`
 * skips both of its early returns without dimensions and does reach `PNG.sync.read`.
 * Saying otherwise would make this predicate false exactly where a decode happens, in
 * a module whose invariant is that no path may decode uncharged - so a future caller
 * treating it as the sole decode gate would be routed around the budget.
 */
function willDecode(full: boolean, mime: string, b64: string, dim: ImageDims, maxEdge: number, maxBytes: number): boolean {
	if (mime !== 'image/png') return false;
	if (!full) return !dim || Math.max(dim.width, dim.height) > maxEdge;
	return !withinHostLimits(b64, maxBytes, dim);
}

/** A fitted image plus what producing it actually cost the decoder. */
interface FittedImage {
	block: ImageBlockPayload | null;
	/** SOURCE pixels handed to the decoder across every attempt made here. */
	decodedPixels: number;
}

/**
 * One image, scaled to policy: downscale unless `full`, then enforce the host
 * ceilings — falling back to a downscale for an oversized `full` image, and
 * returning a null block only when even that does not fit (a huge non-PNG, which
 * we cannot resample). Never returns a payload we know the host would reject.
 *
 * The pixel bound is checked FIRST, before any decode: a raster past it is
 * declined outright rather than handed to pngjs (see `MAX_DECODE_PIXELS`). `dim`
 * is the caller's already-parsed header, threaded through so no path re-reads it
 * - and it is also the fallback for the block's own `width`/`height`, so a `full`
 * image and a non-PNG (neither of which is decoded) report the same pixel size a
 * downscaled one does rather than reporting none.
 */
function fitImageBlock(output_index: number, mime: string, b64: string, full: boolean, maxEdge: number, maxBytes: number, dim: ImageDims = imageDimensions(mime, b64)): FittedImage {
	if (exceedsDecodeBound(mime, b64, dim)) return { block: null, decodedPixels: 0 };
	const scaled = full ? { data: b64, resized: false as const, decodedPixels: 0 } : downscaleImageForBlock(mime, b64, maxEdge, dim);
	const build = (s: ScaledImage, note?: string): ImageBlockPayload => {
		const width = s.width ?? dim?.width;
		const height = s.height ?? dim?.height;
		return {
			output_index,
			mime: blockMime(mime),
			data: base64Payload(s.data),
			...(width != null && height != null ? { width, height } : {}),
			...(s.resized ? { downscaled: { from: `${width}×${height}`, to: `${s.scaledWidth}×${s.scaledHeight}`, ...(note ? { note } : { note: FETCH_FULL }) } } : {})
		};
	};
	if (withinHostLimits(scaled.data, maxBytes, emittedDims(scaled, dim))) return { block: build(scaled), decodedPixels: scaled.decodedPixels };
	// Over a host ceiling. A routine (already downscaled) image that still does not
	// fit is beyond what we can do; a `full` one gets the ordinary downscale as a
	// fallback, so "I asked for full res" degrades to a smaller figure, not to none.
	if (!full) return { block: null, decodedPixels: scaled.decodedPixels };
	const retry = downscaleImageForBlock(mime, b64, maxEdge, dim);
	const decodedPixels = scaled.decodedPixels + retry.decodedPixels;
	if (retry.resized && withinHostLimits(retry.data, maxBytes, emittedDims(retry, dim))) return { block: build(retry, 'the original exceeds the inline image size limit, so a downscaled copy is shown'), decodedPixels };
	return { block: null, decodedPixels };
}

/** The dimensions of the raster actually EMITTED - the resampled ones when we resized. */
function emittedDims(s: ScaledImage, original: ImageDims): ImageDims {
	return s.resized ? { width: s.scaledWidth!, height: s.scaledHeight! } : original;
}

/** Whether a raster is small enough (bytes AND pixels) for a host to accept it. */
function withinHostLimits(b64: string, maxBytes: number, dim: ImageDims): boolean {
	if (base64Bytes(b64) > maxBytes) return false;
	return !dim || Math.max(dim.width, dim.height) <= MAX_IMAGE_EDGE_HARD;
}

/**
 * Whether `buildImageBlocks` would actually SHOW this output on the default path —
 * decided from the header alone, so a caller can flag a figure without paying for
 * a decode. This is what `has_image` on a batch record means: not "an image mime
 * is present" but "a figure `get_full_output` can really display", so a raster the
 * policy declines never sends the agent on a round trip that returns the same text
 * placeholder it already had.
 *
 * A PNG over `maxEdge` is resampled down to it, so its shipped raster is bounded
 * on both axes (and at 768px cannot approach the byte ceiling) — that branch is a
 * yes without decoding. Everything else must already be inside the ceilings.
 */
export function canInlineImage(mime: string, b64: string, maxEdge = IMG_MAX_EDGE, maxBytes = IMAGE_BLOCK_MAX_BYTES): boolean {
	if (!isInlinableImageMime(mime)) return false;
	const dim = imageDimensions(mime, b64);
	if (exceedsDecodeBound(mime, b64, dim)) return false;
	if (mime === 'image/png' && dim && Math.max(dim.width, dim.height) > maxEdge) return true;
	return withinHostLimits(b64, maxBytes, dim);
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
