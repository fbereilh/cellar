/**
 * Cellar — jupytext / Databricks `.py` notebook (de)serialization.
 *
 * Cellar opens `.py` notebooks (jupytext "percent" / "light" and Databricks'
 * source format) as live, kernel-attached documents, the same experience as a
 * `.ipynb`. This module is the `.py` ⇄ cells boundary; `notebook.js` calls it
 * from `loadDoc` / `persist` exactly where it calls `ipynb.js` for a `.ipynb`,
 * so everything above it (cell ops, run, events, MCP) is format-agnostic.
 *
 * ## Two engines, one helper
 *   - **jupytext** handles percent / light / etc. It is a Python library, so it
 *     runs in a short-lived subprocess of the *project* venv's python — the same
 *     interpreter the kernel uses (see `databricks.js` for the same split). That
 *     way "can the kernel import jupytext" and "can our converter import it"
 *     never disagree.
 *   - **Databricks source format** (`# Databricks notebook source`,
 *     `# COMMAND ----------`, `# MAGIC`) is handled by a small dedicated
 *     converter inside the helper. jupytext has NO native Databricks format, and
 *     mis-parses it as "light"; the converter is exact and round-trips
 *     byte-for-byte, which is what the captain's git/Databricks workflow needs.
 *
 * ## Text has no outputs — by design
 * A `.py` notebook, saved, is pure source: no outputs, no execution counts. That
 * is what makes it good for git and Databricks. So a `.py` doc persists only when
 * its SOURCE / structure changes; an outputs-only mutation (a run) updates the
 * in-memory doc for live display but writes nothing (`notebook.js` `setOutputs`).
 *
 * ## The helper is embedded, not a sibling `.py`
 * `$lib/server` modules are bundled into `build/`, so a sibling data file would
 * not ship. `inspect.js` and `databricks.js` embed their probes the same way.
 * The helper always prints exactly one `SENTINEL`-prefixed JSON line and never
 * lets a traceback be the only answer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { hasUv, installPackages, isValidVenv, venvPython } from './venv.js';

const SENTINEL = '__CELLAR_JPT__';
const HELPER_TIMEOUT_MS = 30_000;
const HELPER_MAX_BUFFER = 64 * 1024 * 1024; // large notebooks

/** Databricks source-format markers (the first line, and the cell separator). */
const DBX_HEADER = '# Databricks notebook source';

/** Formats offered in the "Save as .py" picker. Databricks is the captain's default. */
export const SAVE_FORMATS = ['databricks', 'percent'];

function workspace() {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/**
 * The interpreter the kernel runs in, which is also the one the jupytext
 * subprocess must use — whatever jupytext the kernel could import is exactly what
 * our converter should import. Mirrors `databricks.js`'s `projectPython()`
 * (kept local so the two features stay decoupled).
 */
export function projectPython() {
	const bound = process.env.CELLAR_PROJECT_VENV;
	if (bound && existsSync(bound)) return bound;
	const local = join(workspace(), '.venv');
	return isValidVenv(local) ? venvPython(local) : null;
}

/** A structured failure the routes turn into an HTTP status + clear copy. */
export class JupytextError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'JupytextError';
		this.code = code;
	}
}

/** True for a `.py` path (the only extension Cellar treats as a possible text notebook). */
export function isPyPath(path) {
	return extname(path).toLowerCase() === '.py';
}

/**
 * Decide, from a `.py` file's TEXT alone, whether Cellar should open it as a live
 * notebook — and never boot python to do it. A plain script must still open as
 * text (matching VS Code / the task), so only an explicit notebook marker counts:
 *   - the Databricks source header,
 *   - a percent/hydrogen cell marker (`# %%`), or
 *   - a jupytext YAML front-matter header (`# ---` … `# jupytext:`).
 * A markerless "light" script is indistinguishable from an ordinary module, so it
 * is deliberately NOT treated as a notebook. The returned `format` is a hint; the
 * Python helper re-detects authoritatively on read and reports the real one.
 */
export function detectPyNotebook(text) {
	const firstNonBlank = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
	if (firstNonBlank === DBX_HEADER) return { notebook: true, format: 'databricks' };
	if (/^# %%/m.test(text)) return { notebook: true, format: 'percent' };
	if (/^# ---\s*$/m.test(text) && /^#\s+jupytext:/m.test(text)) return { notebook: true, format: null };
	return { notebook: false, format: null };
}

// ---------------------------------------------------------------------------
// The Python helper (embedded)
// ---------------------------------------------------------------------------

const HELPER = `
import json, sys

SENTINEL = ${JSON.stringify(SENTINEL)}
DBX_HEADER = "# Databricks notebook source"
DBX_SEP = "# COMMAND ----------"
MAGIC_PREFIX = "# MAGIC"


def _strip_blank_edges(lines):
    while lines and lines[0].strip() == "":
        lines.pop(0)
    while lines and lines[-1].strip() == "":
        lines.pop()
    return lines


def parse_databricks(text):
    lines = text.split("\\n")
    if lines and lines[0].strip() == DBX_HEADER:
        lines = lines[1:]
    chunks = [[]]
    for ln in lines:
        if ln.strip() == DBX_SEP:
            chunks.append([])
        else:
            chunks[-1].append(ln)
    cells = []
    for chunk in chunks:
        chunk = _strip_blank_edges(list(chunk))
        if not chunk:
            continue
        if all(l.startswith(MAGIC_PREFIX) for l in chunk):
            inner = []
            for l in chunk:
                if l.startswith(MAGIC_PREFIX + " "):
                    inner.append(l[len(MAGIC_PREFIX) + 1:])
                else:  # a bare "# MAGIC" line (blank line inside a magic cell)
                    inner.append(l[len(MAGIC_PREFIX):])
            first = inner[0].strip()
            if first == "%md":
                body = _strip_blank_edges(inner[1:])
                cells.append({"cell_type": "markdown", "source": "\\n".join(body)})
            else:
                # keep the magic intact as a code cell (%sql / %sh / %run / ...)
                cells.append({"cell_type": "code", "source": "\\n".join(inner)})
        else:
            cells.append({"cell_type": "code", "source": "\\n".join(chunk)})
    return cells


def write_databricks(cells):
    out = [DBX_HEADER]
    first = True
    for c in cells:
        src = c.get("source", "")
        if not first:
            out.append("")
            out.append(DBX_SEP)
            out.append("")
        first = False
        if c.get("cell_type") == "markdown":
            out.append(MAGIC_PREFIX + " %md")
            for l in src.split("\\n"):
                out.append(MAGIC_PREFIX + " " + l if l != "" else MAGIC_PREFIX)
        elif src.lstrip().startswith("%"):
            for l in src.split("\\n"):
                out.append(MAGIC_PREFIX + " " + l if l != "" else MAGIC_PREFIX)
        else:
            out.extend(src.split("\\n"))
    return "\\n".join(out) + "\\n"


def read(path, fmt=None):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    first = next((l for l in text.split("\\n") if l.strip() != ""), "")
    if fmt == "databricks" or first.strip() == DBX_HEADER:
        return {"ok": True, "format": "databricks", "cells": parse_databricks(text)}
    import jupytext
    nb = jupytext.reads(text, fmt=("py:" + fmt) if fmt else None)
    fmt_name = nb.metadata.get("jupytext", {}).get("text_representation", {}).get("format_name") or "percent"
    cells = [{"cell_type": c.cell_type, "source": c.source} for c in nb.cells]
    return {"ok": True, "format": fmt_name, "cells": cells}


def write(path, fmt, cells):
    if fmt == "databricks":
        text = write_databricks(cells)
    else:
        import jupytext
        from nbformat.v4 import new_notebook, new_code_cell, new_markdown_cell
        nb_cells = []
        for c in cells:
            if c.get("cell_type") == "markdown":
                nb_cells.append(new_markdown_cell(c.get("source", "")))
            else:
                nb_cells.append(new_code_cell(c.get("source", "")))
        nb = new_notebook(cells=nb_cells)
        # Drop the jupytext YAML header (and its version stamp) so re-saving from a
        # different jupytext version produces no git diff. The cell markers alone
        # are enough to re-detect the format on reopen.
        nb.metadata["jupytext"] = {"notebook_metadata_filter": "-all", "cell_metadata_filter": "-all"}
        text = jupytext.writes(nb, fmt="py:" + fmt)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return {"ok": True, "path": path, "format": fmt}


def main():
    req = json.loads(sys.argv[1])
    op = req.get("op")
    if op == "check":
        import jupytext  # noqa: F401
        return {"ok": True, "jupytext": True}
    if op == "read":
        return read(req["path"], req.get("format"))
    if op == "write":
        return write(req["path"], req["format"], req["cells"])
    return {"ok": False, "code": "error", "message": "unknown op: %r" % (op,)}


try:
    result = main()
except FileNotFoundError as e:
    result = {"ok": False, "code": "not_found", "message": str(e)}
except (ImportError, ModuleNotFoundError) as e:
    result = {"ok": False, "code": "jupytext_missing", "message": "%s: %s" % (type(e).__name__, e)}
except Exception as e:  # never let a traceback be the only answer
    result = {"ok": False, "code": "error", "message": "%s: %s" % (type(e).__name__, e)}
sys.stdout.write(SENTINEL + json.dumps(result) + "\\n")
`;

/** No project interpreter bound at all — nothing can import jupytext. */
function requirePython() {
	const python = projectPython();
	if (!python) {
		throw new JupytextError(
			'no_python',
			'No Python environment is bound to this workspace. Launch Cellar with `cellar`, or set one in Settings → Python environment.'
		);
	}
	return python;
}

/** Run one helper command SYNCHRONOUSLY in the project venv and return its parsed result. */
function runHelperSync(request) {
	const python = requirePython();
	const res = spawnSync(python, ['-c', HELPER, JSON.stringify(request)], {
		cwd: workspace(),
		encoding: 'utf8',
		timeout: HELPER_TIMEOUT_MS,
		maxBuffer: HELPER_MAX_BUFFER
	});
	if (res.error) {
		if (res.error.code === 'ETIMEDOUT') throw new JupytextError('timeout', 'the jupytext helper timed out');
		throw new JupytextError('error', `could not run ${python}: ${res.error.message}`);
	}
	const line = (res.stdout || '').split('\n').find((l) => l.startsWith(SENTINEL));
	if (!line) {
		throw new JupytextError('error', (res.stderr || '').trim() || 'the jupytext helper produced no result');
	}
	let result;
	try {
		result = JSON.parse(line.slice(SENTINEL.length));
	} catch (err) {
		throw new JupytextError('error', `unparseable helper result: ${err.message}`);
	}
	if (!result.ok) throw new JupytextError(result.code || 'error', result.message || 'jupytext helper failed');
	return result;
}

/**
 * Read a `.py` notebook into canonical cells. `format` (optional) forces a
 * format; otherwise the helper auto-detects (Databricks header → the dedicated
 * converter, else jupytext). Returns `{ format, cells }` where each cell is in
 * canonical shape (id minted by the caller, no outputs, empty metadata) — text
 * notebooks carry neither outputs nor cell metadata.
 */
export function readPyNotebook(absPath, format) {
	const result = runHelperSync({ op: 'read', path: absPath, format });
	const cells = (result.cells || []).map((c) => ({
		id: null,
		cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
		source: typeof c.source === 'string' ? c.source : '',
		outputs: [],
		metadata: {}
	}));
	return { format: result.format, cells };
}

/**
 * Write canonical cells to a `.py` file in the given jupytext/Databricks format.
 * Only source + cell type are written (a text notebook has no outputs).
 */
export function writePyNotebook(absPath, cells, format) {
	const payload = cells.map((c) => ({
		cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
		source: typeof c.source === 'string' ? c.source : ''
	}));
	runHelperSync({ op: 'write', path: absPath, format, cells: payload });
}

// ---------------------------------------------------------------------------
// jupytext availability (async — install / check)
// ---------------------------------------------------------------------------

/** Can the project interpreter import jupytext? */
export async function checkJupytext() {
	const python = projectPython();
	if (!python) return { python: null, jupytext: false };
	const res = spawnSync(python, ['-c', 'import jupytext'], { encoding: 'utf8', timeout: HELPER_TIMEOUT_MS });
	return { python, jupytext: res.status === 0 };
}

/**
 * Ensure jupytext is importable by the project interpreter, installing it with uv
 * if missing (the one place besides ipykernel / the Databricks packages that
 * Cellar adds to a project venv). Throws a clear `JupytextError` when it cannot —
 * a missing package must never surface as a crash.
 */
export async function ensureJupytext() {
	const python = requirePython();
	const { jupytext } = await checkJupytext();
	if (jupytext) return { installed: false, python };
	if (!(await hasUv())) {
		throw new JupytextError(
			'jupytext_missing',
			'jupytext is not installed in this workspace’s Python environment, and uv is not on PATH to install it. Install jupytext into the venv (e.g. `uv pip install jupytext`).'
		);
	}
	try {
		await installPackages(python, ['jupytext']);
	} catch (err) {
		throw new JupytextError(
			'jupytext_missing',
			`could not install jupytext into ${python}: ${err?.message ?? err}. Install it manually (\`uv pip install jupytext\`).`
		);
	}
	return { installed: true, python };
}

/** HTTP status for a `JupytextError.code`. */
export function statusFor(code) {
	switch (code) {
		case 'bad_request':
			return 400;
		case 'not_found':
			return 404;
		case 'no_python':
		case 'jupytext_missing':
			return 412; // precondition: the environment is not ready
		case 'timeout':
			return 504;
		default:
			return 500;
	}
}

/** Resolve a workspace-relative path to an absolute path (guarded to the workspace). */
export function resolveInWorkspace(relPath) {
	const root = resolve(workspace());
	const abs = resolve(root, relPath ?? '');
	if (abs !== root && !abs.startsWith(root + sep)) {
		throw new JupytextError('bad_request', 'path escapes workspace');
	}
	return abs;
}
