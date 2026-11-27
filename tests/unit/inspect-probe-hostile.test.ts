/**
 * Cellar's namespace probes must finish on objects that answer every attribute.
 *
 * The reported failure: after `from fasthtml.common import *` the next cell never
 * ran. fastcore exports `null` (a NullType whose `__getattr__` and `__getitem__`
 * return `null`) and `Self` (whose attributes return an endlessly indexable
 * `_Self`). The kernel_state probe took `hasattr(x, 'shape')` as proof of an
 * array, then iterated `x.shape`. Python fell back to the `__getitem__` iteration
 * protocol, which never raises IndexError, so the probe spun at full CPU with
 * growing memory and every later cell queued behind it.
 *
 * These spawn the REAL probe strings from `inspect.ts`, the exact code the kernel
 * runs, against:
 *   - the minimal `Hostile` class from the report;
 *   - faithful copies of fastcore's `NullType` and `_SelfCls`, so the case is
 *     covered on every machine;
 *   - the real fastcore `null` and `Self`, when fastcore is importable. That part
 *     is skipped with the reason in the suite name when it is not.
 * Each run has a hard process timeout, so a regression fails instead of hanging.
 *
 * The per-value time budget is checked the same way: a value whose `__repr__`
 * never returns is reported as not inspected, and the rest of the namespace is
 * still read.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	KERNEL_STATE_PROBE,
	LIST_VARS_PROBE,
	inspectProbeCode,
	PROBE_VALUE_BUDGET_S
} from '../../src/lib/server/inspect';

/** Hard ceiling for one probe process. A probe that loops forever fails here. */
const RUN_TIMEOUT_MS = 20_000;

const HOSTILE = `
class Hostile:
    def __getattr__(self, k): return self
    def __getitem__(self, i): return self
x = Hostile()
`;

// Copies of fastcore 2.2.49's NullType and _SelfCls/_Self, trimmed to the parts
// the probe can touch: attribute access, indexing, truthiness, repr.
const FASTCORE_COPIES = `
class NullType:
    def __getattr__(self, *args): return null
    def __call__(self, *args, **kwargs): return null
    def __getitem__(self, *args): return null
    def __bool__(self): return False
null_copy = null = NullType()
class _Self:
    def __init__(self, steps=()): self.__dict__['steps'] = steps
    def __repr__(self): return '~Self' + ''.join('.' + str(s[0]) for s in self.steps)
    def __getattr__(self, k):
        if k.startswith('__') and k.endswith('__'): raise AttributeError(k)
        return _Self((*self.steps, (k, None, None)))
    def __getitem__(self, i): return _Self((*self.steps, ('__getitem__', (i,), {})))
class _SelfCls:
    def __getattr__(self, k):
        if k.startswith('__') and k.endswith('__'): raise AttributeError(k)
        return _Self(((k, None, None),))
    def __getitem__(self, i): return _Self((('__getitem__', (i,), {}),))
self_copy = _SelfCls()
del null
`;

// Ordinary values that must keep their shape, length and columns.
const CONTROLS = `
class Framey:
    shape = (3, 2)
    columns = ['a', 'b']
    def __repr__(self): return 'Framey'
frame = Framey()
nums = list(range(5))
`;

/** A value whose repr never returns: the per-value budget must stop it. */
const SLOW = `
class Slow:
    def __repr__(self):
        while True:
            pass
slow = Slow()
`;

const hasFastcore = spawnSync('python3', ['-c', 'import fastcore.basics'], { stdio: 'ignore' }).status === 0;

/** Run `setup` then `probe` in a fresh python3, and return the last JSON line it printed. */
function runProbe(setup: string, probe: string): { json: unknown; ms: number } {
	const t0 = Date.now();
	const res = spawnSync('python3', ['-'], {
		input: `${setup}\n${probe}\n`,
		encoding: 'utf8',
		timeout: RUN_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024
	});
	const ms = Date.now() - t0;
	if (res.error) throw new Error(`probe did not finish within ${RUN_TIMEOUT_MS}ms: ${res.error.message}`);
	if (res.status !== 0) throw new Error(`probe failed (${res.status}): ${res.stderr}`);
	const line = res.stdout.trim().split('\n').filter(Boolean).at(-1)!;
	return { json: JSON.parse(line), ms };
}

type Row = Record<string, unknown> & { name: string };
const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

function kernelState(setup: string) {
	const { json, ms } = runProbe(setup, KERNEL_STATE_PROBE);
	const s = json as { variables: Row[]; uninspected?: Row[]; imports: Row[]; classes: Row[] };
	return { vars: byName(s.variables), uninspected: byName(s.uninspected ?? []), state: s, ms };
}

function listVariables(setup: string) {
	const { json, ms } = runProbe(setup, LIST_VARS_PROBE);
	return { vars: byName(json as Row[]), ms };
}

function inspectVariable(setup: string, name: string) {
	const { json, ms } = runProbe(setup, inspectProbeCode(name));
	return { detail: json as Row, ms };
}

describe('the namespace probes finish on objects that answer every attribute', () => {
	const setup = HOSTILE + FASTCORE_COPIES + CONTROLS;
	const hostileNames = ['x', 'null_copy', 'self_copy'];

	it('kernel_state lists each hostile value with no shape or columns, and keeps real ones', () => {
		const { vars, uninspected } = kernelState(setup);
		for (const n of hostileNames) {
			expect(vars[n], n).toBeDefined();
			expect(vars[n].shape, n).toBe('');
			expect(vars[n].columns, n).toBeUndefined();
		}
		expect(Object.keys(uninspected)).toEqual([]);
		// Attributes the TYPE defines still count, so ordinary values are unchanged.
		expect(vars.frame).toMatchObject({ shape: '3x2', columns: ['a', 'b'], preview: 'Framey' });
		expect(vars.nums).toMatchObject({ shape: '5' });
	});

	it('list_variables describes each hostile value without a size', () => {
		const { vars } = listVariables(setup);
		for (const n of hostileNames) {
			expect(vars[n], n).toBeDefined();
			expect(vars[n].size, n).toBeUndefined();
			expect(vars[n].not_inspected, n).toBeUndefined();
		}
		expect(vars.nums).toMatchObject({ size: 5 });
	});

	it('inspect_variable reads each hostile value as a scalar', () => {
		for (const n of hostileNames) {
			const { detail } = inspectVariable(setup, n);
			expect(detail, n).toMatchObject({ found: true, name: n, kind: 'scalar' });
			expect(detail.size, n).toBeUndefined();
		}
	});

	it('leaves no probe helper behind in the namespace', () => {
		const { json } = runProbe(
			setup + 'import json as _j\n',
			`${KERNEL_STATE_PROBE}\n${LIST_VARS_PROBE}\nprint(_j.dumps(sorted(k for k in globals() if k.startswith('_cellar') or k.startswith('_Cellar') or k.startswith('_CELLAR'))))`
		);
		// Only the module aliases the probes import at top level remain, as before.
		expect(json).toEqual(['_cellar_ins', '_cellar_json', '_cellar_sys']);
	});
});

describe.skipIf(!hasFastcore)(
	'the namespace probes finish on the real fastcore null and Self' + (hasFastcore ? '' : ' (SKIPPED: fastcore is not installed in python3)'),
	() => {
		const setup = 'from fastcore.basics import null, Self\n';

		it('kernel_state, list_variables and inspect_variable all return', () => {
			const ks = kernelState(setup);
			expect(ks.vars.null).toMatchObject({ type: 'NullType', shape: '' });
			expect(ks.vars.Self).toMatchObject({ type: '_SelfCls', shape: '' });
			const lv = listVariables(setup);
			expect(lv.vars.null).toBeDefined();
			expect(lv.vars.Self).toBeDefined();
			expect(inspectVariable(setup, 'null').detail).toMatchObject({ found: true, kind: 'scalar' });
			expect(inspectVariable(setup, 'Self').detail).toMatchObject({ found: true, kind: 'scalar' });
		});
	}
);

describe('a value that never finishes is reported, not waited on forever', () => {
	const setup = SLOW + 'ok = 1\n';

	it('kernel_state names it as uninspected and still reads the rest', () => {
		const { vars, uninspected, ms } = kernelState(setup);
		expect(uninspected.slow).toMatchObject({ type: 'Slow' });
		expect(String(uninspected.slow.reason)).toContain(`${PROBE_VALUE_BUDGET_S}s budget`);
		expect(vars.slow).toBeUndefined();
		expect(vars.ok).toMatchObject({ preview: '1' });
		expect(ms).toBeLessThan(RUN_TIMEOUT_MS / 2);
	});

	it('list_variables marks it not inspected', () => {
		const { vars } = listVariables(setup);
		expect(String(vars.slow.not_inspected)).toContain('budget');
		expect(vars.ok).toMatchObject({ repr_short: '1' });
	});

	it('inspect_variable marks it not inspected', () => {
		const { detail } = inspectVariable(setup, 'slow');
		expect(detail).toMatchObject({ found: true, type: 'Slow' });
		expect(String(detail.not_inspected)).toContain('budget');
	});

	it('restores the SIGALRM handler it borrowed', () => {
		const { json } = runProbe(
			setup + 'import signal as _s, json as _j\n_h = lambda *a: None\n_s.signal(_s.SIGALRM, _h)\n',
			`${KERNEL_STATE_PROBE}\nprint(_j.dumps([_s.getsignal(_s.SIGALRM) is _h, _s.getitimer(_s.ITIMER_REAL)]))`
		);
		expect(json).toEqual([true, [0, 0]]);
	});
});
