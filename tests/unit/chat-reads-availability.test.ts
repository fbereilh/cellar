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
import { chatReadsBlockedCause, chatToolPolicy } from '../../src/lib/server/chat/claude-cli';

let WS: string;
let route: typeof import('../../src/routes/api/chat/status/+server.js');
const savedWorkspace = process.env.CELLAR_WORKSPACE;

/** Call the route the way SvelteKit does. */
async function reads(nb?: string) {
	const url = new URL('http://localhost/api/chat/status');
	if (nb !== undefined) url.searchParams.set('notebook', nb);
	const res = await route.GET({ url } as Parameters<typeof route.GET>[0]);
	return (await res.json()).reads as { available: boolean; cause: string | null; notebook?: string };
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-reads-avail-'));
	process.env.CELLAR_WORKSPACE = WS;
	writeFileSync(join(WS, 'ok.ipynb'), '{"cells":[],"nbformat":4,"nbformat_minor":5}\n');
	writeFileSync(join(WS, 'run{1}.ipynb'), '{"cells":[],"nbformat":4,"nbformat_minor":5}\n');
	route = await import('../../src/routes/api/chat/status/+server.js');
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
			expect(chatReadsBlockedCause(ws, `${ws}/analysis.ipynb`)).toBe('workspace');
		}
	});

	it('blames the NOTEBOOK when only its name cannot be patterned, and the sibling beside it is fine', () => {
		const ws = '/tmp/plain-workspace';
		expect(chatReadsBlockedCause(ws, `${ws}/run{1}.ipynb`)).toBe('notebook');
		// Same workspace, different notebook: nothing to report. This asymmetry is
		// why the message must name which of the two is at fault.
		expect(chatReadsBlockedCause(ws, `${ws}/run1.ipynb`)).toBeNull();
	});

	it('blames the notebook when a DERIVED sibling name is the unpatternable one', () => {
		// The notebook's own name is clean, but a name it derives is not, so the
		// denial could not be spelled for every artifact - reads must still be off.
		const ws = '/tmp/plain-workspace';
		expect(chatReadsBlockedCause(ws, `${ws}/sub[x]/analysis.ipynb`)).toBe('notebook');
	});

	it('agrees with what the ENGINE does, in both directions', () => {
		const ws = '/tmp/plain-workspace';
		const good = { readRoot: ws, notebookPath: `${ws}/analysis.ipynb` };
		const bad = { readRoot: ws, notebookPath: `${ws}/run{1}.ipynb` };
		// A verdict of "nothing to report" must mean the run really is granted reads...
		expect(chatReadsBlockedCause(good.readRoot, good.notebookPath)).toBeNull();
		expect(chatToolPolicy(good).readRoot).not.toBeNull();
		// ...and a reported cause must mean the run really is read-less.
		expect(chatReadsBlockedCause(bad.readRoot, bad.notebookPath)).toBe('notebook');
		expect(chatToolPolicy(bad).readRoot).toBeNull();
		expect(chatToolPolicy(bad).grants).toEqual([]);
	});
});

describe('the route the Settings pane reads', () => {
	it('reports availability for a healthy workspace + notebook', async () => {
		expect(await reads('ok.ipynb')).toEqual({ available: true, cause: null });
	});

	it('reports the notebook cause and NAMES the notebook', async () => {
		const r = await reads('run{1}.ipynb');
		expect(r.available).toBe(false);
		expect(r.cause).toBe('notebook');
		// Naming it is the point: its neighbour in the same workspace is unaffected.
		expect(r.notebook).toBe('run{1}.ipynb');
		expect((await reads('ok.ipynb')).available).toBe(true);
	});

	it('answers the workspace half even when no notebook is named', async () => {
		// With no notebook in hand the notebook half is simply not claimed, rather
		// than invented from a placeholder.
		expect(await reads()).toEqual({ available: true, cause: null });
	});
});
