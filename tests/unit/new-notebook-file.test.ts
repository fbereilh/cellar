/**
 * A NEW `.ipynb` is a VALID notebook the moment it exists — and an already-BLANK
 * one refuses to open, with a message that says what to do about it.
 *
 * The reported bug: creating `analysis.ipynb` through the file explorer produced a
 * ZERO-BYTE file (`createEntry` writes `''` for every file kind), and opening it
 * answered `Unexpected end of JSON input` — `JSON.parse('')` reaching the user
 * through `readNotebook`. The empty-state "New notebook" button and every MCP
 * create went through `createNotebook` instead and wrote a real skeleton, which is
 * why one route worked and the other did not.
 *
 * The fix is the WRITER (`POST /api/fs/op` + `createEntry`), which makes the file
 * valid for every tool and not just Cellar. The READER stays STRICT: a file that
 * is already blank on disk is refused rather than inferred into an empty notebook
 * (see `readNotebook` for the measured cost of the leniency that was tried), so
 * the second half of these tests pins that refusal on every route that can still
 * produce a blank `.ipynb` — a `touch`, a rename, a copy — and pins the repair.
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

describe('an already-blank .ipynb refuses, and names the repair', () => {
	// The reader is deliberately strict. Opening a blank file as an empty notebook
	// was tried and withdrawn: it can only ever repair a file that is genuinely
	// empty, while a file caught MID-WRITE by a non-atomic external writer looks
	// identical and would be silently overwritten by the next save. Refusing costs
	// one delete-and-recreate, which the explorer now does correctly.
	const REPAIR = /file is empty[\s\S]*create it again from the file explorer/i;

	it('refuses a zero-byte file with the empty-file message, not a raw parser error', () => {
		writeFileSync(join(WS, 'touched.ipynb'), '');
		// The bug's own symptom was `Unexpected end of JSON input` reaching the user.
		expect(() => nbmod.getNotebook('touched.ipynb')).toThrow(REPAIR);
		expect(() => nbmod.getNotebook('touched.ipynb')).not.toThrow(/JSON input/i);
	});

	it('treats a whitespace-only file the same (it holds no more than the empty one)', () => {
		writeFileSync(join(WS, 'blankish.ipynb'), '\n  \n\t\n');
		expect(() => nbmod.getNotebook('blankish.ipynb')).toThrow(REPAIR);
	});

	it('does not repeat the file name — every caller already prefixes it', () => {
		writeFileSync(join(WS, 'named-blank.ipynb'), '');
		let msg = '';
		try {
			nbmod.getNotebook('named-blank.ipynb');
		} catch (err) {
			msg = String((err as Error).message);
		}
		expect(msg).toMatch(REPAIR);
		expect(msg).not.toMatch(/named-blank/);
		// And no absolute server path leaks either.
		expect(msg).not.toContain(WS);
	});

	it('refuses the OTHER blank-file routes the same way: a rename and a copy', async () => {
		writeFileSync(join(WS, 'empty-src.txt'), '');
		await op({ op: 'rename', path: 'empty-src.txt', name: 'renamed.ipynb' });
		expect(() => nbmod.getNotebook('renamed.ipynb')).toThrow(REPAIR);

		mkdirSync(join(WS, 'dest'));
		await op({ op: 'copy', path: 'renamed.ipynb', dest: 'dest' });
		expect(() => nbmod.getNotebook('dest/renamed.ipynb')).toThrow(REPAIR);
	});

	it('leaves the file exactly as it was — a refusal writes nothing', () => {
		const abs = join(WS, 'untouched-on-refusal.ipynb');
		writeFileSync(abs, '');
		expect(() => nbmod.getNotebook('untouched-on-refusal.ipynb')).toThrow();
		expect(statSync(abs).size).toBe(0);
	});

	it('and the repair really works: delete it, create it again, and it opens', async () => {
		writeFileSync(join(WS, 'repairable.ipynb'), '');
		expect(() => nbmod.getNotebook('repairable.ipynb')).toThrow(REPAIR);

		expect((await op({ op: 'delete', path: 'repairable.ipynb' })).status).toBe(200);
		expect((await op({ op: 'create', parent: '', name: 'repairable.ipynb', kind: 'file' })).status).toBe(200);
		expect(nbmod.getNotebook('repairable.ipynb').cells).toHaveLength(1);
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

describe('the blank-notebook writer', () => {
	it('mints a fresh cell id each time — two new notebooks are not the same cell', () => {
		const a = ipynb.blankNotebook();
		const b = ipynb.blankNotebook();
		expect(a.cells[0].id).not.toBe(b.cells[0].id);
		// Everything else is identical: one shape, one definition.
		a.cells[0].id = b.cells[0].id = 'x';
		expect(a).toEqual(b);
		expect(JSON.parse(ipynb.blankNotebookText()).cells).toHaveLength(1);
	});

	it('isIpynbPath matches the browser tab rule', () => {
		for (const p of ['a.ipynb', 'A.IPYNB', 'dir/b.Ipynb']) expect(ipynb.isIpynbPath(p)).toBe(true);
		for (const p of ['a.py', 'a.ipynb.bak', 'ipynb', 'a.json', '']) expect(ipynb.isIpynbPath(p)).toBe(false);
	});
});
