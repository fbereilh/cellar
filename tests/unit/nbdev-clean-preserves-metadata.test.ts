/**
 * The claim the whole feature rests on, MEASURED rather than read off nbdev's
 * documentation: with `allowed_metadata_keys` / `allowed_cell_metadata_keys`
 * naming `cellar`, nbdev's cleanup leaves Cellar's namespace alone - and without
 * them it destroys it.
 *
 * The CONTROL is what makes the passing case mean anything: a test that only
 * asserted survival with the keys present would pass just as happily against an
 * nbdev that never stripped anything, and would say nothing about whether Cellar
 * needs to write them at all.
 *
 * Two cleanup paths are covered, because they are what a user actually installs:
 *   - `nbdev-clean`, the CLI (and what a pre-commit hook or CI step invokes)
 *   - `clean_jupyter`, the function `nbdev-install-hooks` wires into
 *     `~/.jupyter/jupyter_*_config.py` as a pre-save hook. It is called directly
 *     here; installing the hook for real would rewrite the developer's own
 *     `~/.jupyter` config, which no test may do. Note it is gated on nbdev's own
 *     `jupyter_hooks` setting, which defaults to FALSE - so the fixture turns it
 *     on, or the hook is a no-op and the control would pass vacuously.
 *
 * VERIFIED AGAINST nbdev 3.3.12 (Python 3.12, macOS/arm64). nbdev is a fast
 * mover - 3.0.0 moved config from `settings.ini` into `pyproject.toml` and made
 * the leftover a hard raise - so re-measure rather than trusting this note.
 *
 * The notebook under test is written by Cellar's OWN `writeNotebook`, so what
 * nbdev is handed is what Cellar really persists, not a hand-built approximation.
 *
 * SKIPS where no nbdev interpreter is discoverable (CI has none), with the reason
 * in the suite name so a green run is never mistaken for a verified one. Point it
 * at one with `CELLAR_NBDEV_PYTHON=/path/to/python`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeNotebook } from '../../src/lib/server/ipynb';
import { protectCellarMetadata, detectNbdev } from '../../src/lib/server/nbdev';

/** A python that can `import nbdev`, or null. */
function findNbdevPython(): string | null {
	const candidates = [
		process.env.CELLAR_NBDEV_PYTHON,
		join(process.cwd(), '.venv', 'bin', 'python'),
		join(process.env.HOME ?? '', '.cellar', 'host-venv', 'bin', 'python')
	].filter((p): p is string => !!p);
	for (const py of candidates) {
		if (!existsSync(py)) continue;
		try {
			execFileSync(py, ['-c', 'import nbdev'], { stdio: 'ignore' });
			return py;
		} catch {
			/* not this one */
		}
	}
	return null;
}

const PYTHON = findNbdevPython();
const VERSION = PYTHON
	? execFileSync(PYTHON, ['-c', 'import nbdev;print(nbdev.__version__)'], { encoding: 'utf8' }).trim()
	: '';

let ROOT: string;
let WS: string;
const NB = () => join(WS, 'nbs', 'demo.ipynb');

/** The notebook Cellar would persist: a cellar namespace at both levels. */
function seedNotebook() {
	writeNotebook(NB(), {
		cells: [
			{
				id: 'c1',
				cell_type: 'code',
				source: 'x = 1\n',
				outputs: [],
				metadata: { cellar: { export: true, hide_input: false } }
			},
			{
				id: 'c2',
				cell_type: 'markdown',
				source: '# Title\n',
				outputs: [],
				metadata: { cellar: { hidden_from_agent: true } }
			}
		],
		metadata: {
			kernelspec: { display_name: 'python3', language: 'python', name: 'python3' },
			cellar: { export_target: 'demo/core.py', export_base: 'workspace', header_numbering: [1, 2] }
		}
	} as never);
}

function writePyproject(withAllowlist: boolean) {
	writeFileSync(
		join(WS, 'pyproject.toml'),
		`[project]
name = "demo"
version = "0.1.0"

[tool.nbdev]
repo = "demo"
lib_path = "demo"
nbs_path = "nbs"
doc_path = "_docs"
# nbdev's Jupyter pre-save hook is gated on this and DEFAULTS TO FALSE, so
# without it the save-hook control below would pass without cleaning anything.
jupyter_hooks = true
${withAllowlist ? 'allowed_metadata_keys = ["cellar"]\nallowed_cell_metadata_keys = ["cellar"]\n' : ''}`,
		'utf8'
	);
}

/** `metadata.cellar` at notebook level, and each cell's, as they are on disk. */
function metaOnDisk() {
	const nb = JSON.parse(readFileSync(NB(), 'utf8'));
	return {
		notebook: nb.metadata?.cellar ?? null,
		cells: nb.cells.map((c: { metadata?: Record<string, unknown> }) => c.metadata?.cellar ?? null)
	};
}

function runCli() {
	execFileSync(join(dirname(PYTHON as string), 'nbdev-clean'), ['--fname', NB()], {
		cwd: WS,
		stdio: 'pipe'
	});
}

/**
 * Drive the Jupyter pre-save hook exactly as the installed hook does - it is
 * handed the in-memory model and mutates it - then write the result back so the
 * assertions read one shape for both paths.
 */
function runSaveHook() {
	const script = `
import json,sys
from nbdev.clean import clean_jupyter
p = sys.argv[1]
content = json.load(open(p))
clean_jupyter(path=p, model={'type':'notebook','content':content})
json.dump(content, open(p,'w'))
`;
	execFileSync(PYTHON as string, ['-c', script, NB()], { cwd: WS, stdio: 'pipe' });
}

beforeAll(() => {
	if (!PYTHON) return;
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-nbdev-clean-'));
	WS = join(ROOT, 'project');
	mkdirSync(join(WS, 'nbs'), { recursive: true });
});

afterAll(() => {
	if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

const suite = PYTHON
	? `nbdev-clean vs Cellar metadata (nbdev ${VERSION})`
	: 'nbdev-clean vs Cellar metadata — SKIPPED: no python with nbdev installed (set CELLAR_NBDEV_PYTHON)';

describe.skipIf(!PYTHON)(suite, () => {
	// The control. Without it, the passing case below says nothing: it would hold
	// just as well against an nbdev that strips nothing at all.
	it('CONTROL: without the allowlist keys, nbdev-clean erases every cellar key', () => {
		writePyproject(false);
		seedNotebook();
		runCli();
		expect(metaOnDisk()).toEqual({ notebook: null, cells: [null, null] });
	});

	it('with the allowlist keys, nbdev-clean leaves the cellar namespace intact', () => {
		writePyproject(true);
		seedNotebook();
		runCli();
		expect(metaOnDisk()).toEqual({
			notebook: { export_target: 'demo/core.py', export_base: 'workspace', header_numbering: [1, 2] },
			cells: [{ export: true, hide_input: false }, { hidden_from_agent: true }]
		});
	});

	// The gap the scout left open: it verified the mitigation for the CLI only and
	// expected the hook to behave the same because it calls the same `clean_nb`.
	it('CONTROL: without the keys, the Jupyter save hook erases them too', () => {
		writePyproject(false);
		seedNotebook();
		runSaveHook();
		expect(metaOnDisk()).toEqual({ notebook: null, cells: [null, null] });
	});

	it('with the keys, the Jupyter save hook leaves them intact', () => {
		writePyproject(true);
		seedNotebook();
		runSaveHook();
		expect(metaOnDisk().notebook).toEqual({
			export_target: 'demo/core.py',
			export_base: 'workspace',
			header_numbering: [1, 2]
		});
		expect(metaOnDisk().cells[0]).toEqual({ export: true, hide_input: false });
	});

	// End to end: the button Cellar offers really is what makes the difference.
	it("Cellar's own write is what turns the control into the passing case", () => {
		writePyproject(false);
		seedNotebook();
		runCli();
		expect(metaOnDisk().notebook).toBeNull();

		expect(detectNbdev(WS)).toMatchObject({ kind: 'unprotected' });
		expect(protectCellarMetadata(WS).status).toBe('written');
		expect(detectNbdev(WS)).toMatchObject({ kind: 'protected' });

		seedNotebook();
		runCli();
		expect(metaOnDisk().notebook).toEqual({
			export_target: 'demo/core.py',
			export_base: 'workspace',
			header_numbering: [1, 2]
		});
		expect(metaOnDisk().cells[0]).toEqual({ export: true, hide_input: false });
	});
});
