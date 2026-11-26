/**
 * An export never runs as if its notebook were alone in the workspace.
 *
 * Behavior: `exportPy` before any workspace scan has finished. Oracle: the repo
 * rule "Refuse, never degrade" - without a scan the notebooks that feed the
 * module are unknown, so writing it could drop their cells. Rejected: a silent
 * single-notebook export.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('an export before the workspace scan', () => {
	it('is refused, and succeeds once the scan has run', async () => {
		const ws = mkdtempSync(join(tmpdir(), 'cellar-export-needs-scan-'));
		process.env.CELLAR_WORKSPACE = ws;
		const nbmod = await import('../../src/lib/server/notebook');
		writeFileSync(
			join(ws, 'core.ipynb'),
			JSON.stringify({
				cells: [
					{
						id: 'c',
						cell_type: 'code',
						source: ['#| default_exp core\n', '#| export\n', 'A = 1'],
						metadata: {},
						outputs: [],
						execution_count: null
					}
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		expect(() => nbmod.exportPy('core.ipynb')).toThrow(/has not been scanned/);
		expect(existsSync(join(ws, 'core.py'))).toBe(false);

		await nbmod.syncExportPeers();
		expect(nbmod.exportPy('core.ipynb')).toMatchObject({ written: true, target: 'core.py', count: 1 });
	});
});
