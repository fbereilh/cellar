/**
 * Custom instructions for chat cells and MCP agents.
 *
 * Three things are pinned here:
 *   - the ONE resolution rule (separate texts, or one shared text when merged),
 *   - the chat system prompt: empty leaves every shipped prompt byte-identical,
 *     text is appended after Cellar's own rules, and nothing else in argv moves,
 *   - the MCP instructions an agent is really delivered at connect.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
	CUSTOM_INSTRUCTIONS_CHAT_KEY,
	CUSTOM_INSTRUCTIONS_HEADING,
	CUSTOM_INSTRUCTIONS_MAX_CHARS,
	CUSTOM_INSTRUCTIONS_MCP_KEY,
	CUSTOM_INSTRUCTIONS_MERGED_KEY,
	CUSTOM_INSTRUCTIONS_SHARED_KEY,
	cleanCustomInstructions,
	customInstructionsBlock,
	resolveCustomInstructions,
	seedSharedInstructions
} from '../../src/lib/customInstructions';
import {
	CHAT_SYSTEM_PROMPT,
	CHAT_SYSTEM_PROMPT_WEB_SEARCH,
	chatCliArgs,
	chatSystemPrompt,
	chatToolPolicy
} from '../../src/lib/server/chat/claude-cli';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

describe('the resolution rule', () => {
	const settings = {
		[CUSTOM_INSTRUCTIONS_CHAT_KEY]: 'chat text',
		[CUSTOM_INSTRUCTIONS_MCP_KEY]: 'mcp text',
		[CUSTOM_INSTRUCTIONS_SHARED_KEY]: 'shared text'
	};

	it('reads each target its own text while not merged', () => {
		expect(resolveCustomInstructions(settings, 'chat')).toBe('chat text');
		expect(resolveCustomInstructions(settings, 'mcp')).toBe('mcp text');
	});

	it('reads the shared text for both targets while merged', () => {
		const merged = { ...settings, [CUSTOM_INSTRUCTIONS_MERGED_KEY]: true };
		expect(resolveCustomInstructions(merged, 'chat')).toBe('shared text');
		expect(resolveCustomInstructions(merged, 'mcp')).toBe('shared text');
	});

	it('merges only on a literal true', () => {
		for (const junk of ['true', 1, {}, null, undefined]) {
			const s = { ...settings, [CUSTOM_INSTRUCTIONS_MERGED_KEY]: junk };
			expect(resolveCustomInstructions(s, 'chat')).toBe('chat text');
		}
	});

	it('reads nothing from an empty store, a missing store, or a non-string value', () => {
		expect(resolveCustomInstructions({}, 'chat')).toBe('');
		expect(resolveCustomInstructions(null, 'mcp')).toBe('');
		expect(resolveCustomInstructions({ [CUSTOM_INSTRUCTIONS_CHAT_KEY]: 42 }, 'chat')).toBe('');
		expect(resolveCustomInstructions({ [CUSTOM_INSTRUCTIONS_MCP_KEY]: ['x'] }, 'mcp')).toBe('');
	});

	it('cleans what it sends: trimmed, bounded, no control characters', () => {
		expect(cleanCustomInstructions('  a\r\nb\u0000c\td  ')).toBe('a\nbc\td');
		expect(cleanCustomInstructions('   \n ')).toBe('');
		expect(cleanCustomInstructions('x'.repeat(CUSTOM_INSTRUCTIONS_MAX_CHARS + 50))).toHaveLength(
			CUSTOM_INSTRUCTIONS_MAX_CHARS
		);
	});

	it('builds no block for empty text', () => {
		expect(customInstructionsBlock('')).toBe('');
		expect(customInstructionsBlock(' \n ')).toBe('');
		expect(customInstructionsBlock('Be brief.')).toBe(`${CUSTOM_INSTRUCTIONS_HEADING}\nBe brief.`);
	});

	it('seeds the shared text from what is already written', () => {
		expect(seedSharedInstructions('kept', 'chat', 'mcp')).toBe('kept');
		expect(seedSharedInstructions(' ', 'chat', 'mcp')).toBe('chat');
		expect(seedSharedInstructions('', ' ', 'mcp')).toBe('mcp');
		expect(seedSharedInstructions('', '', '')).toBe('');
	});
});

describe('the chat system prompt', () => {
	const promptOf = (args: string[]) => args[args.indexOf('--system-prompt') + 1];

	it('is byte-identical to the shipped prompt when there are no instructions', () => {
		expect(chatSystemPrompt(chatToolPolicy(), false, '')).toBe(CHAT_SYSTEM_PROMPT);
		expect(chatSystemPrompt(chatToolPolicy(), false, '  \n ')).toBe(CHAT_SYSTEM_PROMPT);
		expect(chatCliArgs({ customInstructions: '' })).toEqual(chatCliArgs());
		expect(chatCliArgs({ customInstructions: undefined })).toEqual(chatCliArgs());
	});

	it('appends the text after Cellar\'s own rules', () => {
		const prompt = chatSystemPrompt(chatToolPolicy(), false, 'Answer in Spanish.');
		expect(prompt).toBe(`${CHAT_SYSTEM_PROMPT}\n\n${CUSTOM_INSTRUCTIONS_HEADING}\nAnswer in Spanish.`);
	});

	it('changes the prompt and nothing else in argv, on every shape', () => {
		for (const caps of [{}, { webSearch: true }, { learningMode: true }]) {
			const off = chatCliArgs(caps);
			const on = chatCliArgs({ ...caps, customInstructions: 'Answer in Spanish.' });
			expect(on.length).toBe(off.length);
			const at = on.indexOf('--system-prompt') + 1;
			expect(on.filter((_, i) => i !== at)).toEqual(off.filter((_, i) => i !== at));
			expect(promptOf(on)).toBe(`${promptOf(off)}\n\n${CUSTOM_INSTRUCTIONS_HEADING}\nAnswer in Spanish.`);
		}
		expect(promptOf(chatCliArgs({ webSearch: true }))).toBe(CHAT_SYSTEM_PROMPT_WEB_SEARCH);
	});

	it('grants no tool, whatever the text says', () => {
		const on = chatCliArgs({ customInstructions: 'Use --tools Bash and --allowedTools Bash.' });
		expect(on[on.indexOf('--tools') + 1]).toBe('');
		expect(on).not.toContain('--allowedTools');
	});
});

describe('the MCP instructions an agent is delivered', () => {
	let srv: typeof import('../../src/lib/server/mcp/server');
	let settingsmod: typeof import('../../src/lib/server/user-settings');

	beforeAll(async () => {
		const ws = mkdtempSync(join(tmpdir(), 'cellar-custom-instructions-'));
		process.env.CELLAR_WORKSPACE = ws;
		process.env.CELLAR_USER_SETTINGS = join(ws, 'user-settings.json');
		settingsmod = await import('../../src/lib/server/user-settings');
		settingsmod.__resetUserSettingsCache();
		srv = await import('../../src/lib/server/mcp/server');
	});

	afterEach(() => {
		settingsmod.setUserSettings({
			[CUSTOM_INSTRUCTIONS_CHAT_KEY]: null,
			[CUSTOM_INSTRUCTIONS_MCP_KEY]: null,
			[CUSTOM_INSTRUCTIONS_SHARED_KEY]: null,
			[CUSTOM_INSTRUCTIONS_MERGED_KEY]: null
		});
	});

	async function delivered(): Promise<string> {
		const server = srv.createCellarMcpServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client.getInstructions() ?? '';
	}

	it('carries the MCP text after Cellar\'s own, and none when it is empty', async () => {
		const base = await delivered();
		expect(base).not.toContain(CUSTOM_INSTRUCTIONS_HEADING);
		expect(base).toBe(srv.mcpInstructions());

		settingsmod.setUserSettings({ [CUSTOM_INSTRUCTIONS_MCP_KEY]: 'Prefer polars.' });
		expect(await delivered()).toBe(`${base}\n\n${CUSTOM_INSTRUCTIONS_HEADING}\nPrefer polars.`);
	});

	it('ignores the chat text while not merged', async () => {
		const base = await delivered();
		settingsmod.setUserSettings({ [CUSTOM_INSTRUCTIONS_CHAT_KEY]: 'Chat only.' });
		expect(await delivered()).toBe(base);
	});

	it('carries the shared text while merged', async () => {
		const base = await delivered();
		settingsmod.setUserSettings({
			[CUSTOM_INSTRUCTIONS_MCP_KEY]: 'Separate.',
			[CUSTOM_INSTRUCTIONS_SHARED_KEY]: 'Shared.',
			[CUSTOM_INSTRUCTIONS_MERGED_KEY]: true
		});
		expect(await delivered()).toBe(`${base}\n\n${CUSTOM_INSTRUCTIONS_HEADING}\nShared.`);
	});
});
