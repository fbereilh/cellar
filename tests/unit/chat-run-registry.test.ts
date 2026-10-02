/**
 * The out-of-process chat-run registry: an app that dies WITHOUT running a
 * handler (a crash, an OOM kill, a SIGKILL) must not orphan its chat tree for
 * good - and the sweep that reaps such a tree must never signal anything that is
 * not provably that tree.
 *
 * ## What was wrong
 *
 * A chat child leads a process group (and session) of its own, so Stop can reach
 * everything the CLI started. The in-process routes that stop it on the way out
 * are all HANDLERS, and the in-process registry dies with the app, so an app that
 * left without running one left the tree running in a session nothing would ever
 * signal - and nothing on disk said it was there.
 *
 * ## The risk this suite is mostly about
 *
 * Reaping by a recorded group id is dangerous: once the leader is gone the OS
 * may hand its pid - and with it the group id - to an unrelated process, and
 * `kill(-pgid)` would take down that unrelated tree. So the impostor cases here
 * are the load-bearing ones, and they assert that the impostor was NEVER EVEN
 * SIGNALLED (it records any SIGTERM it receives), not merely that it survived:
 * survival alone cannot tell "not signalled" from "signalled and ignored".
 *
 * Everything is a REAL process: the whole question is what a signal reaches, so
 * a mocked `process.kill` could see it in neither direction.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	chatRunDecision,
	chatRunsDir,
	findOrphanChatRuns,
	forgetChatRun,
	listChatRuns,
	pruneDeadChatRuns,
	reapChatRun,
	reapOrphanChatRuns,
	recordChatRun
} from '../../src/lib/server/chat-run-registry';
import { processStartTime } from '../../src/lib/server/instances';
import { claudeCliEngine } from '../../src/lib/server/chat/claude-cli';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(REPO, 'bin', 'cellar.js');
const REGISTRY = join(REPO, 'src', 'lib', 'server', 'chat-run-registry.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ROOT: string;
let DIR: string;
const savedDir = process.env.CELLAR_CHAT_RUNS_DIR;
const savedPath = process.env.PATH;
/** Every pid a case started, so one failing case can never leave a process behind. */
const started: number[] = [];
/** Every child handle, so node reaps them (a zombie would read as alive). */
const handles: ChildProcess[] = [];

beforeAll(() => {
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-chat-runs-'));
});

afterAll(() => {
	if (savedDir === undefined) delete process.env.CELLAR_CHAT_RUNS_DIR;
	else process.env.CELLAR_CHAT_RUNS_DIR = savedDir;
	process.env.PATH = savedPath;
	rmSync(ROOT, { recursive: true, force: true });
});

let caseN = 0;
function freshDir(): string {
	DIR = join(ROOT, `case-${++caseN}`);
	mkdirSync(DIR, { recursive: true });
	process.env.CELLAR_CHAT_RUNS_DIR = DIR;
	return DIR;
}

afterEach(() => {
	process.env.PATH = savedPath;
	for (const pid of started.splice(0)) {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			/* not a group leader, or gone */
		}
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	}
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === 'EPERM';
	}
};

async function until(pred: () => boolean, ms = 8_000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return true;
		await sleep(25);
	}
	return pred();
}

async function readPid(file: string): Promise<number> {
	await until(() => existsSync(file) && Number(readFileSync(file, 'utf8').trim()) > 0, 5_000);
	const pid = Number(readFileSync(file, 'utf8').trim());
	started.push(pid);
	return pid;
}

/**
 * A REAL process group shaped like a chat run: a leader (its pid IS the group
 * id, because it is spawned `detached`) with a long-lived descendant.
 * `leaderScript` lets a case make the leader (and what it starts) ignore SIGTERM.
 */
async function spawnGroup(opts: { leaderIgnoresTerm?: boolean; descendantIgnoresTerm?: boolean } = {}) {
	const gcFile = join(ROOT, `gc-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`);
	const descendant = opts.descendantIgnoresTerm ? `(trap '' TERM; exec sleep 600)` : 'sleep 600';
	const script = [opts.leaderIgnoresTerm ? `trap '' TERM;` : '', `${descendant} & echo $! > ${gcFile}; wait`].join(' ');
	const leader = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
	handles.push(leader);
	started.push(leader.pid!);
	const descendantPid = await readPid(gcFile);
	return { leader: leader.pid!, leaderStart: processStartTime(leader.pid!)!, descendant: descendantPid };
}

/** A pid that WAS a real process and is now provably dead, with its real start time. */
async function deadProcess(): Promise<{ pid: number; start: number }> {
	const p = spawn('sleep', ['60'], { stdio: 'ignore' });
	const pid = p.pid!;
	await until(() => processStartTime(pid) != null, 2_000);
	const start = processStartTime(pid)!;
	const exited = new Promise((r) => p.once('exit', r));
	p.kill('SIGKILL');
	await exited;
	return { pid, start };
}

/**
 * An UNRELATED process that holds a pid a record names: a group leader of its
 * own that writes down every SIGTERM/SIGHUP it receives instead of dying. If the
 * reaper ever signals it, the marker says so.
 */
async function spawnImpostor(): Promise<{ pid: number; start: number; marker: string }> {
	const marker = join(ROOT, `impostor-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
	writeFileSync(marker, '');
	const code = `
		const fs = require('fs');
		for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(s, () => fs.appendFileSync(${JSON.stringify(marker)}, s + '\\n'));
		setInterval(() => {}, 1e6);
	`;
	const p = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
	handles.push(p);
	started.push(p.pid!);
	await until(() => processStartTime(p.pid!) != null, 2_000);
	await sleep(150); // let it install its handlers before anything could signal it
	return { pid: p.pid!, start: processStartTime(p.pid!)!, marker };
}

function writeRecord(record: Record<string, unknown>, name = `${record.pgid}-test.json`): string {
	const path = join(DIR, name);
	writeFileSync(path, JSON.stringify(record));
	return path;
}

describe('recording a chat process group', () => {
	it('writes a record naming the group, its leader start, and this process as the owner', async () => {
		freshDir();
		const g = await spawnGroup();
		const path = recordChatRun(g.leader, { notebook: '/ws/a.ipynb' });
		expect(path).toBeTruthy();
		expect(path!.startsWith(DIR)).toBe(true);
		const rec = JSON.parse(readFileSync(path!, 'utf8'));
		expect(rec.pgid).toBe(g.leader);
		expect(rec.leaderStart).toBe(g.leaderStart);
		expect(rec.ownerPid).toBe(process.pid);
		expect(rec.ownerStart).toBe(processStartTime(process.pid));
		expect(rec.notebook).toBe('/ws/a.ipynb');
		// Durable: another process listing the same directory sees exactly it.
		expect(listChatRuns().map((e) => e.path)).toEqual([path]);

		forgetChatRun(path);
		expect(existsSync(path!)).toBe(false);
		expect(listChatRuns()).toEqual([]);
	});

	it('records nothing in isolated mode - that mode never touches the shared state', async () => {
		freshDir();
		const g = await spawnGroup();
		expect(recordChatRun(g.leader, { env: { ...process.env, CELLAR_ISOLATED: '1' } })).toBeNull();
		expect(readdirSync(DIR)).toEqual([]);
	});

	it('records nothing it could never verify later (no start time, no usable pid)', async () => {
		freshDir();
		const dead = await deadProcess();
		expect(recordChatRun(dead.pid)).toBeNull();
		expect(recordChatRun(undefined)).toBeNull();
		expect(recordChatRun(0)).toBeNull();
		expect(recordChatRun(1)).toBeNull();
		expect(readdirSync(DIR)).toEqual([]);
	});

	it('defaults to ~/.cellar/chat-runs and honours the override', () => {
		expect(chatRunsDir({ HOME: '/home/x' } as NodeJS.ProcessEnv)).toMatch(/\.cellar[/\\]chat-runs$/);
		expect(chatRunsDir({ CELLAR_CHAT_RUNS_DIR: '/tmp/somewhere' } as NodeJS.ProcessEnv)).toBe('/tmp/somewhere');
	});
});

describe('reaping: what may be signalled', () => {
	it('reaps an orphan: owner gone, leader provably the one recorded - leader AND descendant die', async () => {
		freshDir();
		const owner = await deadProcess();
		const g = await spawnGroup();
		const path = writeRecord({ pgid: g.leader, leaderStart: g.leaderStart, ownerPid: owner.pid, ownerStart: owner.start });

		expect(chatRunDecision(JSON.parse(readFileSync(path, 'utf8'))).action).toBe('reap');
		const logs: string[] = [];
		const { reaped, pruned } = await reapOrphanChatRuns({ log: (m) => logs.push(m) });

		expect(reaped.map((r) => r.pgid)).toEqual([g.leader]);
		expect(pruned).toBe(0);
		expect(await until(() => !alive(g.leader))).toBe(true);
		// The descendant is the reason the GROUP is signalled rather than the pid.
		expect(await until(() => !alive(g.descendant))).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(logs.join('\n')).toMatch(/orphaned/);
	});

	it('NEVER touches a live run: an owner that is provably running wins over everything', async () => {
		freshDir();
		const g = await spawnGroup();
		// This very process is the owner, and it is alive.
		const path = recordChatRun(g.leader)!;
		expect(chatRunDecision(JSON.parse(readFileSync(path, 'utf8'))).action).toBe('live');

		const { reaped, pruned } = await reapOrphanChatRuns();
		expect(reaped).toEqual([]);
		expect(pruned).toBe(0);
		expect(alive(g.leader)).toBe(true);
		expect(alive(g.descendant)).toBe(true);
		expect(existsSync(path)).toBe(true); // kept: it still describes a live run
		expect(findOrphanChatRuns()).toEqual([]);
	});

	it('an owner whose pid now belongs to a DIFFERENT process counts as gone', async () => {
		freshDir();
		const g = await spawnGroup();
		const other = await spawnImpostor();
		// The owner pid is alive, but it started at another time: it is not our app.
		const path = writeRecord({ pgid: g.leader, leaderStart: g.leaderStart, ownerPid: other.pid, ownerStart: other.start - 3_600_000 });
		expect(chatRunDecision(JSON.parse(readFileSync(path, 'utf8'))).action).toBe('reap');
		await reapOrphanChatRuns();
		expect(await until(() => !alive(g.leader))).toBe(true);
		// ...and the process that merely holds the owner's old pid is left alone.
		expect(alive(other.pid)).toBe(true);
		expect(readFileSync(other.marker, 'utf8')).toBe('');
	});

	it('PID REUSE: a group id now held by an unrelated process is NEVER signalled', async () => {
		freshDir();
		const owner = await deadProcess();
		// The recorded leader died and the OS handed its pid to this unrelated
		// process, which leads a group of its own - so `kill(-pgid)` WOULD reach it.
		// The recorded start is the real run's; the impostor necessarily started later.
		const impostor = await spawnImpostor();
		const path = writeRecord({ pgid: impostor.pid, leaderStart: impostor.start - 60_000, ownerPid: owner.pid, ownerStart: owner.start });

		const decision = chatRunDecision(JSON.parse(readFileSync(path, 'utf8')));
		expect(decision.action).toBe('prune');
		expect(decision.reason).toMatch(/pid reused/);

		const logs: string[] = [];
		const { reaped, pruned } = await reapOrphanChatRuns({ log: (m) => logs.push(m) });
		expect(reaped).toEqual([]);
		expect(pruned).toBe(1);
		await sleep(300); // give a wrongly-sent signal time to land
		expect(alive(impostor.pid)).toBe(true);
		// Not merely survived: never SIGNALLED at all.
		expect(readFileSync(impostor.marker, 'utf8')).toBe('');
		expect(existsSync(path)).toBe(false); // the stale record is dropped
		expect(logs.join('\n')).toMatch(/nothing signalled/);
	});

	it('PID REUSE: a reused pid just past the identity window is still refused', async () => {
		freshDir();
		const owner = await deadProcess();
		const impostor = await spawnImpostor();
		// The identity check tolerates 2s of skew; a start 5s away is not a match.
		writeRecord({ pgid: impostor.pid, leaderStart: impostor.start - 5_000, ownerPid: owner.pid, ownerStart: owner.start });
		await reapOrphanChatRuns();
		await sleep(300);
		expect(alive(impostor.pid)).toBe(true);
		expect(readFileSync(impostor.marker, 'utf8')).toBe('');
	});

	it('prunes, without a signal, a record whose leader has simply exited', async () => {
		freshDir();
		const owner = await deadProcess();
		const leader = await deadProcess();
		const path = writeRecord({ pgid: leader.pid, leaderStart: leader.start, ownerPid: owner.pid, ownerStart: owner.start });
		expect(chatRunDecision(JSON.parse(readFileSync(path, 'utf8')))).toMatchObject({ action: 'prune' });
		expect(pruneDeadChatRuns()).toBe(1);
		expect(existsSync(path)).toBe(false);
	});

	it('keeps the record and signals nothing when the OWNER cannot be verified', async () => {
		freshDir();
		const g = await spawnGroup();
		const owner = await spawnImpostor(); // alive - only its identity is unknowable
		const path = writeRecord({ pgid: g.leader, leaderStart: g.leaderStart, ownerPid: owner.pid, ownerStart: owner.start });

		// `ps` answers for every pid EXCEPT the owner's. The leader is therefore
		// perfectly verifiable - which is exactly what makes this case bite: an owner
		// that might still be running must keep its run alive even though the group
		// itself could be proven ours and killed.
		const shim = mkdtempSync(join(ROOT, 'ps-shim-'));
		writeFileSync(
			join(shim, 'ps'),
			`#!/bin/sh\nfor a in "$@"; do [ "$a" = "${owner.pid}" ] && exit 1; done\nexec /bin/ps "$@"\n`
		);
		chmodSync(join(shim, 'ps'), 0o755);
		process.env.PATH = `${shim}:${savedPath}`;
		expect(processStartTime(g.leader)).toBe(g.leaderStart);
		expect(processStartTime(owner.pid)).toBeNull();

		const r = await reapChatRun({ path, record: JSON.parse(readFileSync(path, 'utf8')) });
		expect(r.action).toBe('keep');
		expect(r.signalled).toBe(false);
		expect(existsSync(path)).toBe(true); // a later sweep, with ps, can decide
		await sleep(300);
		expect(alive(g.leader)).toBe(true);
		expect(alive(g.descendant)).toBe(true);
		expect(readFileSync(owner.marker, 'utf8')).toBe('');
	});

	it('keeps the record and signals nothing when the LEADER cannot be verified', async () => {
		freshDir();
		const owner = await deadProcess();
		const g = await spawnGroup();
		const path = writeRecord({ pgid: g.leader, leaderStart: g.leaderStart, ownerPid: owner.pid, ownerStart: owner.start });
		const shim = mkdtempSync(join(ROOT, 'ps-shim-'));
		writeFileSync(join(shim, 'ps'), '#!/bin/sh\nexit 1\n');
		chmodSync(join(shim, 'ps'), 0o755);
		process.env.PATH = `${shim}:${savedPath}`;

		const r = await reapChatRun({ path, record: JSON.parse(readFileSync(path, 'utf8')) });
		expect(r).toMatchObject({ action: 'keep', signalled: false });
		expect(existsSync(path)).toBe(true);
		await sleep(300);
		expect(alive(g.leader)).toBe(true);
		expect(alive(g.descendant)).toBe(true);
	});

	it('acts on nothing a record cannot prove - a malformed one is pruned, never signalled', async () => {
		freshDir();
		const impostor = await spawnImpostor();
		const bad = [
			writeRecord({ pgid: impostor.pid }, 'a.json'), // no identity at all
			writeRecord({ pgid: impostor.pid, leaderStart: impostor.start, ownerPid: 'x', ownerStart: 1 }, 'b.json')
		];
		writeFileSync(join(DIR, 'c.json'), '{ not json');
		const n = pruneDeadChatRuns();
		expect(n).toBe(3);
		for (const p of bad) expect(existsSync(p)).toBe(false);
		await sleep(200);
		expect(readFileSync(impostor.marker, 'utf8')).toBe('');
	});
});

describe('reaping: the escalation re-checks identity before SIGKILL', () => {
	it('a leader that ignores SIGTERM is SIGKILLed while it is still provably ours', async () => {
		freshDir();
		const owner = await deadProcess();
		const g = await spawnGroup({ leaderIgnoresTerm: true });
		writeRecord({ pgid: g.leader, leaderStart: g.leaderStart, ownerPid: owner.pid, ownerStart: owner.start });

		const t0 = Date.now();
		await reapOrphanChatRuns({ graceMs: 400 });
		expect(Date.now() - t0).toBeGreaterThanOrEqual(400); // it really waited out the SIGTERM
		expect(await until(() => !alive(g.leader) && !alive(g.descendant))).toBe(true);
	});

	it('once the leader is gone, a surviving descendant is NOT SIGKILLed - no identity is left to match', async () => {
		freshDir();
		const owner = await deadProcess();
		// The leader dies on SIGTERM; the descendant ignores it. After the grace the
		// group still has a member, but the only identity we ever recorded - the
		// leader - is gone, so escalating would be signalling a bare group id.
		const g = await spawnGroup({ descendantIgnoresTerm: true });
		const logs: string[] = [];
		writeRecord({ pgid: g.leader, leaderStart: g.leaderStart, ownerPid: owner.pid, ownerStart: owner.start });
		await reapOrphanChatRuns({ graceMs: 400, log: (m) => logs.push(m) });

		expect(await until(() => !alive(g.leader), 3_000)).toBe(true);
		expect(alive(g.descendant)).toBe(true);
		expect(logs.join('\n')).toMatch(/not signalled/);
	});
});

// ---------------------------------------------------------------------------
// The engine: every real chat run is recorded, and the record lives exactly as
// long as the leader does.

describe('the chat engine records its process group', () => {
	let BIN: string;

	const SAFE_INIT = JSON.stringify({
		type: 'system',
		subtype: 'init',
		tools: [],
		mcp_servers: [],
		slash_commands: [],
		skills: [],
		claude_code_version: '9.9.9-stub'
	});
	const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi' });

	/** A stub `claude`, keyed by MODE so concurrent cases never rewrite a running script. */
	function stub(mode: 'finish' | 'hang' | 'hang-ignoring-term', pidDir: string): void {
		const lines = ['#!/bin/sh', `echo $$ > ${pidDir}/leader.pid`, 'cat > /dev/null', `echo '${SAFE_INIT}'`];
		if (mode === 'finish') lines.push(`echo '${RESULT}'`, 'exit 0');
		else {
			if (mode === 'hang-ignoring-term') lines.push(`trap '' TERM`);
			lines.push('sleep 600 & wait');
		}
		writeFileSync(join(BIN, 'claude'), lines.join('\n') + '\n');
		chmodSync(join(BIN, 'claude'), 0o755);
	}

	function run(signal: AbortSignal) {
		return claudeCliEngine.run({ prompt: 'hi\n', configDir: null, notebookPath: '/ws/n.ipynb', signal, onDelta: () => {} });
	}

	it('a normal run leaves no record behind once its leader has exited', async () => {
		freshDir();
		BIN = mkdtempSync(join(ROOT, 'bin-'));
		const pids = mkdtempSync(join(ROOT, 'pids-'));
		stub('finish', pids);
		process.env.PATH = `${BIN}:${savedPath}`;

		const res = await run(new AbortController().signal);
		expect(res.ok).toBe(true);
		const leader = await readPid(join(pids, 'leader.pid'));
		// Gone once the leader is: start and stop are untouched, and nothing leaks.
		expect(await until(() => listChatRuns().length === 0, 3_000)).toBe(true);
		expect(alive(leader)).toBe(false);
	});

	it('the record names THIS run: its leader as the group, this process as the owner', async () => {
		freshDir();
		BIN = mkdtempSync(join(ROOT, 'bin-'));
		const pids = mkdtempSync(join(ROOT, 'pids-'));
		stub('hang', pids);
		process.env.PATH = `${BIN}:${savedPath}`;

		const ctrl = new AbortController();
		const pending = run(ctrl.signal);
		const leader = await readPid(join(pids, 'leader.pid'));
		expect(await until(() => listChatRuns().length === 1, 3_000)).toBe(true);
		const [{ record }] = listChatRuns();
		expect(record).toMatchObject({ pgid: leader, ownerPid: process.pid, notebook: '/ws/n.ipynb' });
		expect(record.leaderStart).toBe(processStartTime(leader));
		// A live run is exactly what a sweep must leave alone.
		expect(chatRunDecision(record).action).toBe('live');

		ctrl.abort();
		const res = await pending;
		expect(res.failure?.kind).toBe('cancelled');
		expect(await until(() => listChatRuns().length === 0, 5_000)).toBe(true);
	});

	it('a stop that settles before the leader dies KEEPS the record until the leader is gone', async () => {
		freshDir();
		BIN = mkdtempSync(join(ROOT, 'bin-'));
		const pids = mkdtempSync(join(ROOT, 'pids-'));
		stub('hang-ignoring-term', pids);
		process.env.PATH = `${BIN}:${savedPath}`;

		const ctrl = new AbortController();
		const pending = run(ctrl.signal);
		const leader = await readPid(join(pids, 'leader.pid'));
		expect(await until(() => listChatRuns().length === 1, 3_000)).toBe(true);

		ctrl.abort();
		const res = await pending; // settles on the verdict, promptly
		expect(res.failure?.kind).toBe('cancelled');
		// The leader shrugged off the SIGTERM, so it is still running - and still
		// recorded. Dropping the record at settle would leave exactly this process
		// unfindable if the app died now.
		expect(alive(leader)).toBe(true);
		expect(listChatRuns()).toHaveLength(1);
		// The engine's own 3s SIGKILL ends it, and only then does the record go.
		expect(await until(() => !alive(leader), 6_000)).toBe(true);
		expect(await until(() => listChatRuns().length === 0, 2_000)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The headline: an app killed with SIGKILL - so no handler runs - leaves a chat
// tree behind, and `cellar cleanup` (the real CLI) finds and reaps it. The next
// LAUNCH runs the same sweep; that path is demonstrated end to end, with a real
// launcher, in tests/e2e/chat-orphan-reap.spec.ts.

describe('an app killed with SIGKILL', () => {
	let home: string;
	let shim: string;

	beforeAll(() => {
		home = mkdtempSync(join(ROOT, 'home-'));
		// The machine-wide `ps -eo` scan answers nothing, so `cellar cleanup` here can
		// never reach a real cellar of the developer's (the cleanup-command.test.ts
		// safety measure). Every other `ps` form passes through: identity needs it.
		shim = mkdtempSync(join(ROOT, 'shim-'));
		writeFileSync(join(shim, 'ps'), '#!/bin/sh\n[ "$1" = "-eo" ] && exit 0\nexec /bin/ps "$@"\n');
		chmodSync(join(shim, 'ps'), 0o755);
	});

	/**
	 * A stand-in APP: it spawns a chat-shaped group exactly as the engine does
	 * (`detached`) and records it through the real registry, then waits to be
	 * killed. Plain JS so it runs as its own process - the point is that it DIES.
	 */
	async function startApp(): Promise<{ app: ChildProcess; leader: number; descendant: number; path: string }> {
		const gcFile = join(ROOT, `app-gc-${Date.now()}.pid`);
		const code = `
			import { spawn } from 'node:child_process';
			import { recordChatRun } from ${JSON.stringify(REGISTRY)};
			const child = spawn('/bin/sh', ['-c', 'sleep 600 & echo $! > ${gcFile}; wait'], { detached: true, stdio: 'ignore' });
			const path = recordChatRun(child.pid, { notebook: '/ws/orphan.ipynb' });
			console.log(JSON.stringify({ leader: child.pid, path }));
			setInterval(() => {}, 1e6);
		`;
		const app = spawn(process.execPath, ['--input-type=module', '-e', code], {
			cwd: ROOT,
			env: { ...process.env, CELLAR_CHAT_RUNS_DIR: DIR },
			stdio: ['ignore', 'pipe', 'inherit']
		});
		handles.push(app);
		started.push(app.pid!);
		const line = await new Promise<string>((resolve) => {
			let buf = '';
			app.stdout!.on('data', (d) => {
				buf += d.toString();
				if (buf.includes('\n')) resolve(buf.split('\n')[0]);
			});
		});
		const { leader, path } = JSON.parse(line);
		started.push(leader);
		const descendant = await readPid(gcFile);
		return { app, leader, descendant, path };
	}

	function cleanup(args: string[]) {
		return spawnSync(process.execPath, [CLI, 'cleanup', ...args], {
			encoding: 'utf8',
			cwd: ROOT,
			input: '', // not a tty: the routine-consent shape
			env: { ...process.env, HOME: home, PATH: `${shim}:${savedPath}`, CELLAR_CHAT_RUNS_DIR: DIR, CI: '' }
		});
	}

	it('leaves an orphan that `cellar cleanup` then reaps - leader and descendant', async () => {
		freshDir();
		const { app, leader, descendant, path } = await startApp();
		expect(path).toBeTruthy();
		expect(existsSync(path)).toBe(true);

		const exited = new Promise((r) => app.once('exit', r));
		app.kill('SIGKILL'); // no handler can run: this is the case the registry exists for
		await exited;
		// The control that keeps the rest honest: the tree really was orphaned.
		await sleep(200);
		expect(alive(leader)).toBe(true);
		expect(alive(descendant)).toBe(true);

		const r = cleanup([]);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(r.stdout).toContain(`chat   pgid=${leader}`);
		expect(await until(() => !alive(leader))).toBe(true);
		expect(await until(() => !alive(descendant))).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it('--dry-run names the orphan and stops nothing', async () => {
		freshDir();
		const { app, leader, descendant, path } = await startApp();
		const exited = new Promise((r) => app.once('exit', r));
		app.kill('SIGKILL');
		await exited;

		const r = cleanup(['--dry-run']);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(r.stdout).toContain(`chat   pgid=${leader}`);
		expect(r.stdout).toContain('nothing was stopped');
		await sleep(300);
		expect(alive(leader)).toBe(true);
		expect(alive(descendant)).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	it('cleanup leaves a LIVE app\'s chat run alone, at every scope it can reach without the phrase', async () => {
		freshDir();
		const { leader, descendant, path } = await startApp(); // the app stays alive
		for (const args of [[], ['--all', '-y']]) {
			const r = cleanup(args);
			expect(r.status, r.stdout + r.stderr).toBe(0);
			expect(r.stdout).not.toContain('chat   pgid=');
		}
		await sleep(300);
		expect(alive(leader)).toBe(true);
		expect(alive(descendant)).toBe(true);
		expect(existsSync(path)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The npm package manifest: the launcher imports this module at runtime, so the
// published `files` list must carry it.

describe('package.json files', () => {
	it('ships the module the launcher imports', () => {
		const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
		expect(pkg.files).toContain('src/lib/server/chat-run-registry.js');
	});
});
