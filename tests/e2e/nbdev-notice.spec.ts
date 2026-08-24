import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * DETECT AND OFFER, in a real browser: the nbdev metadata hazard is announced in
 * the sidebar, the file is written only on a click, and the card retires itself.
 *
 * TWO launchers on TWO workspaces, because the load-bearing half of "never nag"
 * is the NEGATIVE: a workspace that is not an nbdev project must render no card
 * at all, and a single-workspace spec cannot say that. Both are throwaway trees.
 *
 * Assertions read `pyproject.toml` FROM DISK rather than trusting the card,
 * because the promise is about the user's file: the two keys present, everything
 * else byte-identical.
 */

let nbdevLauncher: ChildProcess | null = null;
let plainLauncher: ChildProcess | null = null;
let root = '';
let nbdevWs = '';
let plainWs = '';
let nbdevUrl = '';
let plainUrl = '';

const PYPROJECT = `# a comment the user wrote
[project]
name = "demo"
version = "0.1.0"

[tool.nbdev]
repo = "demo"
lib_path = "demo"
allowed_metadata_keys = ["solveit"]

[tool.ruff]
line-length = 100
`;

const pyprojectPath = () => join(nbdevWs, 'pyproject.toml');
const pyproject = () => readFileSync(pyprojectPath(), 'utf8');

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	root = mkdtempSync(join(tmpdir(), 'cellar-e2e-nbdev-'));
	nbdevWs = join(root, 'nbdev-project');
	plainWs = join(root, 'plain-project');
	mkdirSync(nbdevWs, { recursive: true });
	mkdirSync(plainWs, { recursive: true });
	writeFileSync(pyprojectPath(), PYPROJECT, 'utf8');
	// A pyproject that is nobody's nbdev project: the negative case has to be a
	// real file, or it only proves that a missing file renders nothing.
	writeFileSync(join(plainWs, 'pyproject.toml'), '[project]\nname = "plain"\n', 'utf8');

	const a = await bootCellar(nbdevWs);
	nbdevLauncher = a.proc;
	nbdevUrl = a.url;
	const b = await bootCellar(plainWs);
	plainLauncher = b.proc;
	plainUrl = b.url;
});

test.afterAll(async () => {
	if (nbdevLauncher) killCellar(nbdevLauncher);
	if (plainLauncher) killCellar(plainLauncher);
	nbdevLauncher = plainLauncher = null;
	if (root && existsSync(root)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

test('announces the hazard, writes only on the click, then retires itself', async ({ page }) => {
	const before = pyproject();
	await page.goto(`${nbdevUrl}/?ws=${encodeURIComponent(nbdevWs)}`);

	const card = page.getByTestId('nbdev-notice');
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute('data-kind', 'unprotected');
	// It says what is at risk, and names the exact file it would edit.
	await expect(page.getByTestId('nbdev-notice-body')).toContainText('erased');
	await expect(page.getByTestId('nbdev-notice-path')).toHaveText(pyprojectPath());
	// The remedy is shown whether or not Cellar writes it, so a user who would
	// rather do it by hand can.
	await expect(page.getByTestId('nbdev-notice-remedy')).toContainText('allowed_cell_metadata_keys');

	// Merely LOOKING must not write: the whole point of detect-and-offer.
	expect(pyproject()).toBe(before);

	await page.getByTestId('nbdev-notice-apply').click();
	await expect(card).toHaveCount(0);

	const after = pyproject();
	// Merged, not replaced - `solveit` was already there and survives.
	expect(after).toContain('allowed_metadata_keys = ["solveit", "cellar"]');
	expect(after).toContain('allowed_cell_metadata_keys = ["cellar"]');
	// Everything else byte-identical: strip the one inserted line and the one
	// rewritten line back to their originals and the file is what it was.
	expect(
		after
			.replace('allowed_cell_metadata_keys = ["cellar"]\n', '')
			.replace('allowed_metadata_keys = ["solveit", "cellar"]', 'allowed_metadata_keys = ["solveit"]')
	).toBe(before);

	// Idempotent, and never re-offered: a reload finds nothing to say.
	await page.reload();
	await expect(page.getByTestId('sidebar')).toBeVisible();
	await expect(page.getByTestId('nbdev-notice')).toHaveCount(0);
	expect(pyproject()).toBe(after);
});

test('says nothing at all in a workspace that is not an nbdev project', async ({ page }) => {
	await page.goto(`${plainUrl}/?ws=${encodeURIComponent(plainWs)}`);
	await expect(page.getByTestId('sidebar')).toBeVisible();
	await expect(page.getByTestId('nbdev-notice')).toHaveCount(0);
});

test('refuses a shape it cannot edit, and says so instead of offering a button', async ({ page }) => {
	// An inline table: legal TOML, and one a line-based editor must not rewrite.
	writeFileSync(join(plainWs, 'pyproject.toml'), '[project]\nname = "x"\n\n[tool]\nnbdev = { repo = "x" }\n', 'utf8');
	const before = readFileSync(join(plainWs, 'pyproject.toml'), 'utf8');
	await page.goto(`${plainUrl}/?ws=${encodeURIComponent(plainWs)}`);

	const card = page.getByTestId('nbdev-notice');
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute('data-kind', 'other-form');
	await expect(page.getByTestId('nbdev-notice-apply')).toHaveCount(0);
	// A refusal has to stay actionable: it names its own repair.
	await expect(page.getByTestId('nbdev-notice-hint')).toContainText('by hand');
	expect(readFileSync(join(plainWs, 'pyproject.toml'), 'utf8')).toBe(before);
});
