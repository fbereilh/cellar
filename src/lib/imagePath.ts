/**
 * Cellar — image file identity + content types (shared, browser-safe, pure).
 *
 * One source of truth for "is this path an image the shell renders in an image
 * tab" and "what Content-Type does the raw route serve it as". Imported by the
 * shell (`+page.svelte` tab-kind resolution), the raw-bytes route
 * (`/api/fs/raw`), and the unit tests, so the extension set can never drift
 * between the three. No Node/DOM APIs, so it's safe on either side.
 */

/**
 * Extension → MIME content type for the image kinds the shell renders. SVG is
 * served as `image/svg+xml` but is only ever loaded through an `<img src>` (an
 * `<img>` never executes embedded SVG script), never injected as inline DOM.
 */
export const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	avif: 'image/avif'
};

/** Lowercase extension of a path (no dot), or '' when it has none. */
function extOf(path: string): string {
	const name = path.split(/[/\\]/).pop() ?? path;
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** True when `path` names an image file the shell opens in an image tab. */
export function isImagePath(path: string): boolean {
	return extOf(path) in IMAGE_CONTENT_TYPES;
}

/**
 * Content-Type for an image path, or null when the extension is not a known
 * image kind. The route uses null to reject non-image paths.
 */
export function imageContentType(path: string): string | null {
	return IMAGE_CONTENT_TYPES[extOf(path)] ?? null;
}
