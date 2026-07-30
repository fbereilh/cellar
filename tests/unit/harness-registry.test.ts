/**
 * Harness MCP integration registry (src/lib/server/harness.js) + the
 * `cellar harness` CLI verb.
 *
 * These files are the user's: `.mcp.json` and `.codex/config.toml` hold other
 * MCP servers and unrelated settings, so the two things that must hold for
 * every write are MERGE (nothing else changes) and IDEMPOTENCE (a second run
 * neither duplicates nor churns the file). Both fail silently — a clobbered
 * config looks fine until the user next opens their agent — hence the byte-level
 * assertions here rather than "the cellar entry is present" checks.
 *
 * The TOML writer is text-surgical (no TOML dependency), so its scanner gets
 * adversarial cases of its own: a `[table]`-lookalike inside a multi-line
 * string, a quoted key form, a comment containing `]`, and an inline definition
 * it must DETECT (never duplicate) but refuse to rewrite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
	HARNESSES,
	clearHarnessDecline,
	configureHarness,
	getHarness,
	harnessConfigPath,
	harnessDeclined,
	harnessMarkerPath,
	harnessNames,
	harnessSetupDone,
	harnessState,
	harnessStates,
	parseHarnessAnswer,
	readHarnessSetup,
	resolveHarnessAnswer,
	shouldPromptHarnessSetup,
	writeHarnessSetup
} from '../../src/lib/server/harness.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(REPO, 'bin', 'cellar.js');

let ws: string;

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), 'cellar-harness-'));
});
afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

const claudeFile = () => join(ws, '.mcp.json');
const codexFile = () => join(ws, '.codex', 'config.toml');
const read = (f: string) => readFileSync(f, 'utf8');

function writeCodex(text: string) {
	mkdirSync(join(ws, '.codex'), { recursive: true });
	writeFileSync(codexFile(), text);
}

describe('registry shape', () => {
	it('covers the two v1 harnesses, each with a distinct config file + format', () => {
		expect(harnessNames()).toEqual(['claude', 'codex']);
		expect(getHarness('claude')?.configPath).toBe('.mcp.json');
		expect(getHarness('codex')?.configPath).toBe(join('.codex', 'config.toml'));
		// The whole point of the registry: Codex does NOT read .mcp.json, so the
		// paths and formats must never collapse into one.
		const paths = HARNESSES.map((h) => h.configPath);
		expect(new Set(paths).size).toBe(paths.length);
		expect(new Set(HARNESSES.map((h) => h.format))).toEqual(new Set(['json', 'toml']));
	});

	it('resolves a name case-insensitively and rejects an unknown one', () => {
		expect(getHarness('  CODEX ')?.name).toBe('codex');
		expect(getHarness('opencode')).toBeNull();
		const r = configureHarness('opencode', ws);
		expect(r.ok).toBe(false);
		expect(r.message).toContain('claude, codex');
		// A refused harness writes nothing at all.
		expect(existsSync(claudeFile())).toBe(false);
		expect(existsSync(codexFile())).toBe(false);
	});

	it('exposes the config path used by the launcher', () => {
		expect(harnessConfigPath('claude', ws)).toBe(claudeFile());
		expect(harnessConfigPath('nope', ws)).toBeNull();
	});
});

describe('claude (.mcp.json, JSON)', () => {
	it('writes the correct stdio entry into a fresh workspace', () => {
		const r = configureHarness('claude', ws);
		expect(r.status).toBe('wrote');
		expect(JSON.parse(read(claudeFile()))).toEqual({
			mcpServers: { cellar: { command: 'cellar', args: ['mcp'] } }
		});
	});

	it('merges: other servers and unrelated top-level settings survive', () => {
		writeFileSync(
			claudeFile(),
			JSON.stringify(
				{
					mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } },
					someOtherSetting: { keep: true }
				},
				null,
				2
			) + '\n'
		);
		configureHarness('claude', ws);
		const after = JSON.parse(read(claudeFile()));
		expect(after.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp@latest'] });
		expect(after.someOtherSetting).toEqual({ keep: true });
		expect(after.mcpServers.cellar).toEqual({ command: 'cellar', args: ['mcp'] });
	});

	it('is idempotent: a second call reports already-configured and does not touch the file', () => {
		configureHarness('claude', ws);
		const before = read(claudeFile());
		const mtime = statSync(claudeFile()).mtimeMs;
		const r = configureHarness('claude', ws);
		expect(r.status).toBe('already');
		expect(read(claudeFile())).toBe(before);
		expect(statSync(claudeFile()).mtimeMs).toBe(mtime);
	});

	it('repairs a stale cellar entry rather than adding a second one', () => {
		writeFileSync(
			claudeFile(),
			JSON.stringify({ mcpServers: { cellar: { command: 'cellar', args: ['mcp', '--port', '39587'] } } }, null, 2)
		);
		const r = configureHarness('claude', ws);
		expect(r.status).toBe('updated');
		const after = JSON.parse(read(claudeFile()));
		expect(Object.keys(after.mcpServers)).toEqual(['cellar']);
		expect(after.mcpServers.cellar).toEqual({ command: 'cellar', args: ['mcp'] });
	});

	it('merges INSIDE the cellar entry: keys Cellar does not own survive a repair', () => {
		// Cellar owns `command`/`args` and nothing else - exactly like the TOML writer,
		// which rewrites only those two lines. Replacing the entry wholesale silently
		// dropped a user's `env`/`type`/`cwd`.
		writeFileSync(
			claudeFile(),
			JSON.stringify(
				{ mcpServers: { cellar: { type: 'stdio', command: 'cellar', args: ['mcp', '--stale'], env: { A: '1' } } } },
				null,
				2
			) + '\n'
		);
		expect(configureHarness('claude', ws).status).toBe('updated');
		expect(JSON.parse(read(claudeFile())).mcpServers.cellar).toEqual({
			type: 'stdio',
			command: 'cellar',
			args: ['mcp'],
			env: { A: '1' }
		});
	});

	it('reports already-configured on a correct entry whatever the file formatting', () => {
		// Idempotence is decided on MEANING, not on our re-serialized bytes matching
		// the user's: a correct config indented differently was reported `updated` and
		// rewritten on EVERY launch.
		const odd = '{\n    "mcpServers": {\n        "cellar": {"command": "cellar", "args": ["mcp"], "env": {"A": "1"}}\n    }\n}';
		writeFileSync(claudeFile(), odd);
		const mtime = statSync(claudeFile()).mtimeMs;
		expect(configureHarness('claude', ws).status).toBe('already');
		expect(read(claudeFile())).toBe(odd);
		expect(statSync(claudeFile()).mtimeMs).toBe(mtime);
	});

	it('refuses a file that is not a JSON object, leaving it byte-identical', () => {
		const junk = '{ this is not json ';
		writeFileSync(claudeFile(), junk);
		const r = configureHarness('claude', ws);
		expect(r.status).toBe('skipped');
		expect(read(claudeFile())).toBe(junk);

		writeFileSync(claudeFile(), '["an array"]');
		expect(configureHarness('claude', ws).status).toBe('skipped');
		expect(read(claudeFile())).toBe('["an array"]');
	});

	it('refuses a non-object "mcpServers" instead of replacing it', () => {
		// The merge below would swap the user's value for `{ cellar: … }` and report
		// success - the clobber this module exists to refuse. The TOML sibling already
		// refuses the analogous `mcp_servers = { … }`, so the two writers must agree.
		for (const junk of ['"nope"', '42', '["a", "b"]', 'null']) {
			const text = `{ "mcpServers": ${junk}, "keep": 1 }`;
			writeFileSync(claudeFile(), text);
			const r = configureHarness('claude', ws);
			expect(r.status).toBe('skipped');
			expect(r.message).toMatch(/mcpServers/);
			expect(read(claudeFile())).toBe(text);
		}
		// And it is reported as unreadable, not as a harness simply not configured.
		expect(harnessState('claude', ws)).toMatchObject({ unreadable: true, configured: false });
	});

	it('refuses a config it cannot read at all, rather than throwing', () => {
		// A directory where the config should be (EISDIR) - the same class as a mode
		// that denies us. The read used to be guarded here but not on the TOML side;
		// both must answer with the module's actionable refusal.
		mkdirSync(claudeFile(), { recursive: true });
		const r = configureHarness('claude', ws);
		expect(r.status).toBe('skipped');
		expect(r.message).toMatch(/could not be read/);
		expect(harnessState('claude', ws)?.unreadable).toBe(true);
	});
});

describe('codex (.codex/config.toml, TOML)', () => {
	const CANONICAL = '[mcp_servers.cellar]\ncommand = "cellar"\nargs = ["mcp"]\n';

	it('creates .codex/ and writes the exact table Codex itself writes', () => {
		const r = configureHarness('codex', ws);
		expect(r.status).toBe('wrote');
		// Byte-for-byte the shape `codex mcp add cellar -- cellar mcp` produces.
		expect(read(codexFile())).toBe(CANONICAL);
	});

	it('appends to an existing config, leaving every prior byte untouched', () => {
		const existing = [
			'# my codex settings',
			'model = "gpt-5"',
			'approval_policy = "on-request"',
			'',
			'[mcp_servers.serena]',
			'command = "uvx"',
			'args = ["--from", "git+https://example/serena", "serena"]',
			'',
			'[sandbox_workspace_write]',
			'network_access = true',
			''
		].join('\n');
		writeCodex(existing);
		expect(configureHarness('codex', ws).status).toBe('wrote');
		const after = read(codexFile());
		expect(after.startsWith(existing)).toBe(true);
		expect(after).toContain('[mcp_servers.cellar]');
		// The other server, and the unrelated settings, are still exactly there.
		expect(after).toContain('[mcp_servers.serena]');
		expect(after).toContain('model = "gpt-5"');
		expect(after).toContain('network_access = true');
	});

	it('is idempotent, including against Codex-written and reordered forms', () => {
		configureHarness('codex', ws);
		const before = read(codexFile());
		const mtime = statSync(codexFile()).mtimeMs;
		expect(configureHarness('codex', ws).status).toBe('already');
		expect(read(codexFile())).toBe(before);
		expect(statSync(codexFile()).mtimeMs).toBe(mtime);

		// Same meaning, different spelling: single quotes, spacing, key order, a
		// trailing comment. None of these is a reason to rewrite the user's file.
		writeCodex("[mcp_servers.cellar]\nargs = [ 'mcp' ]   # bridge\ncommand = 'cellar'\n");
		const spelled = read(codexFile());
		expect(configureHarness('codex', ws).status).toBe('already');
		expect(read(codexFile())).toBe(spelled);
	});

	it('updates only the command/args lines, preserving sibling keys and comments', () => {
		writeCodex(
			[
				'[mcp_servers.cellar]',
				'# pinned by hand once upon a time',
				'command = "npx"',
				'args = ["cellar-mcp", "--port", "39587"]',
				'startup_timeout_sec = 30',
				'',
				'[mcp_servers.other]',
				'command = "other"',
				''
			].join('\n')
		);
		expect(configureHarness('codex', ws).status).toBe('updated');
		const after = read(codexFile());
		expect(after).toContain('command = "cellar"');
		expect(after).toContain('args = ["mcp"]');
		expect(after).not.toContain('39587');
		// Everything that is not command/args is untouched.
		expect(after).toContain('# pinned by hand once upon a time');
		expect(after).toContain('startup_timeout_sec = 30');
		expect(after).toContain('[mcp_servers.other]');
		// And exactly one cellar table exists.
		expect(after.match(/\[mcp_servers\.cellar\]/g)).toHaveLength(1);
	});

	it('leaves an already-correct key line alone, comment and all, when its sibling is wrong', () => {
		// The splice replaces whole physical lines, so rewriting a key that already
		// says what Cellar would write costs that line its own trailing comment for
		// no change at all. Byte preservation is per KEY, not merely per table.
		writeCodex(
			[
				'[mcp_servers.cellar]',
				'command = "cellar"   # the stdio bridge',
				'args = ["mcp", "--stale"]  # wrong',
				''
			].join('\n')
		);
		expect(configureHarness('codex', ws).status).toBe('updated');
		expect(read(codexFile())).toBe(
			['[mcp_servers.cellar]', 'command = "cellar"   # the stdio bridge', 'args = ["mcp"]', ''].join(
				'\n'
			)
		);
	});

	it('joins a multi-line args array when deciding, and rewrites it as one line', () => {
		writeCodex('[mcp_servers.cellar]\ncommand = "cellar"\nargs = [\n  "mcp",\n  "--stale"\n]\n');
		expect(configureHarness('codex', ws).status).toBe('updated');
		expect(read(codexFile())).toBe('[mcp_servers.cellar]\ncommand = "cellar"\nargs = ["mcp"]\n');

		// The same layout carrying the CORRECT value is left alone entirely.
		const ok = '[mcp_servers.cellar]\ncommand = "cellar"\nargs = [\n  "mcp"\n]\n';
		writeCodex(ok);
		expect(configureHarness('codex', ws).status).toBe('already');
		expect(read(codexFile())).toBe(ok);
	});

	it('recognizes a quoted-key table header as the same table', () => {
		writeCodex('[mcp_servers."cellar"]\ncommand = "cellar"\nargs = ["mcp"]\n');
		expect(configureHarness('codex', ws).status).toBe('already');
		expect(read(codexFile())).not.toContain('[mcp_servers.cellar]');
	});

	it('ignores a table-lookalike inside a multi-line string', () => {
		// The reason the writer tracks string state rather than scanning lines: this
		// text is DATA, and treating it as a table would report a config that does
		// not exist as already-configured (leaving Codex silently unwired).
		const existing = 'instructions = """\n[mcp_servers.cellar]\ncommand = "not real"\n"""\n';
		writeCodex(existing);
		expect(configureHarness('codex', ws).status).toBe('wrote');
		const after = read(codexFile());
		expect(after.startsWith(existing)).toBe(true);
		expect(after.trimEnd().endsWith('args = ["mcp"]')).toBe(true);
	});

	it('is not fooled by a bracket inside a comment', () => {
		const existing = '# see [mcp_servers.cellar] in the docs\nmodel = "gpt-5"\n';
		writeCodex(existing);
		expect(configureHarness('codex', ws).status).toBe('wrote');
		expect(read(codexFile()).startsWith(existing)).toBe(true);
	});

	it('detects an inline definition and refuses to touch it (never duplicates)', () => {
		const existing = '[mcp_servers]\ncellar = { command = "cellar", args = ["mcp"] }\n';
		writeCodex(existing);
		const r = configureHarness('codex', ws);
		expect(r.status).toBe('skipped');
		expect(r.message).toContain('another form');
		expect(read(codexFile())).toBe(existing);
	});

	it('detects a dotted-key definition and refuses to touch it', () => {
		const existing = 'mcp_servers.cellar.command = "cellar"\nmcp_servers.cellar.args = ["mcp"]\n';
		writeCodex(existing);
		expect(configureHarness('codex', ws).status).toBe('skipped');
		expect(read(codexFile())).toBe(existing);
	});

	it('refuses a file it cannot read as TOML with confidence', () => {
		const broken = 'instructions = """\nnever closed\n';
		writeCodex(broken);
		const r = configureHarness('codex', ws);
		expect(r.status).toBe('skipped');
		expect(r.message).toContain('TOML');
		expect(read(codexFile())).toBe(broken);
	});

	it('refuses a file it cannot read at all, rather than throwing', () => {
		// The TOML read was unguarded while the JSON one was wrapped, so an EACCES /
		// EISDIR config threw a raw stack trace out of `cellar harness list|add`
		// instead of the documented refusal. Both formats now answer the same way.
		mkdirSync(codexFile(), { recursive: true });
		const r = configureHarness('codex', ws);
		expect(r.status).toBe('skipped');
		expect(r.message).toMatch(/could not be read/);
		// `harnessState` reads the same file and must not throw either - it is what
		// `cellar harness list` prints, and what the first-run prompt gates on.
		expect(harnessState('codex', ws)).toMatchObject({ unreadable: true, configured: false });
		expect(() => harnessStates(ws)).not.toThrow();
		expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(true);
	});

	it('carries the trusted-project note, since project config is ignored without it', () => {
		expect(configureHarness('codex', ws).note).toMatch(/trusted/i);
	});

	// The scanner has to know what is STRUCTURE and what is DATA in two directions
	// - an open string and an open bracket - and getting either wrong does not look
	// like a parse error, it looks like a config that quietly lost something. Each
	// case below deleted or invalidated part of the user's file before the fix.
	describe('never mistakes a value for structure', () => {
		it('keeps sibling keys when a value string contains a bracket', () => {
			// `args = [… "a[b"]` counted the in-string `[` as depth, so the value span
			// ran to the end of the table and the rewrite spliced the rest away.
			writeCodex(
				[
					'[mcp_servers.cellar]',
					'command = "npx"',
					'args = ["-p", "a[b"]',
					'startup_timeout_sec = 30',
					'env = { A = "1" }',
					'',
					'[mcp_servers.other]',
					'command = "other"',
					''
				].join('\n')
			);
			expect(configureHarness('codex', ws).status).toBe('updated');
			const after = read(codexFile());
			expect(after).toContain('startup_timeout_sec = 30');
			expect(after).toContain('env = { A = "1" }');
			expect(after).toContain('[mcp_servers.other]');
			expect(after).toContain('args = ["mcp"]');
			expect(after).not.toContain('a[b');
		});

		it('rewrites the REAL command, not one written inside a multi-line string', () => {
			// The worst shape: the string body was rewritten (corrupting the user's own
			// text) while the actual `command` kept its wrong value, so Codex stayed broken.
			writeCodex(
				['[mcp_servers.cellar]', 'description = """', 'command = "evil"', '"""', 'command = "npx"', 'args = ["x"]', ''].join(
					'\n'
				)
			);
			expect(configureHarness('codex', ws).status).toBe('updated');
			const after = read(codexFile());
			// The string body reads exactly as authored; only the real key moved.
			expect(after.match(/command = "evil"/g)).toHaveLength(1);
			expect(after.match(/command = "cellar"/g)).toHaveLength(1);
			expect(after).not.toContain('command = "npx"');
			expect(harnessState('codex', ws)?.configured).toBe(true);
		});

		it('rewrites a key in place when a nested array sits above it (no duplicate key)', () => {
			// A `[1, 2]` element read as a table header truncated the span, so `args`
			// read as missing and a SECOND one was inserted - invalid TOML.
			writeCodex(['[mcp_servers.cellar]', 'command = "npx"', 'matrix = [', '  [1, 2]', ']', 'args = ["x"]', ''].join('\n'));
			expect(configureHarness('codex', ws).status).toBe('updated');
			const after = read(codexFile());
			expect(after.match(/^args = /gm)).toHaveLength(1);
			expect(after).toContain('args = ["mcp"]');
			expect(after).toContain('matrix = [\n  [1, 2]\n]');
			expect(configureHarness('codex', ws).status).toBe('already');
		});

		it('replaces a multi-line-string value whole, leaving no orphan lines', () => {
			writeCodex(['[mcp_servers.cellar]', 'command = """', 'cellar', '"""', 'args = ["mcp"]', 'keep = 1', ''].join('\n'));
			expect(configureHarness('codex', ws).status).toBe('updated');
			const after = read(codexFile());
			expect(after).toBe('[mcp_servers.cellar]\ncommand = "cellar"\nargs = ["mcp"]\nkeep = 1\n');
		});

		it('refuses a root-level inline mcp_servers instead of appending an illegal table', () => {
			// TOML forbids extending an inline table, so appending `[mcp_servers.cellar]`
			// under it made the WHOLE file unparseable - every other setting lost with it.
			const existing = 'mcp_servers = { cellar = { command = "cellar", args = ["mcp"] } }\nmodel = "gpt-5"\n';
			writeCodex(existing);
			const r = configureHarness('codex', ws);
			expect(r.status).toBe('skipped');
			expect(r.message).toContain('another form');
			expect(read(codexFile())).toBe(existing);
			// And it is reported as present-but-not-editable, never as absent.
			expect(harnessState('codex', ws)).toMatchObject({ present: true, configured: false });
		});

		it('refuses a value whose brackets never close', () => {
			const broken = '[mcp_servers.cellar]\nargs = [\n  "mcp"\n';
			writeCodex(broken);
			expect(configureHarness('codex', ws).status).toBe('skipped');
			expect(read(codexFile())).toBe(broken);
		});

		it('still appends correctly below an array of tables and a multi-line array', () => {
			const existing = [
				'[[profiles]]',
				'name = "a"',
				'',
				'[sandbox_workspace_write]',
				'writable_roots = [',
				'  "/tmp",',
				'  "/var/folders"',
				']',
				''
			].join('\n');
			writeCodex(existing);
			expect(configureHarness('codex', ws).status).toBe('wrote');
			const after = read(codexFile());
			expect(after.startsWith(existing)).toBe(true);
			expect(after.trimEnd().endsWith('args = ["mcp"]')).toBe(true);
			expect(configureHarness('codex', ws).status).toBe('already');
		});
	});

	it('replaces the file atomically, leaving no temp file behind', () => {
		// These files hold the user's other MCP servers and settings, so a crash
		// mid-write must not be able to truncate one (the .ipynb rule, same reason).
		configureHarness('codex', ws);
		configureHarness('claude', ws);
		const stray = [...readdirSync(join(ws, '.codex')), ...readdirSync(ws)].filter((f) => f.includes('.tmp'));
		expect(stray).toEqual([]);
	});
});

describe('harnessState', () => {
	it('separates "an entry exists" from "it points at Cellar"', () => {
		expect(harnessState('codex', ws)).toMatchObject({ exists: false, present: false, configured: false });
		writeCodex('[mcp_servers.cellar]\ncommand = "npx"\nargs = ["something-else"]\n');
		expect(harnessState('codex', ws)).toMatchObject({ exists: true, present: true, configured: false });
		configureHarness('codex', ws);
		expect(harnessState('codex', ws)).toMatchObject({ exists: true, present: true, configured: true });
	});

	it('flags an unreadable config instead of calling it unconfigured', () => {
		writeFileSync(claudeFile(), 'not json');
		expect(harnessState('claude', ws)).toMatchObject({ unreadable: true, configured: false });
	});

	it('reports every registered harness, in registry order', () => {
		expect(harnessStates(ws).map((s) => s.name)).toEqual(harnessNames());
	});
});

describe('first-run marker', () => {
	it('asks once: unasked → prompt, then never again', () => {
		expect(harnessSetupDone(ws)).toBe(false);
		expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({ prompt: true, reason: 'ask' });

		writeHarnessSetup(ws, { configured: ['codex'], declined: ['claude'] });
		expect(harnessSetupDone(ws)).toBe(true);
		expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({
			prompt: false,
			reason: 'already-asked'
		});
	});

	it('never prompts non-interactively, and records nothing so a human is still asked', () => {
		const d = shouldPromptHarnessSetup(ws, { interactive: false });
		expect(d).toMatchObject({ prompt: false, reason: 'non-interactive', record: false });
		expect(existsSync(join(ws, '.cellar', 'harness.json'))).toBe(false);
		// A later interactive launch in the same workspace still asks.
		expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(true);
	});

	it('does not ask when every harness is already configured, but records that', () => {
		for (const n of harnessNames()) configureHarness(n, ws);
		const d = shouldPromptHarnessSetup(ws, { interactive: true });
		expect(d).toMatchObject({ prompt: false, reason: 'all-configured', record: true });
	});

	/**
	 * `--no-mcp-config` opts out of the `.mcp.json` write. The prompt must not offer
	 * to write the very file the flag refuses - and an omitted harness must not be
	 * DECLINED either, since a decline outlives the flag and would keep the write off
	 * on the next launch without it.
	 */
	it('omits an excluded harness from the offer, and never declines it', () => {
		const auto = HARNESSES.filter((h) => h.auto).map((h) => h.name);
		expect(auto).toEqual(['claude']);

		const d = shouldPromptHarnessSetup(ws, { interactive: true, exclude: auto });
		expect(d.prompt).toBe(true);
		expect(d.offered).toEqual(['codex']);
		expect(d.states?.map((s) => s.name)).toEqual(['codex']);

		// The decline is derived from those same states, so the excluded harness cannot
		// reach the marker - even on an explicit skip.
		const r = resolveHarnessAnswer(d.states!, '', d.offered);
		expect(r.record).toEqual({ configured: [], declined: ['codex'] });
		writeHarnessSetup(ws, r.record!);
		expect(harnessDeclined('claude', ws)).toBe(false);
		expect(harnessDeclined('codex', ws)).toBe(true);
	});

	it('numbers the offer against the harnesses actually shown', () => {
		// The prompt lists `states` and parses numbers against `offered`; excluding one
		// must shift both together or "1" would configure a harness nobody was shown.
		const d = shouldPromptHarnessSetup(ws, { interactive: true, exclude: ['claude'] });
		expect(parseHarnessAnswer('1', d.offered).chosen).toEqual(['codex']);
	});

	it('records nothing when the exclusion leaves nothing to ask about', () => {
		// Not an answered question: a launch without the opt-out must still ask.
		const d = shouldPromptHarnessSetup(ws, { interactive: true, exclude: harnessNames() });
		expect(d).toMatchObject({ prompt: false, reason: 'nothing-offered', record: false });
		expect(d.offered).toEqual([]);
		expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(true);
	});

	it('remembers an explicit decline, which is what the launcher honors', () => {
		writeHarnessSetup(ws, { configured: ['codex'], declined: ['claude'] });
		expect(harnessDeclined('claude', ws)).toBe(true);
		expect(harnessDeclined('codex', ws)).toBe(false);
		expect(harnessDeclined('nope', ws)).toBe(false);
		expect(readHarnessSetup(ws)).toMatchObject({ version: 1, configured: ['codex'], declined: ['claude'] });
	});

	it('treats a corrupt marker as unasked rather than throwing', () => {
		mkdirSync(join(ws, '.cellar'), { recursive: true });
		writeFileSync(join(ws, '.cellar', 'harness.json'), '{ broken');
		expect(readHarnessSetup(ws)).toBeNull();
		expect(harnessSetupDone(ws)).toBe(false);
	});
});

describe('parseHarnessAnswer', () => {
	it('accepts numbers, names, "all", and mixed separators', () => {
		expect(parseHarnessAnswer('2').chosen).toEqual(['codex']);
		expect(parseHarnessAnswer('codex').chosen).toEqual(['codex']);
		expect(parseHarnessAnswer('1, 2').chosen).toEqual(['claude', 'codex']);
		expect(parseHarnessAnswer('claude codex').chosen).toEqual(['claude', 'codex']);
		expect(parseHarnessAnswer('all').chosen).toEqual(harnessNames());
		expect(parseHarnessAnswer('CODEX').chosen).toEqual(['codex']);
		// A repeated choice is one choice, not two writes.
		expect(parseHarnessAnswer('codex 2 codex').chosen).toEqual(['codex']);
	});

	it('treats an empty answer or a no/skip token as skip', () => {
		for (const a of ['', '   ', 'n', 'no', 'none', 'skip']) {
			expect(parseHarnessAnswer(a)).toMatchObject({ chosen: [], skipped: true });
		}
	});

	it('reports an unrecognized token instead of silently dropping it', () => {
		const r = parseHarnessAnswer('codex, opencode, 9');
		expect(r.chosen).toEqual(['codex']);
		expect(r.unknown).toEqual(['opencode', '9']);
	});

	it('separates a real answer from one nothing in it resolved', () => {
		// A skip IS a decision; a typo is not, and must not be recorded as one.
		expect(parseHarnessAnswer('').answered).toBe(true);
		expect(parseHarnessAnswer('no').answered).toBe(true);
		expect(parseHarnessAnswer('codex').answered).toBe(true);
		expect(parseHarnessAnswer('codex opencode').answered).toBe(true);
		expect(parseHarnessAnswer('opencode').answered).toBe(false);
		expect(parseHarnessAnswer('9, zzz').answered).toBe(false);
	});
});

/**
 * What one prompt answer RECORDS. The marker outlives the launch and silently
 * gates the launcher's automatic `.mcp.json` write, so a wrong entry here has no
 * symptom in the run that wrote it - only later, as a write that never happens
 * again and a decline the user never made.
 */
describe('resolveHarnessAnswer', () => {
	const states = (over: Partial<Record<string, boolean>> = {}) =>
		harnessNames().map((name) => ({
			name,
			label: name,
			file: `/x/${name}`,
			exists: false,
			present: false,
			configured: !!over[name],
			unreadable: false
		})) as any;

	it('declines only what was offered as unconfigured and passed over', () => {
		const r = resolveHarnessAnswer(states(), '2');
		expect(r.chosen).toEqual(['codex']);
		expect(r.record).toEqual({ configured: ['codex'], declined: ['claude'] });
	});

	it('never declines an ALREADY-CONFIGURED harness the user simply did not re-pick', () => {
		// The prompt labels it "(already configured)", so there was nothing to say no
		// to - and declining it would switch off the per-launch write that keeps its
		// entry current.
		const r = resolveHarnessAnswer(states({ claude: true }), '2');
		expect(r.record).toEqual({ configured: ['codex'], declined: [] });
	});

	it('records an explicit skip, declining exactly the unconfigured harnesses', () => {
		for (const answer of ['', '   ', 'n', 'no', 'none', 'skip']) {
			expect(resolveHarnessAnswer(states({ claude: true }), answer).record).toEqual({
				configured: [],
				declined: ['codex']
			});
		}
	});

	it('records NOTHING for an answer nothing in which resolved', () => {
		const r = resolveHarnessAnswer(states(), 'opencode');
		expect(r.record).toBeNull();
		expect(r.unknown).toEqual(['opencode']);
	});

	it('records NOTHING when there was no answer at all', () => {
		// A timeout, a closed stdin and a backgrounded job are one outcome by design:
		// not a decision, so the next interactive launch asks again.
		expect(resolveHarnessAnswer(states(), null).record).toBeNull();
		expect(resolveHarnessAnswer(states(), undefined).record).toBeNull();
	});

	it('the recorded decline is exactly what the launcher gate reads', () => {
		// Ties the pure rule to the real gate: `harnessDeclined('claude')` is what
		// suppresses the automatic .mcp.json write. Claude is already configured and
		// the user skips, so nothing is declined for it - the write keeps running.
		configureHarness('claude', ws);
		const r = resolveHarnessAnswer(harnessStates(ws), '');
		expect(r.record).toEqual({ configured: [], declined: ['codex'] });
		writeHarnessSetup(ws, r.record!);
		expect(harnessDeclined('claude', ws)).toBe(false);
		expect(harnessDeclined('codex', ws)).toBe(true);
	});
});

describe('retracting a decline', () => {
	it('`cellar harness add` re-enables the automatic write it had switched off', () => {
		writeHarnessSetup(ws, { configured: [], declined: ['claude', 'codex'] });
		expect(harnessDeclined('claude', ws)).toBe(true);

		const r = spawnSync(process.execPath, [CLI, 'harness', 'add', 'claude'], {
			cwd: ws,
			encoding: 'utf8',
			env: { ...process.env, CI: '1' }
		});
		expect(r.status).toBe(0);
		// The message beside the skipped launch write promises exactly this.
		expect(harnessDeclined('claude', ws)).toBe(false);
		// Scoped: the other harness's decline is untouched, and the question still
		// counts as asked.
		expect(harnessDeclined('codex', ws)).toBe(true);
		expect(harnessSetupDone(ws)).toBe(true);
		expect(readHarnessSetup(ws)?.configured).toContain('claude');
	});

	it('claims nothing for a harness nothing writes on launch', () => {
		// Only an `auto` harness is written per launch, so only its decline switches
		// anything off. Retracting codex's would announce a per-launch Codex setup that
		// does not exist.
		expect(getHarness('codex')?.auto).toBeUndefined();
		writeHarnessSetup(ws, { configured: [], declined: ['claude', 'codex'] });

		const r = spawnSync(process.execPath, [CLI, 'harness', 'add', 'codex'], {
			cwd: ws,
			encoding: 'utf8',
			env: { ...process.env, CI: '1' }
		});
		expect(r.status).toBe(0);
		expect(r.stdout).not.toMatch(/re-enabled automatic/);
		// And the retraction itself is gated too: codex's decline gates nothing, so it
		// is left exactly as recorded.
		expect(harnessDeclined('codex', ws)).toBe(true);
		expect(harnessDeclined('claude', ws)).toBe(true);
	});

	it('keeps the original promptedAt, so the question is not re-asked', () => {
		writeHarnessSetup(ws, { configured: [], declined: ['claude'], promptedAt: 1234 });
		expect(clearHarnessDecline('claude', ws)).toBe(true);
		expect(readHarnessSetup(ws)?.promptedAt).toBe(1234);
		expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(false);
	});

	it('is a no-op when there is nothing to retract', () => {
		expect(clearHarnessDecline('claude', ws)).toBe(false);
		expect(existsSync(harnessMarkerPath(ws))).toBe(false);
		writeHarnessSetup(ws, { configured: ['claude'], declined: [] });
		expect(clearHarnessDecline('claude', ws)).toBe(false);
		expect(clearHarnessDecline('nope', ws)).toBe(false);
	});
});

/**
 * The first-run prompt sits in the LAUNCH path, so two properties matter that a
 * unit suite cannot boot a launcher to observe. Both are asserted against the
 * source: an ordering, and the shape of the wait.
 */
describe('first-run prompt placement + wait (bin/cellar.js)', () => {
	const src = readFileSync(CLI, 'utf8');
	const mainBody = src.slice(src.indexOf('async function main()'));

	it('asks BEFORE the single-instance takeover claims/reaps the folder', () => {
		// Otherwise a relaunch reaps the instance that owns this folder and then waits
		// for an answer, leaving the user with no running Cellar at all.
		const prompt = mainBody.indexOf('maybePromptHarnessSetup()');
		const lock = mainBody.indexOf('acquireInstanceLock(WORKSPACE)');
		const reap = mainBody.indexOf('reapInstance(');
		expect(prompt).toBeGreaterThan(-1);
		expect(lock).toBeGreaterThan(-1);
		expect(prompt).toBeLessThan(lock);
		expect(prompt).toBeLessThan(reap);
	});

	it('passes the prompt a bounded wait', () => {
		expect(src).toMatch(/maybePromptHarnessSetup[\s\S]*?timeoutMs:\s*HARNESS_PROMPT_TIMEOUT_MS/);
		expect(src).toMatch(/HARNESS_PROMPT_TIMEOUT_MS = [\d_]+/);
	});

	it('gates the per-launch write on the registry `auto` flag, not a hardcoded name', () => {
		// The prompt offers, and honors a decline for, every `auto` harness; a name
		// pinned at the write would silently ignore a second one's decline - the
		// prompt-contradicts-the-next-step failure the gate exists to prevent.
		const write = mainBody.slice(mainBody.indexOf('agent connects via') - 1500);
		expect(write).toMatch(/HARNESSES\.filter\(\(x\) => x\.auto\)/);
		expect(write).toMatch(/harnessDeclined\(h\.name, WORKSPACE\)/);
		expect(mainBody).not.toMatch(/harnessDeclined\('claude'/);
		// Same registry-driven write as `cellar harness add`, so the two cannot drift.
		expect(write).toMatch(/configureHarness\(h\.name, WORKSPACE\)/);
	});

	it('does not offer a harness `--no-mcp-config` refuses to write', () => {
		// The flag's whole point is that `.mcp.json` is not written; a prompt that
		// wrote it one answer later would contradict it.
		const prompt = src.slice(src.indexOf('async function maybePromptHarnessSetup'));
		expect(prompt).toMatch(/exclude:\s*writeMcpConfigOptIn\s*\?\s*\[\]\s*:\s*HARNESSES\.filter\(\(h\) => h\.auto\)/);
	});

	/**
	 * The ways the question can go unanswered, exercised against the SHIPPED source
	 * of `ask` over fake stdio - a launcher cannot be booted here. All must resolve
	 * the same "no answer" value, which records nothing.
	 */
	describe('gives up rather than stranding the launch', () => {
		const body = src.slice(src.indexOf('function ask('), src.indexOf('function printHelp('));
		const makeAsk = (stdin: any) => {
			const stdout: any = new PassThrough();
			stdout.resume();
			return new Function('createInterface', 'process', `${body}; return ask;`)(createInterface, { stdin, stdout });
		};
		const fakeTty = () => {
			const s: any = new PassThrough();
			s.isTTY = true;
			return s;
		};

		it('still returns a real answer', async () => {
			const stdin = fakeTty();
			const p = makeAsk(stdin)('q? ', { timeoutMs: 5000 });
			stdin.write('codex\n');
			expect(await p).toBe('codex');
			expect(resolveHarnessAnswer(harnessStates(ws), await p).chosen).toEqual(['codex']);
		});

		// A timeout far beyond this test's own budget, so only the close/error handler
		// can be what resolves these - never the timer.
		const NEVER = 10 * 60_000;

		it('a stdin that closes with no answer resolves null, and records nothing', async () => {
			const stdin = fakeTty();
			const p = makeAsk(stdin)('q? ', { timeoutMs: NEVER });
			stdin.end();
			expect(await p).toBeNull();
			expect(resolveHarnessAnswer(harnessStates(ws), await p).record).toBeNull();
		});

		it('a stdin error resolves null', async () => {
			const stdin = fakeTty();
			const p = makeAsk(stdin)('q? ', { timeoutMs: NEVER });
			stdin.emit('error', new Error('EIO'));
			expect(await p).toBeNull();
		});

		it('the timeout fires and skips WITHOUT recording a decline', async () => {
			// A silent stdin must not hold the launch. And the timer must not be unref'd,
			// or the process could fall out from under the prompt instead of giving up.
			const answer = await makeAsk(fakeTty())('q? ', { timeoutMs: 120 });
			expect(answer).toBeNull();
			const { record } = resolveHarnessAnswer(harnessStates(ws), answer);
			expect(record).toBeNull();
			expect(existsSync(harnessMarkerPath(ws))).toBe(false);
			expect(harnessDeclined('claude', ws)).toBe(false);
		});
	});

	/**
	 * The backgrounded `cellar &`, which the timeout above CANNOT cover: reading the
	 * terminal from a background process group raises SIGTTIN, whose default
	 * disposition STOPS the process, and a stopped process runs no timers. Overriding
	 * that with a SIGTTIN listener is measurably worse - the read then fails with
	 * EIO, libuv retries, and the process spins at 100% CPU without reaching either
	 * the JS handler or the timer - so the only fix is not to read at all, which
	 * makes the foreground test the whole mechanism.
	 */
	describe('never reads stdin off the foreground', () => {
		const decide = new Function(
			`${src.slice(src.indexOf('function foregroundFromPs'), src.indexOf('function inForegroundJob'))}; return foregroundFromPs;`
		)();

		it('reads `ps -o pgid=,tpgid=` as foreground / background / unknown', () => {
			// A background job is exactly the case where the two differ - verified on a
			// real pty: `set -m; node … &` reports pgid 78159 vs tpgid 78158 and the
			// process sits in state T.
			expect(decide(' 4242  4242\n')).toBe(true);
			expect(decide(' 78159 78158\n')).toBe(false);
			// No controlling terminal, or a `ps` that reports no tpgid: unknown, which
			// must NOT read as "background" - that would silently kill the prompt for
			// everyone on a platform whose ps differs.
			expect(decide('4242 -1')).toBeNull();
			expect(decide('4242')).toBeNull();
			expect(decide('')).toBeNull();
			expect(decide(undefined)).toBeNull();
			expect(decide('nonsense output')).toBeNull();
		});

		it('skips the prompt only on a PROVEN background job', () => {
			// `=== false` and not a falsy check: unknown must still prompt (behind the
			// timeout), or Windows and any ps without tpgid would never be asked.
			const prompt = src.slice(src.indexOf('async function maybePromptHarnessSetup'));
			expect(prompt).toMatch(/if \(inForegroundJob\(\) === false\) return;/);
			// Skipping records nothing, so the next foreground launch still asks: the
			// only writes below the gate are the ones a real answer reaches.
			const gate = prompt.indexOf('inForegroundJob() === false');
			expect(gate).toBeGreaterThan(-1);
			expect(prompt.slice(0, gate)).not.toMatch(/writeHarnessSetup\(WORKSPACE, record\)/);
		});
	});

	it('still never prompts non-interactively, and records nothing when it does not', () => {
		// A real launch with CI=1: no prompt, no marker, and the launch is unaffected.
		const r = spawnSync(process.execPath, [CLI, 'harness', 'list'], {
			cwd: ws,
			encoding: 'utf8',
			env: { ...process.env, CI: '1' }
		});
		expect(r.status).toBe(0);
		expect(existsSync(harnessMarkerPath(ws))).toBe(false);
		expect(shouldPromptHarnessSetup(ws, { interactive: false })).toMatchObject({ prompt: false, record: false });
	});
});

describe('`cellar harness` CLI verb', () => {
	const run = (args: string[]) =>
		spawnSync(process.execPath, [CLI, ...args], { cwd: ws, encoding: 'utf8', env: { ...process.env, CI: '1' } });

	it('lists supported harnesses with their configured state', () => {
		const before = run(['harness', 'list']);
		expect(before.status).toBe(0);
		expect(before.stdout).toContain('claude');
		expect(before.stdout).toContain('codex');
		expect(before.stdout).toContain('not configured');

		expect(run(['harness', 'add', 'codex']).status).toBe(0);
		const after = run(['harness', 'list']);
		expect(after.stdout).toMatch(/codex\s+configured/);
		expect(after.stdout).toMatch(/claude\s+not configured/);
	});

	it('adds a harness, is idempotent on a second run, and says nothing was duplicated', () => {
		const first = run(['harness', 'add', 'codex']);
		expect(first.status).toBe(0);
		expect(read(codexFile())).toContain('[mcp_servers.cellar]');
		const bytes = read(codexFile());

		const second = run(['harness', 'add', 'codex']);
		expect(second.status).toBe(0);
		expect(second.stdout).toContain('already configured');
		expect(read(codexFile())).toBe(bytes);
	});

	it('says the tools arrive only while cellar is running here', () => {
		// The config is inert on its own: `cellar mcp` bridges to a live instance.
		expect(run(['harness', 'add', 'claude']).stdout).toMatch(/while `cellar` is running/);
	});

	it('configures every harness with `all`', () => {
		expect(run(['harness', 'add', 'all']).status).toBe(0);
		expect(existsSync(claudeFile())).toBe(true);
		expect(existsSync(codexFile())).toBe(true);
	});

	it('honors --workspace so another repo can be configured without cd-ing', () => {
		const other = mkdtempSync(join(tmpdir(), 'cellar-harness-other-'));
		try {
			expect(run(['harness', 'add', 'codex', '--workspace', other]).status).toBe(0);
			expect(existsSync(join(other, '.codex', 'config.toml'))).toBe(true);
			expect(existsSync(codexFile())).toBe(false);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it('exits non-zero on an unknown harness and on a missing name, writing nothing', () => {
		const bad = run(['harness', 'add', 'opencode']);
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain('unknown harness');

		expect(run(['harness', 'add']).status).toBe(1);
		expect(run(['harness', 'frobnicate']).status).toBe(1);
		expect(existsSync(claudeFile())).toBe(false);
		expect(existsSync(codexFile())).toBe(false);
	});

	it('never boots a server: no runtime.json / lock is left behind', () => {
		run(['harness', 'add', 'all']);
		expect(existsSync(join(ws, '.cellar', 'runtime.json'))).toBe(false);
		expect(existsSync(join(ws, '.cellar', 'instance.lock'))).toBe(false);
	});

	it('reports a config it cannot read, and keeps going, instead of crashing', () => {
		mkdirSync(codexFile(), { recursive: true });
		const r = run(['harness', 'add', 'all']);
		// Claude still gets configured: one bad harness does not abort `add all`.
		expect(existsSync(claudeFile())).toBe(true);
		expect(r.stdout + r.stderr).toMatch(/could not be read/);
		expect(r.stderr).not.toMatch(/at .*harness\.js/);
	});

	// A refusal is the registry's job; the WRITE can still fail on the filesystem,
	// and that used to leave the process on an unhandled exception.
	const canDropWrite = process.platform !== 'win32' && process.getuid?.() !== 0;
	it.skipIf(!canDropWrite)('reports a write failure per harness instead of throwing', () => {
		chmodSync(ws, 0o555);
		try {
			const r = run(['harness', 'add', 'all']);
			// Non-zero, so a script can still tell nothing was written…
			expect(r.status).toBe(1);
			// …and every harness is reported in the ordinary one-line shape, not a stack.
			expect(r.stderr).toMatch(/Claude Code: skipped/);
			expect(r.stderr).toMatch(/Codex: skipped/);
			expect(r.stderr).not.toMatch(/^\s+at /m);
		} finally {
			chmodSync(ws, 0o755);
		}
	});

	it('is documented in --help', () => {
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain('cellar harness');
		expect(help.stdout).toContain('harness add codex');
	});
});
