// @vitest-environment jsdom
/**
 * The kernel-backed CodeMirror completion source.
 *
 * Two things are proved here that nothing else can prove cheaply. First, the
 * source really is REGISTERED as language data for its editor - the wiring is one
 * expression wide and, got wrong, the feature is silently inert while every
 * behavioural test of the source itself still passes. Second, the OPTION SHAPE:
 * CodeMirror drops a duplicate across sources only when label, `detail`, `apply`,
 * `boost` and `type` all agree, so the "only label + a mapped type" rule is what
 * keeps `print` from appearing twice beside `@codemirror/lang-python`'s own
 * builtin list. Both are invariants a reviewer would otherwise have to take on
 * trust.
 *
 * The kernel is a fake handle: what the real one answers is measured against a
 * real ipykernel in `kernel-introspect.test.ts` and in the e2e.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { python } from '@codemirror/lang-python';
import { kernelCompletion, kernelCompletionSource } from '../../src/lib/kernelCompletion';
import {
	completionType,
	fromCodePointOffset,
	toCodePointOffset,
	type CompleteOutcome,
	type KernelIntrospectHandle
} from '../../src/lib/kernelIntrospect';

/** A handle whose `complete` answers `outcome` and records what it was asked. */
function fakeHandle(outcome: CompleteOutcome | (() => Promise<CompleteOutcome>)) {
	const calls: { code: string; cursorPos: number; signal?: AbortSignal }[] = [];
	const handle: KernelIntrospectHandle = {
		complete: (code, cursorPos, signal) => {
			calls.push({ code, cursorPos, signal });
			return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome);
		},
		inspect: async () => ({ ok: false, reason: 'failed' })
	};
	return { handle, calls };
}

function okOutcome(
	matches: { text: string; type: string | null }[],
	cursorStart: number,
	cursorEnd: number
): CompleteOutcome {
	return { ok: true, matches, cursorStart, cursorEnd };
}

async function query(
	doc: string,
	pos: number,
	handle: KernelIntrospectHandle | null,
	explicit = false
): Promise<CompletionResult | null> {
	const source = kernelCompletionSource(() => handle);
	// `python()` so the state has a real syntax tree: the implicit path's second gate
	// resolves the node at the caret, and without a language every position resolves
	// to the document node and the gate could never fire.
	const state = EditorState.create({ doc, extensions: [python()] });
	return await source(new CompletionContext(state, pos, explicit));
}

describe('it is really wired into the editor', () => {
	it('registers as this editor’s language data, alongside the language’s own sources', () => {
		const { handle } = fakeHandle(okOutcome([], 0, 0));
		const withKernel = EditorState.create({
			doc: 'import os\n',
			extensions: [python(), kernelCompletion(() => handle)]
		});
		const withoutKernel = EditorState.create({ doc: 'import os\n', extensions: [python()] });
		const ours = withKernel.languageDataAt<unknown>('autocomplete', 3);
		const theirs = withoutKernel.languageDataAt<unknown>('autocomplete', 3);
		// Exactly one MORE source than the language brings on its own: added beside
		// them, never instead of them. Replacing the language's sources would lose the
		// file-local names of a cell that has not been run - precisely the names a user
		// is in the middle of writing.
		expect(ours.length).toBe(theirs.length + 1);
		expect(theirs.length).toBeGreaterThan(0);
	});

	it('registers PER EDITOR, so a second notebook’s kernel is never asked about this one', async () => {
		// The invariant the module's header argues for, asserted as BEHAVIOUR rather
		// than as the shape of the registration call: two editors carrying DIFFERENT
		// handles is what makes it observable at all, since a registration shared
		// between them looks identical from inside either one. Each editor's own
		// source is RUN, and each must reach its own handle and no other - two
		// notebooks' kernels are different namespaces in different processes, so an
		// editor answering through the other's would be confidently wrong.
		const a = fakeHandle(okOutcome([{ text: 'from_a', type: 'instance' }], 0, 1));
		const b = fakeHandle(okOutcome([{ text: 'from_b', type: 'instance' }], 0, 1));
		const stateA = EditorState.create({
			doc: 'x',
			extensions: [python(), kernelCompletion(() => a.handle)]
		});
		const stateB = EditorState.create({
			doc: 'x',
			extensions: [python(), kernelCompletion(() => b.handle)]
		});
		const plain = EditorState.create({ doc: 'x', extensions: [python()] });
		const shared = new Set(plain.languageDataAt<unknown>('autocomplete', 1));
		const kernelSourceOf = (state: EditorState) => {
			const own = state.languageDataAt<unknown>('autocomplete', 1).filter((s) => !shared.has(s));
			expect(own.length).toBe(1); // exactly ONE kernel source per editor
			return own[0] as (ctx: CompletionContext) => Promise<CompletionResult | null>;
		};
		const resA = await kernelSourceOf(stateA)(new CompletionContext(stateA, 1, true));
		const resB = await kernelSourceOf(stateB)(new CompletionContext(stateB, 1, true));
		expect(resA?.options.map((o) => o.label)).toEqual(['from_a']);
		expect(resB?.options.map((o) => o.label)).toEqual(['from_b']);
		expect(a.calls.length).toBe(1);
		expect(b.calls.length).toBe(1);
	});

	it('hands back the SAME source object every time, so a query is not restarted per keystroke', () => {
		const { handle } = fakeHandle(okOutcome([], 0, 0));
		const state = EditorState.create({ doc: 'x', extensions: [kernelCompletion(() => handle)] });
		const a = state.languageDataAt<unknown>('autocomplete', 1);
		const b = state.languageDataAt<unknown>('autocomplete', 1);
		expect(a[0]).toBe(b[0]);
	});
});

describe('when it asks, and when it does not', () => {
	it('does nothing at all without a handle - the no-kernel case is byte-identical to before', async () => {
		expect(await query('myva', 4, null)).toBeNull();
	});

	it('asks after an identifier character or a dot', async () => {
		const f1 = fakeHandle(okOutcome([{ text: 'myvar', type: 'instance' }], 0, 4));
		expect(await query('myva', 4, f1.handle)).not.toBeNull();
		const f2 = fakeHandle(okOutcome([{ text: 'hello', type: 'function' }], 2, 2));
		expect(await query('t.', 2, f2.handle)).not.toBeNull();
	});

	it('stays quiet mid-prose, so typing costs no round trip', async () => {
		const f = fakeHandle(okOutcome([{ text: 'x', type: null }], 0, 0));
		expect(await query('a comment about ', 16, f.handle)).toBeNull();
		expect(f.calls).toEqual([]);
	});

	it('never asks while the caret is inside a COMMENT, however completable the character before it', async () => {
		// `COMPLETABLE_BEFORE` matches every word character of `# import da`, so the
		// character rule alone left this source asking the kernel on every keystroke of
		// a comment - and IPython answers namespace matches for the extracted prefix,
		// so a completion list really could pop up in prose.
		const f = fakeHandle(okOutcome([{ text: 'database', type: 'instance' }], 9, 11));
		expect(await query('# import da', 11, f.handle)).toBeNull();
		expect(f.calls).toEqual([]);
	});

	it('never asks while the caret is inside a STRING, on the implicit path', async () => {
		const f = fakeHandle(okOutcome([{ text: 'data/', type: 'path' }], 6, 8));
		expect(await query("open('da')", 8, f.handle)).toBeNull();
		expect(await query('x = f"pre{1}post"', 15, f.handle)).toBeNull();
		expect(f.calls).toEqual([]);
	});

	it('still completes after a DOT - the gate drops PropertyName, which is the headline case', async () => {
		// `@codemirror/lang-python`'s own `dontComplete` includes `PropertyName`, which
		// is why its sources bail after a dot. Copying that list wholesale here would
		// disable live-object attribute completion, the thing this source exists for.
		const f = fakeHandle(okOutcome([{ text: 'pathsep', type: 'instance' }], 3, 5));
		const res = await query('os.pa', 5, f.handle);
		expect(res?.options.map((o) => o.label)).toEqual(['pathsep']);
		expect(f.calls.length).toBe(1);
	});

	it('asks anyway when the user pressed Tab - which is what reaches path completion in a string', async () => {
		const f = fakeHandle(okOutcome([{ text: 'data/', type: 'path' }], 6, 6));
		const res = await query("open('", 6, f.handle, true);
		expect(res?.options.map((o) => o.label)).toEqual(['data/']);
		expect(f.calls[0]).toMatchObject({ code: "open('", cursorPos: 6 });
	});

	it('asks anyway when the user pressed Tab inside a COMMENT too - explicit bypasses both gates', async () => {
		const f = fakeHandle(okOutcome([{ text: 'database', type: 'instance' }], 9, 11));
		const res = await query('# import da', 11, f.handle, true);
		expect(res?.options.map((o) => o.label)).toEqual(['database']);
		expect(f.calls.length).toBe(1);
	});
});

describe('the option shape is what makes CodeMirror’s cross-source dedupe work', () => {
	it('emits ONLY label and a mapped type - no detail, no boost', async () => {
		const f = fakeHandle(
			okOutcome(
				[
					{ text: 'print', type: 'function' },
					{ text: 'os', type: 'module' },
					{ text: 'mystery', type: '<unknown>' }
				],
				0,
				2
			)
		);
		const res = await query('pr', 2, f.handle);
		expect(res?.options).toEqual([
			// `print` here is byte-identical to what `@codemirror/lang-python`'s builtin
			// list emits, which is exactly why the merged list shows it once.
			{ label: 'print', type: 'function' },
			{ label: 'os', type: 'namespace' },
			// An unmodelled type carries NO `type` rather than an invented one: a null
			// type on either side still counts as agreement for the dedupe.
			{ label: 'mystery' }
		]);
		for (const o of res!.options) {
			expect(o).not.toHaveProperty('detail');
			expect(o).not.toHaveProperty('boost');
			expect(o).not.toHaveProperty('apply');
		}
	});

	it('maps every type Jedi actually emits onto CodeMirror’s vocabulary', () => {
		// Measured against a real IPython 9.15: these are the `_jupyter_types_experimental`
		// values a live session produces.
		expect(completionType('function')).toBe('function');
		expect(completionType('instance')).toBe('variable');
		expect(completionType('module')).toBe('namespace');
		expect(completionType('class')).toBe('class');
		expect(completionType('keyword')).toBe('keyword');
		expect(completionType('<unknown>')).toBeUndefined();
		expect(completionType(null)).toBeUndefined();
	});
});

describe('the replacement range comes from the protocol, and is refused when it cannot be trusted', () => {
	it('uses the kernel’s own cursor_start/cursor_end', async () => {
		const f = fakeHandle(okOutcome([{ text: 'path', type: 'module' }], 3, 5));
		const res = await query('os.pa', 5, f.handle);
		// Replaces only `pa`, not `os.pa` - the thing a file-only completer guesses at.
		expect(res).toMatchObject({ from: 3, to: 5 });
	});

	it('refuses an inverted or out-of-document range rather than clamping it', async () => {
		// A clamp would silently rewrite a different span of the user's code than the
		// kernel named, which is worse than offering nothing.
		expect(await query('os.pa', 5, fakeHandle(okOutcome([{ text: 'x', type: null }], 5, 3)).handle)).toBeNull();
		expect(await query('os.pa', 5, fakeHandle(okOutcome([{ text: 'x', type: null }], 3, 99)).handle)).toBeNull();
	});

	it('refuses a range that ends PAST the caret', async () => {
		// The user may have typed while the request was out; applying then would eat
		// characters the kernel never saw.
		const f = fakeHandle(okOutcome([{ text: 'x', type: null }], 0, 5));
		expect(await query('os.pa', 3, f.handle)).toBeNull();
	});

	it('has no matches to offer, so it offers nothing', async () => {
		expect(await query('zzz', 3, fakeHandle(okOutcome([], 0, 3)).handle)).toBeNull();
	});
});

describe('every EXPECTED failure is silent - this runs on a keystroke', () => {
	it('returns null for a refusal the server reached', async () => {
		// `busy_timeout` is deliberately absent: it is the one refusal that is NOT an
		// expected state, and it gets its own block below.
		for (const reason of ['no_kernel', 'busy', 'restarting', 'dead', 'not_connected', 'timeout', 'failed'] as const) {
			expect(await query('myva', 4, fakeHandle({ ok: false, reason }).handle)).toBeNull();
		}
	});

	it('returns null when the request never reached the server at all', async () => {
		const f = fakeHandle(() => Promise.reject(new Error('NetworkError')));
		expect(await query('myva', 4, f.handle)).toBeNull();
	});
});

describe('the ONE refusal that is stated, because silence there is a lie', () => {
	// `busy_timeout` means Cellar waited for its OWN background work on the kernel
	// and stopped waiting. The user gets no kernel names for a reason that has
	// nothing to do with what they typed, and returning null makes that
	// indistinguishable from "nothing matched". That was a real, silent, 5-of-5
	// deterministic failure on slower hardware before the wait followed the work.
	it('returns a visible row instead of null', async () => {
		const result = await query('myva', 4, fakeHandle({ ok: false, reason: 'busy_timeout' }).handle);
		expect(result).not.toBeNull();
		expect(result!.options).toHaveLength(1);
		expect(`${result!.options[0].label} ${result!.options[0].detail ?? ''}`).toMatch(/kernel|background/i);
	});

	it('INSERTS NOTHING when it is accepted', async () => {
		// A message the user can accept by reflex must not type itself into their
		// cell - that would be worse than the silence it replaces. `apply` is the
		// hook CodeMirror uses when an option is chosen, so it must be a no-op
		// function rather than absent (absent means "insert the label").
		const result = await query('myva', 4, fakeHandle({ ok: false, reason: 'busy_timeout' }).handle);
		expect(typeof result!.options[0].apply).toBe('function');
	});

	it('does not filter itself away, and leaves the other sources theirs', async () => {
		// It is not a match for what was typed, so CodeMirror would filter it out;
		// and it is one source among several, so it must not claim to be the whole
		// answer.
		const result = await query('myva', 4, fakeHandle({ ok: false, reason: 'busy_timeout' }).handle);
		expect(result!.filter).toBe(false);
	});
});

describe('a stale query cancels its own request', () => {
	it('aborts the fetch when CodeMirror abandons the query', async () => {
		let seen: AbortSignal | undefined;
		const handle: KernelIntrospectHandle = {
			complete: (_c, _p, signal) => {
				seen = signal;
				return new Promise(() => {});
			},
			inspect: async () => ({ ok: false, reason: 'failed' })
		};
		const source = kernelCompletionSource(() => handle);
		const ctx = new CompletionContext(EditorState.create({ doc: 'myva' }), 4, false);
		void source(ctx);
		await Promise.resolve();
		expect(seen?.aborted).toBe(false);
		// What CodeMirror does to a query whose context has moved on.
		(ctx as unknown as { abortListeners: (() => void)[] | null }).abortListeners?.forEach((fn) => fn());
		expect(seen?.aborted).toBe(true);
	});
});

describe('offsets: the protocol counts code points, CodeMirror counts UTF-16 units', () => {
	// Not theoretical: one emoji in a comment above the caret is enough to make the
	// kernel complete a different span of the cell than the editor is looking at,
	// and it degrades silently - as a completion that replaces the wrong characters.
	const withEmoji = '# 🎉 note\nmyva';

	it('sends a code-point offset', async () => {
		const f = fakeHandle(okOutcome([{ text: 'myvar', type: null }], 10, 14));
		await query(withEmoji, withEmoji.length, f.handle);
		expect(f.calls[0].cursorPos).toBe(toCodePointOffset(withEmoji, withEmoji.length));
		// The emoji is one code point but two UTF-16 units, so the two differ by one.
		expect(f.calls[0].cursorPos).toBe(withEmoji.length - 1);
	});

	it('translates the returned range back into editor offsets', async () => {
		// `myva` starts at code point 9 and the caret is at code point 13; in UTF-16
		// units those are 10 and 14.
		const f = fakeHandle(okOutcome([{ text: 'myvar', type: null }], 9, 13));
		const res = await query(withEmoji, withEmoji.length, f.handle);
		expect(res).toMatchObject({ from: 10, to: 14 });
		expect(withEmoji.slice(10, 14)).toBe('myva');
	});

	it('round-trips every offset of an astral string, and refuses one past the end', () => {
		const s = 'a🎉b';
		for (let cp = 0; cp <= 3; cp++) expect(toCodePointOffset(s, fromCodePointOffset(s, cp)!)).toBe(cp);
		expect(fromCodePointOffset(s, 4)).toBeNull();
		expect(fromCodePointOffset(s, -1)).toBeNull();
	});
});

describe('the handle is read per query, not captured', () => {
	it('picks up a kernel that appeared after the editor was built', async () => {
		// A notebook gets its kernel on its FIRST RUN, long after its editors exist.
		let handle: KernelIntrospectHandle | null = null;
		const source = kernelCompletionSource(() => handle);
		const state = EditorState.create({ doc: 'myva' });
		expect(await source(new CompletionContext(state, 4, false))).toBeNull();
		handle = fakeHandle(okOutcome([{ text: 'myvar_unique_xyz', type: 'instance' }], 0, 4)).handle;
		const res = await source(new CompletionContext(state, 4, false));
		expect(res?.options.map((o) => o.label)).toEqual(['myvar_unique_xyz']);
	});
});

describe('what CodeMirror does with the merged list', () => {
	it('is not asked again for every character typed after the answer', async () => {
		const f = fakeHandle(okOutcome([{ text: 'pathsep', type: 'instance' }], 3, 5));
		const res = await query('os.pa', 5, f.handle);
		// `validFor` is what turns `os.` -> `os.pathse` into ONE request rather than
		// seven; IPython returns the complete match set for a prefix, so filtering the
		// answer down locally is exact.
		expect(res?.validFor).toBeInstanceOf(RegExp);
		expect((res!.validFor as RegExp).test('thsep')).toBe(true);
		expect((res!.validFor as RegExp).test('(')).toBe(false);
	});
});
