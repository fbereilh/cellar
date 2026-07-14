/**
 * Cellar — workspace git status (shell sidebar file tree decorations) and
 * git-HEAD baselines (editor gutter + notebook cell change decorations).
 *
 * `gitStatus()` reports per-file status so the file tree can decorate entries
 * the way VS Code does (colored name + status letter, folder rollup).
 * `gitHeadFile()` hands out one file's content at HEAD, which the browser diffs
 * the live buffer against (see `src/lib/gitdiff.js`) — diffing client-side keeps
 * the markers live as you type without a `git` process per keystroke.
 *
 * Everything degrades gracefully when the workspace is not a git repository:
 * `isRepo:false`, never an error.
 *
 * Independent of the notebook document/kernel — this only shells out to `git`
 * with the workspace root as the working directory.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { workspaceRoot, resolveInWorkspace } from './fstree';

const MAX_GIT_BUFFER = 8 * 1024 * 1024;

/** Single-letter git decoration, matching VS Code's convention. */
export type GitStatusLetter = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

/** Result of `gitStatus()`: whether the workspace is a repo + its file decorations. */
export interface GitStatusResult {
	isRepo: boolean;
	files: Record<string, GitStatusLetter>;
	/**
	 * Git-ignored paths (workspace-relative), so the file tree can grey them the
	 * way VS Code does. A whole ignored directory is one entry WITH a trailing
	 * slash (`build/`); individually-ignored files carry no slash (`secret.txt`).
	 * The client greys a node when its path matches an entry exactly or sits under
	 * an ignored directory prefix (see `$lib/gitIgnored`).
	 */
	ignored: string[];
}

/** Result of `gitBranch()`: the current branch (or short SHA when detached). */
export interface GitBranchResult {
	isRepo: boolean;
	/** Branch name on a normal HEAD, short commit SHA when detached, else null. */
	branch: string | null;
	/** True when HEAD is detached — the client renders the SHA in parentheses. */
	detached: boolean;
}

/** Result of `gitHeadFile()`: one file's content as of git HEAD. */
export interface GitHeadFileResult {
	isRepo: boolean;
	tracked: boolean;
	content: string | null;
}

/** One parsed `git blame --line-porcelain` line record. */
export interface BlameLine {
	commit: string;
	shortSha: string | null;
	author: string;
	authorTime: number | null;
	summary: string;
	notCommitted: boolean;
}

/** Result of `gitBlameFile()`. */
export interface GitBlameFileResult {
	isRepo: boolean;
	tracked: boolean;
	lines: BlameLine[];
}

/**
 * Result of `gitBlameNotebookCells()`: per-cell blame keyed by stable cell id.
 * Each record is a `BlameLine` (an uncommitted/new cell is a `notCommitted:true`
 * record), so the status-bar footer renders it with the exact same markup as a
 * file's cursor-line blame.
 */
export interface GitBlameNotebookResult {
	isRepo: boolean;
	tracked: boolean;
	cells: Record<string, BlameLine>;
}

/**
 * Collapse a two-char porcelain XY code into a single display letter, matching
 * VS Code's git decorations:
 *   M modified · A added · D deleted · R renamed · U untracked · C conflict
 */
function classify(xy: string): GitStatusLetter {
	const x = xy[0];
	const y = xy[1];
	if (xy === '??') return 'U'; // untracked
	// Unmerged / conflict states (both sides touched, or an unmerged marker).
	if (x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA') return 'C';
	// Prefer the working-tree change, then the staged one.
	const c = y !== ' ' && y !== '?' ? y : x;
	if (c === 'A') return 'A';
	if (c === 'M') return 'M';
	if (c === 'D') return 'D';
	if (c === 'R') return 'R';
	if (c === 'C') return 'A'; // copied → treat as added
	if (c === 'T') return 'M'; // type change → modified
	return 'M';
}

/**
 * Run `git status --porcelain` at the workspace root (NUL-delimited).
 * `--ignored=matching` folds ignored paths into the same output as `!!` entries
 * (a wholly-ignored directory collapses to one `dir/` entry, scattered ignored
 * files list individually) so status + ignore come back in one git call.
 */
function runStatus(root: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			'git',
			['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '-z', '--', '.'],
			{ maxBuffer: 8 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					// Not a repo, or git missing → no decorations, no error.
					resolve(null);
					return;
				}
				resolve(stdout);
			}
		);
	});
}

/**
 * The workspace path relative to the git repo root (e.g. `sub/deep/`, with a
 * trailing slash, or `''` when the workspace *is* the repo root). Porcelain
 * paths are repo-root-relative, so we strip this to key the map by the same
 * workspace-relative paths the file tree uses.
 */
function runPrefix(root: string): Promise<string> {
	return new Promise((resolve) => {
		execFile('git', ['-C', root, 'rev-parse', '--show-prefix'], (err, stdout) => {
			if (err) {
				resolve('');
				return;
			}
			resolve(stdout.trim());
		});
	});
}

/**
 * Parse NUL-delimited porcelain v1 output into a { relPath: letter } map.
 * Rename entries in `-z` mode emit two NUL-separated fields (new, then orig);
 * we key the new path and skip the trailing original.
 *
 * @param {string} stdout NUL-delimited porcelain output.
 * @param {string} prefix Workspace path relative to the repo root (trailing
 *   slash), stripped so keys are workspace-relative. Paths outside the
 *   workspace subtree are dropped.
 * @returns Status letters keyed by path, plus the list of git-ignored paths
 *   (`!!` entries; directories keep their trailing slash).
 */
function parse(stdout: string, prefix: string): { files: Record<string, GitStatusLetter>; ignored: string[] } {
	const map: Record<string, GitStatusLetter> = {};
	const ignored: string[] = [];
	const parts = stdout.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) continue;
		const xy = entry.slice(0, 2);
		let path = entry.slice(3); // skip "XY "
		// A rename/copy carries the original path in the next field — consume it.
		if (xy[0] === 'R' || xy[0] === 'C') i++;
		if (!path) continue;
		if (prefix) {
			if (!path.startsWith(prefix)) continue; // outside the workspace subtree
			path = path.slice(prefix.length);
		}
		if (!path) continue;
		if (xy === '!!') ignored.push(path); // git-ignored (dirs keep trailing slash)
		else map[path] = classify(xy);
	}
	return { files: map, ignored };
}

/**
 * Git status for the workspace.
 * @returns {Promise<{isRepo: boolean, files: Record<string,string>}>}
 */
export async function gitStatus(): Promise<GitStatusResult> {
	const root = workspaceRoot();
	const stdout = await runStatus(root);
	if (stdout == null) return { isRepo: false, files: {}, ignored: [] };
	const prefix = await runPrefix(root);
	const { files, ignored } = parse(stdout, prefix);
	return { isRepo: true, files, ignored };
}

/**
 * The current git branch for the workspace.
 *
 * A normal (even unborn/no-commits-yet) branch resolves via `symbolic-ref`; a
 * detached HEAD makes that fail, so we fall back to the short commit SHA and
 * flag `detached` (the client renders it parenthesized, VS Code-style). A
 * non-repo returns `{isRepo:false, branch:null}` so the header shows no chip.
 */
export async function gitBranch(): Promise<GitBranchResult> {
	const root = workspaceRoot();
	// Succeeds on any real branch (including one with no commits yet); `--quiet`
	// makes a detached HEAD exit non-zero silently → runGit resolves null.
	const sym = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
	if (sym != null) {
		const branch = sym.trim();
		return { isRepo: true, branch: branch || null, detached: false };
	}
	// Either detached HEAD or not a repo — a short SHA distinguishes them.
	const sha = await runGit(root, ['rev-parse', '--short', 'HEAD']);
	if (sha != null) return { isRepo: true, branch: sha.trim(), detached: true };
	// No SHA: confirm whether this is even a repo (an empty/detached repo is rare).
	const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
	return { isRepo: inside != null, branch: null, detached: false };
}

/** Run a git subcommand at the workspace root; `null` on any failure. */
function runGit(root: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile('git', ['-C', root, ...args], { maxBuffer: MAX_GIT_BUFFER }, (err, stdout) => {
			resolve(err ? null : stdout);
		});
	});
}

/**
 * One workspace file's content as of git HEAD — the baseline the editor and the
 * notebook diff against.
 *
 * `tracked:false` (with `content:null`) covers every case where HEAD has nothing
 * to compare against: not a repo, no commits yet, an untracked or newly-added
 * file, or a binary blob. Callers show no decorations then, exactly as VS Code
 * leaves a brand-new file's gutter empty — the file tree's `U`/`A` letter is
 * already the whole story.
 *
 * @param {string} relPath Workspace-relative path (path-guarded).
 * @returns {Promise<{isRepo: boolean, tracked: boolean, content: string|null}>}
 */
export async function gitHeadFile(relPath: string): Promise<GitHeadFileResult> {
	const root = workspaceRoot();
	resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	if ((await runGit(root, ['rev-parse', '--is-inside-work-tree'])) == null) {
		return { isRepo: false, tracked: false, content: null };
	}
	// Porcelain paths (and `git show`'s object syntax) are repo-root-relative.
	const prefix = await runPrefix(root);
	const content = await runGit(root, ['show', `HEAD:${prefix}${rel}`]);
	if (content == null) return { isRepo: true, tracked: false, content: null };
	// A NUL byte means a binary blob; there is no line diff to draw.
	if (content.includes('\0')) return { isRepo: true, tracked: false, content: null };
	return { isRepo: true, tracked: true, content };
}

/** The 40-char all-zero SHA git blame uses for not-yet-committed local lines. */
const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Parse `git blame --line-porcelain` into one record per line, in file order.
 * `--line-porcelain` repeats the full commit header for every line, so we never
 * have to remember a commit block across lines — each line is self-describing.
 *
 * A line with local (uncommitted) modifications is blamed against the all-zero
 * SHA with author `Not Committed Yet`; we flag it `notCommitted` so the UI can
 * say "You · uncommitted" instead of a bogus author/date.
 */
function parseBlame(stdout: string): BlameLine[] {
	const lines: BlameLine[] = [];
	let cur: { commit: string; author: string; authorTime: number; summary: string; notCommitted: boolean } | null =
		null;
	for (const raw of stdout.split('\n')) {
		// A header line "<sha> <orig> <final> [count]" opens a new line's block.
		if (/^[0-9a-f]{40} \d+ \d+/.test(raw)) {
			const sha = raw.slice(0, 40);
			cur = { commit: sha, author: '', authorTime: 0, summary: '', notCommitted: sha === ZERO_SHA };
			continue;
		}
		if (!cur) continue;
		if (raw.startsWith('author ')) cur.author = raw.slice(7);
		else if (raw.startsWith('author-time ')) cur.authorTime = Number(raw.slice(12)) * 1000;
		else if (raw.startsWith('summary ')) cur.summary = raw.slice(8);
		else if (raw.startsWith('\t')) {
			// The tab-prefixed content line closes the block — commit the record.
			lines.push({
				commit: cur.commit,
				shortSha: cur.notCommitted ? null : cur.commit.slice(0, 7),
				author: cur.author,
				authorTime: cur.authorTime || null,
				summary: cur.summary,
				notCommitted: cur.notCommitted
			});
			cur = null;
		}
	}
	return lines;
}

/**
 * Per-line git blame for one workspace file — who last touched each line and when.
 * Blames the working-tree file, so locally-modified (unsaved-to-git) lines come
 * back flagged `notCommitted` ("Not Committed Yet"), matching VS Code/GitLens.
 *
 * `tracked:false` (empty `lines`) covers every no-blame case: not a repo, no
 * commits, an untracked file, or a binary blob — the caller then shows nothing.
 *
 * @param {string} relPath Workspace-relative path (path-guarded).
 * @returns {Promise<{isRepo: boolean, tracked: boolean, lines: Array<object>}>}
 */
export async function gitBlameFile(relPath: string): Promise<GitBlameFileResult> {
	const root = workspaceRoot();
	resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	if ((await runGit(root, ['rev-parse', '--is-inside-work-tree'])) == null) {
		return { isRepo: false, tracked: false, lines: [] };
	}
	// `--incremental` off; `-w` ignores whitespace-only reblame noise. A file with
	// no HEAD blob (untracked / newly added) makes blame fail → tracked:false.
	const out = await runGit(root, ['blame', '--line-porcelain', '-w', '--', rel]);
	if (out == null) return { isRepo: true, tracked: false, lines: [] };
	return { isRepo: true, tracked: true, lines: parseBlame(out) };
}

/** A `Not Committed Yet` blame record for a cell with no committed source lines. */
function notCommittedRecord(): BlameLine {
	return { commit: ZERO_SHA, shortSha: null, author: 'Not Committed Yet', authorTime: null, summary: '', notCommitted: true };
}

/**
 * Map each cell id in a serialized `.ipynb` to the 1-based FILE LINES its `source`
 * occupies, by parsing the JSON while tracking line numbers.
 *
 * We can't use `JSON.parse` here: git blame is per file line, so we need to know
 * which physical line each `source` string sits on. Cellar's clean-on-save writes
 * deterministic, pretty-printed nbformat (1-space indent) where every `source`
 * array element is its own JSON string on its own line — and a JSON string is
 * always single-line (a raw `\n` is escaped), so a string token's start line IS
 * its file line for any pretty-printed notebook, cellar-authored or not.
 *
 * Returns `null` when the text isn't a notebook object with a `cells` array — the
 * caller then reports `tracked:false` (nothing to blame), like the HEAD route does
 * for an unparseable baseline.
 */
function cellSourceLines(text: string): Map<string, number[]> | null {
	let i = 0;
	let line = 1;
	const n = text.length;

	/** A parsed node: strings carry the file line they start on. */
	type StringNode = { type: 'string'; value: string; line: number };
	type Node =
		| { type: 'object'; props: Record<string, Node> }
		| { type: 'array'; items: Node[] }
		| StringNode
		| { type: 'other' };

	function skipWs(): void {
		while (i < n) {
			const c = text[i];
			if (c === '\n') { line++; i++; }
			else if (c === ' ' || c === '\t' || c === '\r') i++;
			else break;
		}
	}

	function parseString(): StringNode {
		const startLine = line;
		i++; // opening quote
		let s = '';
		while (i < n) {
			const c = text[i++];
			if (c === '\\') {
				const e = text[i++];
				if (e === 'n') s += '\n';
				else if (e === 't') s += '\t';
				else if (e === 'r') s += '\r';
				else if (e === 'b') s += '\b';
				else if (e === 'f') s += '\f';
				else if (e === 'u') { s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16) || 0); i += 4; }
				else s += e; // \" \\ \/ and anything else → the literal char
			} else if (c === '"') {
				break;
			} else {
				if (c === '\n') line++; // not valid JSON inside a string, but stay honest
				s += c;
			}
		}
		return { type: 'string', value: s, line: startLine };
	}

	function parseValue(): Node {
		skipWs();
		const c = text[i];
		if (c === '{') return parseObject();
		if (c === '[') return parseArray();
		if (c === '"') return parseString();
		// number / true / false / null — value we don't care about, scan to a delimiter.
		while (i < n) {
			const ch = text[i];
			if (ch === ',' || ch === '}' || ch === ']' || ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') break;
			i++;
		}
		return { type: 'other' };
	}

	function parseObject(): Node {
		const props: Record<string, Node> = {};
		i++; // '{'
		skipWs();
		if (text[i] === '}') { i++; return { type: 'object', props }; }
		while (i < n) {
			skipWs();
			if (text[i] !== '"') throw new Error('bad json');
			const key = parseString().value;
			skipWs();
			if (text[i] !== ':') throw new Error('bad json');
			i++; // ':'
			props[key] = parseValue();
			skipWs();
			const sep = text[i++];
			if (sep === ',') continue;
			if (sep === '}') break;
			throw new Error('bad json');
		}
		return { type: 'object', props };
	}

	function parseArray(): Node {
		const items: Node[] = [];
		i++; // '['
		skipWs();
		if (text[i] === ']') { i++; return { type: 'array', items }; }
		while (i < n) {
			items.push(parseValue());
			skipWs();
			const sep = text[i++];
			if (sep === ',') continue;
			if (sep === ']') break;
			throw new Error('bad json');
		}
		return { type: 'array', items };
	}

	let root: Node;
	try {
		root = parseValue();
	} catch {
		return null;
	}
	if (root.type !== 'object') return null;
	const cellsNode = root.props.cells;
	if (!cellsNode || cellsNode.type !== 'array') return null;

	const map = new Map<string, number[]>();
	for (const cellNode of cellsNode.items) {
		if (cellNode.type !== 'object') continue;
		const idNode = cellNode.props.id;
		if (!idNode || idNode.type !== 'string' || !idNode.value) continue; // can't key without an id
		const srcNode = cellNode.props.source;
		const lines: number[] = [];
		if (srcNode) {
			if (srcNode.type === 'array') {
				for (const el of srcNode.items) if (el.type === 'string') lines.push(el.line);
			} else if (srcNode.type === 'string') {
				lines.push(srcNode.line);
			}
		}
		map.set(idNode.value, lines);
	}
	return map;
}

/**
 * Per-CELL git blame for a notebook — who last touched each cell and when, keyed
 * by the cell's stable nbformat id. The shell shows the focused cell's record in
 * the same bottom status bar a file tab uses for its cursor line.
 *
 * We blame the on-disk `.ipynb` per line (`gitBlameFile`'s machinery), read the
 * exact bytes git blamed to learn which file lines each cell's `source` spans
 * (`cellSourceLines`), then reduce each cell to its MOST-RECENT contributing
 * commit (max author-time across its source lines). A cell whose source lines are
 * all locally-modified or brand-new (no committed line) comes back `notCommitted`
 * — so an edited-but-uncommitted cell reads "You, uncommitted" rather than a stale
 * old author. Blaming the working-tree file is what makes that automatic: an edit
 * autosaves to disk, git sees those lines as uncommitted, and the next refetch
 * reflects it.
 *
 * `tracked:false` (empty `cells`) covers every no-blame case: not a repo, an
 * untracked/new notebook, or on-disk bytes that don't parse as a notebook.
 *
 * @param {string} relPath Workspace-relative path (path-guarded).
 */
export async function gitBlameNotebookCells(relPath: string): Promise<GitBlameNotebookResult> {
	const root = workspaceRoot();
	const abs = resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	if ((await runGit(root, ['rev-parse', '--is-inside-work-tree'])) == null) {
		return { isRepo: false, tracked: false, cells: {} };
	}
	const out = await runGit(root, ['blame', '--line-porcelain', '-w', '--', rel]);
	if (out == null) return { isRepo: true, tracked: false, cells: {} }; // untracked / no HEAD blob
	const blame = parseBlame(out);

	let text: string;
	try {
		text = readFileSync(abs, 'utf8');
	} catch {
		return { isRepo: true, tracked: false, cells: {} };
	}
	const cellLines = cellSourceLines(text);
	if (!cellLines) return { isRepo: true, tracked: false, cells: {} };

	const cells: Record<string, BlameLine> = {};
	for (const [id, lineNums] of cellLines) {
		// An uncommitted (locally-modified or brand-new) source line is the MOST-RECENT
		// contribution to the cell — newer than any commit — so any such line makes the
		// whole cell read "You, uncommitted" rather than a stale committed author. This
		// is also the dirty-cell case: an edit autosaves to disk, git flags those lines
		// uncommitted, and the cell surfaces as uncommitted on the next refetch.
		let best: BlameLine | null = null;
		let dirty = false;
		for (const ln of lineNums) {
			const rec = blame[ln - 1];
			if (!rec) continue;
			if (rec.notCommitted) { dirty = true; break; }
			if (rec.authorTime == null) continue;
			if (!best || (rec.authorTime ?? 0) > (best.authorTime ?? 0)) best = rec;
		}
		// No source line at all (empty cell) is likewise treated as uncommitted.
		cells[id] = dirty || !best ? notCommittedRecord() : best;
	}
	return { isRepo: true, tracked: true, cells };
}
