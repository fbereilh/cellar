/**
 * The chat transcript builder - the two rules that carry the feature's safety
 * and cost claims:
 *
 * 1. A cell hidden from agents (`hidden_from_agent`) is PROVABLY ABSENT from
 *    what is sent - same flag, same predicate as the MCP read surface.
 * 2. The transcript is BYTE-STABLE across runs of an unchanged notebook -
 *    prompt caching keys on an exact prefix (a measured 22.6x cost reduction),
 *    so rendering the same notebook twice must yield identical bytes.
 */
import { describe, it, expect } from 'vitest';
import { buildChatPrompt, type TranscriptCell } from '../../src/lib/server/chat/transcript';

const code = (id: string, source: string, outputs: TranscriptCell['outputs'] = [], cellar: Record<string, unknown> = {}): TranscriptCell => ({
	id,
	cell_type: 'code',
	source,
	outputs,
	metadata: { cellar }
});

const md = (id: string, source: string): TranscriptCell => ({ id, cell_type: 'markdown', source, metadata: {} });

describe('what goes in', () => {
	it('includes cells strictly ABOVE the chat cell, in document order, and the question last', () => {
		const cells = [
			md('m1', '# Analysis'),
			code('c1', 'x = 1', [{ output_type: 'stream', name: 'stdout', text: 'ready\n' }]),
			code('chat1', 'ignored stored source', [], { language: 'chat' }),
			code('below', 'never = "included"')
		];
		const { prompt, includedIds } = buildChatPrompt(cells, 'chat1', 'What is x?');
		expect(includedIds).toEqual(['m1', 'c1']);
		expect(prompt).toBe(
			'[cell m1 · markdown]\n# Analysis\n\n' +
				'[cell c1 · code]\nx = 1\n\n' +
				'[cell c1 · output]\nready\n\n' +
				'[question]\nWhat is x?\n'
		);
		// The chat cell's own STORED source and everything below it are absent.
		expect(prompt).not.toContain('ignored stored source');
		expect(prompt).not.toContain('never = "included"');
	});

	it('a hidden cell is provably absent - source AND outputs', () => {
		const cells = [
			code('secret', 'API_KEY = "hunter2"', [{ output_type: 'stream', name: 'stdout', text: 'hunter2-output\n' }], {
				hidden_from_agent: true
			}),
			code('shown', 'y = 2'),
			code('chat1', '', [], { language: 'chat' })
		];
		const { prompt, includedIds } = buildChatPrompt(cells, 'chat1', 'q');
		expect(includedIds).toEqual(['shown']);
		expect(prompt).not.toContain('hunter2');
		expect(prompt).not.toContain('secret');
	});

	it('a prior chat cell reads as a dialog: its output is labelled reply', () => {
		const cells = [
			code('chat0', 'What is 2+2?', [{ output_type: 'display_data', data: { 'text/markdown': 'It is **4**.', 'text/plain': 'It is 4.' }, metadata: {} }], {
				language: 'chat'
			}),
			code('chat1', '', [], { language: 'chat' })
		];
		const { prompt } = buildChatPrompt(cells, 'chat1', 'And doubled?');
		expect(prompt).toContain('[cell chat0 · chat]\nWhat is 2+2?');
		expect(prompt).toContain('[cell chat0 · reply]\nIt is **4**.');
	});

	it('outputs contribute deterministic text; rich-only outputs contribute nothing', () => {
		const cells = [
			code('c1', 'plot()', [
				{ output_type: 'display_data', data: { 'image/png': 'aGVsbG8=' }, metadata: {} },
				{ output_type: 'error', ename: 'ValueError', evalue: '\u001b[31mboom\u001b[0m', traceback: ['tb'] },
				{ output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {}, execution_count: 1 }
			]),
			code('chat1', '', [], { language: 'chat' })
		];
		const { prompt } = buildChatPrompt(cells, 'chat1', 'q');
		expect(prompt).not.toContain('aGVsbG8='); // no base64 rides the transcript
		expect(prompt).toContain('ValueError: boom'); // ANSI stripped from evalue
		expect(prompt).not.toContain('\u001b'); // no escape bytes anywhere
		expect(prompt).toContain('42');
	});

	it('an unknown chat cell id yields just the question (defensive)', () => {
		const { prompt, includedIds } = buildChatPrompt([code('c1', 'x = 1')], 'nope', 'q');
		expect(includedIds).toEqual([]);
		expect(prompt).toBe('[question]\nq\n');
	});
});

describe('byte stability (the prompt-cache prefix)', () => {
	it('the same notebook renders to IDENTICAL bytes, twice and across process time', () => {
		const cells = [
			md('m1', '## Setup'),
			code('c1', 'import pandas as pd\ndf = pd.DataFrame()', [{ output_type: 'stream', name: 'stdout', text: 'ok\n' }]),
			code('c2', 'df.head()', [{ output_type: 'execute_result', data: { 'text/plain': 'Empty DataFrame' }, metadata: {}, execution_count: 2 }]),
			code('chat1', '', [], { language: 'chat' })
		];
		const a = buildChatPrompt(cells, 'chat1', 'Summarize.');
		const b = buildChatPrompt(cells, 'chat1', 'Summarize.');
		expect(a.prompt).toBe(b.prompt);
	});

	it('the module holds nothing time-varying (no Date/Math.random in the source)', async () => {
		const fs = await import('node:fs');
		const src = fs.readFileSync(new URL('../../src/lib/server/chat/transcript.ts', import.meta.url), 'utf8');
		expect(src).not.toMatch(/Date\.now|new Date|Math\.random/);
	});
});
