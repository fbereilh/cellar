/**
 * nbdev coexistence: detecting the metadata-preservation hazard, and the write
 * that closes it.
 *
 * Everything here runs against REAL files in a temp tree, because every claim is
 * about bytes on disk: which `pyproject.toml` is found, that a merge keeps what
 * was already there, and - the rule most easily lost in a refactor - that every
 * line the writer did not touch comes back byte-identical. A test that compared
 * a parsed value rather than the file text would pass against a writer that
 * reformatted the user's whole config.
 *
 * The empirical half - that the keys really do stop nbdev erasing Cellar's
 * metadata - lives in `nbdev-clean-preserves-metadata.test.ts`, which needs a
 * real nbdev install and so skips where there is none.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectNbdev, protectCellarMetadata } from '../../src/lib/server/nbdev';
import { nbdevNotice, REMEDY_LINES } from '../../src/lib/nbdev';

const ROOTS: string[] = [];
let ROOT: string;
let WS: string;

beforeEach(() => {
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-nbdev-'));
	ROOTS.push(ROOT);
	WS = join(ROOT, 'project');
	mkdirSync(join(WS, 'nbs'), { recursive: true });
});

afterAll(() => {
	for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

const PY = () => join(WS, 'pyproject.toml');
const write = (file: string, text: string) => writeFileSync(file, text, 'utf8');
const read = (file: string) => readFileSync(file, 'utf8');

const BASE = `[project]
name = "demo"
version = "0.1.0"

[tool.nbdev]
repo = "demo"
lib_path = "demo"
`;

describe('detectNbdev', () => {
	it('says nothing at all about a workspace with no pyproject', () => {
		expect(detectNbdev(WS)).toEqual({ kind: 'none' });
	});

	it('says nothing about a pyproject that is not nbdev’s', () => {
		write(PY(), '[project]\nname = "demo"\n\n[tool.ruff]\nline-length = 100\n');
		expect(detectNbdev(WS)).toEqual({ kind: 'none' });
	});

	it('reports an nbdev project missing both keys, naming the file', () => {
		write(PY(), BASE);
		expect(detectNbdev(WS)).toEqual({
			kind: 'unprotected',
			path: PY(),
			missing: ['allowed_metadata_keys', 'allowed_cell_metadata_keys']
		});
	});

	it('reports a key that exists but does not carry cellar', () => {
		write(PY(), BASE + 'allowed_metadata_keys = ["solveit"]\nallowed_cell_metadata_keys = ["cellar"]\n');
		expect(detectNbdev(WS)).toEqual({
			kind: 'unprotected',
			path: PY(),
			missing: ['allowed_metadata_keys']
		});
	});

	it('is silent once both keys carry cellar', () => {
		write(PY(), BASE + 'allowed_metadata_keys = ["cellar"]\nallowed_cell_metadata_keys = ["cellar"]\n');
		expect(detectNbdev(WS)).toEqual({ kind: 'protected', path: PY() });
		expect(nbdevNotice(detectNbdev(WS))).toBeNull();
	});

	// nbdev's own discovery walks UP (`_find_nbdev_pyproject`), so a monorepo whose
	// config lives at the repo root with Cellar opened in a subdirectory is the
	// ordinary case - the one place refusing to look would leave the hazard unfixed.
	it('walks up to a parent pyproject, and prefers the NEAREST one', () => {
		write(join(ROOT, 'pyproject.toml'), BASE);
		const nested = join(WS, 'nbs');
		expect(detectNbdev(nested)).toMatchObject({ kind: 'unprotected', path: join(ROOT, 'pyproject.toml') });
		write(PY(), BASE + 'allowed_metadata_keys = ["cellar"]\nallowed_cell_metadata_keys = ["cellar"]\n');
		expect(detectNbdev(nested)).toEqual({ kind: 'protected', path: PY() });
	});

	// A pyproject with no `[tool.nbdev]` must not stop the walk, exactly as nbdev's
	// `_has_nbdev` returns False and keeps looking.
	it('walks past a non-nbdev pyproject to an nbdev one above it', () => {
		write(join(ROOT, 'pyproject.toml'), BASE);
		write(PY(), '[project]\nname = "inner"\n');
		expect(detectNbdev(WS)).toMatchObject({ kind: 'unprotected', path: join(ROOT, 'pyproject.toml') });
	});

	it('refuses an inline-table [tool.nbdev] rather than guessing, and says which line', () => {
		write(PY(), '[project]\nname = "demo"\n\n[tool]\nnbdev = { repo = "demo" }\n');
		expect(detectNbdev(WS)).toEqual({ kind: 'other-form', path: PY(), line: 5 });
	});

	// A dotted key defines `tool.nbdev` implicitly, and TOML forbids extending such
	// a table with a `[tool.nbdev]` header afterwards - so this refuses rather than
	// appending something that would make the whole file unparseable.
	it('refuses a top-level dotted-key tool.nbdev', () => {
		write(PY(), 'tool.nbdev.repo = "demo"\n\n[project]\nname = "demo"\n');
		expect(detectNbdev(WS)).toMatchObject({ kind: 'other-form', path: PY(), line: 1 });
	});

	it('refuses an allowlist that is not a plain list of strings, naming the key', () => {
		write(PY(), BASE + 'allowed_metadata_keys = { a = 1 }\n');
		expect(detectNbdev(WS)).toEqual({
			kind: 'unwritable-value',
			path: PY(),
			key: 'allowed_metadata_keys',
			line: 8
		});
	});

	it('reports an nbdev-looking pyproject it cannot parse', () => {
		write(PY(), '[project]\nname = "demo\n\n[tool.nbdev]\nrepo = "demo"\n');
		expect(detectNbdev(WS)).toMatchObject({ kind: 'unreadable', path: PY() });
	});

	// A broken pyproject that never mentions nbdev is none of Cellar's business -
	// exactly what nbdev's own `_has_nbdev` concludes, since it swallows the parse
	// error and walks on.
	it('says nothing about an unparseable pyproject that is not nbdev’s', () => {
		write(PY(), '[project]\nname = "demo\n');
		expect(detectNbdev(WS)).toEqual({ kind: 'none' });
	});

	// No evidence it is nbdev's at all, so silence rather than a nag. The failure
	// that matters is at WRITE time, where it is reported and nothing is changed.
	it('says nothing about a pyproject it cannot open', () => {
		write(PY(), BASE);
		chmodSync(PY(), 0o000);
		try {
			expect(detectNbdev(WS)).toEqual({ kind: 'none' });
		} finally {
			chmodSync(PY(), 0o600);
		}
	});

	// Deliberately narrower than nbdev, which raises on ANY settings.ini it meets
	// while looking for a project: a bare `settings.ini` is an ordinary configparser
	// filename, and telling a user who never touched nbdev that their project is
	// broken is exactly the false nag this surface exists to avoid.
	it('reports a legacy nbdev settings.ini only when it looks like nbdev’s', () => {
		write(join(WS, 'settings.ini'), '[DEFAULT]\nfoo = bar\n');
		expect(detectNbdev(WS)).toEqual({ kind: 'none' });
		write(join(WS, 'settings.ini'), '[DEFAULT]\nlib_name = demo\nnbs_path = nbs\n');
		expect(detectNbdev(WS)).toEqual({ kind: 'legacy-settings-ini', path: join(WS, 'settings.ini') });
	});

	// nbdev only raises on a settings.ini when no `[tool.nbdev]` pyproject was
	// found, so a project that has migrated must not be nagged about the leftover.
	it('ignores a settings.ini when an nbdev pyproject exists', () => {
		write(PY(), BASE);
		write(join(WS, 'settings.ini'), '[DEFAULT]\nlib_name = demo\n');
		expect(detectNbdev(WS)).toMatchObject({ kind: 'unprotected' });
	});
});

describe('protectCellarMetadata', () => {
	it('adds both keys inside [tool.nbdev] and leaves every other line byte-identical', () => {
		write(PY(), BASE);
		const before = read(PY());
		const res = protectCellarMetadata(WS);
		expect(res.status).toBe('written');
		expect(res.state).toEqual({ kind: 'protected', path: PY() });
		const after = read(PY());
		expect(after).toContain('allowed_metadata_keys = ["cellar"]');
		expect(after).toContain('allowed_cell_metadata_keys = ["cellar"]');
		// Nothing but the two inserted lines: strip them and the file is what it was.
		const stripped = after
			.split('\n')
			.filter((l) => !l.startsWith('allowed_metadata_keys') && !l.startsWith('allowed_cell_metadata_keys'))
			.join('\n');
		expect(stripped).toBe(before);
	});

	it('MERGES with values already there rather than replacing them', () => {
		write(PY(), BASE + 'allowed_metadata_keys = ["solveit", "jupytext"]\n');
		protectCellarMetadata(WS);
		expect(read(PY())).toContain('allowed_metadata_keys = ["solveit", "jupytext", "cellar"]');
		expect(read(PY())).toContain('allowed_cell_metadata_keys = ["cellar"]');
	});

	// A value spanning several lines is read whole and re-rendered as ONE line - the
	// splice replaces whole physical lines, which is the same property the sibling
	// Codex writer has. That is the one formatting cost, and it is scoped to the key
	// being CHANGED: everything else, this key included once it says `cellar`, is
	// byte-identical. Pinned so the collapse is a decision rather than a surprise.
	it('merges a multi-line array, re-rendering that ONE key on a single line', () => {
		write(PY(), BASE + 'allowed_metadata_keys = [\n  "solveit",\n  "jupytext",\n]\n\n[tool.ruff]\nline-length = 100\n');
		protectCellarMetadata(WS);
		const after = read(PY());
		expect(after).toContain('allowed_metadata_keys = ["solveit", "jupytext", "cellar"]');
		expect(after).not.toContain('  "jupytext",');
		// The neighbouring table is untouched.
		expect(after).toContain('[tool.ruff]\nline-length = 100');
	});

	it('leaves a key that already says cellar byte-identical, comment and all', () => {
		write(PY(), BASE + 'allowed_metadata_keys = ["cellar"]  # set by hand\n');
		protectCellarMetadata(WS);
		// Rewriting it to change nothing would destroy that trailing comment.
		expect(read(PY())).toContain('allowed_metadata_keys = ["cellar"]  # set by hand');
	});

	it('is idempotent: a second run writes nothing at all', () => {
		write(PY(), BASE);
		expect(protectCellarMetadata(WS).status).toBe('written');
		const after = read(PY());
		const second = protectCellarMetadata(WS);
		expect(second.status).toBe('already');
		expect(read(PY())).toBe(after);
		// and there is nothing left to offer
		expect(nbdevNotice(detectNbdev(WS))).toBeNull();
	});

	it('preserves comments, key order and spacing everywhere else', () => {
		write(
			PY(),
			`# a comment the user wrote
[project]
name = "demo"          # trailing
dependencies = [
  "pandas",
]

[tool.nbdev]
# why this repo is named that
repo = "demo"

[tool.ruff]
line-length = 100
`
		);
		protectCellarMetadata(WS);
		const after = read(PY());
		expect(after).toContain('# a comment the user wrote');
		expect(after).toContain('name = "demo"          # trailing');
		expect(after).toContain('# why this repo is named that');
		expect(after).toContain('[tool.ruff]\nline-length = 100');
		// Inserted directly under the header, so the table stays self-describing.
		expect(after).toContain('[tool.nbdev]\nallowed_metadata_keys = ["cellar"]');
	});

	it('writes CRLF into a CRLF file, so a two-line edit is not a whole-file diff', () => {
		write(PY(), BASE.replace(/\n/g, '\r\n'));
		protectCellarMetadata(WS);
		const after = read(PY());
		expect(after).toContain('allowed_metadata_keys = ["cellar"]\r\n');
		expect(after.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
	});

	it('does nothing to a project that is not nbdev’s', () => {
		write(PY(), '[project]\nname = "demo"\n');
		const before = read(PY());
		expect(protectCellarMetadata(WS)).toEqual({ status: 'refused', state: { kind: 'none' } });
		expect(read(PY())).toBe(before);
	});

	// All-or-nothing: half protection under a shape Cellar does not understand is
	// worse than a clear refusal that names the two lines to add by hand.
	it('refuses the WHOLE write when one allowlist is unreadable, touching nothing', () => {
		write(PY(), BASE + 'allowed_metadata_keys = { a = 1 }\n');
		const before = read(PY());
		const res = protectCellarMetadata(WS);
		expect(res.status).toBe('refused');
		expect(res.state).toMatchObject({ kind: 'unwritable-value', key: 'allowed_metadata_keys' });
		expect(read(PY())).toBe(before);
		expect(read(PY())).not.toContain('allowed_cell_metadata_keys');
	});

	it('refuses an inline-table [tool.nbdev], touching nothing', () => {
		write(PY(), '[project]\nname = "demo"\n\n[tool]\nnbdev = { repo = "demo" }\n');
		const before = read(PY());
		expect(protectCellarMetadata(WS).status).toBe('refused');
		expect(read(PY())).toBe(before);
	});

	// Honest about failure: never report protection that is not in place.
	it('reports a write it could not make, and leaves the file untouched', () => {
		write(PY(), BASE);
		const before = read(PY());
		chmodSync(WS, 0o500); // no writes in the directory: the temp+rename cannot land
		try {
			const res = protectCellarMetadata(WS);
			expect(res.status).toBe('failed');
			expect(res.error).toBeTruthy();
			// The state still says the hazard is live - it must not read as protected.
			expect(res.state).toMatchObject({ kind: 'unprotected' });
			expect(read(PY())).toBe(before);
		} finally {
			chmodSync(WS, 0o700);
		}
	});
});

describe('nbdevNotice', () => {
	it('offers a write only for the state Cellar can actually fix', () => {
		expect(nbdevNotice({ kind: 'none' })).toBeNull();
		expect(nbdevNotice({ kind: 'protected', path: '/p' })).toBeNull();
		expect(nbdevNotice({ kind: 'unprotected', path: '/p', missing: [] })?.canWrite).toBe(true);
		expect(nbdevNotice({ kind: 'other-form', path: '/p', line: 3 })?.canWrite).toBe(false);
		expect(nbdevNotice({ kind: 'unreadable', path: '/p', reason: 'x' })?.canWrite).toBe(false);
		expect(nbdevNotice({ kind: 'legacy-settings-ini', path: '/p' })?.canWrite).toBe(false);
		expect(
			nbdevNotice({ kind: 'unwritable-value', path: '/p', key: 'allowed_metadata_keys', line: 3 })?.canWrite
		).toBe(false);
	});

	// Every refusal has to be actionable, so each one names its own repair.
	it('gives a refusal a hint of its own', () => {
		for (const state of [
			{ kind: 'other-form', path: '/p', line: 3 },
			{ kind: 'unreadable', path: '/p', reason: 'x' },
			{ kind: 'legacy-settings-ini', path: '/p' },
			{ kind: 'unwritable-value', path: '/p', key: 'allowed_metadata_keys', line: 3 }
		] as const) {
			expect(nbdevNotice(state)?.hint).toBeTruthy();
		}
	});

	// The lines shown are the lines the writer produces; a card that showed
	// something else would be advice that does not match what the button does.
	it('shows exactly the lines the writer emits', () => {
		write(PY(), BASE.replace('[tool.nbdev]\nrepo = "demo"\nlib_path = "demo"\n', ''));
		expect(REMEDY_LINES).toEqual([
			'[tool.nbdev]',
			'allowed_metadata_keys = ["cellar"]',
			'allowed_cell_metadata_keys = ["cellar"]'
		]);
		write(PY(), BASE);
		protectCellarMetadata(WS);
		for (const line of REMEDY_LINES) expect(read(PY())).toContain(line);
	});
});
