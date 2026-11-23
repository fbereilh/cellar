import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace } from './harness';
import {
	CUSTOM_INSTRUCTIONS_CHAT_KEY,
	CUSTOM_INSTRUCTIONS_MCP_KEY,
	CUSTOM_INSTRUCTIONS_MERGED_KEY,
	CUSTOM_INSTRUCTIONS_SHARED_KEY
} from '../../src/lib/customInstructions';

/**
 * Settings -> "Custom instructions", against the SERVER store a chat run and a
 * new agent session read (`GET /api/user-settings`), never component state.
 *
 * `bootCellar` redirects `CELLAR_USER_SETTINGS` into the throwaway workspace, so
 * nothing here touches the developer's own settings.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	if (!runtimeAvailable()) return;
	workspace = mkdtempSync(join(tmpdir(), 'cellar-custom-instructions-'));
	const boot = await bootCellar(workspace);
	launcher = boot.proc;
	baseURL = boot.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	removeWorkspace(workspace);
});

test.beforeEach(() => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available');
});

async function openSettings(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
	await page.getByTestId('custom-instructions-control').scrollIntoViewIfNeeded();
}

async function serverSettings(page: Page): Promise<Record<string, unknown>> {
	const res = await page.request.get(`${baseURL}/api/user-settings`);
	expect(res.ok()).toBe(true);
	return (await res.json()) as Record<string, unknown>;
}

const chat = (page: Page) => page.getByTestId('settings-custom-instructions-chat');
const mcp = (page: Page) => page.getByTestId('settings-custom-instructions-mcp');
const shared = (page: Page) => page.getByTestId('settings-custom-instructions-shared');
const merged = (page: Page) => page.getByTestId('settings-custom-instructions-merged');

test('a never-touched install shows two empty boxes and stores nothing', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);
	await expect(chat(page)).toHaveValue('');
	await expect(mcp(page)).toHaveValue('');
	await expect(merged(page)).not.toBeChecked();
	await expect(shared(page)).toHaveCount(0);
	const s = await serverSettings(page);
	for (const key of [
		CUSTOM_INSTRUCTIONS_CHAT_KEY,
		CUSTOM_INSTRUCTIONS_MCP_KEY,
		CUSTOM_INSTRUCTIONS_SHARED_KEY,
		CUSTOM_INSTRUCTIONS_MERGED_KEY
	])
		expect(s).not.toHaveProperty(key);
});

test('each box stores its own text, and a reload shows it back', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);
	await chat(page).fill('Answer in Spanish.');
	await mcp(page).fill('Prefer polars.');
	await mcp(page).blur();
	await expect
		.poll(async () => {
			const s = await serverSettings(page);
			return [s[CUSTOM_INSTRUCTIONS_CHAT_KEY], s[CUSTOM_INSTRUCTIONS_MCP_KEY]];
		})
		.toEqual(['Answer in Spanish.', 'Prefer polars.']);

	await page.reload();
	await openSettings(page);
	await expect(chat(page)).toHaveValue('Answer in Spanish.');
	await expect(mcp(page)).toHaveValue('Prefer polars.');
});

test('merging shows one box seeded from the chat text, and keeps the separate texts', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);
	await merged(page).check();
	await expect(shared(page)).toHaveValue('Answer in Spanish.');
	await expect(chat(page)).toHaveCount(0);
	await expect(mcp(page)).toHaveCount(0);
	await expect
		.poll(async () => {
			const s = await serverSettings(page);
			return [s[CUSTOM_INSTRUCTIONS_MERGED_KEY], s[CUSTOM_INSTRUCTIONS_SHARED_KEY]];
		})
		.toEqual([true, 'Answer in Spanish.']);

	await shared(page).fill('Be brief.');
	await shared(page).blur();
	await expect.poll(async () => (await serverSettings(page))[CUSTOM_INSTRUCTIONS_SHARED_KEY]).toBe('Be brief.');

	// Un-merging brings the two separate texts back untouched.
	await merged(page).uncheck();
	await expect(chat(page)).toHaveValue('Answer in Spanish.');
	await expect(mcp(page)).toHaveValue('Prefer polars.');
	await expect
		.poll(async () => (await serverSettings(page))[CUSTOM_INSTRUCTIONS_MERGED_KEY] ?? null)
		.toBeNull();
});

test('clearing a box deletes its key', async ({ page }) => {
	await page.goto(baseURL);
	await openSettings(page);
	await chat(page).fill('');
	await chat(page).blur();
	await expect
		.poll(async () => Object.prototype.hasOwnProperty.call(await serverSettings(page), CUSTOM_INSTRUCTIONS_CHAT_KEY))
		.toBe(false);
});
