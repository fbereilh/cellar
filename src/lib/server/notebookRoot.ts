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
 * decorative: `resolveRootDir` ASKS `resolveInWorkspace` and treats its throw as
 * the outside branch, so this module holds no containment rule of its own. A
 * local copy of the guard's lexical prefix test deciding the branch — and then
 * calling the guard inside it, unreachably — would make the claim below true only
 * for as long as the two rules happened to agree.
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { workspaceRoot, resolveInWorkspace } from './fstree';
import { getNotebookRoot } from './notebook';
import { listWorktreesAt, type GitWorktree } from './git';
import { NotebookRootError, classifyRootPath } from '../notebookRoot';

/** How a root was admitted — for messages, and for the UI to label it. */
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
	/** Which admission rule let this root through. */
	kind: RootKind;
}

/** The lexical workspace root, as every path here is relative to. */
function ws(): string {
	return resolve(workspaceRoot());
}

/** `realpathSync` where possible, else the path itself (it may not exist yet). */
function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
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
 * namespace and then applied lexically from the workspace. Measuring it as
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
export function worktreeDeclaration(worktreePath: string): string {
	const rel = relative(realpathOrSelf(ws()), worktreePath).split(sep).join('/');
	if (rel && samePath(resolve(ws(), rel), worktreePath)) return rel;
	return toRel(worktreePath);
}

/** Short, deterministic rendering of what IS registered, for a refusal message. */
function nameWorktrees(list: GitWorktree[]): string {
	const others = list.filter((w) => !samePath(w.path, ws()));
	if (!others.length) return 'This repository has no other worktrees registered.';
	const shown = others.slice(0, 5).map((w) => w.path);
	const more = others.length - shown.length;
	return `Cellar found ${others.length} registered worktree${others.length === 1 ? '' : 's'}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
}

/**
 * Admit an out-of-workspace declaration, or throw naming why it was refused.
 *
 * `dir` is the LEXICALLY resolved candidate. Verification is realpath identity
 * against the listing (the two-namespace rule); nothing lexical is compared,
 * because `git worktree list` realpaths its output.
 */
function assertRegisteredWorktree(dir: string, declared: string): GitWorktree {
	let list = listWorktreesAt(ws());
	let match = list.find((w) => samePath(w.path, dir));
	// A MISS is re-checked against a FRESH listing before it becomes a refusal.
	// The listing is cached for 1.5s, which would otherwise be a window in which a
	// worktree the user created seconds ago — the very next thing they do after
	// `git worktree add` is point a notebook at it — is reported as unregistered.
	// One extra spawn on the refusal path is cheap (refusals are rare, and the
	// alternative is telling the user their worktree does not exist), and the happy
	// path never reaches this.
	if (!match) {
		list = listWorktreesAt(ws(), { refresh: true });
		match = list.find((w) => samePath(w.path, dir));
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
		const moved = list.find((w) => !samePath(w.path, ws()) && registrationName(w.path) === wanted);
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
	// Lexical resolution serves both shapes: `resolve(ws, '../sib')` escapes,
	// `resolve(ws, '/abs')` returns the absolute path untouched.
	const dir = resolve(ws(), declared);

	if (dir === ws()) {
		// Reachable via a value the classifier accepted that still resolves to the
		// workspace itself; that is the same thing as declaring no root.
		return null;
	}

	// THE SHARED GUARD MAKES THE DECISION — it is asked, never paraphrased.
	//
	// This module holds no containment rule of its own. A local `insideWorkspace`
	// copy of the guard's lexical test used to decide the branch and then call
	// `resolveInWorkspace` inside it, which made that call (and its catch)
	// unreachable by construction — so the doctrine's claim that the untouched
	// guard is the authority for the inside branch was true only by coincidence of
	// the two rules agreeing. Asking the guard and treating its THROW as the
	// outside branch is what makes the claim structural: there is exactly one
	// implementation of "inside the workspace" in the app, and this is a caller of
	// it, not a second copy.
	let kind: RootKind;
	let match: GitWorktree | null = null;
	let inside = true;
	try {
		// INSIDE — including an `outside`-SHAPED declaration that lexically lands
		// back in the workspace (`roots/../pr-1`, or an absolute path that happens
		// to be under it). Those are stored in the canonical workspace-relative
		// form, so one directory has one declaration however it was typed.
		resolveInWorkspace(toRel(dir));
	} catch {
		inside = false;
	}
	if (inside) {
		kind = 'workspace';
	} else {
		// OUTSIDE — the second, narrower admission rule. Throws unless the listing
		// names this exact directory, and its refusal names the repair, so a path
		// that simply escapes the workspace is answered by the gate rather than by
		// a separate escape message this branch would have to keep in sync.
		match = assertRegisteredWorktree(dir, declared);
		kind = 'worktree';
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
	const rootDir = resolve(ws(), rel);
	let stat;
	try {
		stat = statSync(rootDir);
	} catch {
		// Being LISTED is not proof of existing: a removed worktree still lists,
		// tagged `prunable`. So each kind names its own repair.
		throw new NotebookRootError(
			kind === 'worktree'
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
