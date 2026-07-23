import { test, expect } from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The agent can SEE the figures it draws — end to end over the real wire an agent
 * uses: a `cellar mcp` stdio bridge into a live cellar, a real python kernel, a
 * real matplotlib figure.
 *
 * This is the gap the feature closes. `add_and_run` used to answer a plotting
 * cell with the text `[image/png, 978×536, 44 KB]`, so an agent authoring charts
 * was blind to its own work and had to add a throwaway fig.savefig() cell, run
 * it, read the PNG off disk and delete the cell just to look at what it had
 * drawn. So the check is not "an image field exists" but: the tool RESULT the
 * agent receives carries a viewable image content block of the figure that cell
 * just rendered, bounded in size, while the human's browser still shows the same
 * figure and non-image outputs are untouched.
 *
 * Like the other specs here it boots the REAL launcher and SKIPS when the kernel
 * runtime (uv + python3 + host-venv) or matplotlib is absent — the vitest suite
 * is the gate.
 */

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let baseURL = '';

/** Screenshots land beside the spec run when an evidence dir is provided. */
const SHOTS = process.env.CELLAR_E2E_SHOTS || '';
const shot = async (page: import('@playwright/test').Page, name: string) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

/** Raw tool result — the content BLOCKS, which is what this spec is about. */
const callRaw = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args }) as Promise<ToolResult>;

/** The JSON payload a tool result carries in its text block. */
const payloadOf = (r: ToolResult) => JSON.parse(r.content.find((c) => c.type === 'text')!.text!);

const imagesOf = (r: ToolResult) => r.content.filter((c) => c.type === 'image');

/** PNG magic — proof the block holds a real raster, not a placeholder string. */
const isPng = (b64: string) => Buffer.from(b64, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const pngDims = (b64: string) => {
	const buf = Buffer.from(b64, 'base64');
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

/**
 * Provision the workspace venv with matplotlib BEFORE the launcher boots, so the
 * kernel it binds (`<ws>/.venv`) can actually plot. Returns false when uv cannot
 * do it, which skips the spec rather than failing it.
 */
function provisionVenv(ws: string): boolean {
	const venv = join(ws, '.venv');
	const mk = spawnSync('uv', ['venv', venv], { stdio: 'ignore' });
	if (mk.status !== 0) return false;
	const py = join(venv, 'bin', 'python');
	const install = spawnSync('uv', ['pip', 'install', '--python', py, 'ipykernel', 'matplotlib'], { stdio: 'ignore', timeout: 300_000 });
	return install.status === 0 && existsSync(py);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-figures-'));
	test.skip(!provisionVenv(workspace), 'could not install matplotlib into the throwaway venv');

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;

	client = new Client({ name: 'e2e-agent', version: '0' });
	await client.connect(
		new StdioClientTransport({
			command: 'node',
			args: [join(REPO, 'bin', 'cellar.js'), 'mcp'],
			cwd: workspace,
			env: { ...process.env } as Record<string, string>
		})
	);
});

test.afterAll(async () => {
	try {
		await client?.close();
	} catch {
		/* best effort */
	}
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

// A deliberately high-DPI figure (8×4in at 200dpi = 1600×800), so the run also
// exercises the downscale bound rather than a conveniently small raster.
const FIGURE_SOURCE = `import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(8, 4), dpi=200)
ax.plot([1, 2, 3, 4], [2, 1, 3, 5], marker='o')
ax.set_title('e2e figure')
plt.show()`;

test('add_and_run returns the figure the cell just drew as a real image block', async ({ page }) => {
	test.setTimeout(180_000);
	await callRaw('use_notebook', { name: 'figures.ipynb' });

	// route_imports:false keeps this one cell self-contained: the subject here is
	// the figure that comes back, not the import-routing contract.
	const res = await callRaw('add_and_run', { source: FIGURE_SOURCE, route_imports: false });
	const body = payloadOf(res);
	expect(body.status, JSON.stringify(body).slice(0, 800)).toBe('ok');

	// THE POINT: a viewable image block, not `[image/png, 1600×800, 44 KB]`.
	const images = imagesOf(res);
	expect(images).toHaveLength(1);
	expect(images[0].mimeType).toBe('image/png');
	expect(isPng(images[0].data!)).toBe(true);

	// Bounded: the high-DPI figure arrives downscaled to the 768px longest edge and
	// says what it came from. (The exact source size is matplotlib's to decide — a
	// tight bbox trims the requested 1600×800 — so the assertion is on the BOUND,
	// cross-checked against the original below, not on a hardcoded raster size.)
	const dims = pngDims(images[0].data!);
	expect(Math.max(dims.width, dims.height)).toBe(768);
	const meta = body.images[0];
	expect(meta).toEqual(expect.objectContaining({ output_index: expect.any(Number), mime: 'image/png' }));
	expect(meta.downscaled.to).toBe(`${dims.width}×${dims.height}`);
	expect(Math.max(meta.width, meta.height)).toBeGreaterThan(768);

	// The raster is not ALSO stringified into the JSON text (double billing), and
	// the output list still carries its enriched placeholder so the agent can see
	// which output the picture came from.
	expect(res.content.find((c) => c.type === 'text')!.text).not.toContain(images[0].data);
	const imgOut = body.outputs[meta.output_index];
	expect(imgOut.image).toBe('image/png');
	expect(imgOut.text).toMatch(new RegExp(`^\\[image/png, ${meta.width}×${meta.height}, [\\d.]+ (B|KB|MB)\\]$`));

	// get_full_output shows it too — size:'full' hands back the ORIGINAL raster,
	// which is exactly what the run result said it had downscaled FROM.
	const full = await callRaw('get_full_output', { id: body.id, size: 'full' });
	const fullImages = imagesOf(full);
	expect(fullImages).toHaveLength(1);
	expect(pngDims(fullImages[0].data!)).toEqual({ width: meta.width, height: meta.height });
	expect(meta.downscaled.from).toBe(`${meta.width}×${meta.height}`);

	// Regression: the human's notebook still renders the figure as an image. (The
	// agent's notebook is surfaced without stealing focus, so the human opens it
	// from the file tree exactly as they would.)
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText('figures.ipynb').first().dblclick();
	const img = page.locator('[data-testid=output-image]').first();
	await expect(img).toBeVisible({ timeout: 30_000 });
	await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
	await shot(page, 'figure-rendered.png');
});

test('a cell with no figure is unchanged: text output, no image blocks', async () => {
	test.setTimeout(120_000);
	await callRaw('use_notebook', { name: 'figures.ipynb' });
	const res = await callRaw('add_and_run', { source: "print('no figure here')", route_imports: false });
	const body = payloadOf(res);
	expect(body.status).toBe('ok');
	expect(imagesOf(res)).toHaveLength(0);
	expect(body.images).toBeUndefined();
	expect(body.outputs[0].text).toContain('no figure here');
});
