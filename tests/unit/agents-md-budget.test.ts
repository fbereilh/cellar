/**
 * AGENTS.md loads into every agent session in this repo, so its size is paid on
 * every task. It grew from 5 KB to over 1 MB in four months because feature
 * changes appended their design notes to it, until it passed the harness's
 * 150,000-character limit for a memory file. The detail now lives in
 * `docs/dev-notes/`, and AGENTS.md keeps only an index plus the rules every
 * change must follow.
 *
 * These checks make the regrowth visible in the same change that causes it:
 *   - AGENTS.md stays under a fixed character budget, far below the limit;
 *   - every link it gives to a local file resolves, so the index never points at
 *     a note that was renamed or removed;
 *   - every note under `docs/dev-notes/` is listed in the index, so a new note
 *     cannot hide from the agents that need it.
 *
 * Raise the budget only when the repo owner explicitly asks for it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS = join(ROOT, 'AGENTS.md');
const NOTES = join(ROOT, 'docs', 'dev-notes');

/** Characters, not bytes: the harness limit counts characters. */
const BUDGET = 40_000;

const text = readFileSync(AGENTS, 'utf8');

/** Relative markdown link targets, without any `#anchor`. */
function localLinks(md: string): string[] {
	const out: string[] = [];
	for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
		const target = m[1].split('#')[0];
		if (!target || /^[a-z]+:/i.test(target)) continue;
		out.push(target);
	}
	return out;
}

describe('AGENTS.md stays small', () => {
	it(`is under ${BUDGET.toLocaleString('en-US')} characters`, () => {
		expect([...text].length).toBeLessThanOrEqual(BUDGET);
	});

	it('links only to files that exist', () => {
		const links = localLinks(text);
		expect(links.length).toBeGreaterThan(0);
		const missing = links.filter((l) => !existsSync(join(ROOT, l)));
		expect(missing).toEqual([]);
	});

	it('lists every note under docs/dev-notes in its index', () => {
		const linked = new Set(localLinks(text));
		const notes = readdirSync(NOTES).filter((f) => f.endsWith('.md'));
		expect(notes.length).toBeGreaterThan(0);
		const unlisted = notes.map((f) => `docs/dev-notes/${f}`).filter((p) => !linked.has(p));
		expect(unlisted).toEqual([]);
	});

	it('keeps CLAUDE.md as a pointer to AGENTS.md', () => {
		const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
		expect(claude).toContain('@AGENTS.md');
	});
});
