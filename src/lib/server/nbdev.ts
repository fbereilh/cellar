/**
 * nbdev coexistence: stop nbdev's cleanup erasing Cellar's notebook metadata.
 *
 * `nbdev-clean` - the CLI, and the Jupyter pre-save hook `nbdev-install-hooks`
 * wires up - rebuilds each notebook's metadata from an ALLOWLIST and drops
 * everything else. Cellar's whole namespace lives in `metadata.cellar` /
 * `cell.metadata.cellar` (export target and base, header numbering, per-cell
 * export marks, hide-from-agent, report view), so in an nbdev project all of it
 * is silently wiped by a hook the user installed once and forgot. Measured
 * against nbdev 3.3.12: `nb meta ['cellar','kernelspec'] -> ['kernelspec']`,
 * `cell meta {"cellar":{…}} -> {}`, exit 0, no warning.
 *
 * nbdev's own supported remedy is two keys in the project's `pyproject.toml`:
 *
 *   [tool.nbdev]
 *   allowed_metadata_keys = ["cellar"]
 *   allowed_cell_metadata_keys = ["cellar"]
 *
 * the same mechanism nbdev uses for `solveit` in its own repo, so Cellar's
 * metadata gets an officially-supported seat rather than a workaround.
 *
 * DETECT AND OFFER, never write unasked. `pyproject.toml` is a file the user
 * owns and may have under review, so this module only ever REPORTS on a page
 * load; the write happens on an explicit click, through `protectCellarMetadata`.
 * That is also why the write derives its own target and the route takes no path:
 * an endpoint that edited a caller-named file would be an arbitrary-file writer.
 *
 * Two boundaries worth stating plainly:
 *
 * - **The target may sit ABOVE the workspace.** nbdev's own project discovery
 *   walks up (`nbdev/config.py` `_find_nbdev_pyproject`), and a monorepo whose
 *   `[tool.nbdev]` lives at the repo root with Cellar opened in `nbs/` is the
 *   ordinary case - refusing there would leave the hazard unfixed exactly where
 *   nbdev says the config belongs. So this deliberately does NOT go through
 *   `resolveInWorkspace`, and what makes that safe is the offer: the absolute
 *   path is named on screen before anything is written, and the write only ever
 *   touches those two keys inside `[tool.nbdev]`.
 * - **Anything not a plain `[tool.nbdev]` table is REFUSED, not guessed at.**
 *   An inline table (`nbdev = { … }`), a dotted key, a value that is not an
 *   array of strings: each is a legal TOML shape this line-based editor cannot
 *   change without risking the rest of a file that is none of Cellar's business.
 *   A refusal names the two lines so the user can add them by hand - which
 *   works whatever the shape.
 * - **The one accepted formatting cost.** An edit replaces whole physical LINES,
 *   so an allowlist written across several lines is re-rendered on one (and a
 *   comment sitting INSIDE that array goes with it). It is scoped to the single
 *   key whose value is CHANGING - a key that already says `cellar` is left
 *   byte-identical, trailing comment and all - and it is the same property the
 *   sibling Codex writer in `harness.js` has. Pinned by test so the collapse is a
 *   decision rather than a surprise.
 *
 * No nbdev dependency, no Python, no subprocess: detection is a walk-up plus the
 * shared TOML scanner (`toml.js`), exactly as `harness.js` reads a Codex config.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from './write-file-atomic.js';
import {
	editTable,
	findTable,
	otherFormLine,
	parseStringArray,
	parseTomlDoc,
	readAssignment
} from './toml.js';
import { workspaceRoot } from './fstree';
import { ALLOWLIST_KEYS, CELLAR_METADATA_KEY, NBDEV_TABLE, type NbdevState } from '$lib/nbdev';

export type NbdevWriteStatus = 'written' | 'already' | 'refused' | 'failed';

export type NbdevWriteResult = {
	status: NbdevWriteStatus;
	/** What the project looks like AFTER the attempt - the card renders from this. */
	state: NbdevState;
	/** Present on `failed`: why the file could not be written. */
	error?: string;
};

/** Directories from `start` up to the filesystem root, nearest first. */
function ancestors(start: string): string[] {
	const out: string[] = [];
	let dir = resolve(start);
	for (;;) {
		out.push(dir);
		const up = dirname(dir);
		if (up === dir) return out;
		dir = up;
	}
}

function readText(file: string): { text: string | null; error?: string } {
	try {
		return { text: readFileSync(file, 'utf8') };
	} catch (e) {
		return { text: null, error: (e as Error)?.message ?? 'read failed' };
	}
}

/** A regular file at `p`? (`existsSync` alone would accept a directory.) */
function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/**
 * The keys a legacy nbdev `settings.ini` carries. nbdev raises on ANY
 * `settings.ini` it finds while looking for a project, but Cellar is
 * deliberately STRICTER: a bare `settings.ini` is an ordinary configparser
 * filename, and telling a user who has never touched nbdev that their project is
 * broken is the false nag this whole surface exists to avoid. Under-reporting is
 * the safe direction for a notice.
 */
const SETTINGS_INI_SIGNALS = /^\s*(lib_name|lib_path|nbs_path|doc_path|nbdev_\w+)\s*=/m;

/**
 * Does this `pyproject.toml` text look like it belongs to nbdev at all? Used only
 * to decide whether an UNREADABLE file is worth reporting - a broken TOML in a
 * project that never mentions nbdev is none of Cellar's business, and nbdev
 * itself just skips such a file (`_has_nbdev` swallows the parse error).
 */
const PYPROJECT_NBDEV_SIGNAL = /nbdev/;

type Located = { path: string; text: string; doc: ReturnType<typeof parseTomlDoc> };

/**
 * Classify one candidate `pyproject.toml`.
 *
 * `'skip'` means "not an nbdev project file, keep walking" - matching nbdev's own
 * `_has_nbdev`, which returns False for anything it cannot read.
 */
function classifyPyproject(path: string): NbdevState | Located | 'skip' {
	const { text } = readText(path);
	// A file we cannot open at all gives no evidence that this is nbdev's project,
	// so it is SKIPPED rather than reported - exactly what nbdev's own `_has_nbdev`
	// does with a read it cannot make. Reporting it would nag a user whose broken
	// `pyproject.toml` has nothing to do with nbdev. The failure that DOES matter is
	// at write time, where `protectCellarMetadata` reports it and changes nothing.
	if (text === null) return 'skip';
	const doc = parseTomlDoc(text);
	if (doc.malformed) {
		if (!PYPROJECT_NBDEV_SIGNAL.test(text)) return 'skip';
		return { kind: 'unreadable', path, reason: 'could not be read as TOML with confidence' };
	}
	if (findTable(doc, NBDEV_TABLE)) return { path, text, doc };
	const line = otherFormLine(doc, NBDEV_TABLE);
	if (line !== null) return { kind: 'other-form', path, line: line + 1 };
	return 'skip';
}

/** Read the value of one allowlist key: its array, or why it cannot be used. */
function readAllowlist(
	located: Located,
	key: string
): { found: false } | { found: true; span: { first: number; last: number }; values: string[] | null } {
	const table = findTable(located.doc, NBDEV_TABLE);
	const assignment = table ? readAssignment(located.doc, table, key) : null;
	if (!assignment) return { found: false };
	return {
		found: true,
		span: { first: assignment.first, last: assignment.last },
		values: parseStringArray(assignment.value)
	};
}

/** `key = ["a", "b"]`, quoted the way `harness.js` quotes an args array. */
function renderAllowlist(key: string, values: string[]): string {
	return `${key} = [${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

/** The state a located, readable nbdev `pyproject.toml` is in. */
function stateOf(located: Located): NbdevState {
	const missing: string[] = [];
	for (const key of ALLOWLIST_KEYS) {
		const read = readAllowlist(located, key);
		if (!read.found) {
			missing.push(key);
			continue;
		}
		if (read.values === null) {
			// A legal TOML value this line editor must not rewrite (a number, an inline
			// table, a computed-looking array). Refuse the WHOLE file rather than half
			// protect it: an ambiguous outcome is worse than a clear refusal that names
			// the two lines to add by hand.
			return { kind: 'unwritable-value', path: located.path, key, line: read.span.first + 1 };
		}
		if (!read.values.includes(CELLAR_METADATA_KEY)) missing.push(key);
	}
	return missing.length
		? { kind: 'unprotected', path: located.path, missing }
		: { kind: 'protected', path: located.path };
}

/**
 * What does the project around `workspace` look like right now?
 *
 * Never throws: any trouble degrades to a state that says so (or to `none`), so
 * this is safe to call during SSR.
 */
export function detectNbdev(workspace: string = safeWorkspace()): NbdevState {
	if (!workspace) return { kind: 'none' };
	let dirs: string[];
	try {
		dirs = ancestors(workspace);
	} catch {
		return { kind: 'none' };
	}
	for (const dir of dirs) {
		const path = join(dir, 'pyproject.toml');
		if (!isFile(path)) continue;
		let verdict: NbdevState | Located | 'skip';
		try {
			verdict = classifyPyproject(path);
		} catch {
			verdict = 'skip';
		}
		if (verdict === 'skip') continue;
		if ('kind' in verdict) return verdict;
		return stateOf(verdict);
	}
	// Only now, exactly as nbdev orders it: a `settings.ini` matters solely when no
	// `[tool.nbdev]` pyproject was found, because that is when nbdev raises.
	for (const dir of dirs) {
		const path = join(dir, 'settings.ini');
		if (!isFile(path)) continue;
		const { text } = readText(path);
		if (text !== null && SETTINGS_INI_SIGNALS.test(text)) return { kind: 'legacy-settings-ini', path };
	}
	return { kind: 'none' };
}

function safeWorkspace(): string {
	try {
		return workspaceRoot();
	} catch {
		return '';
	}
}

/**
 * Add `cellar` to both allowlists in the nbdev `pyproject.toml` above
 * `workspace`, merging with whatever is already there.
 *
 * Idempotent: a project already carrying `cellar` in both keys is `already` and
 * writes nothing. A key that exists with other values keeps them, in order, with
 * `cellar` appended. A key whose value already says `cellar` is left byte-identical
 * - the splice replaces whole physical lines, so rewriting it would destroy that
 * line's own comment and spacing to change nothing.
 *
 * The target is derived here, never supplied by the caller.
 */
export function protectCellarMetadata(workspace: string = safeWorkspace()): NbdevWriteResult {
	const state = detectNbdev(workspace);
	if (state.kind === 'protected') return { status: 'already', state };
	if (state.kind !== 'unprotected') return { status: 'refused', state };

	const { text, error } = readText(state.path);
	if (text === null) {
		return {
			status: 'failed',
			state: { kind: 'unreadable', path: state.path, reason: error ?? 'could not be read' },
			error: error ?? 'could not be read'
		};
	}
	const doc = parseTomlDoc(text);
	const table = findTable(doc, NBDEV_TABLE);
	if (doc.malformed || !table) {
		// The file moved under us between the detect and the write.
		return { status: 'refused', state: detectNbdev(workspace) };
	}
	const located: Located = { path: state.path, text, doc };

	const edits = [];
	for (const key of ALLOWLIST_KEYS) {
		const read = readAllowlist(located, key);
		if (!read.found) {
			edits.push({ replace: null, text: renderAllowlist(key, [CELLAR_METADATA_KEY]) });
			continue;
		}
		if (read.values === null) {
			return { status: 'refused', state: { kind: 'unwritable-value', path: state.path, key, line: read.span.first + 1 } };
		}
		if (read.values.includes(CELLAR_METADATA_KEY)) {
			edits.push({ replace: read.span, text: null });
			continue;
		}
		edits.push({
			replace: read.span,
			text: renderAllowlist(key, [...read.values, CELLAR_METADATA_KEY])
		});
	}

	const next = editTable(doc, table, edits);
	if (next === text) return { status: 'already', state: { kind: 'protected', path: state.path } };
	try {
		writeFileAtomic(state.path, next);
	} catch (e) {
		const why = (e as Error)?.message ?? 'write failed';
		// Honest about failure: the file is untouched (`writeFileAtomic` stages a temp
		// and renames), so the hazard is still live and the state still says so.
		return { status: 'failed', state: detectNbdev(workspace), error: why };
	}
	return { status: 'written', state: detectNbdev(workspace) };
}
