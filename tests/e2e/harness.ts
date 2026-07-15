import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared launcher harness for cellar's Playwright E2E specs. Each spec boots the
 * REAL `cellar` launcher (Node app + Jupyter sidecar + a python3 kernel) against a
 * throwaway workspace; the app port is allocated dynamically per run, so the URL
 * is discovered from the launcher's stdout rather than a fixed `webServer`. The
 * runtime (uv + python3 + the cached host-venv) is not reliably present in CI, so
 * these are LOCAL, best-effort checks that SKIP when the runtime is missing — the
 * vitest unit suite is the must-pass gate.
 */

/** Repo root, resolved from this file's location (tests/e2e/harness.ts → ../..). */
export const REPO = resolve(fileURLToPath(import.meta.url), '../../..');

/** True only when the kernel runtime the E2E needs is actually present. */
export function runtimeAvailable(): boolean {
	const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
	const hostVenv = join(process.env.HOME || '', '.cellar', 'host-venv', 'bin', 'python');
	return has('uv') && has('python3') && existsSync(hostVenv);
}

/** Spawn the launcher and resolve the app URL it prints once fully up. */
export function bootCellar(ws: string): Promise<{ proc: ChildProcess; url: string }> {
	// A no-op `open`/`xdg-open` on PATH so the launcher's "open the browser" step
	// is suppressed — Playwright drives its own browser against the URL.
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	for (const name of ['open', 'xdg-open']) {
		const p = join(shim, name);
		writeFileSync(p, '#!/bin/sh\nexit 0\n');
		chmodSync(p, 0o755);
	}

	const proc = spawn(
		'node',
		[join(REPO, 'bin', 'cellar.js'), '-w', ws, '--new', '--no-mcp-config', '-y'],
		{
			cwd: REPO,
			env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, CI: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true
		}
	);

	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error('launcher did not become ready in time')), 90_000);
		let buf = '';
		const scan = (chunk: Buffer) => {
			const s = chunk.toString();
			buf += s;
			process.stdout.write(`[cellar-e2e] ${s}`);
			const m = buf.match(/app → (http:\/\/localhost:\d+)/);
			if (m) {
				clearTimeout(timer);
				resolvePromise({ proc, url: m[1] });
			}
		};
		proc.stdout?.on('data', scan);
		proc.stderr?.on('data', scan);
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`launcher exited early (${code})`));
		});
	});
}

/** Kill the launcher and its whole process group (app + jupyter sidecar). */
export function killCellar(proc: ChildProcess): void {
	if (proc.pid == null) return;
	try {
		process.kill(-proc.pid, 'SIGTERM');
	} catch {
		try {
			proc.kill('SIGTERM');
		} catch {
			/* already gone */
		}
	}
}
