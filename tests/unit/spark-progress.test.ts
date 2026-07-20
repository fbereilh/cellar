/**
 * Live Spark job-progress bars — the pure, ipywidgets-free core.
 *
 * These tests spawn the REAL kernel-side Python (`SPARK_PROGRESS_CORE_PY` from
 * `databricks.ts`, the exact string injected at Databricks connect time) with a
 * FAKE renderer, mirroring `dataflow-load-before-store.test.ts`: no hand-written
 * re-implementation of the logic, so the test can only pass if the code the
 * kernel actually runs behaves as claimed.
 *
 * The four hard-won facts under test (all established against the captain's real
 * Databricks cluster — see the AGENTS.md "Live Spark progress" entry):
 *   - per-stage counts sum to the right OVERALL completion fraction/label;
 *   - the ~4-5 identical callbacks per tick collapse to ONE render (dedupe);
 *   - a sub-interval (single terminal `done=True`) query never flashes a bar;
 *   - the bar completes and the manager stops tracking on `done`.
 * Persistence (nothing progress-related reaches the saved `.ipynb`) is covered by
 * the widget-mime strip in `clean-on-save.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SPARK_PROGRESS_CORE_PY } from '../../src/lib/server/databricks';

/**
 * A Python driver: exec the real core, drive it with a call-recording fake
 * renderer, and print one JSON blob of results. `Stage` mimics Spark Connect's
 * `StageInfo` dataclass (the handler reads `num_tasks` / `num_completed_tasks` /
 * `num_bytes_read` off each stage). The handler is called with KEYWORD args,
 * exactly as pyspark's `Progress._notify` invokes it.
 */
const DRIVER = `
${SPARK_PROGRESS_CORE_PY}
import json


class Stage:
    def __init__(self, num_tasks, num_completed_tasks, num_bytes_read=0):
        self.num_tasks = num_tasks
        self.num_completed_tasks = num_completed_tasks
        self.num_bytes_read = num_bytes_read


class Rec:
    def __init__(self):
        self.calls = []

    def make(self):
        self.calls.append({'op': 'make'})
        return {'w': True}

    def show(self, w):
        self.calls.append({'op': 'show'})

    def update(self, w, s):
        self.calls.append({'op': 'update', 'completed': s['completed'],
                           'total': s['total'], 'pct': round(s['pct'], 4),
                           'done': s['done'], 'label': s['label']})

    def close(self, w, s):
        self.calls.append({'op': 'close', 'completed': s['completed'],
                           'total': s['total'], 'done': s['done']})


def summary(stages, inflight, done):
    return _cellar_spark_summary(stages, inflight, done)


def feed(events):
    """events: list of (stages, inflight, op_id, done). Returns recorded calls
    plus the size of the manager's live-bar registry at the end."""
    rec = Rec()
    mgr = _CellarSparkProgress(rec)
    for stages, inflight, op_id, done in events:
        mgr.handle(stages=stages, inflight_tasks=inflight,
                   operation_id=op_id, done=done)
    return {'calls': rec.calls, 'registry': len(mgr._bars)}


out = {}

# 1) Summary: two stages sum into one overall fraction + label.
out['summary_multistage'] = summary([Stage(100, 25), Stage(12, 3)], 8, False)

# 2) Bytes read (a real scan) render as a human size; no "running" clause at 0.
out['summary_bytes'] = summary([Stage(10, 10, 579030)], 0, True)

# 3) Zero-task plan: no division, pct 0.
out['summary_zero'] = summary([], 0, False)

# 4) Dedupe: 5 identical mid-flight callbacks collapse to one create+render.
op = 'op-A'
dup = [([Stage(112, 5)], 4, op, False)] * 5
out['dedupe'] = feed(dup)

# 5) Full lifecycle: create -> dup burst -> advance -> terminal done.
tick1 = ([Stage(112, 5)], 4, op, False)
tick2 = ([Stage(112, 49)], 6, op, False)
term = ([Stage(112, 112)], 0, op, True)
out['lifecycle'] = feed([tick1, tick1, tick1, tick1, tick2, tick2, term])

# 6) Sub-interval query: a single terminal callback, no prior bar -> nothing.
out['fast_query'] = feed([([Stage(10, 10)], 0, 'op-fast', True)])

# 7) Zero-task terminal callback (an internal SELECT 1 probe) -> nothing.
out['probe'] = feed([([Stage(0, 0)], 0, 'op-probe', True)])


def feed_via_cb(kind):
    """Drive the manager through the REGISTERED wrapper (_cellar_spark_progress_cb)
    rather than mgr.handle directly, exercising the signature-tolerant binding
    that protects the user's .collect() from a future ProgressHandler signature
    drift. 'kind' selects an odd call shape the wrapper must survive."""
    rec = Rec()
    mgr = _CellarSparkProgress(rec)
    cb = _cellar_spark_progress_cb(mgr)
    raised = False
    try:
        if kind == 'keyword':
            cb(stages=[Stage(112, 5)], inflight_tasks=4,
               operation_id='op-cb', done=False)
        elif kind == 'positional':
            cb([Stage(112, 5)], 4, 'op-cb', False)
        elif kind == 'extra_kwarg':
            cb(stages=[Stage(112, 5)], inflight_tasks=4,
               operation_id='op-cb', done=False, future_field=object())
        elif kind == 'missing':
            cb()
    except Exception:
        raised = True
    return {'calls': rec.calls, 'registry': len(mgr._bars), 'raised': raised}


# 8) The registered wrapper tolerates keyword, positional, extra-kwarg, and
# empty calls without ever raising into the caller (the user's .collect()).
out['cb_keyword'] = feed_via_cb('keyword')
out['cb_positional'] = feed_via_cb('positional')
out['cb_extra_kwarg'] = feed_via_cb('extra_kwarg')
out['cb_missing'] = feed_via_cb('missing')

print('__RESULT__' + json.dumps(out))
`;

function run(): Record<string, { calls: unknown[]; registry?: number } & Record<string, unknown>> {
	const stdout = execFileSync('python3', ['-'], { input: DRIVER, encoding: 'utf8' });
	const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
	if (!line) throw new Error(`no result from driver:\n${stdout}`);
	return JSON.parse(line.slice('__RESULT__'.length));
}

const MIDDOT = '·';

describe('Spark progress core', () => {
	const r = run();

	it('sums per-stage counts into the overall completion fraction', () => {
		const s = r.summary_multistage as Record<string, unknown>;
		expect(s.total).toBe(112);
		expect(s.completed).toBe(28);
		expect(s.pct).toBeCloseTo(25.0, 6);
		expect(s.num_stages).toBe(2);
		expect(s.label).toBe(`28/112 tasks ${MIDDOT} 8 running`);
	});

	it('renders bytes read as a human size and omits "running" at zero in-flight', () => {
		const s = r.summary_bytes as Record<string, unknown>;
		expect(s.bytes).toBe(579030);
		expect(s.label).toBe(`10/10 tasks ${MIDDOT} 565.5 KiB`);
		expect(String(s.label)).not.toContain('running');
	});

	it('handles a zero-task plan without dividing', () => {
		const s = r.summary_zero as Record<string, unknown>;
		expect(s.total).toBe(0);
		expect(s.pct).toBe(0);
		expect(s.label).toBe('0/0 tasks');
	});

	it('collapses the ~4-5 identical per-tick callbacks to a single render', () => {
		const { calls } = r.dedupe;
		const ops = calls.map((c) => (c as { op: string }).op);
		// One create (make+show) and exactly one update, despite 5 callbacks.
		expect(ops).toEqual(['make', 'show', 'update']);
	});

	it('creates, advances, completes, then stops tracking the query', () => {
		const { calls, registry } = r.lifecycle;
		const ops = calls.map((c) => (c as { op: string }).op);
		// make+show once, then one update per DISTINCT tick (5, 49, 112) and a
		// final close — the 3 duplicate callbacks render nothing.
		expect(ops).toEqual(['make', 'show', 'update', 'update', 'update', 'close']);
		const updates = calls.filter((c) => (c as { op: string }).op === 'update');
		expect(updates.map((u) => (u as { completed: number }).completed)).toEqual([5, 49, 112]);
		const close = calls.find((c) => (c as { op: string }).op === 'close') as {
			completed: number;
			done: boolean;
		};
		expect(close.done).toBe(true);
		expect(close.completed).toBe(112);
		// Registry emptied on completion — the bar is no longer tracked.
		expect(registry).toBe(0);
	});

	it('shows no intermediate bar for a sub-interval (terminal-only) query', () => {
		const { calls, registry } = r.fast_query;
		expect(calls).toEqual([]);
		expect(registry).toBe(0);
	});

	it('flashes no bar for a zero-task internal probe', () => {
		const { calls, registry } = r.probe;
		expect(calls).toEqual([]);
		expect(registry).toBe(0);
	});

	it('drives the manager through the registered keyword-call wrapper', () => {
		const { calls, raised } = r.cb_keyword;
		expect(raised).toBe(false);
		expect(calls.map((c) => (c as { op: string }).op)).toEqual(['make', 'show', 'update']);
	});

	it('tolerates a positional call convention without raising', () => {
		const { calls, raised } = r.cb_positional;
		expect(raised).toBe(false);
		expect(calls.map((c) => (c as { op: string }).op)).toEqual(['make', 'show', 'update']);
	});

	it('tolerates an unexpected extra kwarg (future signature drift) without raising', () => {
		const { calls, raised } = r.cb_extra_kwarg;
		expect(raised).toBe(false);
		expect(calls.map((c) => (c as { op: string }).op)).toEqual(['make', 'show', 'update']);
	});

	it('swallows a call missing every argument rather than crashing .collect()', () => {
		const { raised } = r.cb_missing;
		expect(raised).toBe(false);
	});
});
