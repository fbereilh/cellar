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
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceRoot, resolveInWorkspace } from './fstree';
import { MAX_FILE_BYTES } from '$lib/server/limits.js';

/**
 * Cap on a single `git` subprocess's stdout. Node's `execFile` REJECTS with an
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` error the moment stdout crosses this — it
 * does NOT hand back the bytes read so far — so an undersized cap silently loses
 * a legitimately large result (e.g. `git show HEAD:big.ipynb` for a notebook with
 * many/large outputs). Node's own default is a stingy 1 MB; we raise it well past
 * any realistic tracked-file blob. An overflow past even this is surfaced by
 * `runGit` (logged + honest degrade) rather than masqueraded as "not tracked".
 */
const MAX_GIT_BUFFER = 256 * 1024 * 1024;

/**
 * Every `git` subprocess this module spawns bumps this counter. The shell fires a
 * burst of git-backed requests on each window focus and each save (file-tree
 * status, per-file HEAD baselines, per-file/cell blame), so the counter is how we
 * observe — in tests and in the E2E smoke test — that the memoized preflights and
 * the status/blame caches actually collapse that fan-out.
 */
let spawnCount = 0;
/**
 * The subcommand of every `git` spawned since the last reset, in order. The
 * count alone cannot express the guarantee the size gate makes — "no
 * `blame --line-porcelain` ran on this file" — because refusing honestly costs
 * one cheap index lookup, so a test asserting a bare zero would forbid the
 * lookup instead of the multi-second call it exists to prevent.
 */
let spawnLog: string[] = [];
/** Total `git` subprocesses spawned by this module since the last reset. */
export function gitSpawnCount(): number {
	return spawnCount;
}
/** The subcommand (`argv[0]`) of each `git` spawned since the last reset. */
export function gitSpawnLog(): string[] {
	return spawnLog.slice();
}
/** Reset the spawn counter (tests / E2E measurement). */
export function resetGitSpawnCount(): void {
	spawnCount = 0;
	spawnLog = [];
}

/**
 * Backstop TTL for the mtime-keyed status/blame/HEAD caches. The real
 * invalidator is the cache signature (target file mtime + git index mtime, see
 * `cacheSig`), which catches every ordinary mutation — a working-tree edit, a
 * stage, a commit, a checkout. The TTL only exists to self-heal the exotic
 * history moves that touch neither (e.g. `git reset --soft`), so it is generous:
 * a burst of identical requests within one focus/save is served from cache, and
 * an unchanged file re-probes at most once per window.
 */
const CACHE_TTL_MS = 5000;

/**
 * Status has a workspace-wide blind spot the per-file caches don't: an UNSTAGED
 * edit made outside cellar touches neither the git index nor a file we key on, so
 * only the TTL bounds its staleness. A quick external edit can be bracketed by a
 * shorter blur→focus gap than a full commit, so status uses a tighter backstop
 * than blame/HEAD. In-app saves clear it outright via `invalidateGitStatusCache`.
 */
const STATUS_TTL_MS = 1500;

/**
 * A negative repo detection ("this path is not inside a git work tree") is
 * re-probed after this long, so a `git init` performed mid-session is picked up
 * promptly. A positive detection is cached for the life of the process — a
 * workspace does not stop being a git repo in a way that matters here.
 */
const PREFLIGHT_MISS_TTL_MS = 4000;

/**
 * Session-stable repo-detection preflights for one directory: whether it is
 * inside a work tree, its path relative to the repo root (porcelain/`git show`
 * paths are repo-root-relative, so we strip this), and the absolute git dir
 * (whose `index` mtime is our cheap, spawn-free "history changed" signal).
 */
interface Preflight {
	inside: boolean;
	prefix: string;
	gitDir: string | null;
	at: number;
}
const preflightCache = new Map<string, Preflight>();

/**
 * Resolve (and memoize) the three repo-detection preflights for `root` in ONE
 * `git rev-parse` spawn. These are stable for the session, so caching them is
 * what removes the bulk of the per-focus/per-save git fan-out — every endpoint
 * used to re-derive `--is-inside-work-tree` / `--show-prefix` on every call.
 */
async function preflight(root: string): Promise<Preflight> {
	const cached = preflightCache.get(root);
	// A positive detection never expires; a negative one is re-probed after a
	// short TTL to catch a mid-session `git init`.
	if (cached && (cached.inside || Date.now() - cached.at < PREFLIGHT_MISS_TTL_MS)) return cached;

	const out = await runGit(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--absolute-git-dir']);
	let info: Preflight;
	if (out == null) {
		info = { inside: false, prefix: '', gitDir: null, at: Date.now() };
	} else {
		const lines = out.split('\n');
		const inside = lines[0]?.trim() === 'true';
		const prefix = (lines[1] ?? '').trim();
		const gitDir = (lines[2] ?? '').trim() || null;
		info = { inside, prefix, gitDir, at: Date.now() };
	}
	preflightCache.set(root, info);
	return info;
}

/** File mtime in ms, or null when the file is absent/unreadable. */
function fileMtimeMs(abs: string): number | null {
	try {
		return statSync(abs).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Ceiling past which LINE-LEVEL git decorations (a file tab's gutter change bars
 * and its per-line blame) are refused outright.
 *
 * They are the one git surface whose cost scales with the whole FILE: a
 * `--line-porcelain` blame emits a full commit header per line (a 10 MB report
 * measured ~2.6 s and ~46 MB of stdout, then one object per line, then a
 * synchronous `JSON.stringify` of the lot — on the same thread that carries
 * kernel streaming, SSE and the in-process MCP server), and the HEAD baseline
 * ships the entire blob to the browser to be re-diffed on every keystroke. Both
 * re-run on mount, on every save and on every window focus.
 *
 * The ordinary text-file cap is the threshold on purpose: everything a tab could
 * open before the HTML exception was carved out (see `limits.js`) keeps its
 * decorations EXACTLY as before, and only the export-sized files that exception
 * newly admits skip them. A refusal is reported (`tooLarge:true`), never
 * disguised as `tracked:false` — "too big to blame" and "untracked" are
 * different facts and the status bar says which. Which is also why size alone
 * cannot decide it: see `decorationRefusal`.
 */
export const MAX_DECORATION_BYTES = MAX_FILE_BYTES;

/**
 * True when the working-tree file is past `MAX_DECORATION_BYTES`. One `stat` and
 * zero git spawns, and it gates every path that would run the blame/`git show` —
 * the point is not to pay for them at all, not to discard the result afterwards.
 * An unreadable file is NOT refused here: it falls through to git, which reports
 * the honest `tracked:false`.
 */
function tooLargeToDecorate(abs: string): boolean {
	try {
		return statSync(abs).size > MAX_DECORATION_BYTES;
	} catch {
		return false;
	}
}

/**
 * Does git track `rel`? ONE path-scoped index lookup — not a repo walk, and a
 * different cost class entirely from the `--line-porcelain` blame the size gate
 * exists to prevent. (`git status --porcelain` is the wrong tool here: it cannot
 * see ignored files at all, so it can't tell tracked-clean from gitignored.)
 */
async function isTracked(root: string, rel: string): Promise<boolean> {
	return (await runGit(root, ['ls-files', '--error-unmatch', '--', rel])) != null;
}

/**
 * Decide whether to refuse line-level decorations for one file, and why.
 * `null` means "small enough — go run git"; otherwise decorations are skipped
 * and `tooLarge` says whether SIZE is the honest reason.
 *
 * Size alone is not that reason. The file this ceiling exists for is a generated
 * `report.html`, which is usually gitignored or simply never added — it has no
 * blame because git has never heard of it, exactly as VS Code shows nothing for
 * a new file. Answering "too large for blame" there names the wrong fact. So an
 * oversized file costs one `ls-files` to separate the two; the blame itself is
 * never spawned either way, which is the guarantee that matters.
 */
async function decorationRefusal(
	root: string,
	abs: string,
	rel: string
): Promise<{ tooLarge: boolean } | null> {
	if (!tooLargeToDecorate(abs)) return null;
	return { tooLarge: await isTracked(root, rel) };
}

/**
 * A cache signature that changes on any mutation affecting git output for a file:
 * the working-tree file's mtime (a plain edit) OR the git index's mtime (a stage,
 * commit, checkout, merge or rebase all rewrite the index). Reading both is two
 * `stat`s and zero git spawns.
 */
function cacheSig(abs: string | null, gitDir: string | null): string {
	const fileM = abs ? fileMtimeMs(abs) : null;
	const idxM = gitDir ? fileMtimeMs(join(gitDir, 'index')) : null;
	return `${fileM ?? 'x'}:${idxM ?? 'x'}`;
}

/** One entry in a signature+TTL cache. */
interface CacheEntry<T> {
	sig: string;
	at: number;
	value: T;
}
const headCache = new Map<string, CacheEntry<GitHeadFileResult>>();
const blameFileCache = new Map<string, CacheEntry<GitBlameFileResult>>();
const blameNbCache = new Map<string, CacheEntry<GitBlameNotebookResult>>();
let statusCache: CacheEntry<GitStatusResult> | null = null;
let branchCache: CacheEntry<GitBranchResult> | null = null;

/** Serve a cached value when its signature still matches and it is within the TTL. */
function fresh<T>(entry: CacheEntry<T> | null | undefined, sig: string, ttl = CACHE_TTL_MS): T | null {
	if (entry && entry.sig === sig && Date.now() - entry.at < ttl) return entry.value;
	return null;
}

/**
 * Drop the workspace-wide status cache. Call on an in-app save/mutation: a
 * cellar-side write changes the working tree (so `git status` differs) WITHOUT
 * touching the git index, so the status signature would otherwise not budge and
 * the file-tree decorations would lag by up to the backstop TTL. Per-file blame
 * and HEAD caches need no such hook — the written file's mtime moves, which is
 * already their signature. Edits made OUTSIDE cellar are bracketed by a
 * blur→focus gap longer than the TTL, so the backstop refreshes those.
 */
export function invalidateGitStatusCache(): void {
	statusCache = null;
}

/**
 * Drop every cached git result (status, blame, HEAD). Broader than the save-hook
 * needs — exported for tests and for any caller that wants a hard reset.
 * Preflights are intentionally NOT cleared: repo identity does not change here.
 */
export function invalidateGitCaches(): void {
	headCache.clear();
	blameFileCache.clear();
	blameNbCache.clear();
	statusCache = null;
	branchCache = null;
}

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
	/** Refused for being past `MAX_DECORATION_BYTES` — distinct from untracked. */
	tooLarge: boolean;
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
	/** Refused for being past `MAX_DECORATION_BYTES` — distinct from untracked. */
	tooLarge: boolean;
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
	return runGit(root, [
		'status',
		'--porcelain=v1',
		'--untracked-files=all',
		'--ignored=matching',
		'-z',
		'--',
		'.'
	]);
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
	const pre = await preflight(root);
	// Not a repo → no decorations, no error, no status spawn.
	if (!pre.inside) return { isRepo: false, files: {}, ignored: [] };

	// The index mtime is the cheap "history changed" signal; combined with the
	// backstop TTL it lets a focus/save burst reuse one status result while still
	// refreshing on a stage/commit/checkout (index mtime) or an explicit save
	// event (`invalidateGitCaches`). Unstaged working edits don't touch the index,
	// so the TTL is what bounds their staleness — the client also refetches status
	// right after a save, which lands fresh once the burst window has passed.
	const sig = cacheSig(null, pre.gitDir);
	const hit = fresh(statusCache, sig, STATUS_TTL_MS);
	if (hit) return hit;

	const stdout = await runStatus(root);
	if (stdout == null) return { isRepo: false, files: {}, ignored: [] };
	const { files, ignored } = parse(stdout, pre.prefix);
	const value: GitStatusResult = { isRepo: true, files, ignored };
	statusCache = { sig, at: Date.now(), value };
	return value;
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
	// The branch fires on every focus (alongside status), yet only changes on a
	// checkout/switch — which rewrites the index, bumping its mtime. So the same
	// index-mtime signature that keys status keys this too: a warm focus re-uses it,
	// a branch switch (or the first commit onto an unborn branch) refreshes it.
	const pre = await preflight(root);
	const sig = cacheSig(null, pre.gitDir);
	const hit = fresh(branchCache, sig);
	if (hit) return hit;

	const value = await resolveBranch(root, pre);
	branchCache = { sig, at: Date.now(), value };
	return value;
}

async function resolveBranch(root: string, pre: Preflight): Promise<GitBranchResult> {
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
	// No SHA: the memoized preflight already told us whether this is even a repo.
	return { isRepo: pre.inside, branch: null, detached: false };
}

/**
 * Run a git subcommand at the workspace root; `null` on any failure.
 *
 * `--no-optional-locks` is load-bearing for the caches: a plain `git status`
 * REFRESHES and rewrites the index's stat cache, bumping `.git/index`'s mtime —
 * the very signal the status cache keys on — so the entry it just wrote would be
 * stale on the next read. Suppressing the optional index write keeps the index
 * mtime a stable "history/staging changed" signal (and avoids lock contention
 * with a concurrent terminal git); the command's output is unaffected.
 */
function runGit(root: string, args: string[]): Promise<string | null> {
	spawnCount++;
	spawnLog.push(args[0] ?? '');
	return new Promise((resolve) => {
		execFile('git', ['-C', root, '--no-optional-locks', ...args], { maxBuffer: MAX_GIT_BUFFER }, (err, stdout) => {
			// A maxBuffer overflow returns truncated stdout ALONGSIDE the error, and the
			// old `err ? null` collapsed it into the same "not a repo / no such ref"
			// silence as an ordinary failure — a huge tracked blob would then just
			// vanish with no decoration and no trace. Detect that one error and SURFACE
			// it (the cap is already large, so hitting it is genuinely anomalous), then
			// degrade honestly to null so the caller shows no baseline rather than a
			// silently-truncated one.
			if (isMaxBufferError(err)) {
				console.warn(
					`[cellar/git] output exceeded the ${Math.round(MAX_GIT_BUFFER / (1024 * 1024))} MB buffer for \`git ${args.join(' ')}\`; ` +
						`dropping the (truncated) result — decorations for this target are unavailable.`
				);
				return resolve(null);
			}
			resolve(err ? null : stdout);
		});
	});
}

/** True when `execFile` failed specifically because stdout crossed `maxBuffer`. */
export function isMaxBufferError(err: unknown): boolean {
	// Node tags the overflow with this code; older/edge builds only set the message.
	const e = err as { code?: string; message?: string } | null;
	return !!e && (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer length exceeded/i.test(e.message ?? ''));
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
 * @param opts.sizeGuard Skip the `git show` above `MAX_DECORATION_BYTES`
 *   (`tooLarge:true` only when the file is also TRACKED — see
 *   `decorationRefusal`). Default true — a file tab's gutter re-diffs the whole
 *   baseline on every keystroke. The NOTEBOOK caller passes false: its
 *   decorations are per CELL and their cost tracks SOURCE, not the outputs that
 *   make an `.ipynb` big, so a size gate there would drop the change bars off an
 *   ordinary plot-heavy notebook.
 * @returns {Promise<{isRepo: boolean, tracked: boolean, content: string|null}>}
 */
export async function gitHeadFile(
	relPath: string,
	opts: { sizeGuard?: boolean } = {}
): Promise<GitHeadFileResult> {
	const root = workspaceRoot();
	const abs = resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	const pre = await preflight(root);
	if (!pre.inside) return { isRepo: false, tracked: false, content: null, tooLarge: false };

	// HEAD:path content changes only when history moves (commit/checkout), so the
	// index mtime alone is a sound signature; the working-file mtime rides along
	// harmlessly and the TTL backstops exotic history moves. Probing the cache
	// first costs two `stat`s and no spawn, so it never weakens the size gate
	// below — a refused answer is cached like any other.
	const cacheKey = `${root}\0${rel}`;
	const sig = cacheSig(abs, pre.gitDir);
	const hit = fresh(headCache.get(cacheKey), sig);
	if (hit) return hit;

	let value: GitHeadFileResult;
	const refused = opts.sizeGuard === false ? null : await decorationRefusal(root, abs, rel);
	if (refused) {
		// No `git show`: the whole point is not to pay for a blob the gutter would
		// re-diff on every keystroke.
		value = { isRepo: true, tracked: false, content: null, tooLarge: refused.tooLarge };
	} else {
		// Porcelain paths (and `git show`'s object syntax) are repo-root-relative.
		const content = await runGit(root, ['show', `HEAD:${pre.prefix}${rel}`]);
		if (content == null) value = { isRepo: true, tracked: false, content: null, tooLarge: false };
		// A NUL byte means a binary blob; there is no line diff to draw.
		else if (content.includes('\0')) value = { isRepo: true, tracked: false, content: null, tooLarge: false };
		else value = { isRepo: true, tracked: true, content, tooLarge: false };
	}
	headCache.set(cacheKey, { sig, at: Date.now(), value });
	return value;
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
 * `tooLarge:true` is the one no-blame case worth saying out loud, and it is
 * reserved for a TRACKED file past `MAX_DECORATION_BYTES` (see
 * `decorationRefusal`): an untracked one has no blame for the ordinary reason
 * and reads as untracked, however big it is.
 *
 * @param {string} relPath Workspace-relative path (path-guarded).
 * @returns {Promise<{isRepo: boolean, tracked: boolean, lines: Array<object>}>}
 */
export async function gitBlameFile(relPath: string): Promise<GitBlameFileResult> {
	const root = workspaceRoot();
	const abs = resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	const pre = await preflight(root);
	if (!pre.inside) return { isRepo: false, tracked: false, lines: [], tooLarge: false };

	// Blame changes on a working edit (file mtime) or a history move (index mtime);
	// the signature+TTL cache collapses the per-focus/per-save burst without ever
	// serving a result across a real edit. Probing it first costs two `stat`s and
	// no spawn, so it never weakens the size gate below.
	const cacheKey = `${root}\0${rel}`;
	const sig = cacheSig(abs, pre.gitDir);
	const hit = fresh(blameFileCache.get(cacheKey), sig);
	if (hit) return hit;

	let value: GitBlameFileResult;
	const refused = await decorationRefusal(root, abs, rel);
	if (refused) {
		// No `--line-porcelain`: on a multi-MB file it is seconds of git plus tens
		// of MB of stdout, and this runs on mount, on every save and every focus.
		value = { isRepo: true, tracked: false, lines: [], tooLarge: refused.tooLarge };
	} else {
		// `--incremental` off; `-w` ignores whitespace-only reblame noise. A file with
		// no HEAD blob (untracked / newly added) makes blame fail → tracked:false.
		const out = await runGit(root, ['blame', '--line-porcelain', '-w', '--', rel]);
		value =
			out == null
				? { isRepo: true, tracked: false, lines: [], tooLarge: false }
				: { isRepo: true, tracked: true, lines: parseBlame(out), tooLarge: false };
	}
	blameFileCache.set(cacheKey, { sig, at: Date.now(), value });
	return value;
}

/**
 * Parse `git blame -L … --line-porcelain` into a `Map<fileLine, BlameLine>`,
 * keyed by the FINAL (current-file) line number the porcelain header reports.
 *
 * The whole-file `parseBlame` keys records by position because it blames every
 * line 1..N in order; a ranged blame skips the gaps between `-L` ranges, so a
 * record's array index no longer equals its file line. The header
 * `<sha> <origLine> <finalLine> [count]` carries the answer directly — its
 * second field is the current-file line — so we key on that and never depend on
 * output being contiguous.
 */
function parseBlameByLine(stdout: string): Map<number, BlameLine> {
	const byLine = new Map<number, BlameLine>();
	let cur: { commit: string; line: number; author: string; authorTime: number; summary: string; notCommitted: boolean } | null =
		null;
	for (const raw of stdout.split('\n')) {
		const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw);
		if (m) {
			const sha = m[1];
			cur = { commit: sha, line: Number(m[2]), author: '', authorTime: 0, summary: '', notCommitted: sha === ZERO_SHA };
			continue;
		}
		if (!cur) continue;
		if (raw.startsWith('author ')) cur.author = raw.slice(7);
		else if (raw.startsWith('author-time ')) cur.authorTime = Number(raw.slice(12)) * 1000;
		else if (raw.startsWith('summary ')) cur.summary = raw.slice(8);
		else if (raw.startsWith('\t')) {
			byLine.set(cur.line, {
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
	return byLine;
}

/**
 * Merge a set of 1-based file line numbers into minimal ascending contiguous
 * ranges (`[start, end]` inclusive), so a cell's consecutive source lines become
 * one `-L start,end` and the output gaps between cells are never blamed.
 */
function coalesceRanges(lineNums: number[]): Array<[number, number]> {
	const sorted = Array.from(new Set(lineNums)).sort((a, b) => a - b);
	const ranges: Array<[number, number]> = [];
	for (const ln of sorted) {
		const last = ranges[ranges.length - 1];
		if (last && ln === last[1] + 1) last[1] = ln;
		else ranges.push([ln, ln]);
	}
	return ranges;
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
export function cellSourceLines(text: string): Map<string, number[]> | null {
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

	const pre = await preflight(root);
	if (!pre.inside) return { isRepo: false, tracked: false, cells: {} };

	const cacheKey = `${root}\0${rel}`;
	const sig = cacheSig(abs, pre.gitDir);
	const hit = fresh(blameNbCache.get(cacheKey), sig);
	if (hit) return hit;

	const cache = (value: GitBlameNotebookResult): GitBlameNotebookResult => {
		blameNbCache.set(cacheKey, { sig, at: Date.now(), value });
		return value;
	};

	// Read the on-disk bytes FIRST and map each cell to the physical file lines its
	// `source` occupies. Cellar's deterministic clean-on-save (1-space indent, one
	// JSON string per source array element on its own line) makes a string token's
	// start line its git-blame line, so these numbers are exactly what `-L` wants.
	let text: string;
	try {
		text = readFileSync(abs, 'utf8');
	} catch {
		return cache({ isRepo: true, tracked: false, cells: {} });
	}
	const cellLines = cellSourceLines(text);
	if (!cellLines) return cache({ isRepo: true, tracked: false, cells: {} });

	// Blame ONLY the source-line ranges, not the whole `.ipynb`. An output-heavy
	// notebook has thousands of output lines that never need a blame record; `-L`
	// keeps the blame (and the parse) proportional to source, not to output size.
	const allLines: number[] = [];
	for (const nums of cellLines.values()) allLines.push(...nums);
	// When no cell has any source line, still probe line 1 so an untracked notebook
	// (blame fails → tracked:false) is distinguished from a tracked one whose cells
	// are all empty (tracked:true, every cell notCommitted).
	const ranges = allLines.length ? coalesceRanges(allLines) : ([[1, 1]] as Array<[number, number]>);

	const args = ['blame', '--line-porcelain', '-w'];
	for (const [a, b] of ranges) args.push('-L', `${a},${b}`);
	args.push('--', rel);
	const out = await runGit(root, args);
	if (out == null) return cache({ isRepo: true, tracked: false, cells: {} }); // untracked / no HEAD blob
	const byLine = parseBlameByLine(out);

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
			const rec = byLine.get(ln);
			if (!rec) continue;
			if (rec.notCommitted) { dirty = true; break; }
			if (rec.authorTime == null) continue;
			if (!best || (rec.authorTime ?? 0) > (best.authorTime ?? 0)) best = rec;
		}
		// No source line at all (empty cell) is likewise treated as uncommitted.
		cells[id] = dirty || !best ? notCommittedRecord() : best;
	}
	return cache({ isRepo: true, tracked: true, cells });
}
