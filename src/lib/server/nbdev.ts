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
	parseTomlString,
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

/** PEP 621's own table, read only for the `lib_path` fallback (`[project].name`). */
const PROJECT_TABLE = ['project'];

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
		// Wrapped WHOLE, `stateOf` included: this runs during SSR of every page load,
		// so an unexpected throw would 500 the app for a feature almost no workspace
		// uses. A file that cannot be classified is skipped, exactly as nbdev's own
		// `_has_nbdev` skips one it cannot read.
		let verdict: NbdevState | 'skip';
		try {
			const found = classifyPyproject(path);
			verdict = found === 'skip' ? 'skip' : 'kind' in found ? found : stateOf(found);
		} catch {
			verdict = 'skip';
		}
		if (verdict === 'skip') continue;
		return verdict;
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

/**
 * Where nbdev would write a `#| default_exp` module: the project's `lib_path`,
 * absolute. Null when this is not an nbdev project at all.
 *
 * ## Why Cellar needs it
 *
 * nbdev's `default_exp` names a DOTTED MODULE, measured from `lib_path`, not a
 * path measured from anywhere Cellar knows. Cellar honoured the directive but
 * resolved it workspace-relative, so opening a real nbdev notebook and marking a
 * cell wrote a stray module at the workspace root instead of into the library
 * (scout report section 5.2). Honouring the directive that decides WHERE while
 * ignoring the config that decides the ROOT is worse than not honouring it: the
 * target resolves plausibly and writes to the wrong file.
 *
 * ## The rule, measured against nbdev 3.3.13 (`nbdev/config.py` `ConfigToml`)
 *
 * `lib_path` is `[tool.nbdev].lib_path` when present, else `[project].name` with
 * `-` replaced by `_`; either way it is resolved against the DIRECTORY HOLDING THE
 * `pyproject.toml`, and an absent/empty project name degenerates to that directory
 * itself. All four cases were driven through real nbdev rather than remembered.
 *
 * ## Refusing rather than guessing
 *
 * `ok:false` means this IS an nbdev project whose `lib_path` cannot be read with
 * confidence - a `[tool.nbdev]` in a form the line-based scanner will not touch (an
 * inline table, a dotted key), a `pyproject.toml` that is not valid TOML, or a
 * `lib_path` that is not a plain single-line string. The caller must NOT fall back
 * to workspace-relative there: that is exactly the wrong-file write above. It
 * refuses the target instead, and the escape hatch is already there and untouched -
 * an explicit `metadata.cellar.export_target` never consults any of this.
 *
 * ## Cost
 *
 * Only a notebook carrying a `#| default_exp` directive ever asks, so an ordinary
 * Cellar notebook pays nothing. For those that do, the answer is cached on a short
 * TTL (`listWorktreesAt`'s tier, and for its reason: a `pyproject.toml` edit must
 * show up promptly, while a burst of resolutions - the agent map resolves per read
 * - must not each walk the ancestors and re-parse TOML on the process carrying the
 * kernel websockets and the SSE fan-out). Deliberately not memoized for the process
 * lifetime the way `preflight` is: repo identity does not change, a project's
 * `lib_path` can.
 *
 * STATED LIMIT: nbdev also merges a USER-level `~/.config/nbdev/config.toml` under
 * the project's `[tool.nbdev]`, so a user who sets `lib_path` there and omits it
 * from the project would get a different answer from nbdev than from Cellar. Not
 * modelled: reading the user's XDG config is outside this, project config wins
 * wherever it is present, and the failure is visible (the module lands in the
 * project-derived directory) rather than silent.
 */
export type NbdevLibPath =
	| { ok: true; libPath: string; configPath: string }
	| { ok: false; configPath: string; reason: string };

const LIB_PATH_TTL_MS = 2000;
let libPathCache: { workspace: string; at: number; value: NbdevLibPath | null } | null = null;

export function nbdevLibPath(workspace: string = safeWorkspace()): NbdevLibPath | null {
	const now = Date.now();
	if (libPathCache && libPathCache.workspace === workspace && now - libPathCache.at < LIB_PATH_TTL_MS)
		return libPathCache.value;
	const value = readNbdevLibPath(workspace);
	libPathCache = { workspace, at: now, value };
	return value;
}

/** Drop the `lib_path` cache. For tests, and for a write that moves the config. */
export function invalidateNbdevLibPath(): void {
	libPathCache = null;
}

function readNbdevLibPath(workspace: string): NbdevLibPath | null {
	if (!workspace) return null;
	let dirs: string[];
	try {
		dirs = ancestors(workspace);
	} catch {
		return null;
	}
	for (const dir of dirs) {
		const path = join(dir, 'pyproject.toml');
		if (!isFile(path)) continue;
		// Wrapped whole for the reason `detectNbdev` is: this rides `getNotebook`, so
		// an unexpected throw would take down a read rather than a feature.
		let verdict: NbdevLibPath | 'skip';
		try {
			verdict = libPathFrom(path);
		} catch {
			verdict = { ok: false, configPath: path, reason: 'it could not be read' };
		}
		if (verdict === 'skip') continue;
		return verdict;
	}
	return null;
}

/** Read one candidate `pyproject.toml`, or `'skip'` when it is not nbdev's. */
function libPathFrom(path: string): NbdevLibPath | 'skip' {
	const { text } = readText(path);
	if (text === null) return 'skip'; // no evidence this is nbdev's project - `_has_nbdev`'s own stance
	const doc = parseTomlDoc(text);
	if (doc.malformed) {
		if (!PYPROJECT_NBDEV_SIGNAL.test(text)) return 'skip';
		return { ok: false, configPath: path, reason: 'it could not be read as TOML with confidence' };
	}
	const table = findTable(doc, NBDEV_TABLE);
	if (!table) {
		const line = otherFormLine(doc, NBDEV_TABLE);
		if (line === null) return 'skip';
		return {
			ok: false,
			configPath: path,
			reason: `its ${NBDEV_TABLE.join('.')} is not a plain table (line ${line + 1})`
		};
	}
	const dir = dirname(path);
	const assigned = readAssignment(doc, table, 'lib_path');
	if (assigned) {
		const value = parseTomlString(assigned.value);
		if (value === null || !value.trim())
			return {
				ok: false,
				configPath: path,
				reason: `its lib_path (line ${assigned.first + 1}) is not a plain string`
			};
		return { ok: true, libPath: resolve(dir, value.trim()), configPath: path };
	}
	// nbdev's fallback: the project name with `-` folded to `_`. An absent or empty
	// name degenerates to the config directory itself, which is what nbdev does.
	const project = findTable(doc, PROJECT_TABLE);
	const nameAssigned = project ? readAssignment(doc, project, 'name') : null;
	const name = nameAssigned ? parseTomlString(nameAssigned.value) : null;
	if (nameAssigned && name === null)
		return {
			ok: false,
			configPath: path,
			reason: `it sets no lib_path, and its project name (line ${nameAssigned.first + 1}) is not a plain string`
		};
	return { ok: true, libPath: resolve(dir, (name ?? '').trim().replace(/-/g, '_')), configPath: path };
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
