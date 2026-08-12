/**
 * Notebook code roots — the filesystem half (see `$lib/notebookRoot` for the
 * pure rules and the model).
 *
 * WHAT A ROOT CHANGES — exactly two bindings, both already parameterised on a
 * path, so this is a pure superset of the single-root behavior:
 *
 *   1. The kernel process's working directory. `getKernel` sends the root as the
 *      `path` field of the kernel-start request; jupyter_server resolves it under
 *      its `root_dir` (= the workspace) via `cwd_for_path` and spawns the kernel
 *      there. A notebook with no root sends no `path` at all, so the kernel keeps
 *      inheriting the sidecar's cwd exactly as before.
 *   2. The `sys.path` entry Cellar injects at startup (`projectRootAddCode`).
 *
 * WHAT STAYS WORKSPACE-SCOPED (do not "extend" a root into these): the file
 * tree, git status/decorations/blame, search, checkpoints, the UI-state store,
 * the `.cellar/` runtime + harness config, the instance registry, and the
 * interpreter — one venv per instance, unaffected by any notebook's root. This
 * holds for an out-of-workspace worktree root too: it grants the kernel a cwd,
 * and NOT one byte of file reach through any Cellar API.
 *
 * WHY EXISTENCE IS CHECKED HERE, and why a bad root REFUSES rather than degrades:
 * jupyter_server's `cwd_for_path` walks UP to `root_dir` when the path is not a
 * directory, so a stale or misspelled root would silently start the kernel in the
 * workspace — the notebook would look connected to the tree under review while
 * running the wrong code, which is precisely the failure this feature exists to
 * prevent. So a declared-but-unusable root throws with a message naming the path
 * and the fix, and the run fails loudly instead of quietly answering from the
 * wrong checkout.
 *
 * ── TWO ADMISSION RULES ────────────────────────────────────────────────────────
 *
 * `resolveRootDir` branches ONCE, and the branches are not equals:
 *
 *   inside  -> `resolveInWorkspace` (UNCHANGED, never widened) -> statSync
 *   outside -> registered-worktree gate                        -> statSync
 *
 * THE GUARD ITSELF PICKS THE BRANCH, and that is structural rather than
 * decorative: `isOutsideWorkspace` ASKS `resolveInWorkspace` and treats its throw
 * as the outside verdict, so this module holds no containment rule of its own. A
 * local copy of the guard's lexical prefix test deciding the branch — and then
 * calling the guard inside it, unreachably — would make the claim below true only
 * for as long as the two rules happened to agree. That helper is EXPORTED and is
 * the app's one answer to "is this directory inside the workspace": the picker and
 * the sidebar's worktree rows label `external` with it too, because two local
 * copies of the rule (one comparing lexical paths, one realpath'd) had them
 * labelling the same checkout differently.
 *
 * WHICH RULE ADMITTED A ROOT AND WHERE THAT ROOT SITS ARE TWO QUESTIONS. The gate
 * answers the first (and its `GitWorktree` is what names the repair for a
 * registered-but-gone directory); `kind` answers the second, off the CANONICAL
 * directory, so a worktree that happens to live inside the workspace is
 * `kind:'workspace'` however its declaration was typed.
 *
 * `resolveInWorkspace` is the app-wide guard and stays byte-for-byte as it is:
 * every FILE path in the app resolves through it (the tree, `/api/fs/*`,
 * `gitHeadFile`, `gitBlameFile`, the export target, the notebook path guard), so
 * the moment it learns about worktrees every one of them inherits the reach. The
 * worktree gate is therefore a SIBLING rule, and a strictly narrower one: a path
 * is admitted only when `git worktree list --porcelain`, run in the workspace,
 * names that exact directory — i.e. the set is authored by the user's own
 * `git worktree add` runs against the workspace's OWN repository. Not "any
 * absolute path", not "any git repo", not "anything under $HOME". Both branches
 * then share the same existence + directory-ness checks, because a REMOVED
 * worktree still lists (`prunable`): the listing authorises, `statSync` decides
 * usability.
 *
 * REGISTERED IS NOT SUFFICIENT: a checkout that CONTAINS the workspace is refused
 * (`enclosesWorkspace`). `git worktree list` walks UP to find the repo, so when the
 * workspace is a SUBDIRECTORY of a checkout (`cd repo/analysis && cellar`) the
 * listing's first entry is the ENCLOSING repo root — and the gate's only exclusion
 * was the workspace ITSELF. Admitted, it roots the kernel ABOVE the tree Cellar is
 * serving and writes agent config into the workspace's parent, which is the
 * opposite of the sibling-checkout model this is written around; it was reachable
 * purely as a side effect of the main checkout always being listed. It is refused
 * AFTER the gate so the refusal can say what is true — that it is registered, and
 * that it encloses — rather than the gate's "not a registered worktree", which
 * would be false here; and it is dropped from the detection listing, the sidebar's
 * worktree rows and the gate's own "what IS registered" message, so it is never
 * offered either.
 *
 * ── THE TWO-NAMESPACE RULE (verify by realpath, bind and persist lexically) ────
 *
 * The subtlest thing in this module, and the one that gets "simplified" into a
 * single `realpathSync` and then breaks on one platform.
 *
 *   • `git worktree list` returns REALPATH'd paths. Cellar's `CELLAR_WORKSPACE`
 *     and jupyter's `root_dir` are the LEXICAL `resolve()`d string. On macOS
 *     these differ constantly (`/tmp` -> `/private/tmp`, `/var/folders` ->
 *     `/private/var/folders` — every `mkdtemp` workspace, so real users and the
 *     e2e harness both). So VERIFICATION compares `realpathSync` of both sides
 *     for IDENTITY.
 *   • But BINDING and PERSISTING stay LEXICAL. jupyter's `to_os_path` joins the
 *     API path onto the lexical `root_dir` and `normpath`s it WITHOUT resolving
 *     symlinks, so a realpath'd relative path would persist the machine-specific
 *     `../../private/tmp/...` form into the committed `.ipynb`.
 *
 * Identity comparison of two absolute paths is safe and is NOT what the symlink
 * note below forbids: that warns against realpathing ONE side of a PREFIX
 * containment test, which is asymmetric. Identity has no such asymmetry, and
 * here it is required.
 *
 * SO EVERY "are these the same directory" TEST IS CANONICAL — the listing scan,
 * the workspace-exclusion in `nameWorktrees`, and the "this declaration IS the
 * workspace" short-circuit in `resolveRootDir`. A LEXICAL `===` may only ever be
 * a fast path in front of one, never the whole rule: git prints the MAIN CHECKOUT
 * as the first line of `git worktree list`, so a workspace whose own path
 * traverses a symlink has a second, realpath'd spelling of itself that a user can
 * paste — and a lexical-only test lets it fall through to the worktree gate, which
 * matches it.
 *
 * EVERY declaration naming a git-reported path is minted by ONE function,
 * `worktreeDeclaration` — the picker, the sidebar route, and `resolveRootDir`
 * itself. This rule has been got wrong once per site that re-derived it, always
 * the same way (measuring the hop with `relative(lexicalWorkspace, gitPath)`),
 * and always silently, because the wrong form still resolves. So a new surface
 * that turns a worktree into a declaration CALLS that function; it does not
 * measure the hop itself.
 *
 * NEVER HAND JUPYTER AN ABSOLUTE PATH. `to_os_path` strips the leading `/` and
 * joins, so `/Users/x/repo` becomes `<ws>/Users/x/repo`, which does not exist —
 * and `cwd_for_path` then walks UP, starting the kernel somewhere arbitrary. A
 * `..`-relative API path, by contrast, escapes `root_dir` cleanly and is returned
 * verbatim when it is a directory. That is why `apiPath` is a named field rather
 * than a reuse of `rel`: a future admission rule cannot silently send an absolute
 * path without going past the field that says what it is for. The transport is
 * additionally verified once at kernel start (see `initKernel`), so relying on
 * that upstream behaviour cannot fail silently.
 *
 * WHAT "INSIDE THE WORKSPACE" MEANS HERE, stated exactly: `resolveInWorkspace` is
 * a LEXICAL prefix check with no `realpathSync`, so it refuses an absolute path
 * and a `..` traversal by name - and a root declared as a SYMLINK pointing outside
 * the workspace resolves, since `statSync` follows it. That narrowing is ACCEPTED,
 * not an oversight, and must not be "fixed" here: the same lexical guard is what
 * the file tree and `/api/fs/file` resolve through, so such a symlink already
 * reads outside the workspace everywhere else - making a code root uniquely
 * stricter than every other path in the app would be inconsistent, and widening
 * the guard app-wide is a separate task. Do NOT reach for `realpathSync` on the
 * root alone, for the prefix-asymmetry reason above. The exposure is bounded and
 * is now the WIDER of the two out-of-workspace routes: a symlink may point
 * anywhere, whereas the worktree gate admits only checkouts of this repo. It
 * takes a hand-edited `metadata.cellar.root` or an explicit MCP call to reach
 * (the picker enumerates a symlinked root but offers nothing a `readdirSync` of
 * the workspace cannot see), and the kernel executes arbitrary user code
 * regardless - so a symlinked root grants nothing a cell could not already do.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workspaceRoot, resolveInWorkspace } from './fstree';
import { getNotebookRoot } from './notebook';
import { listWorktreesAt, type GitWorktree } from './git';
import { NotebookRootError, classifyRootPath } from '../notebookRoot';

/** Where a root's directory sits relative to the workspace — see `ResolvedRoot.kind`. */
export type RootKind = 'workspace' | 'worktree';

/** A notebook's resolved root: the canonical declaration + its absolute dir. */
export interface ResolvedRoot {
	/**
	 * Canonical PERSISTED declaration: `roots/pr-482` for a root inside the
	 * workspace, `../winrate-model-pr398` for an external worktree. Never
	 * absolute — see §"what is persisted" in the header.
	 */
	rel: string;
	/**
	 * Absolute directory the kernel is rooted at. LEXICAL (never realpath'd), so
	 * it agrees with the workspace it is relative to.
	 */
	dir: string;
	/**
	 * The jupyter kernel-start `path`. Equals `rel`, and is never absolute: an
	 * absolute API path collapses INTO the workspace (see the header).
	 */
	apiPath: string;
	/**
	 * Where the resolved DIRECTORY sits — inside the workspace, or outside it. A
	 * fact about `dir`/`rel`, decided by the shared guard (`isOutsideWorkspace`),
	 * NOT about which admission rule answered nor about the shape that was typed:
	 * its consumers (the agent-config write, the startup cwd verification) act on
	 * where the kernel really runs.
	 */
	kind: RootKind;
}

/** The lexical workspace root, as every path here is relative to. */
function ws(): string {
	return resolve(workspaceRoot());
}

/**
 * A path in the REAL namespace, resolving as much of it as exists.
 *
 * A plain `realpathSync` throws for a path that is GONE, which is exactly the
 * case that matters here: a `prunable` worktree is still listed at a realpath'd
 * path while Cellar's candidate is lexical, so falling back to the raw string
 * leaves `/var/…` to be compared against `/private/var/…` and the entry reads as
 * "not registered" instead of "registered but missing" — the wrong refusal, with
 * the wrong repair. So the deepest existing ANCESTOR is resolved and the missing
 * tail re-appended.
 */
function canonicalPath(p: string): string {
	let head = p;
	const tail: string[] = [];
	// Bounded by the path's own depth; `dirname('/')` is `/`, which stops it.
	for (let i = 0; i < 64; i++) {
		try {
			return tail.length ? join(realpathSync(head), ...tail) : realpathSync(head);
		} catch {
			const parent = dirname(head);
			if (parent === head) return p;
			tail.unshift(basename(head));
			head = parent;
		}
	}
	return p;
}

/** True when two absolute paths name the same directory, across namespaces. */
function samePath(a: string, b: string): boolean {
	return a === b || canonicalPath(a) === canonicalPath(b);
}

/**
 * The workspace in the REAL namespace — the right-hand side of nearly every
 * identity/containment question here, and therefore the one worth HOISTING.
 *
 * Exported so a caller that asks several of those questions in one pass resolves it
 * ONCE and threads it in, the way `resolveRootDir` already threads `canonDir` into
 * the gate. Every such helper below takes it as an optional argument defaulting to
 * this, so the semantics are identical whether or not a caller hoists — the sidebar
 * route was paying three `realpathSync` WALKS of the workspace per registered
 * worktree (one in `enclosesWorkspace`, two in `worktreeDeclaration`), on a panel
 * that refetches on mount, on `sse:open`, on every `fsRefreshSignal` and on every
 * window focus, on the process carrying the kernel websockets and the SSE fan-out —
 * with a worktree per PR under review, which is this feature's own use case.
 *
 * Deliberately NOT memoized process-wide: the workspace's canonical form is stable
 * in practice, but a cache keyed on a path that can be re-created underneath it is
 * the kind of silent staleness this module is written against. Hoisting is explicit
 * and expires with the request.
 */
export function canonicalWorkspace(): string {
	return canonicalPath(ws());
}

/**
 * `canonicalPath` for a worktree the listing reported, memoized on the ENTRY.
 *
 * `samePath` resolves BOTH sides, and its `a === b` fast path essentially never
 * hits against a listing (the candidate is lexical, git's path is realpath'd -
 * which is the whole reason `samePath` exists), so scanning the listing cost a
 * `realpathSync` walk per entry. `listWorkspaceRoots` then resolves once per
 * DETECTED worktree, making that O(N²) blocking syscalls on a path `LiveNotebook`
 * runs at every notebook mount, for a workspace with a worktree per PR under
 * review - this feature's own headline use case, i.e. exactly the N where it bites.
 *
 * Keyed on the object rather than the string because `listWorktreesAt` hands back
 * the same entries for the life of its (1.5s) cache and mints fresh ones on the
 * next spawn: the memo therefore expires with the listing it belongs to, so it
 * cannot outlive the answer it caches. The comparison itself is unchanged.
 */
const worktreeCanonical = new WeakMap<GitWorktree, string>();
function canonicalWorktreePath(w: GitWorktree): string {
	let canon = worktreeCanonical.get(w);
	if (canon === undefined) {
		canon = canonicalPath(w.path);
		worktreeCanonical.set(w, canon);
	}
	return canon;
}

/**
 * `samePath(w.path, dir)` with `dir`'s canonical form supplied by the caller, so a
 * scan of the listing resolves the candidate ONCE instead of once per entry.
 */
function isWorktreeAt(w: GitWorktree, dir: string, canonDir: string): boolean {
	return w.path === dir || canonicalWorktreePath(w) === canonDir;
}

/**
 * A linked worktree's REGISTRATION NAME — the `<name>` in
 * `<repo>/.git/worktrees/<name>`, read from the worktree's own `.git` file.
 *
 * This is the one identifier that SURVIVES `git worktree move` (verified: moving
 * a worktree rewrites nothing in `.git/worktrees/<name>`), which is what makes
 * naming the new path a fact rather than a guess. The basename cannot do it — a
 * move usually changes it, which is the whole reason the old path stopped
 * working. Null for the main checkout (whose `.git` is a directory) and whenever
 * the file cannot be read.
 */
function registrationName(worktreeDir: string): string | null {
	try {
		const dotGit = join(worktreeDir, '.git');
		if (statSync(dotGit).isDirectory()) return null;
		const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
		return m ? basename(m[1].trim()) : null;
	} catch {
		return null;
	}
}

/** A declaration's absolute directory, kept in the LEXICAL namespace. */
function toRel(dir: string): string {
	// `relative` yields the platform separator; the declaration is stored with `/`
	// so it round-trips a `.ipynb` written on either platform.
	return relative(ws(), dir).split(sep).join('/');
}

/**
 * Whether an absolute LEXICAL directory lies OUTSIDE the workspace.
 *
 * THE ONE IMPLEMENTATION OF THAT QUESTION IN THE APP, and it is the app-wide
 * guard's own ANSWER rather than a copy of its rule: the guard is asked, and its
 * throw IS the outside verdict. That is what makes "there is exactly one
 * containment rule" structural — a local copy of the guard's lexical prefix test
 * had been written three times in this feature, and two of the copies did not
 * agree (one comparing lexical operands, the other realpath'd ones), so the
 * notebook picker could label a checkout internal while the sidebar's worktree row
 * labelled the same checkout external — the exact misreading the `external` tag
 * exists to prevent.
 *
 * `dir` must be LEXICAL. A path git reported is realpath'd, so it is turned into a
 * declaration by `worktreeDeclaration` first and resolved from the lexical
 * workspace — otherwise a worktree genuinely inside a workspace whose own path
 * traverses a symlink (`/var/folders`, `/tmp`, a symlinked home) reads as outside.
 */
export function isOutsideWorkspace(dir: string): boolean {
	try {
		resolveInWorkspace(toRel(dir));
		return false;
	} catch {
		return true;
	}
}

/**
 * Whether `dir` CONTAINS the workspace — an ENCLOSING checkout, which is refused.
 *
 * A DIFFERENT question from `isOutsideWorkspace`, and one the shared guard cannot
 * answer: `resolveInWorkspace` is anchored AT the workspace, so it decides whether
 * something lies inside it and has no way to decide whether the workspace lies
 * inside something. So this is a second rule, and like its sibling it lives in
 * exactly ONE place and every site asks it — the picker's validation (through
 * `resolveRootDir`), the gate's refusal listing, and the sidebar's worktree rows.
 *
 * WHY IT EXISTS: `git worktree list` walks UP to find the repo, so when the
 * workspace is a SUBDIRECTORY of a checkout (`cd repo/analysis && cellar`, a layout
 * Cellar already recognises elsewhere) the listing's first entry is the ENCLOSING
 * repo root — and nothing else in the gate excluded it, since the only directory
 * filtered there is the workspace ITSELF. Admitted, it roots the kernel at the
 * directory that CONTAINS the tree Cellar is serving (its cwd and `sys.path` cover
 * the workspace), and `setNotebookRootAndRestart` then writes `.mcp.json` into the
 * workspace's PARENT. That is the opposite of the sibling-checkout model everything
 * here is written around; it was admitted purely as a side effect of the main
 * checkout always being listed, and it was never a designed capability.
 *
 * Compared CANONICALLY, like every other identity/containment question here: git
 * realpaths its output while Cellar's workspace is the lexical resolve. `canonWs`
 * is that side, hoisted by a caller asking this of many candidates in one pass; the
 * default keeps a lone call identical to what it always was.
 */
export function enclosesWorkspace(dir: string, canonWs: string = canonicalWorkspace()): boolean {
	const inner = relative(canonicalPath(dir), canonWs);
	// '' is the workspace itself (identity, not enclosure) and an absolute result
	// means no relative path exists at all (a different Windows drive).
	if (inner === '' || isAbsolute(inner)) return false;
	// A first segment of `..` means the workspace lies OUTSIDE `dir`. Split rather
	// than prefix-tested, so no separator arithmetic is re-derived here.
	return inner.split(sep)[0] !== '..';
}

/**
 * The DECLARATION that names a worktree `git worktree list` reported.
 *
 * THE TWO-NAMESPACE RULE, applied in the direction detection needs it — and the
 * one place it lives, because it has to be got right identically by the picker
 * (`listWorkspaceRoots`) and by the sidebar route, and writing it twice is how
 * one of them ends up with the other spelling.
 *
 * git hands back a REALPATH'd absolute path; a declaration must be LEXICAL,
 * because it is what gets persisted and what jupyter joins onto its lexical
 * `root_dir`. So the hop between the two checkouts is measured in the REAL
 * namespace (`canonWs`, hoistable by a caller minting many declarations in one
 * pass) and then applied lexically from the workspace. Measuring it as
 * `relative(lexicalWs, realPath)` instead yields the machine-specific
 * `../../../private/var/folders/…` form on macOS: it resolves, but it is not a
 * declaration anyone should have in a committed `.ipynb`, and it is not even the
 * shortest path to the same directory.
 *
 * The hop is then VERIFIED rather than assumed, because it is measured in one
 * namespace and applied in the other: that is exact whenever the symlink
 * separating them sits ABOVE the hop (macOS's `/var` -> `/private/var`, and every
 * layout seen in practice), and where it does not, the `..` count would name a
 * DIFFERENT directory. So a declaration that does not resolve back to the very
 * worktree git reported falls back to the lexical measurement — machine-specific,
 * but naming the right directory. An ugly declaration is a cosmetic cost; one
 * that points somewhere else is the silent degrade this feature exists to prevent.
 */
export function worktreeDeclaration(worktreePath: string, canonWs: string = canonicalWorkspace()): string {
	const rel = relative(canonWs, worktreePath).split(sep).join('/');
	if (rel && samePath(resolve(ws(), rel), worktreePath)) return rel;
	return toRel(worktreePath);
}

/** Short, deterministic rendering of what IS registered, for a refusal message. */
function nameWorktrees(list: GitWorktree[]): string {
	const wsDir = ws();
	const canonWs = canonicalPath(wsDir);
	// Neither the workspace itself nor a checkout that ENCLOSES it: a refusal that
	// offers a candidate the very next resolve would refuse is worse than a short list.
	const others = list.filter((w) => !isWorktreeAt(w, wsDir, canonWs) && !enclosesWorkspace(w.path, canonWs));
	if (!others.length) return 'This repository has no other worktrees registered.';
	const shown = others.slice(0, 5).map((w) => w.path);
	const more = others.length - shown.length;
	return `Cellar found ${others.length} registered worktree${others.length === 1 ? '' : 's'}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
}

/**
 * Admit an out-of-workspace declaration, or throw naming why it was refused.
 *
 * `dir` is the LEXICALLY resolved candidate and `canonDir` its REAL-namespace form,
 * supplied by the caller because it has already paid for it. Verification is
 * realpath identity against the listing (the two-namespace rule); nothing lexical
 * is compared, because `git worktree list` realpaths its output.
 */
function assertRegisteredWorktree(dir: string, canonDir: string, declared: string): GitWorktree {
	let list = listWorktreesAt(ws());
	let match = list.find((w) => isWorktreeAt(w, dir, canonDir));
	// A MISS is re-checked against a FRESH listing before it becomes a refusal.
	// The listing is cached for 1.5s, which would otherwise be a window in which a
	// worktree the user created seconds ago — the very next thing they do after
	// `git worktree add` is point a notebook at it — is reported as unregistered.
	// One extra spawn on the refusal path is cheap (refusals are rare, and the
	// alternative is telling the user their worktree does not exist), and the happy
	// path never reaches this.
	if (!match) {
		list = listWorktreesAt(ws(), { refresh: true });
		match = list.find((w) => isWorktreeAt(w, dir, canonDir));
	}
	if (match) return match;

	// MOVED (`git worktree move` is an ordinary thing to do): the declared path is
	// gone, and a registered worktree carries the REGISTRATION NAME that path had.
	// That name is stable across a move, so this identifies the same worktree
	// rather than guessing from a basename — which a move usually changes, and
	// which would otherwise match an unrelated checkout that merely shares a name.
	// Naming the new path turns a dead end into a one-line fix, and the listing is
	// already in hand. Deliberately NOT auto-followed: rewriting a committed
	// `.ipynb` because a directory moved is a silent change to the user's file.
	if (!existsDir(dir)) {
		const wanted = basename(dir);
		const wsDir = ws();
		const canonWs = canonicalPath(wsDir);
		const moved = list.find((w) => !isWorktreeAt(w, wsDir, canonWs) && registrationName(w.path) === wanted);
		if (moved) {
			throw new NotebookRootError(
				`Notebook root ${JSON.stringify(declared)} is no longer registered at that path — that worktree was moved to ${JSON.stringify(moved.path)}. Update the notebook's root to the new path, or clear it to run at the workspace root.`
			);
		}
	}

	throw new NotebookRootError(
		`Notebook root ${JSON.stringify(declared)} is outside the workspace and is not a registered git worktree of this repository. A root must be a directory inside the workspace, or a worktree of the workspace's own repo (\`git worktree add <path> <branch>\`, then \`git worktree list\` to confirm). ${nameWorktrees(list)}`
	);
}

/** True when `dir` exists and is a directory (following symlinks, like `statSync`). */
function existsDir(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve a declared root to an absolute directory, refusing anything that is not
 * a usable directory the workspace may root a kernel at.
 *
 * Layered deliberately: the pure rules classify the SHAPE, then the shape picks
 * its admission rule (the untouched workspace guard, or the registered-worktree
 * gate), and only then is the filesystem consulted for existence. Returns null
 * when the declaration means "the workspace root" (absent/empty).
 *
 * This is also the ONE validate-and-store site: it returns the canonical
 * `..`-relative form for an external worktree, so an ABSOLUTE path may be typed
 * at the API (it is what `git worktree add` prints and what a user pastes) while
 * what lands in the committed `.ipynb` is portable and leaks no home directory —
 * the same decision, for the same reasons, as the nbdev export target.
 */
export function resolveRootDir(raw: string | null | undefined): ResolvedRoot | null {
	const shape = classifyRootPath(raw);
	if (shape.kind === 'none') return null;

	// The declared text, for messages: what the user actually wrote.
	const declared = shape.kind === 'inside' ? shape.rel : shape.raw;
	const wsDir = ws();
	// Lexical resolution serves both shapes: `resolve(ws, '../sib')` escapes,
	// `resolve(ws, '/abs')` returns the absolute path untouched.
	const dir = resolve(wsDir, declared);

	if (dir === wsDir) {
		// Reachable via a value the classifier accepted that still resolves to the
		// workspace itself; that is the same thing as declaring no root. Free, and
		// exact for every declaration written in Cellar's own lexical namespace — but
		// NOT sufficient on its own, which is what the canonical re-check below is for.
		return null;
	}

	// THE SHARED GUARD MAKES THE DECISION — it is asked, never paraphrased.
	//
	// This module holds no containment rule of its own: `isOutsideWorkspace` ASKS
	// `resolveInWorkspace` and treats its throw as the outside verdict. A local
	// `insideWorkspace` copy of the guard's lexical test used to decide the branch
	// and then call the guard inside it, which made that call (and its catch)
	// unreachable by construction — so the doctrine's claim that the untouched guard
	// is the authority for the inside branch was true only by coincidence of the two
	// rules agreeing.
	//
	// An `outside`-SHAPED declaration that lexically lands back in the workspace
	// (`roots/../pr-1`, or an absolute path that happens to be under it) takes the
	// inside branch and is stored in the canonical workspace-relative form, so one
	// directory has one declaration however it was typed.
	let match: GitWorktree | null = null;
	if (isOutsideWorkspace(dir)) {
		// Resolved ONCE here and threaded through every comparison the gate makes —
		// the listing scan, the refreshed re-check, the moved-worktree lookup. See
		// `canonicalWorktreePath`.
		const canonDir = canonicalPath(dir);
		// IDENTITY IS COMPARED BY REALPATH, and this is the last site in the module
		// that was still doing it lexically — reached by exactly the input the branch
		// accepts absolute paths FOR. `git worktree list`'s FIRST line is the MAIN
		// CHECKOUT, realpath'd; on a workspace whose own path traverses a symlink
		// (`/var/folders`, `/tmp`, a symlinked home) pasting it lands here rather than
		// in the lexical short-circuit above, and the gate then MATCHES it, since the
		// main checkout is a listed worktree and nothing there excludes it. The result
		// was a root that IS the workspace, declared as `../../../private/var/…` in a
		// COMMITTED `.ipynb` and labelled `kind:'worktree'` — so `initKernel` would run
		// its external-root cwd verification against the workspace and
		// `setNotebookRootAndRestart` would write agent config INTO it, rewriting the
		// very `<ws>/.mcp.json` that "an ordinary workspace launch is untouched" is
		// about. Asked canonically it is what it always was: no root at all. The cost
		// is confined to this branch, so an ordinary `roots/…` root pays nothing.
		const canonWs = canonicalWorkspace();
		if (canonDir === canonWs) return null;
		// OUTSIDE — the second, narrower admission rule. Throws unless the listing
		// names this exact directory, and its refusal names the repair, so a path
		// that simply escapes the workspace is answered by the gate rather than by
		// a separate escape message this branch would have to keep in sync.
		match = assertRegisteredWorktree(dir, canonDir, declared);
		// REGISTERED IS NOT ENOUGH: a checkout that CONTAINS the workspace is refused
		// after the gate, not before it, so a path that is merely outside keeps the
		// gate's own repair message. Named honestly for what it is — saying it is not
		// a registered worktree would be false here, since it demonstrably is.
		if (enclosesWorkspace(canonDir, canonWs)) {
			throw new NotebookRootError(
				`Notebook root ${JSON.stringify(declared)} is a registered worktree of this repository, but it CONTAINS the workspace — rooting a kernel there would run it above the directory Cellar is serving. A root must be a separate checkout (a sibling worktree), or a directory inside the workspace.`
			);
		}
	}

	// THE CANONICAL DECLARATION, through the ONE helper that owns the two-namespace
	// rule. The gate returns the worktree it matched, and it is git's REALPATH'd
	// path that has to be turned into a declaration — measuring the hop from the
	// LEXICAL workspace instead (`toRel`) is what this branch used to do, and it
	// persists `../../../private/var/folders/…` into a COMMITTED `.ipynb` on any
	// workspace whose path traverses a symlink, i.e. exactly the input this branch
	// accepts absolute paths FOR (what `git worktree add` printed is realpath'd).
	// It also gave one checkout two spellings, so the sidebar kept offering "Use as
	// root" for a worktree the notebook was already rooted at.
	const rel = match ? worktreeDeclaration(match.path) : toRel(dir);
	// Bound from the DECLARATION, so `dir` and `rel` are two views of one directory
	// however the root was typed — which is what lets `isSameDeclaredRoot` compare
	// resolved directories and see a re-declaration in the other spelling as the
	// no-op it is.
	const rootDir = resolve(wsDir, rel);
	// KIND IS A PROPERTY OF THE DIRECTORY, not of the shape that was typed and not of
	// which admission rule answered. Reading it off the branch above made it a
	// property of the INPUT: on a workspace whose path traverses a symlink, pasting
	// the absolute path git printed for a worktree that lives INSIDE `roots/` makes
	// the raw candidate fail the lexical guard, so the gate answered and `kind` came
	// back `'worktree'` — while `rel` normalized straight back to `roots/pr-1` and
	// the directory is plainly inside the workspace. Its two consumers act on that:
	// `setNotebookRootAndRestart` would write agent config into a workspace
	// subdirectory, and `initKernel` would run its external-root cwd verification —
	// and the SAME directory declared relatively classified as `'workspace'`, so one
	// directory had two kinds depending on how it was typed. Asked about the CANONICAL
	// directory, `kind` and `rel` can never disagree.
	const kind: RootKind = isOutsideWorkspace(rootDir) ? 'worktree' : 'workspace';
	let stat;
	try {
		stat = statSync(rootDir);
	} catch {
		// Being LISTED is not proof of existing: a removed worktree still lists,
		// tagged `prunable`. So the repair names how this root was ADMITTED — `match`,
		// not `kind`: a registered worktree needs `git worktree prune` whether or not
		// its directory happens to sit inside the workspace, and `kind` is now a fact
		// about the directory rather than about the listing.
		throw new NotebookRootError(
			match
				? `Notebook root ${JSON.stringify(rel)} is a registered worktree but its directory no longer exists. Run \`git worktree prune\`, re-create it (\`git worktree add ${rel} <branch>\`), or clear the notebook's root to run against the workspace.`
				: `Notebook root ${JSON.stringify(rel)} does not exist in this workspace. Create it (e.g. \`git worktree add ${rel} <branch>\`) or clear the notebook's root to run against the workspace.`
		);
	}
	if (!stat.isDirectory()) {
		throw new NotebookRootError(
			`Notebook root ${JSON.stringify(rel)} is a file, not a directory. A root is a directory the kernel runs in — normally a git worktree.`
		);
	}
	return { rel, dir: rootDir, apiPath: rel, kind };
}

/**
 * The resolved root for a notebook, or null when it declares none (the workspace
 * — today's behavior). Throws `NotebookRootError` when a root IS declared but is
 * unusable; see the module header for why that is a refusal, not a fallback.
 *
 * `nb` is any form `notebook.ts` accepts (absolute, workspace-relative, or
 * omitted for the active notebook).
 */
export function notebookRoot(nb?: string | null): ResolvedRoot | null {
	return resolveRootDir(getNotebookRoot(nb));
}
