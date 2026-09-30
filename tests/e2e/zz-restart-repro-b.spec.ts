import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bootCellar, killCellar, REPO, removeWorkspace } from './harness';

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let base = '';
const call = async (name: string, args: Record<string, unknown> = {}, timeout = 20_000) => {
	const r: any = await client!.callTool({ name, arguments: args }, undefined, { timeout: Math.max(timeout, 40_000) });
	return JSON.parse(r.content.filter((c: any) => c.type === 'text' && !String(c.text).startsWith('[cellar] user')).map((c: any) => c.text).join('\n'));
};
test.beforeAll(async () => {
	workspace = mkdtempSync(join(tmpdir(), 'cellar-restart-repro-'));
	const b = await bootCellar(workspace);
	launcher = b.proc; base = b.url.split('/?')[0];
	client = new Client({ name: 'repro', version: '0' });
	await client.connect(new StdioClientTransport({ command: 'node', args: [join(REPO, 'bin', 'cellar.js'), 'mcp'], cwd: workspace, env: { ...process.env } as Record<string, string> }));
});
test.afterAll(async () => { try { await client?.close(); } catch {} if (launcher) killCellar(launcher); removeWorkspace(workspace); });
test('restart loop', async () => {
	test.setTimeout(3_600_000);
	const N = Number(process.env.REPRO_N || 40);
	let wedges = 0;
	for (let i = 0; i < N; i++) {
		const nb = `r${i}.ipynb`;
		await call('use_notebook', { name: nb });
		await call('add_and_run', { source: `v = ${i}`, route_imports: false }, 60_000);
		await fetch(`${base}/api/notebooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: nb }) });
		const mode = process.env.REPRO_PROBE ?? '1';
		if (mode !== '0') {
			void fetch(`${base}/api/kernel/variables`).catch(() => {});
			await new Promise((r) => setTimeout(r, Math.floor(Math.random() * Number(process.env.REPRO_JITTER || 60))));
		}
		const t0 = Date.now();
		let stage = 'restart';
		try {
			await call('restart_kernel', { notebook: nb });
			stage = 'run-after';
			await call('add_and_run', { source: `w = ${i}`, route_imports: false });
			console.log(`iter ${i} ok ${Date.now() - t0}ms`);
		} catch (e) {
			wedges++;
			console.log(`iter ${i} WEDGE at ${stage}: ${(e as Error).message}`);
		}
		await fetch(`${base}/api/kernel/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: nb }) }).catch(() => {});
	}
	console.log(`WEDGES ${wedges}/${N}`);
	expect(wedges).toBe(0);
});
