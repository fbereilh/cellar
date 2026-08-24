/**
 * Workspace-reads AVAILABILITY - the DETECT half of the Settings pane's report.
 *
 * Reads fail CLOSED on a workspace path or notebook name Cellar cannot express as
 * a literal permission rule, and that fallback is otherwise SILENT: the toggle
 * still renders on and its copy still promises the reply may browse the
 * workspace, while the only report goes to the MODEL through the frozen prompt -
 * so the person meets a reply that merely seems broken. This is the same
 * DETECT + REPORT shape the Databricks card applies to `sdkDbutils`.
 *
 * What is asserted here is the VERDICT and the route that carries it, driven
 * against real paths and the REAL route rather than the shape of the predicate:
 *
 *  - a healthy workspace + notebook reports nothing to say;
 *  - an un-patternable WORKSPACE reports the `workspace` cause;
 *  - an un-patternable NOTEBOOK name reports the `notebook` cause and NAMES that
 *    notebook - and, in the SAME workspace, a sibling notebook still reports
 *    nothing. That asymmetry is the whole reason the report has to say which of
 *    the two is at fault: reads can be off for one notebook while working in the
 *    one beside it, so an unqualified "reads are off" would be wrong about the
 *    workspace as a whole;
 *  - the verdict agrees with what the ENGINE would actually do, asserted through
 *    `chatToolPolicy` rather than restated - a pane that promised reads the run
 *    would refuse (or vice versa) is the defect this exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatPathRefusal, chatReadsBlockedCause, chatToolPolicy } from '../../src/lib/server/chat/claude-cli';

let WS: string;
let route: typeof import('../../src/routes/api/chat/reads/+server.js');
const savedWorkspace = process.env.CELLAR_WORKSPACE;

/** Call the route the way SvelteKit does. */
async function reads(nb?: string) {
	const url = new URL('http://localhost/api/chat/reads');
	if (nb !== undefined) url.searchParams.set('notebook', nb);
	const res = await route.GET({ url } as Parameters<typeof route.GET>[0]);
	return (await res.json()) as {
		decided: string;
		available: boolean;
		blocked?: { cause: string; kind: string; segment?: string; isNotebookName?: boolean };
		notebook?: string;
	};
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-reads-avail-'));
	process.env.CELLAR_WORKSPACE = WS;
	writeFileSync(join(WS, 'ok.ipynb'), '{"cells":[],"nbformat":4,"nbformat_minor":5}\n');
	writeFileSync(join(WS, 'run{1}.ipynb'), '{"cells":[],"nbformat":4,"nbformat_minor":5}\n');
	mkdirSync(join(WS, 'sub[x]'), { recursive: true });
	writeFileSync(join(WS, 'sub[x]', 'nested.ipynb'), '{"cells":[],"nbformat":4,"nbformat_minor":5}\n');
	route = await import('../../src/routes/api/chat/reads/+server.js');
});

afterAll(() => {
	if (savedWorkspace === undefined) delete process.env.CELLAR_WORKSPACE;
	else process.env.CELLAR_WORKSPACE = savedWorkspace;
	rmSync(WS, { recursive: true, force: true });
});

describe('the reads-availability verdict', () => {
	it('says nothing when reads can really be granted', () => {
		expect(chatReadsBlockedCause('/tmp/plain-workspace', '/tmp/plain-workspace/analysis.ipynb')).toBeNull();
	});

	it('blames the WORKSPACE when its own path cannot be patterned', () => {
		// The scope that matters: no notebook in this workspace can have reads.
		for (const ws of ['/tmp/analysis [2024]', '/tmp/runs{a}', '/tmp/back\\slash', '/tmp/pick@(a|b)']) {
			expect(chatReadsBlockedCause(ws, `${ws}/analysis.ipynb`)?.cause).toBe('workspace');
		}
	});

	it('blames the NOTEBOOK when only its name cannot be patterned, and the sibling beside it is fine', () => {
		const ws = '/tmp/plain-workspace';
		const v = chatReadsBlockedCause(ws, `${ws}/run{1}.ipynb`);
		expect(v?.cause).toBe('notebook');
		// The offending SEGMENT is named, and it IS the notebook's own file name -
		// so the copy may say "rename this notebook".
		expect(v?.kind).toBe('character');
		expect(v?.segment).toBe('run{1}.ipynb');
		expect(v?.isNotebookName).toBe(true);
		// Same workspace, different notebook: nothing to report. This asymmetry is
		// why the message must name which of the two is at fault.
		expect(chatReadsBlockedCause(ws, `${ws}/run1.ipynb`)).toBeNull();
	});

	it('blames the notebook when a DERIVED sibling name is the unpatternable one', () => {
		// The notebook's own name is clean, but a name it derives is not, so the
		// denial could not be spelled for every artifact - reads must still be off.
		const ws = '/tmp/plain-workspace';
		const v = chatReadsBlockedCause(ws, `${ws}/sub[x]/analysis.ipynb`);
		expect(v?.cause).toBe('notebook');
		// It names the DIRECTORY, and says this is not the notebook's own name -
		// "rename this notebook" would be advice that cannot work here.
		expect(v?.segment).toBe('sub[x]');
		expect(v?.isNotebookName).toBe(false);
	});

	it('tells a STRUCTURAL refusal apart from a bad character, because only one has a remedy', () => {
		// A non-POSIX path (every Windows path) fails for a reason no rename can fix -
		// the `//` rule prefix is POSIX-only - so it must not be reported as a name.
		expect(chatPathRefusal('C:\\Users\\me\\ws')).toEqual({ kind: 'platform' });
		expect(chatPathRefusal('relative/dir')).toEqual({ kind: 'platform' });
		expect(chatReadsBlockedCause('C:\\Users\\me\\ws', 'C:\\Users\\me\\ws\\a.ipynb')).toEqual({ cause: 'workspace', kind: 'platform' });
		// ...while a refused character names the one segment at fault.
		expect(chatPathRefusal('/tmp/ok/analysis [2024]/x.ipynb')).toEqual({ kind: 'character', segment: 'analysis [2024]' });
		expect(chatPathRefusal('/tmp/ok/plain.ipynb')).toBeNull();
	});

	it('agrees with what the ENGINE does, in both directions', () => {
		const ws = '/tmp/plain-workspace';
		const good = { readRoot: ws, notebookPath: `${ws}/analysis.ipynb` };
		const bad = { readRoot: ws, notebookPath: `${ws}/run{1}.ipynb` };
		// A verdict of "nothing to report" must mean the run really is granted reads...
		expect(chatReadsBlockedCause(good.readRoot, good.notebookPath)).toBeNull();
		expect(chatToolPolicy(good).readRoot).not.toBeNull();
		// ...and a reported cause must mean the run really is read-less.
		expect(chatReadsBlockedCause(bad.readRoot, bad.notebookPath)?.cause).toBe('notebook');
		expect(chatToolPolicy(bad).readRoot).toBeNull();
		expect(chatToolPolicy(bad).grants).toEqual([]);
	});
});

describe('the route the Settings pane reads', () => {
	it('reports availability for a healthy workspace + notebook', async () => {
		expect(await reads('ok.ipynb')).toEqual({ decided: 'both', available: true });
	});

	it('reports the notebook cause and NAMES the notebook', async () => {
		const r = await reads('run{1}.ipynb');
		expect(r.available).toBe(false);
		expect(r.blocked?.cause).toBe('notebook');
		expect(r.blocked?.segment).toBe('run{1}.ipynb');
		expect(r.blocked?.isNotebookName).toBe(true);
		// Naming it is the point: its neighbour in the same workspace is unaffected.
		expect(r.notebook).toBe('run{1}.ipynb');
		expect((await reads('ok.ipynb')).available).toBe(true);
	});

	it('answers the workspace half even when no notebook is named', async () => {
		// With no notebook in hand the notebook half is not CLAIMED - `decided` says
		// so - rather than answered from a synthetic placeholder path.
		expect(await reads()).toEqual({ decided: 'workspace', available: true });
	});

	it('names an ancestor DIRECTORY rather than the notebook when that is what fails', async () => {
		const r = await reads('sub[x]/nested.ipynb');
		expect(r.available).toBe(false);
		expect(r.blocked?.segment).toBe('sub[x]');
		expect(r.blocked?.isNotebookName).toBe(false);
	});

	it('spawns no CLI: it imports nothing auth-related', async () => {
		// The regression this route exists to undo - riding /api/chat/status made
		// opening Settings spawn `claude auth status` for every user. Asserted
		// behaviourally: a verdict resolves without the CLI being reachable at all.
		const savedPath = process.env.PATH;
		process.env.PATH = '/nonexistent-for-this-test';
		try {
			expect((await reads('ok.ipynb')).available).toBe(true);
		} finally {
			process.env.PATH = savedPath;
		}
	});
});
