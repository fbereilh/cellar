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
	allowHarness,
	configureHarness,
	defaultAllowedHarnesses,
	disallowHarness,
	getHarness,
	harnessConfigPath,
	harnessMarkerPath,
	harnessNames,
	harnessSetupDone,
	harnessState,
	harnessStates,
	isHarnessAllowed,
	markHarnessPrompted,
	parseHarnessAnswer,
	promptedHarnesses,
	readAllowList,
	readHarnessSetup,
	reconcileHarnesses,
	shouldPromptHarnessSetup,
	stripHarness,
	writeAllowList
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

/** This process's umask, restored immediately - the only way to read it in node. */
const PROCESS_UMASK = (() => {
	const m = process.umask(0o022);
	process.umask(m);
	return m;
})();

/** Line feeds NOT preceded by a carriage return, i.e. the mixed-ending damage. */
function countBare(buf: Buffer) {
	let n = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a && buf[i - 1] !== 0x0d) n++;
	return n;
}

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

describe('writing the user\'s file', () => {
	it('preserves the target\'s permissions across the atomic replace', () => {
		// temp+rename installs a NEW inode, so without carrying the mode over, a
		// `chmod 600` config comes back 0644. These files routinely hold another MCP
		// server's `env` block with an API token, so that is a disclosure.
		configureHarness('claude', ws);
		chmodSync(claudeFile(), 0o600);
		writeFileSync(claudeFile(), JSON.stringify({ mcpServers: { cellar: { command: 'stale' } } }));
		chmodSync(claudeFile(), 0o600);
		expect(configureHarness('claude', ws).status).toBe('updated');
		expect(statSync(claudeFile()).mode & 0o777).toBe(0o600);
	});

	it('tightens the temp BEFORE writing the secret-bearing bytes into it', () => {
		// The temp lives in the TARGET's own directory, so writing first leaves a
		// complete copy of the merged config - another server's `env` block, API token
		// included - readable at the default mode for as long as the write takes. The
		// window is not observable from here, so the ORDER is what is pinned.
		const mod = readFileSync(join(REPO, 'src', 'lib', 'server', 'harness.js'), 'utf8');
		const body = mod.slice(mod.indexOf('function writeFileAtomic'), mod.indexOf('function readConfigText'));
		expect(body.indexOf('fchmodSync(fd, mode)')).toBeGreaterThan(-1);
		expect(body.indexOf('fchmodSync(fd, mode)')).toBeLessThan(body.indexOf('writeFileSync(fd, text)'));
	});

	it('writes a NEW file at the ordinary default, not something exotic', () => {
		configureHarness('claude', ws);
		// Whatever the umask yields; the point is that nothing here narrows or widens
		// a file the user has not got an opinion about yet.
		expect(statSync(claudeFile()).mode & 0o777).toBe(0o666 & ~PROCESS_UMASK);
	});

	it('keeps a CRLF config on CRLF, in both the append and the rewrite path', () => {
		// Emitting LF into a CRLF file leaves mixed endings - a two-line edit that
		// diffs as the whole file, the opposite of what this writer promises.
		const head = 'model = "gpt-5"\r\n\r\n[mcp_servers.serena]\r\ncommand = "uvx"\r\n';
		writeCodex(head);
		expect(configureHarness('codex', ws).status).toBe('wrote');
		let bytes = readFileSync(codexFile());
		expect(bytes.toString().startsWith(head)).toBe(true);
		expect(bytes.includes(Buffer.from('\r\n[mcp_servers.cellar]\r\n'))).toBe(true);
		expect(countBare(bytes)).toBe(0);

		// The rewrite path too: an inserted line must wear the same ending.
		writeCodex(head + '\r\n[mcp_servers.cellar]\r\ncommand = "npx"\r\nargs = ["old"]\r\n');
		expect(configureHarness('codex', ws).status).toBe('updated');
		bytes = readFileSync(codexFile());
		expect(bytes.toString()).toContain('command = "cellar"');
		expect(countBare(bytes)).toBe(0);
	});

	it('leaves an LF config on LF', () => {
		writeCodex('model = "gpt-5"\n');
		configureHarness('codex', ws);
		expect(readFileSync(codexFile()).includes(Buffer.from('\r'))).toBe(false);
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

describe('the allow-list', () => {
	it('starts with the registry defaults, so zero-config works before anything is written', () => {
		// No marker at all - a brand-new workspace behaves exactly as it always did.
		expect(existsSync(harnessMarkerPath(ws))).toBe(false);
		expect(readAllowList(ws)).toEqual(['claude']);
		expect(defaultAllowedHarnesses()).toEqual(['claude']);
		expect(isHarnessAllowed('claude', ws)).toBe(true);
		expect(isHarnessAllowed('codex', ws)).toBe(false);
	});

	it('persists an addition, and survives a fresh read', () => {
		expect(allowHarness('codex', ws)).toEqual({ ok: true, changed: true });
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);
		// Round-trips through the file, not just in memory.
		expect(JSON.parse(read(harnessMarkerPath(ws)))).toMatchObject({ version: 2, allowed: ['claude', 'codex'] });
		// Idempotent: adding again changes nothing.
		expect(allowHarness('codex', ws)).toEqual({ ok: true, changed: false });
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);
	});

	it('persists a REMOVAL of a default harness, which the defaults must not undo', () => {
		// The trap: `readAllowList` falls back to the defaults when no list was ever
		// written, so removing claude has to write an explicit list - otherwise the
		// fallback silently re-adds it on the very next read and `harness remove`
		// would appear to do nothing.
		expect(disallowHarness('claude', ws)).toEqual({ ok: true, changed: true });
		expect(readAllowList(ws)).toEqual([]);
		expect(isHarnessAllowed('claude', ws)).toBe(false);
		expect(disallowHarness('claude', ws)).toEqual({ ok: true, changed: false });
	});

	it('separates CONFIGURED from MANAGED, which the sidebar banner turns on', () => {
		// `harness remove` deliberately leaves the entry in place, so the config can be
		// correct while nothing checks it any more. The "Connect an agent" panel reads
		// exactly these two predicates (`+page.server.js`), and may only promise the
		// every-start repair on the second - asserting a self-heal that will not happen
		// is the defect this split exists to prevent.
		configureHarness('claude', ws);
		expect(harnessState('claude', ws)?.configured).toBe(true);
		expect(isHarnessAllowed('claude', ws)).toBe(true);

		disallowHarness('claude', ws);
		expect(harnessState('claude', ws)?.configured).toBe(true);
		expect(isHarnessAllowed('claude', ws)).toBe(false);
	});

	it('keeps the list in registry order and drops names it does not know', () => {
		writeAllowList(ws, ['codex', 'opencode', 'claude', 'codex']);
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);
	});

	it('preserves the question bookkeeping across an unrelated allow-list write', () => {
		markHarnessPrompted(ws, { at: 1234 });
		allowHarness('codex', ws);
		// Both halves must survive: dropping `promptedFor` would re-open a settled
		// question, and dropping `promptedAt` would re-ask the whole thing.
		expect(readHarnessSetup(ws)).toMatchObject({
			promptedAt: 1234,
			promptedFor: harnessNames(),
			allowed: ['claude', 'codex']
		});
		expect(harnessSetupDone(ws)).toBe(true);
	});

	it('treats a corrupt marker as never written rather than throwing', () => {
		mkdirSync(join(ws, '.cellar'), { recursive: true });
		writeFileSync(harnessMarkerPath(ws), '{ broken');
		expect(readHarnessSetup(ws)).toBeNull();
		expect(harnessSetupDone(ws)).toBe(false);
		// …and falls back to the defaults, so a damaged marker cannot cost zero-config.
		expect(readAllowList(ws)).toEqual(['claude']);
	});

	it('reads a pre-allow-list marker as defaults plus whatever was configured', () => {
		// Never shipped in a release, but a dev machine may hold one. `declined` is
		// deliberately ignored: nothing is declined in this model.
		mkdirSync(join(ws, '.cellar'), { recursive: true });
		writeFileSync(
			harnessMarkerPath(ws),
			JSON.stringify({ version: 1, promptedAt: 5, configured: ['codex'], declined: ['claude'] })
		);
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);
	});
});

describe('reconcile (the every-start self-heal)', () => {
	it('writes an allowed harness that has no config yet', () => {
		const out = reconcileHarnesses(ws);
		expect(out.map((r) => r.name)).toEqual(['claude']);
		expect(out[0].status).toBe('wrote');
		expect(JSON.parse(read(claudeFile())).mcpServers.cellar).toEqual({ command: 'cellar', args: ['mcp'] });
	});

	it('REPAIRS a deleted config on the next start - the point of the model', () => {
		reconcileHarnesses(ws);
		rmSync(claudeFile());
		expect(existsSync(claudeFile())).toBe(false);
		const out = reconcileHarnesses(ws);
		expect(out[0].status).toBe('wrote');
		expect(JSON.parse(read(claudeFile())).mcpServers.cellar).toEqual({ command: 'cellar', args: ['mcp'] });
	});

	it('repairs an entry someone edited to something else', () => {
		writeFileSync(claudeFile(), JSON.stringify({ mcpServers: { cellar: { command: 'nope', args: [] } } }, null, 2));
		expect(reconcileHarnesses(ws)[0].status).toBe('updated');
		expect(JSON.parse(read(claudeFile())).mcpServers.cellar).toEqual({ command: 'cellar', args: ['mcp'] });
	});

	it('writes NOTHING when every allowed config is already correct', () => {
		reconcileHarnesses(ws);
		const mtime = statSync(claudeFile()).mtimeMs;
		expect(reconcileHarnesses(ws)[0].status).toBe('already');
		expect(statSync(claudeFile()).mtimeMs).toBe(mtime);
	});

	it('touches only what is on the list', () => {
		reconcileHarnesses(ws);
		expect(existsSync(codexFile())).toBe(false);
		allowHarness('codex', ws);
		expect(reconcileHarnesses(ws).map((r) => r.name)).toEqual(['claude', 'codex']);
		expect(read(codexFile())).toContain('[mcp_servers.cellar]');
	});

	it('stops reconciling a removed harness, leaving its config alone', () => {
		allowHarness('codex', ws);
		reconcileHarnesses(ws);
		const before = read(codexFile());
		disallowHarness('codex', ws);
		expect(reconcileHarnesses(ws).map((r) => r.name)).toEqual(['claude']);
		// Not managed is not deleted: the entry keeps working until asked otherwise.
		expect(read(codexFile())).toBe(before);
	});

	it('excludes a harness for THIS launch without changing the list', () => {
		allowHarness('codex', ws);
		const out = reconcileHarnesses(ws, { exclude: ['claude'] });
		expect(out.map((r) => r.name)).toEqual(['codex']);
		expect(existsSync(claudeFile())).toBe(false);
		// `--no-mcp-config` is a per-launch refusal, never a durable decision.
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);
	});

	it('never throws: an unwritable config is reported, not raised', () => {
		// A directory where the config should be: the write cannot succeed, and a
		// notebook launch must not fail because of it.
		mkdirSync(claudeFile(), { recursive: true });
		const out = reconcileHarnesses(ws);
		expect(out[0].status).toBe('skipped');
		expect(out[0].message).toBeTruthy();
	});
});

describe('stripHarness (the opt-in destructive half of remove)', () => {
	it('removes the cellar entry from JSON, leaving every other server', () => {
		writeFileSync(
			claudeFile(),
			JSON.stringify(
				{ mcpServers: { playwright: { command: 'npx' }, cellar: { command: 'cellar', args: ['mcp'] } }, other: 1 },
				null,
				2
			) + '\n'
		);
		expect(stripHarness('claude', ws).status).toBe('updated');
		const after = JSON.parse(read(claudeFile()));
		expect(after.mcpServers).toEqual({ playwright: { command: 'npx' } });
		expect(after.other).toBe(1);
	});

	it('removes the cellar TABLE from TOML, leaving every other setting byte-intact', () => {
		const head = '# mine\nmodel = "gpt-5"\n\n[mcp_servers.serena]\ncommand = "uvx"\n';
		writeCodex(head);
		configureHarness('codex', ws);
		expect(read(codexFile())).toContain('[mcp_servers.cellar]');
		expect(stripHarness('codex', ws).status).toBe('updated');
		expect(read(codexFile())).toBe(head);
	});

	it('is a no-op when there is nothing of ours to remove', () => {
		expect(stripHarness('claude', ws).status).toBe('already');
		writeCodex('model = "gpt-5"\n');
		expect(stripHarness('codex', ws).status).toBe('already');
		expect(read(codexFile())).toBe('model = "gpt-5"\n');
	});

	it('refuses a shape Cellar did not write, exactly as the writer refuses it', () => {
		const inline = '[mcp_servers]\ncellar = { command = "cellar", args = ["mcp"] }\n';
		writeCodex(inline);
		const r = stripHarness('codex', ws);
		expect(r.status).toBe('skipped');
		expect(read(codexFile())).toBe(inline);

		writeFileSync(claudeFile(), 'not json');
		expect(stripHarness('claude', ws).status).toBe('skipped');
		expect(read(claudeFile())).toBe('not json');
	});
});

describe('the first-run question can only ADD', () => {
	it('offers only harnesses not already managed', () => {
		const d = shouldPromptHarnessSetup(ws, { interactive: true });
		expect(d).toMatchObject({ prompt: true, reason: 'ask', record: true });
		// claude is already managed, so there is nothing to ask about it.
		expect(d.offered).toEqual(['codex']);
	});

	it('does not ask at all once everything is managed', () => {
		allowHarness('codex', ws);
		expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({
			prompt: false,
			reason: 'nothing-to-offer'
		});
	});

	it('asks once: a recorded promptedAt closes the question', () => {
		expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(true);
		markHarnessPrompted(ws);
		expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({
			prompt: false,
			reason: 'already-asked'
		});
	});

	it('never prompts non-interactively, and records nothing so a human is still asked', () => {
		expect(shouldPromptHarnessSetup(ws, { interactive: false })).toMatchObject({
			prompt: false,
			reason: 'non-interactive',
			record: false
		});
		expect(existsSync(harnessMarkerPath(ws))).toBe(false);
		expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(true);
	});

	it('an ENTER (or any skip) removes nothing - the whole point of the model', () => {
		// The failure this design retired: the most reflexive answer used to record a
		// decline and permanently switch off the zero-config `.mcp.json` write.
		for (const answer of ['', '   ', 'n', 'no', 'none', 'skip']) {
			const { chosen, answered } = parseHarnessAnswer(answer, ['codex']);
			expect(chosen).toEqual([]);
			expect(answered).toBe(true); // a real answer - just not one that adds
			// Nothing in the skip path can take claude off the list.
			expect(readAllowList(ws)).toContain('claude');
		}
		markHarnessPrompted(ws);
		expect(readAllowList(ws)).toEqual(['claude']);
		expect(isHarnessAllowed('claude', ws)).toBe(true);
	});

	it('a NON-answer records nothing, so the question comes back', () => {
		// No answer at all (timeout / closed stdin / background job), and an answer
		// nothing in which resolved, are both "not a decision".
		expect(parseHarnessAnswer(null, ['codex']).answered).toBe(false);
		expect(parseHarnessAnswer(undefined, ['codex']).answered).toBe(false);
		expect(parseHarnessAnswer('opencode zzz', ['codex'])).toMatchObject({ answered: false, unknown: ['opencode', 'zzz'] });
	});

	it('omits an excluded harness from the offer', () => {
		const d = shouldPromptHarnessSetup(ws, { interactive: true, exclude: ['claude'] });
		expect(d.offered).toEqual(['codex']);
		// Excluding an ALREADY-MANAGED harness hides nothing that could have been
		// asked about, so the question can still be closed.
		expect(d.record).toBe(true);
	});

	it('does NOT close the question when the exclusion hid something askable', () => {
		// The trap: recording "asked" over a flag-filtered view suppresses the
		// question forever for a harness this launch never showed. Here codex is not
		// managed and not offered, so nothing may be recorded.
		const d = shouldPromptHarnessSetup(ws, { interactive: true, exclude: ['codex'] });
		expect(d.offered).toEqual([]);
		expect(d.record).toBe(false);
		expect(d.prompt).toBe(false);
		// Unfiltered, it is askable again.
		expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({ prompt: true, record: true });
	});

	/**
	 * The question is settled per HARNESS, which is what keeps a frozen allow-list
	 * from also freezing discovery: the defaults SEED a workspace and are then
	 * authoritative (an allow-list may only grow by an explicit act), so a harness
	 * a later release adds would otherwise be invisible to every workspace that has
	 * already been asked.
	 */
	describe('per-harness coverage', () => {
		it('does not re-ask about a harness the question already showed', () => {
			markHarnessPrompted(ws);
			expect(promptedHarnesses(ws)).toEqual(harnessNames());
			expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({
				prompt: false,
				reason: 'already-asked'
			});
		});

		it('DOES ask about a harness it never showed', () => {
			// A marker written when only claude existed: codex arrived later, so it has
			// never been offered here and is still an open question.
			markHarnessPrompted(ws, { covered: ['claude'] });
			expect(promptedHarnesses(ws)).toEqual(['claude']);
			const d = shouldPromptHarnessSetup(ws, { interactive: true });
			expect(d).toMatchObject({ prompt: true, reason: 'ask', record: true });
			expect(d.offered).toEqual(['codex']);
			// Answering settles it, and the earlier coverage is not lost.
			markHarnessPrompted(ws);
			expect(promptedHarnesses(ws)).toEqual(harnessNames());
			expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(false);
		});

		it('reads a marker with no promptedFor as having covered everything', () => {
			// Absent means "everything registered when it was written" - an upgrade must
			// not re-ask about harnesses the user has already been shown.
			mkdirSync(join(ws, '.cellar'), { recursive: true });
			writeFileSync(harnessMarkerPath(ws), JSON.stringify({ version: 2, promptedAt: 7, allowed: ['claude'] }));
			expect(promptedHarnesses(ws)).toEqual(harnessNames());
			expect(harnessSetupDone(ws)).toBe(true);
			expect(shouldPromptHarnessSetup(ws, { interactive: true }).prompt).toBe(false);
		});

		it('does not offer back a harness the user explicitly REMOVED', () => {
			// `harness remove claude` before the first interactive launch leaves an empty
			// allow-list and no `promptedAt`, so without recording the removal the next
			// start offered to add back exactly what was just taken away.
			disallowHarness('claude', ws);
			expect(promptedHarnesses(ws)).toEqual(['claude']);
			const d = shouldPromptHarnessSetup(ws, { interactive: true });
			expect(d.offered).toEqual(['codex']);
			expect(d.prompt).toBe(true);
			// …and it is recorded per harness, never by stamping `promptedAt`, which
			// would close the question for codex too.
			expect(readHarnessSetup(ws)?.promptedAt).toBeUndefined();
			expect(harnessSetupDone(ws)).toBe(false);
		});

		it('leaves a removal recorded even when the list was already without it', () => {
			// A removal run twice, or one predating this record, is the same explicit
			// answer - so the second call still settles the question rather than leaving
			// it open forever.
			writeAllowList(ws, []);
			expect(disallowHarness('claude', ws)).toEqual({ ok: true, changed: false });
			expect(promptedHarnesses(ws)).toEqual(['claude']);
			// Now genuinely nothing left to do, and no further write.
			const before = read(harnessMarkerPath(ws));
			expect(disallowHarness('claude', ws)).toEqual({ ok: true, changed: false });
			expect(read(harnessMarkerPath(ws))).toBe(before);
		});

		it('separates "already asked" from "nothing left to offer"', () => {
			// Managing every harness settles the question without it ever being asked -
			// a different fact, and the launcher's own copy turns on it.
			allowHarness('codex', ws);
			expect(promptedHarnesses(ws)).toEqual([]);
			expect(shouldPromptHarnessSetup(ws, { interactive: true })).toMatchObject({
				prompt: false,
				reason: 'nothing-to-offer'
			});
		});
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

	it('classifies all THREE token classes apart', () => {
		// The prompt names the already-managed harnesses one line above the question,
		// so typing one is the natural reply: it is understood and needs no write,
		// which is neither an addition nor an unrecognized token.
		const r = parseHarnessAnswer('codex claude opencode', ['codex'], { managed: ['claude'] });
		expect(r.chosen).toEqual(['codex']);
		expect(r.managed).toEqual(['claude']);
		expect(r.unknown).toEqual(['opencode']);
	});

	it('counts an ALREADY-MANAGED reply as a real answer with nothing to write', () => {
		// It must settle the question rather than reading as "nothing recognized" and
		// coming back on every later launch - and it must not be reported as a choice,
		// or the caller would write a config it was never asked to touch.
		const r = parseHarnessAnswer('claude', ['codex'], { managed: ['claude'] });
		expect(r).toMatchObject({ chosen: [], managed: ['claude'], unknown: [], answered: true, skipped: true });
	});

	it('still calls a name unrecognized when it is not a harness at all', () => {
		expect(parseHarnessAnswer('claude', ['codex'])).toMatchObject({ managed: [], unknown: ['claude'] });
		expect(parseHarnessAnswer('opencode', ['codex'], { managed: ['claude'] })).toMatchObject({
			managed: [],
			unknown: ['opencode'],
			answered: false
		});
	});
});

/**
 * What one prompt answer RECORDS. The marker outlives the launch and silently
 * gates the launcher's automatic `.mcp.json` write, so a wrong entry here has no
 * symptom in the run that wrote it - only later, as a write that never happens
 * again and a decline the user never made.
 */

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

	it('RECONCILES the allow-list on every launch, rather than writing one fixed harness', () => {
		// The launch-path write is the self-heal: whatever the workspace allows gets
		// checked and repaired every start. A hardcoded harness here would both miss a
		// second one and turn the allow-list back into a one-off write.
		expect(mainBody).toMatch(/reconcileHarnesses\(WORKSPACE, \{ exclude: mcpConfigExcluded\(\) \}\)/);
		expect(mainBody).not.toMatch(/configureHarness\('claude'/);
		// The exclusion is derived from the FILE the flag names, not a pinned name.
		expect(src).toMatch(/h\.configPath === MCP_JSON_CONFIG_PATH/);
	});

	it('catches per harness at EVERY configureHarness call site', () => {
		// A write can still fail on the filesystem (read-only workspace, ENOSPC,
		// EACCES on `.codex/`) after the registry has agreed to edit. Unguarded, the
		// prompt's own loop throws past `writeHarnessSetup` into the outer catch, so
		// a successful SIBLING write goes unrecorded and the answer is discarded -
		// the question then comes back on every later interactive launch.
		const sites = [...src.matchAll(/configureHarness\(/g)].map((m) => m.index as number);
		expect(sites.length).toBeGreaterThanOrEqual(2);
		for (const at of sites) {
			// The nearest preceding block opener must be a `try {`, and a `catch` must
			// follow before the next site - the one-line-shape guard the verb uses.
			const before = src.slice(Math.max(0, at - 400), at);
			expect(before).toMatch(/try\s*\{[^{}]*$/);
			expect(src.slice(at, at + 2000)).toMatch(/\}\s*catch\s*\(/);
		}
	});

	it('records the prompt answer even when a chosen harness fails to write', () => {
		// The marker write must not sit downstream of an unguarded throw.
		const prompt = src.slice(src.indexOf('async function maybePromptHarnessSetup'));
		const loop = prompt.indexOf('for (const name of chosen)');
		const marker = prompt.indexOf('markHarnessPrompted(WORKSPACE)');
		expect(loop).toBeGreaterThan(-1);
		expect(marker).toBeGreaterThan(loop);
		expect(prompt.slice(loop, marker)).toMatch(/\}\s*catch\s*\(/);
	});

	it('records the allow-list BEFORE writing the config it chose', () => {
		// Same rule as the `harness add` verb, and it matters more here: the marker
		// below closes the question, so a write that throws after the allow-list would
		// lose the user's explicit "wire up Codex" for good - the every-start reconcile
		// cannot repair what was never recorded.
		const loop = src.slice(
			src.indexOf('for (const name of chosen)'),
			src.indexOf('if (wrote) console.log', src.indexOf('for (const name of chosen)'))
		);
		expect(loop.indexOf('allowHarness(name, WORKSPACE)')).toBeGreaterThan(-1);
		expect(loop.indexOf('allowHarness(name, WORKSPACE)')).toBeLessThan(loop.indexOf('configureHarness(name, WORKSPACE)'));
	});

	it('never REMOVES from the allow-list anywhere in the prompt', () => {
		// The invariant the whole redesign rests on: an answer - or the absence of one
		// - can only ever add. Nothing on this path may call the removal API.
		const prompt = src.slice(
			src.indexOf('async function maybePromptHarnessSetup'),
			src.indexOf('function mcpConfigExcluded')
		);
		expect(prompt).toMatch(/allowHarness\(name, WORKSPACE\)/);
		expect(prompt).not.toMatch(/disallowHarness|writeAllowList/);
	});

	it('does not offer a harness `--no-mcp-config` refuses to write', () => {
		// The flag's whole point is that `.mcp.json` is not written; a prompt that
		// wrote it one answer later would contradict it. One shared helper feeds both
		// the offer and the launch reconcile, so the two cannot disagree.
		const prompt = src.slice(src.indexOf('async function maybePromptHarnessSetup'));
		expect(prompt).toMatch(/exclude:\s*mcpConfigExcluded\(\)/);
		expect(src).toMatch(/function mcpConfigExcluded\(\)/);
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
			expect(parseHarnessAnswer(await p, ['codex']).chosen).toEqual(['codex']);
		});

		// A timeout far beyond this test's own budget, so only the close/error handler
		// can be what resolves these - never the timer.
		const NEVER = 10 * 60_000;

		it('a stdin that closes with no answer resolves null, and records nothing', async () => {
			const stdin = fakeTty();
			const p = makeAsk(stdin)('q? ', { timeoutMs: NEVER });
			stdin.end();
			expect(await p).toBeNull();
			expect(parseHarnessAnswer(await p, ['codex']).answered).toBe(false);
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
			expect(parseHarnessAnswer(answer, ['codex']).answered).toBe(false);
			expect(existsSync(harnessMarkerPath(ws))).toBe(false);
			// And - the invariant - a timeout takes nothing away.
			expect(isHarnessAllowed('claude', ws)).toBe(true);
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
			expect(prompt.slice(0, gate)).not.toMatch(/markHarnessPrompted\(WORKSPACE\)/);
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

	it('lists each harness with BOTH facts: managed here, and configured right now', () => {
		// They are independent, and the gap between them is the interesting state: a
		// managed harness whose config is missing is exactly what the next start
		// repairs. A list showing only one of them could not say that.
		const before = run(['harness', 'list']);
		expect(before.status).toBe(0);
		// Claude Code is managed by default, before anything has been written.
		expect(before.stdout).toMatch(/claude\s+managed\s+not configured/);
		expect(before.stdout).toMatch(/codex\s+not managed\s+not configured/);

		expect(run(['harness', 'add', 'codex']).status).toBe(0);
		expect(run(['harness', 'list']).stdout).toMatch(/codex\s+managed\s+configured/);
	});

	it('add/remove move a harness in and out of the managed set', () => {
		expect(run(['harness', 'add', 'codex']).status).toBe(0);
		expect(read(codexFile())).toContain('[mcp_servers.cellar]');
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);

		const removed = run(['harness', 'remove', 'codex']);
		expect(removed.status).toBe(0);
		expect(removed.stdout).toMatch(/no longer managed/);
		expect(readAllowList(ws)).toEqual(['claude']);
		// Removing does not delete: the entry keeps working until `--strip`.
		expect(read(codexFile())).toContain('[mcp_servers.cellar]');
		expect(run(['harness', 'list']).stdout).toMatch(/codex\s+not managed\s+configured/);

		const stripped = run(['harness', 'remove', 'codex', '--strip']);
		expect(stripped.status).toBe(0);
		expect(read(codexFile())).not.toContain('[mcp_servers.cellar]');
	});

	it('can stop managing the default harness, and that sticks', () => {
		expect(run(['harness', 'remove', 'claude']).status).toBe(0);
		expect(readAllowList(ws)).toEqual([]);
		// The defaults must not quietly put it back on the next read.
		expect(run(['harness', 'list']).stdout).toMatch(/claude\s+not managed/);
	});

	it('exits non-zero when the registry REFUSES the write', () => {
		// `skipped` is not success: a scripted `add` that configured nothing must say
		// so, or `add all` reports 0 having done nothing.
		writeFileSync(claudeFile(), 'not json');
		const r = run(['harness', 'add', 'claude']);
		expect(r.status).toBe(1);
		// And it SAYS it refused, in the status word - not only inside the explanation.
		expect(r.stdout + r.stderr).toMatch(/skipped:/);
		expect(read(claudeFile())).toBe('not json');
	});

	it('still MANAGES a harness whose config write failed, so a later start repairs it', () => {
		// The allow-list is the standing instruction and the write is only its first
		// reconcile, so the instruction must be recorded FIRST. Ordered the other way
		// a filesystem failure (here: `.codex` is a regular file, so mkdir throws
		// EEXIST) drops the user's explicit "manage this" on the floor - nothing
		// recorded, so no later start repairs it either.
		writeFileSync(join(ws, '.codex'), 'in the way');
		const r = run(['harness', 'add', 'codex']);
		expect(r.status).toBe(1);
		expect(r.stdout + r.stderr).toMatch(/skipped/);
		expect(readAllowList(ws)).toEqual(['claude', 'codex']);

		// Clear the obstruction: the next start's reconcile now writes what the
		// failed `add` could not, with nothing more asked of the user.
		rmSync(join(ws, '.codex'));
		expect(reconcileHarnesses(ws).find((x) => x.name === 'codex')?.status).toBe('wrote');
		expect(read(codexFile())).toContain('[mcp_servers.cellar]');
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

	it('repairs a deleted config the way a real start does, over the real CLI', () => {
		// The unit-level reconcile is proven above; this pins that the SHIPPED launch
		// path is the one wired to it - `cellar harness add` and the launch reconcile
		// must not drift into two different repair rules.
		expect(run(['harness', 'add', 'claude']).status).toBe(0);
		rmSync(claudeFile());
		// The launcher's own reconcile, invoked exactly as `main()` invokes it.
		reconcileHarnesses(ws);
		expect(JSON.parse(read(claudeFile())).mcpServers.cellar).toEqual({ command: 'cellar', args: ['mcp'] });
		expect(run(['harness', 'list']).stdout).toMatch(/claude\s+managed\s+configured/);
	});

	it('is documented in --help', () => {
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain('cellar harness');
		expect(help.stdout).toContain('harness add codex');
		expect(help.stdout).toMatch(/remove <name/);
		// The self-heal is the model; a user reading --help should learn it there.
		expect(help.stdout).toMatch(/repaired on\s*\n?\s*every start/);
	});
});
