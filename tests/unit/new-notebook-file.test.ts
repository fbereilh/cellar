/**
 * A NEW `.ipynb` is a VALID notebook the moment it exists — and an already-BLANK
 * one still opens.
 *
 * The reported bug: creating `analysis.ipynb` through the file explorer produced a
 * ZERO-BYTE file (`createEntry` writes `''` for every file kind), and opening it
 * answered `Unexpected end of JSON input` — `JSON.parse('')` reaching the user
 * through `readNotebook`. The empty-state "New notebook" button and every MCP
 * create went through `createNotebook` instead and wrote a real skeleton, which is
 * why one route worked and the other did not.
 *
 * Two halves, and the tests below keep them apart because they answer different
 * questions:
 *   - the WRITER (`POST /api/fs/op` + `createEntry`) makes the file valid for
 *     every tool, not just Cellar;
 *   - the READER (`readNotebook`) opens a blank file as a blank notebook, which is
 *     what repairs a file the writer never wrote — a `touch`, a rename or a copy of
 *     an empty file, or an `.ipynb` an older Cellar already left on disk.
 *
 * Driven against a real scratch workspace on the real filesystem: the whole
 * question is what lands on disk and whether it can be read back.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let ipynb: typeof import('../../src/lib/server/ipynb');
let OP: (evt: { request: Request }) => Promise<Response>;

/**
 * Drive the real file-op route the sidebar explorer posts to. A refusal reaches
 * the browser as a 400 but reaches a direct caller as a THROWN SvelteKit
 * `HttpError`, so it is normalised back to a status here.
 */
async function op(body: unknown): Promise<{ status: number; body: any }> {
	try {
		const res = await OP({
			request: new Request('http://x/api/fs/op', { method: 'POST', body: JSON.stringify(body) })
		});
		return { status: res.status, body: await res.json() };
	} catch (err) {
		const e = err as { status?: number; body?: { message?: string } };
		return { status: e?.status ?? 500, body: e?.body ?? { message: String(err) } };
	}
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-new-ipynb-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	ipynb = await import('../../src/lib/server/ipynb');
	OP = (await import('../../src/routes/api/fs/op/+server.js')).POST as unknown as typeof OP;
});

describe('the file explorer creates a usable notebook', () => {
	it('writes a valid nbformat 4.5 notebook with one empty code cell', async () => {
		expect((await op({ op: 'create', parent: '', name: 'analysis.ipynb', kind: 'file' })).status).toBe(200);

		const abs = join(WS, 'analysis.ipynb');
		// The headline regression: the file used to be zero bytes.
		expect(statSync(abs).size).toBeGreaterThan(0);
		const raw = JSON.parse(readFileSync(abs, 'utf8'));
		expect(raw.nbformat).toBe(4);
		expect(raw.nbformat_minor).toBe(5);
		expect(raw.cells).toHaveLength(1);
		expect(raw.cells[0].cell_type).toBe('code');
		expect(raw.cells[0].source).toEqual([]);
		// nbformat 4.5 requires an id per cell; Cellar owns generation + uniqueness.
		expect(raw.cells[0].id).toMatch(/^[a-zA-Z0-9-_]{1,64}$/);
	});

	it('opens it — the end-user path the bug dead-ended on', async () => {
		await op({ op: 'create', parent: '', name: 'opens.ipynb', kind: 'file' });
		// This is exactly what `GET /api/notebooks?path=` returns; before the fix it
		// threw `Unexpected end of JSON input` and the tab rendered a load error.
		const view = nbmod.getNotebook('opens.ipynb');
		expect(view.cells).toHaveLength(1);
		expect(view.cells[0].cell_type).toBe('code');
		expect(view.cells[0].source).toBe('');
	});

	it('is byte-stable: re-saving what it wrote changes nothing (zero git diff)', async () => {
		await op({ op: 'create', parent: '', name: 'stable.ipynb', kind: 'file' });
		const abs = join(WS, 'stable.ipynb');
		const before = readFileSync(abs, 'utf8');
		// A save of the untouched document must reproduce the same bytes, or every
		// brand-new notebook would churn its first line of git history.
		nbmod.getNotebook('stable.ipynb');
		ipynb.writeNotebook(abs, { path: abs, cells: nbmod.listCells('stable.ipynb'), metadata: undefined });
		expect(readFileSync(abs, 'utf8')).toBe(before);
	});

	it('decides from the name that LANDS on disk, not the name that was typed', async () => {
		// `assertSimpleName` trims, so a caller answering from its own raw input would
		// answer about `"spaced.ipynb  "` while creating `spaced.ipynb` — blank, which
		// is the very bug. `createEntry` hands the callback the NORMALISED name.
		const res = await op({ op: 'create', parent: '', name: '  spaced.ipynb  ', kind: 'file' });
		expect(res.body.path).toBe('spaced.ipynb');
		expect(statSync(join(WS, 'spaced.ipynb')).size).toBeGreaterThan(0);
		expect(nbmod.getNotebook('spaced.ipynb').cells).toHaveLength(1);
	});

	it('is case-insensitive about the extension, like the browser tab rule', async () => {
		await op({ op: 'create', parent: '', name: 'Shouty.IPYNB', kind: 'file' });
		expect(JSON.parse(readFileSync(join(WS, 'Shouty.IPYNB'), 'utf8')).cells).toHaveLength(1);
	});

	it('works in a subfolder (the tree context menu creates there)', async () => {
		mkdirSync(join(WS, 'sub'));
		await op({ op: 'create', parent: 'sub', name: 'nested.ipynb', kind: 'file' });
		expect(nbmod.getNotebook('sub/nested.ipynb').cells).toHaveLength(1);
	});

	it('leaves every OTHER file kind empty — nothing else changed', async () => {
		await op({ op: 'create', parent: '', name: 'notes.txt', kind: 'file' });
		await op({ op: 'create', parent: '', name: 'script.py', kind: 'file' });
		expect(readFileSync(join(WS, 'notes.txt'), 'utf8')).toBe('');
		expect(readFileSync(join(WS, 'script.py'), 'utf8')).toBe('');
		// A name that merely CONTAINS the extension is not one.
		await op({ op: 'create', parent: '', name: 'x.ipynb.bak', kind: 'file' });
		expect(readFileSync(join(WS, 'x.ipynb.bak'), 'utf8')).toBe('');
	});

	it('still refuses the names it always refused', async () => {
		expect((await op({ op: 'create', parent: '', name: 'analysis.ipynb', kind: 'file' })).status).toBe(400);
		expect((await op({ op: 'create', parent: '', name: '../escape.ipynb', kind: 'file' })).status).toBe(400);
		expect((await op({ op: 'create', parent: '', name: '.hidden.ipynb', kind: 'file' })).status).toBe(400);
	});
});

describe('an already-blank .ipynb opens rather than dead-ending', () => {
	it('reads a zero-byte file as a blank notebook', () => {
		const abs = join(WS, 'touched.ipynb');
		writeFileSync(abs, '');
		const view = nbmod.getNotebook('touched.ipynb');
		expect(view.cells).toHaveLength(1);
		expect(view.cells[0].source).toBe('');
	});

	it('treats a whitespace-only file the same (it holds no more than the empty one)', () => {
		writeFileSync(join(WS, 'blankish.ipynb'), '\n  \n\t\n');
		expect(nbmod.getNotebook('blankish.ipynb').cells).toHaveLength(1);
	});

	it('does NOT write the file on open — Cellar still drops no uninvited bytes', () => {
		const abs = join(WS, 'untouched-on-open.ipynb');
		writeFileSync(abs, '');
		nbmod.getNotebook('untouched-on-open.ipynb');
		// `loadDoc` never persists; the file stays exactly as it was until a real edit.
		expect(statSync(abs).size).toBe(0);
	});

	it('covers the OTHER blank-file routes: a rename and a copy of an empty file', async () => {
		writeFileSync(join(WS, 'empty-src.txt'), '');
		await op({ op: 'rename', path: 'empty-src.txt', name: 'renamed.ipynb' });
		expect(nbmod.getNotebook('renamed.ipynb').cells).toHaveLength(1);

		mkdirSync(join(WS, 'dest'));
		await op({ op: 'copy', path: 'renamed.ipynb', dest: 'dest' });
		expect(nbmod.getNotebook('dest/renamed.ipynb').cells).toHaveLength(1);
	});
});

describe('a blank file that was only MOMENTARILY blank is never overwritten', () => {
	// The blank-file leniency rests on "no bytes, so nothing to lose". That is true
	// of a genuinely empty file and false of one caught MID-WRITE: a non-atomic
	// external writer (nbdev's `fastcore/nbio.py` opens with 'w') truncates before
	// it writes, and this repo has measured a 0-byte read in exactly that window
	// (`fileWatch.ts`'s header). Read there, a real notebook would be cached as a
	// blank document and the next save would overwrite it.
	const REAL = JSON.stringify(
		{
			cells: [{ cell_type: 'code', id: 'precious', metadata: {}, source: ['treasure = 1'], outputs: [], execution_count: null }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		},
		null,
		1
	);

	it('refuses the first save when the file gained content after it was opened blank', () => {
		const abs = join(WS, 'mid-write.ipynb');
		writeFileSync(abs, ''); // the truncation window

		const view = nbmod.getNotebook('mid-write.ipynb');
		expect(view.cells).toHaveLength(1);

		// The external writer finishes.
		writeFileSync(abs, REAL);

		// Any mutation persists; this one must REFUSE rather than overwrite.
		expect(() => nbmod.setSource(view.cells[0].id, 'x = 1', 'mid-write.ipynb')).toThrow(
			/opened as an empty notebook but now has content/i
		);
		// The headline assertion: the user's bytes are untouched.
		expect(readFileSync(abs, 'utf8')).toBe(REAL);
	});

	it('the refusal names the notebook workspace-relative, never an absolute server path', () => {
		const abs = join(WS, 'named.ipynb');
		writeFileSync(abs, '');
		const view = nbmod.getNotebook('named.ipynb');
		writeFileSync(abs, REAL);
		let msg = '';
		try {
			nbmod.setSource(view.cells[0].id, 'x = 1', 'named.ipynb');
		} catch (err) {
			msg = String((err as Error).message);
		}
		expect(msg).toContain('named.ipynb');
		expect(msg).not.toContain(WS);
	});

	it('a genuinely blank file still saves — and the guard does not fire twice', () => {
		const abs = join(WS, 'really-blank.ipynb');
		writeFileSync(abs, '');
		const view = nbmod.getNotebook('really-blank.ipynb');

		nbmod.setSource(view.cells[0].id, 'first = 1', 'really-blank.ipynb');
		expect(readFileSync(abs, 'utf8')).toContain('first = 1');

		// The document now has bytes of its own on disk, so a SECOND save must not
		// be refused by its own first write.
		nbmod.setSource(view.cells[0].id, 'second = 2', 'really-blank.ipynb');
		expect(readFileSync(abs, 'utf8')).toContain('second = 2');
	});

	it('a notebook read from real bytes is never guarded (an ordinary save is unaffected)', () => {
		const abs = join(WS, 'ordinary.ipynb');
		writeFileSync(abs, REAL);
		const view = nbmod.getNotebook('ordinary.ipynb');
		nbmod.setSource(view.cells[0].id, 'edited = 1', 'ordinary.ipynb');
		expect(readFileSync(abs, 'utf8')).toContain('edited = 1');
	});
});

describe('a genuinely corrupt notebook still refuses, and says why', () => {
	it('refuses bytes that are PRESENT but do not parse', () => {
		// The leniency above is scoped to a file holding NOTHING: there is nothing to
		// lose. Bytes that are there must never be opened as an empty notebook and
		// then persisted over.
		writeFileSync(join(WS, 'corrupt.ipynb'), '{"cells": [oops');
		expect(() => nbmod.getNotebook('corrupt.ipynb')).toThrow(/not valid JSON/i);
	});

	it("keeps the parser's own detail, without pinning V8's wording", () => {
		writeFileSync(join(WS, 'corrupt2.ipynb'), '{ nope }');
		let msg = '';
		try {
			nbmod.getNotebook('corrupt2.ipynb');
		} catch (err) {
			msg = String((err as Error).message);
		}
		// The contract is the WRAPPER plus a non-empty inner detail. Asserting V8's
		// own phrasing (its "position N" clause) would couple this to an unstable
		// implementation detail: that wording has already changed across V8
		// versions, and CI pins a different Node than local dev runs.
		const inner = /^not valid JSON \((.+)\)$/s.exec(msg);
		expect(inner, `unexpected message shape: ${msg}`).not.toBeNull();
		expect(inner![1].trim().length).toBeGreaterThan(0);
		// It does NOT repeat the file name: every caller (the notebook route's
		// `Could not open <path>:` prefix, the MCP tool the agent named it in)
		// already has it, and repeating it reads as a stutter.
		expect(msg).not.toMatch(/corrupt2/);
	});

	it('a MISSING notebook is still "not found", not a parse failure', () => {
		expect(() => nbmod.getNotebook('nope.ipynb')).toThrow(/not found/i);
	});
});

describe('blankNotebook is ONE definition with two consumers', () => {
	it('the bytes the explorer writes are what a blank file reads as', () => {
		const written = JSON.parse(ipynb.blankNotebookText());
		const read = ipynb.blankNotebook();
		// Everything but the freshly minted cell id.
		written.cells[0].id = read.cells[0].id = 'x';
		expect(written).toEqual(read);
	});

	it('isIpynbPath matches the browser tab rule', () => {
		for (const p of ['a.ipynb', 'A.IPYNB', 'dir/b.Ipynb']) expect(ipynb.isIpynbPath(p)).toBe(true);
		for (const p of ['a.py', 'a.ipynb.bak', 'ipynb', 'a.json', '']) expect(ipynb.isIpynbPath(p)).toBe(false);
	});
});
