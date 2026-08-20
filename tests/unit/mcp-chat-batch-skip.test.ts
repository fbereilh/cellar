/**
 * An agent's BULK run never spends the user's Claude quota.
 *
 * A chat cell is an nbformat `code` cell (tagged `cellar.language='chat'`), so
 * `run_all` / `run_range`'s `cell_type === 'code'` selectors pick it up - and
 * running one is not a kernel execution but a real, billed model turn that holds
 * the notebook's single queue slot until it answers. A routine `run_all` over a
 * notebook would therefore fire one paid turn per chat cell as a side effect of
 * "re-run everything".
 *
 * Every batch path funnels through `runCells`, so the rule lives there once:
 * a chat cell is SKIPPED and NAMED in the results (silently dropping it would
 * read as a batch that ran it). An EXPLICIT `run_cell` is a deliberate act and
 * still runs the cell.
 *
 * The engine is scripted (`__setChatEngineForTests`) and the auth resolution
 * pinned, so "was a model turn spent" is observable as a call count; the
 * notebooks hold only markdown and chat cells, so no kernel is ever needed.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEngineResult } from '../../src/lib/server/chat/engine';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let enginemod: typeof import('../../src/lib/server/chat/engine');
let authmod: typeof import('../../src/lib/server/chat/auth');

/** Every prompt the engine was asked to answer - i.e. every billed turn. */
let turns: string[];

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-chat-batch-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	enginemod = await import('../../src/lib/server/chat/engine');
	authmod = await import('../../src/lib/server/chat/auth');
	authmod.__setChatAuthForTests({ kind: 'slot', slot: 'test', account: { loggedIn: true } });
});

afterEach(() => {
	enginemod.__setChatEngineForTests(null);
});

function scriptEngine(): void {
	turns = [];
	enginemod.__setChatEngineForTests({
		async run(args): Promise<ChatEngineResult> {
			turns.push(args.prompt);
			return { ok: true, failure: null, engine: 'scripted', replyText: 'answered' };
		}
	});
}

/**
 * A notebook of markdown + chat cells (no python: a batch must reach a real
 * decision without a kernel). Returns the created cells' ids in document order.
 */
function makeNotebook(name: string, kinds: Array<'markdown' | 'chat'>): { target: string; ids: string[] } {
	const target = nbmod.resolveNotebookPath(name);
	nbmod.createNotebook(name);
	const ids: string[] = [];
	let after: string | null = null;
	for (const kind of kinds) {
		const cell = nbmod.addCell(after, kind, target, null, kind === 'chat' ? 'What changed?' : '## Section');
		ids.push(cell.id);
		after = cell.id;
	}
	// createNotebook seeds one empty code cell; drop it so the batch sees only ours.
	const seeded = nbmod.listCells(target).filter((c) => !ids.includes(c.id));
	if (seeded.length) nbmod.deleteCells(seeded.map((c) => c.id), target);
	return { target, ids };
}

/**
 * A batch record echoes the agent-facing HANDLE (a prefix of the stored UUID),
 * so a record is found by asking whether this cell's full id starts with it.
 */
const record = (results: Array<Record<string, unknown>>, fullId: string) =>
	results.find((r) => typeof r.id === 'string' && fullId.startsWith(r.id));

describe('the three batch tools skip a chat cell and NAME it', () => {
	it('run_all runs no model turn and reports the chat cell as skipped, with a reason', async () => {
		scriptEngine();
		const { target, ids } = makeNotebook('all.ipynb', ['markdown', 'chat']);
		const [md, chat] = ids;
		const res = await svc.runAll(target);
		expect(turns).toEqual([]); // nothing was sent, nothing was billed
		expect(res.ran).toBe(0);
		expect(res.errored).toBe(0);
		const skip = record(res.results, chat);
		expect(skip).toBeDefined();
		expect(skip?.status).toBe('skipped');
		expect(String(skip?.note)).toMatch(/chat cell/i);
		expect(String(skip?.note)).toMatch(/run_cell/); // names the deliberate route
		// The chat cell produced no reply output either.
		expect(nbmod.listCells(target).find((c) => c.id === chat)?.outputs).toEqual([]);
		// run_all selects code cells only, so the markdown cell is not in the batch
		// at all - the chat skip is the whole of the report.
		expect(res.results).toHaveLength(1);
		expect(record(res.results, md)).toBeUndefined();
	});

	it('run_cells skips it even when the agent named it explicitly, and keeps running the rest', async () => {
		scriptEngine();
		const { target, ids } = makeNotebook('cells.ipynb', ['markdown', 'chat', 'markdown']);
		const [md1, chat, md2] = ids;
		const res = await svc.runCells([md1, chat, md2], target);
		expect(turns).toEqual([]);
		expect(record(res.results, chat)?.status).toBe('skipped');
		// The batch did not stop at the skip: both markdown cells still rendered.
		expect(record(res.results, md1)?.status).toBe('rendered');
		expect(record(res.results, md2)?.status).toBe('rendered');
	});

	it('run_range skips a chat cell inside the range', async () => {
		scriptEngine();
		const { target, ids } = makeNotebook('range.ipynb', ['markdown', 'chat', 'markdown']);
		const [md1, chat, md2] = ids;
		const res = await svc.runRange(md1, md2, target);
		expect(turns).toEqual([]);
		expect(record(res.results, chat)?.status).toBe('skipped');
	});

	it('a chat cell HIDDEN from the agent is not named at all (the flag outranks the notice)', async () => {
		scriptEngine();
		const { target, ids } = makeNotebook('hidden.ipynb', ['chat']);
		const [chat] = ids;
		nbmod.setVisibility(chat, true, target);
		const res = await svc.runAll(target);
		expect(turns).toEqual([]);
		expect(res.results).toEqual([]);
	});
});

describe('an explicit single run still runs a chat cell', () => {
	it('run_cell on a chat cell spends exactly one turn and persists the reply', async () => {
		scriptEngine();
		const { target, ids } = makeNotebook('single.ipynb', ['chat']);
		const [chat] = ids;
		const r = await svc.runCell(chat, target);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toContain('[question]\nWhat changed?');
		expect(r?.status).toBe('ok');
		const outs = nbmod.listCells(target).find((c) => c.id === chat)?.outputs ?? [];
		expect(outs).toHaveLength(1);
		expect((outs[0] as { data: Record<string, string> }).data['text/markdown']).toBe('answered');
	});
});
