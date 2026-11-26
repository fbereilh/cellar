/**
 * Cellar - the rules behind the file explorer's Paste and Duplicate.
 *
 * Pure and DOM-free, the `fileDrag.ts` precedent: vitest runs without the
 * SvelteKit plugin, so a rule left inside `Sidebar.svelte` could not be driven
 * by a test. `fstree.ts` names copies through `freeName`, so the server's collision
 * rule and the one the tests pin are the same function.
 */
import { parentDirOf } from '$lib/fileDrag';

/**
 * The `n`th collision-free candidate for `name`: `utils copy.py`, then
 * `utils copy 2.py`, ... The extension stays last so the copy still opens as
 * the same kind of file. A name with no extension, or a dot-led one such as a
 * folder called `v1.0`, splits at its LAST dot exactly as Node's `extname`
 * does, so this agrees with the server byte for byte.
 */
export function copyName(name: string, n: number): string {
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot) : '';
	const stem = ext ? name.slice(0, -ext.length) : name;
	const suffix = n === 1 ? ' copy' : ` copy ${n}`;
	return `${stem}${suffix}${ext}`;
}

/**
 * The name a copy into a folder lands under: `name` itself when it is free,
 * else the first free `copyName`. `taken` answers for the destination folder.
 */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
	if (!taken(name)) return name;
	for (let n = 1; ; n++) {
		const candidate = copyName(name, n);
		if (!taken(candidate)) return candidate;
	}
}

/** A row the explorer can paste onto: a folder, a file, or the tree's root area. */
export interface PasteRow {
	type: 'file' | 'dir' | 'root';
	/** Workspace-relative path; '' for the root. */
	path: string;
}

/**
 * The folder a paste onto `row` writes into. A folder takes it, a FILE hands it
 * to its own folder (the VS Code rule, so Cmd+V on a selected file pastes next
 * to it), and the root area means the workspace root ('').
 */
export function pasteTargetDir(row: PasteRow | null): string {
	if (!row || row.type === 'root') return '';
	return row.type === 'dir' ? row.path : parentDirOf(row.path);
}

/** Where a paste takes its content from. */
export type PasteSource = 'cellar' | 'os' | 'none';

/**
 * Which clipboard a paste EVENT reads: the explorer's own Cut/Copy, or files
 * from the system clipboard (copied in Finder, or a screenshot).
 *
 * The most recent copy wins, and that is knowable: every explorer Cut/Copy
 * also writes the copied path to the system clipboard as plain text. So when
 * the system clipboard still holds files, they were copied AFTER that write.
 * When the write could not be confirmed, the explorer's own clipboard keeps
 * first claim, because the files on the system clipboard may be older.
 */
export function pasteSource(opts: {
	/** The explorer holds a Cut/Copy. */
	cellar: boolean;
	/** That Cut/Copy is confirmed on the system clipboard. */
	cellarOnSystemClipboard: boolean;
	/** The paste event carries at least one file. */
	osFiles: boolean;
}): PasteSource {
	if (opts.osFiles && (!opts.cellar || opts.cellarOnSystemClipboard)) return 'os';
	if (opts.cellar) return 'cellar';
	return opts.osFiles ? 'os' : 'none';
}

/**
 * Bytes per upload request. adapter-node refuses any request body over its
 * `BODY_SIZE_LIMIT` (512 K by default, see `$lib/saveLimit.ts`) before a route
 * runs, and Cellar does not raise that limit. A pasted screenshot is routinely
 * several MB, so a paste is sent in chunks that each fit with room to spare.
 */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;

/** The `[start, end)` byte ranges a `size`-byte file is sent in. Always one, even for an empty file. */
export function uploadChunks(size: number, chunk = UPLOAD_CHUNK_BYTES): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let start = 0; start < size; start += chunk) out.push([start, Math.min(size, start + chunk)]);
	if (out.length === 0) out.push([0, 0]);
	return out;
}
