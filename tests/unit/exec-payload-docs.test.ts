/**
 * `func?` / `func??` - the `page` payloads on an execute reply.
 *
 * Two levels, because the feature has two halves that fail in different ways.
 *
 * THE RULE (`pagePayloadOutputs`) is pure and is driven directly. Its fixtures are
 * the BYTES a real ipykernel sent, captured from a live kernel rather than written
 * from the protocol docs: the ANSI strip, the `set_next_input` exclusion and the
 * "not found" case all turn on what IPython really does, and a hand-written
 * fixture is a test of what its author believed.
 *
 * THE WIRING is driven through the REAL `executeCellRun` -> REAL `execute()` with
 * only the Jupyter layer faked, because the load-bearing claims are all about
 * where in the run this happens rather than about parsing a reply:
 *
 *   - the doc really lands in the cell's PERSISTED outputs (a rule that lived only
 *     in `execute()`'s return value would render nothing),
 *   - it lands AFTER the run's iopub output and BEFORE `done`, which is the order
 *     the kernel sent them in and the order `run.ts` needs to accumulate it,
 *   - an ABORTED run emits none, because the reply it would have come on never
 *     arrived,
 *   - and a reply with no payload leaves the cell byte-identical, so nothing here
 *     can invent an output for the ordinary run that is 99.9% of them.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pagePayloadOutputs } from '../../src/lib/server/execPayload';
import { DEFAULT_CAPS } from '../../src/lib/server/output-accumulator';

const ESC = String.fromCharCode(27);

/**
 * VERBATIM from a live ipykernel 6 / IPython 9 (`len?`), escapes and all. The
 * labels are SGR red; this is exactly what a user's cell would persist unstripped.
 */
const LEN_DOC_RAW =
	`${ESC}[31mSignature:${ESC}[39m len(obj, /)\n` +
	`${ESC}[31mDocstring:${ESC}[39m Return the number of items in a container.\n` +
	`${ESC}[31mType:${ESC}[39m      builtin_function_or_method`;
const LEN_DOC_CLEAN =
	'Signature: len(obj, /)\n' +
	'Docstring: Return the number of items in a container.\n' +
	'Type:      builtin_function_or_method';

/** The reply shape a kernel sends for `len?`. */
function pageReply(text: string): Record<string, unknown> {
	return {
		status: 'ok',
		execution_count: 1,
		payload: [{ source: 'page', data: { 'text/plain': text }, start: 0 }]
	};
}

// --- the pure rule ---------------------------------------------------------

describe('pagePayloadOutputs: what a page payload becomes', () => {
	it('turns `len?` into one display_data with the ANSI stripped', () => {
		expect(pagePayloadOutputs(pageReply(LEN_DOC_RAW))).toEqual([
			{ output_type: 'display_data', data: { 'text/plain': LEN_DOC_CLEAN }, metadata: {} }
		]);
	});

	it('keeps `??` source intact - only the colour is dropped, never a line', () => {
		// A real `foo??` reply: `Source:` plus the syntax-HIGHLIGHTED source, so the
		// escapes are interleaved with the code rather than only at line starts.
		const raw =
			`${ESC}[31mSignature:${ESC}[39m foo(a, b=${ESC}[32m1${ESC}[39m)\n` +
			`${ESC}[31mSource:${ESC}[39m   \n` +
			`${ESC}[38;5;28;01mdef${ESC}[39;00m foo(a,b=${ESC}[32m1${ESC}[39m):\n` +
			`    ${ESC}[33m"my doc"${ESC}[39m\n` +
			`    ${ESC}[38;5;28;01mreturn${ESC}[39;00m a`;
		const out = pagePayloadOutputs(pageReply(raw));
		const text = out[0].data['text/plain'] as string;
		expect(text).toContain('Source:');
		expect(text).toContain('def foo(a,b=1):');
		expect(text).toContain('    "my doc"');
		expect(text).toContain('    return a');
		expect(text).not.toContain(ESC);
		// The line COUNT is untouched: a strip that ate a newline would silently
		// reflow source the user is about to copy.
		expect(text.split('\n')).toHaveLength(5);
	});

	it('ignores `set_next_input`, the other payload a kernel really sends', () => {
		// `%recall` emits this. Rendering it would put the text of a NEXT cell into
		// THIS cell's output; ignoring it is what Cellar did before and still does.
		expect(
			pagePayloadOutputs({
				status: 'ok',
				payload: [{ source: 'set_next_input', text: 'what?', replace: false }]
			})
		).toEqual([]);
	});

	it('renders the page half of a MIXED payload and ignores the rest', () => {
		const out = pagePayloadOutputs({
			status: 'ok',
			payload: [
				{ source: 'set_next_input', text: 'x = 1', replace: false },
				{ source: 'page', data: { 'text/plain': 'Docstring: hi' }, start: 0 },
				{ source: 'ask_exit', keepkernel: false }
			]
		});
		expect(out).toHaveLength(1);
		expect(out[0].data['text/plain']).toBe('Docstring: hi');
	});

	it('emits several outputs, in wire order, for several page payloads', () => {
		const out = pagePayloadOutputs({
			payload: [
				{ source: 'page', data: { 'text/plain': 'first' } },
				{ source: 'page', data: { 'text/plain': 'second' } }
			]
		});
		expect(out.map((o) => o.data['text/plain'])).toEqual(['first', 'second']);
	});

	it('joins nbformat`s line-array form and strips ANSI inside it', () => {
		const out = pagePayloadOutputs({
			payload: [{ source: 'page', data: { 'text/plain': [`${ESC}[31mType:${ESC}[39m `, 'module'] } }]
		});
		expect(out[0].data['text/plain']).toEqual(['Type: ', 'module']);
	});

	it('passes a non-text/plain mime through untouched', () => {
		// A kernel that pages `text/html` is renderable by `Cell.svelte`'s existing
		// sandboxed-iframe path; only `text/plain` carries the terminal escapes, so
		// only `text/plain` is rewritten.
		const html = `<b>${ESC}[31mnot ansi here${ESC}[39m</b>`;
		const out = pagePayloadOutputs({ payload: [{ source: 'page', data: { 'text/html': html } }] });
		expect(out[0].data['text/html']).toBe(html);
	});

	it('drops a page payload that would render as an EMPTY box', () => {
		// "showing an empty box" is the one outcome worse than showing nothing.
		for (const data of [{}, { 'text/plain': '' }, { 'text/plain': '   \n  ' }, { 'text/plain': [] }]) {
			expect(pagePayloadOutputs({ payload: [{ source: 'page', data }] })).toEqual([]);
		}
	});

	it('never throws, whatever the reply is', () => {
		// This runs on the settle path of EVERY execute in the app, including the
		// internal probes, so an unanticipated shape must cost an ignored payload and
		// nothing else.
		const shapes: unknown[] = [
			undefined,
			null,
			{},
			{ payload: null },
			{ payload: 'page' },
			{ payload: [null, undefined, 7, 'page', []] },
			{ payload: [{ source: 'page' }] },
			{ payload: [{ source: 'page', data: null }] },
			{ payload: [{ source: 'page', data: 'text' }] },
			{ payload: [{ source: 'page', data: ['text/plain'] }] },
			{ payload: [{ data: { 'text/plain': 'no source' } }] }
		];
		for (const shape of shapes) expect(() => pagePayloadOutputs(shape)).not.toThrow();
		for (const shape of shapes) expect(pagePayloadOutputs(shape)).toEqual([]);
	});
});

// --- the wiring, through the real run path ---------------------------------

const h = vi.hoisted(() => {
	/** The payload the next reply carries; set per test. */
	let replyPayload: unknown = undefined;
	/** IOPub messages the next run emits before its reply. */
	let iopub: { msg_type: string; content: Record<string, unknown> }[] = [];
	/** When set, the next run's future never resolves on its own. */
	let hang = false;

	function makeFakeKernel() {
		const k = {
			id: 'kernel-payload-1',
			name: 'python3',
			status: 'idle' as string,
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string; silent?: boolean }) => {
				h.executed.push(typeof args?.code === 'string' ? args.code : '');
				let resolveDone!: (v: unknown) => void;
				const f = {
					onIOPub: null as ((m: unknown) => void) | null,
					onReply: null as unknown,
					onStdin: null as unknown,
					done: new Promise((res) => {
						resolveDone = res;
					}),
					dispose: vi.fn()
				};
				// A SILENT exec is a Cellar startup injection, never a user run: answer it
				// at once and with no payload, so only the run under test can produce one.
				if (args?.silent) {
					queueMicrotask(() => resolveDone({ content: { status: 'ok', execution_count: 0 } }));
					return f;
				}
				const payload = h.replyPayload;
				const frames = h.iopub;
				const hanging = h.hang;
				h.replyPayload = undefined;
				h.iopub = [];
				h.hang = false;
				queueMicrotask(() => {
					for (const m of frames) f.onIOPub?.({ header: { msg_type: m.msg_type }, parent_header: {}, content: m.content });
					if (hanging) return;
					const content: Record<string, unknown> = { status: 'ok', execution_count: 1 };
					if (payload !== undefined) content.payload = payload;
					resolveDone({ content });
				});
				return f;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			dispose: vi.fn()
		};
		return k;
	}

	return {
		makeFakeKernel,
		startNew: vi.fn(async () => makeFakeKernel()),
		executed: [] as string[],
		get replyPayload() {
			return replyPayload;
		},
		set replyPayload(v: unknown) {
			replyPayload = v;
		},
		get iopub() {
			return iopub;
		},
		set iopub(v: { msg_type: string; content: Record<string, unknown> }[]) {
			iopub = v;
		},
		get hang() {
			return hang;
		},
		set hang(v: boolean) {
			hang = v;
		}
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		runningChanged = { connect: vi.fn() };
		running() {
			return [][Symbol.iterator]();
		}
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o },
	CommsOverSubshells: { Disabled: 'disabled' },
	KernelAPI: { getKernelModel: vi.fn(async () => ({ execution_state: 'idle' })), interruptKernel: vi.fn(async () => {}) }
}));

vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let runmod: typeof import('../../src/lib/server/run');
let kernelmod: typeof import('../../src/lib/server/kernel');

const NB = 'payload.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-payload-'));
	process.env.CELLAR_WORKSPACE = WS;
	// The watchdog must never be what ends a run here.
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '60000';
	nbmod = await import('../../src/lib/server/notebook');
	runmod = await import('../../src/lib/server/run');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(() => {
	h.replyPayload = undefined;
	h.iopub = [];
	h.hang = false;
	h.executed = [];
});

/** Run `source` as a fresh cell and return that cell's persisted outputs. */
async function runCell(source: string, events?: { type: string }[]) {
	const cellId = nbmod.addCell(null, 'code', abs(), null, source).id;
	const res = await runmod.executeCellRun({
		nb: abs(),
		cellId,
		actor: 'user',
		source,
		onEvent: events ? (e) => void events.push(e as { type: string }) : undefined
	});
	const persisted = nbmod.listCells(NB).find((c) => c.id === cellId)?.outputs ?? [];
	return { res, persisted, cellId };
}

describe('the wiring: a page payload reaches the cell', () => {
	it('persists `len?` docs as the cell`s output', async () => {
		h.replyPayload = pageReply(LEN_DOC_RAW).payload;
		const { res, persisted } = await runCell('len?');

		expect(res.status).toBe('ok');
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ output_type: 'display_data', metadata: {} });
		expect((persisted[0] as { data: Record<string, unknown> }).data['text/plain']).toBe(LEN_DOC_CLEAN);
	});

	it('lands AFTER the run`s iopub output and BEFORE `done`', async () => {
		// `print("before")` then `len?`: the stream is iopub, the doc rides the reply,
		// so the doc must come second - and both must precede `done`, or `run.ts` would
		// finalize its accumulator without it.
		h.iopub = [{ msg_type: 'stream', content: { name: 'stdout', text: 'before\n' } }];
		h.replyPayload = pageReply(LEN_DOC_RAW).payload;
		const events: { type: string }[] = [];
		const { persisted } = await runCell('print("before")\nlen?', events);

		expect(persisted.map((o) => o.output_type)).toEqual(['stream', 'display_data']);
		const kinds = events.map((e) => e.type);
		expect(kinds.indexOf('done')).toBeGreaterThan(kinds.lastIndexOf('output'));
		expect(kinds.indexOf('done')).toBeGreaterThan(-1);
	});

	it('leaves an ordinary run with no payload byte-identical', async () => {
		// The regression guard for every OTHER run in the app: nothing here may invent
		// an output when the reply carried no payload.
		h.iopub = [{ msg_type: 'stream', content: { name: 'stdout', text: 'hello\n' } }];
		const { persisted } = await runCell('print("hello")');
		expect(persisted).toEqual([{ output_type: 'stream', name: 'stdout', text: 'hello\n' }]);
	});

	it('renders NOTHING extra for the name that does not exist', async () => {
		// IPython answers an unknown name on iopub, as stdout, with no payload at all -
		// so the sentence the user reads is the kernel's own. Cellar must not add to it,
		// and must not swallow it either.
		h.iopub = [{ msg_type: 'stream', content: { name: 'stdout', text: 'Object `nope_xyz` not found.\n' } }];
		const { persisted } = await runCell('nope_xyz?');
		expect(persisted).toEqual([
			{ output_type: 'stream', name: 'stdout', text: 'Object `nope_xyz` not found.\n' }
		]);
	});

	it('ignores a `set_next_input` payload all the way through the run', async () => {
		h.replyPayload = [{ source: 'set_next_input', text: 'x = 1', replace: false }];
		const { persisted } = await runCell('%recall');
		expect(persisted).toEqual([]);
	});

	it('carries a LONG `??` source through untruncated', async () => {
		// `json.dumps??` is ~4.4 KB against a real kernel; a big library function runs to
		// tens of KB. Nothing here caps it, and the accumulator's own ceiling is 10 MB,
		// so the whole source reaches the cell - which is what makes it copyable.
		const body = Array.from({ length: 4000 }, (_, i) => `    line_${i} = ${i}`).join('\n');
		const long = `Signature: big(a)\nSource:\ndef big(a):\n${body}\n    return a`;
		expect(long.length).toBeGreaterThan(60_000);
		expect(long.length).toBeLessThan(DEFAULT_CAPS.maxTotalBytes);

		h.replyPayload = pageReply(long).payload;
		const { persisted } = await runCell('big??');

		expect(persisted).toHaveLength(1);
		const text = (persisted[0] as { data: Record<string, unknown> }).data['text/plain'] as string;
		expect(text).toBe(long);
		expect(text).toContain('line_3999 = 3999');
		expect(text.split('\n')).toHaveLength(long.split('\n').length);
	});

	it('says so VISIBLY when a payload past the byte cap is truncated', async () => {
		// Nothing is ever dropped in silence. The accumulator owns the ceiling and the
		// marker; this proves a page payload really goes through it rather than around.
		const huge = 'x'.repeat(DEFAULT_CAPS.maxTotalBytes + 1000);
		h.replyPayload = pageReply(huge).payload;
		const { persisted } = await runCell('huge??');

		const marker = persisted.find((o) => o.output_type === 'stream') as { text: string } | undefined;
		expect(marker?.text, 'the truncation marker').toContain('output truncated');
		expect(marker?.text).toContain('total output exceeded');
	});
});

describe('the wiring: nothing is claimed that was not observed', () => {
	it('emits no doc for a run that was ABORTED before its reply', async () => {
		// The payload rides the reply, so a run force-settled by restart/interrupt never
		// had one. Asserted through the real abort path rather than by reading the code.
		h.hang = true;
		const cellId = nbmod.addCell(null, 'code', abs(), null, 'len?').id;
		const running = runmod.executeCellRun({ nb: abs(), cellId, actor: 'user', source: 'len?' });
		// Let the run reach the kernel, then tear it down the way a restart does.
		await new Promise((r) => setTimeout(r, 30));
		await kernelmod.restartKernel(abs());
		const res = await running;

		expect(res.status).toBe('error');
		const persisted = nbmod.listCells(NB).find((c) => c.id === cellId)?.outputs ?? [];
		expect(persisted.some((o) => o.output_type === 'display_data')).toBe(false);
	});

	it('emits no doc when the kernel could not be reached at all', async () => {
		h.startNew.mockImplementationOnce(async () => {
			throw new Error('sidecar unreachable');
		});
		await kernelmod.shutdownKernel(abs());
		const { res, persisted } = await runCell('len?');

		expect(res.kernelDown).toBe(true);
		expect(persisted.every((o) => o.output_type === 'error')).toBe(true);
	});
});

describe('a non-Python cell is untouched BY CONSTRUCTION', () => {
	it('sends a SQL cell`s compiled Python, so its `?` is inside a string literal', async () => {
		// Requirement 5's real mechanism: Cellar never transforms `?` - IPython does,
		// and it only ever sees a SQL cell's SQL as the CONTENTS of a Python string. So
		// the guard is that the compiled source is what reaches the kernel; the kernel
		// then produces no payload, and the cell shows no docs.
		const cellId = nbmod.addCell(null, 'code', abs(), null, 'SELECT a FROM t WHERE b = ?').id;
		nbmod.setCellType(cellId, 'sql', abs());
		await runmod.executeCellRun({ nb: abs(), cellId, actor: 'user', source: 'SELECT a FROM t WHERE b = ?' });

		const sent = h.executed.at(-1) ?? '';
		expect(sent, 'the SQL never reaches the kernel as bare source').not.toBe('SELECT a FROM t WHERE b = ?');
		expect(sent).toContain('spark.sql');
		const persisted = nbmod.listCells(NB).find((c) => c.id === cellId)?.outputs ?? [];
		expect(persisted.some((o) => o.output_type === 'display_data')).toBe(false);
	});
});
