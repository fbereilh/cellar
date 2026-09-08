// @vitest-environment jsdom
/**
 * The Shift+Tab documentation tooltip's editor half, driven against a REAL
 * `EditorView` in jsdom (this repo already mounts one that way - see
 * `directive-comment.test.ts`).
 *
 * The claims worth pinning here are the ones about STATE rather than about pixels:
 * that a second press escalates `detail_level` 0 -> 1 rather than re-asking the
 * same question, that the tooltip goes when the caret moves or the doc changes or
 * the editor blurs, that Escape closes it and only then falls through to the
 * notebook's command-mode shortcut, and that a slow reply landing after any of
 * those repaints NOTHING. Whether it is positioned prettily is an e2e question.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
	DOC_TOOLTIP_CLASS,
	DOC_TOOLTIP_MORE_TESTID,
	closeDocTooltip,
	docTooltipOpen,
	kernelDocTooltip,
	showKernelDocs
} from '../../src/lib/kernelDocTooltip';
import { refusalMessage, type InspectOutcome, type KernelIntrospectHandle } from '../../src/lib/kernelIntrospect';

interface InspectCall {
	code: string;
	cursorPos: number;
	detail: 0 | 1;
}

/** A handle whose `inspect` answers per detail level and records every ask. */
function fakeHandle(reply: (call: InspectCall) => InspectOutcome | Promise<InspectOutcome>) {
	const calls: InspectCall[] = [];
	const handle: KernelIntrospectHandle = {
		complete: async () => ({ ok: false, reason: 'failed' }),
		inspect: (code, cursorPos, detail) => {
			const call = { code, cursorPos, detail };
			calls.push(call);
			return Promise.resolve(reply(call));
		}
	};
	return { handle, calls };
}

/**
 * Mount an editor into its OWN parent, tracked for teardown.
 *
 * Both halves matter for isolation: CodeMirror puts a tooltip in the view's parent
 * node, so scoping the lookup there is what keeps one test's tooltip out of the
 * next test's `querySelector`; and the registry is what stops a test that FAILS
 * before its `destroy()` from dragging every later test down with it - the exact
 * shape AGENTS.md names for the upload-affix specs.
 */
const mounted: EditorView[] = [];
function mount(doc: string, pos = doc.length): EditorView {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const view = new EditorView({
		parent,
		state: EditorState.create({ doc, extensions: [kernelDocTooltip], selection: { anchor: pos } })
	});
	mounted.push(view);
	return view;
}

afterEach(() => {
	for (const v of mounted.splice(0)) {
		v.destroy();
		v.dom.parentElement?.remove();
	}
});

/** The tooltip's rendered element in THIS view, or null when nothing is on screen. */
function tooltipDom(view: EditorView): HTMLElement | null {
	return view.dom.parentElement?.querySelector<HTMLElement>(`.${DOC_TOOLTIP_CLASS}`) ?? null;
}

function tooltipText(view: EditorView): string {
	return tooltipDom(view)?.querySelector('pre')?.textContent ?? '';
}

/** Let the handle's promise and the dispatch it triggers settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const DOCS = 'Signature: t.hello(a, b=2)\nDocstring: Say hello nicely.';
const SOURCE_DOCS = `${DOCS}\nSource:\n    def hello(self, a, b=2): ...`;

describe('the first press asks the kernel about the caret', () => {
	it('sends the WHOLE cell source and the caret offset, at detail 0', async () => {
		const f = fakeHandle(() => ({ ok: true, found: true, text: DOCS, detail: 0 }));
		const view = mount('x = 1\nt.hello(1, ');
		expect(showKernelDocs(view, f.handle)).toBe(true);
		await settle();
		// The kernel's own `token_at_cursor` is what finds the callable from inside a
		// call's arguments; extracting a name here would be a second, worse copy of it.
		expect(f.calls).toEqual([{ code: 'x = 1\nt.hello(1, ', cursorPos: 17, detail: 0 }]);
		expect(tooltipText(view)).toBe(DOCS);
	});

	it('declines - and asks nothing - for a cell with no kernel handle', async () => {
		const view = mount('some prose');
		// Markdown, raw, chat, SQL and mojo cells all reach here with a null handle;
		// returning false is what leaves Shift+Tab its default behaviour there.
		expect(showKernelDocs(view, null)).toBe(false);
		expect(docTooltipOpen(view.state)).toBe(false);
	});

	it('shows a waiting line immediately rather than looking like a dead key', async () => {
		let release!: (v: InspectOutcome) => void;
		const f = fakeHandle(() => new Promise<InspectOutcome>((res) => (release = res)));
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		expect(tooltipText(view)).toMatch(/Looking up/);
		release({ ok: true, found: true, text: DOCS, detail: 0 });
		await settle();
		expect(tooltipText(view)).toBe(DOCS);
	});
});

describe('the second press expands, exactly as classic Jupyter does', () => {
	it('escalates detail 0 -> 1 and replaces the text', async () => {
		const f = fakeHandle((c) => ({
			ok: true,
			found: true,
			text: c.detail === 1 ? SOURCE_DOCS : DOCS,
			detail: c.detail
		}));
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		await settle();
		expect(tooltipText(view)).toBe(DOCS);
		// The "press again" footer is what promises the expansion, so it must be there
		// at level 0...
		expect(tooltipDom(view)?.querySelector(`[data-testid="${DOC_TOOLTIP_MORE_TESTID}"]`)).not.toBeNull();

		showKernelDocs(view, f.handle);
		await settle();
		expect(f.calls.map((c) => c.detail)).toEqual([0, 1]);
		expect(tooltipText(view)).toBe(SOURCE_DOCS);
		// ...and gone at level 1, where a second press would show nothing more. A hint
		// that lies is worse than no hint.
		expect(tooltipDom(view)?.querySelector(`[data-testid="${DOC_TOOLTIP_MORE_TESTID}"]`)).toBeNull();
	});

	it('keeps the text on screen while expanding, instead of blanking it', async () => {
		let release!: (v: InspectOutcome) => void;
		const f = fakeHandle((c) =>
			c.detail === 0
				? { ok: true, found: true, text: DOCS, detail: 0 }
				: new Promise<InspectOutcome>((res) => (release = res))
		);
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		await settle();
		showKernelDocs(view, f.handle);
		// A second press that replaced the docstring with "Looking up…" would read as
		// having LOST the answer rather than as adding to it.
		expect(tooltipText(view)).toBe(DOCS);
		release({ ok: true, found: true, text: SOURCE_DOCS, detail: 1 });
		await settle();
		expect(tooltipText(view)).toBe(SOURCE_DOCS);
	});

	it('stops at level 1: a third press asks nothing more and keeps the tooltip', async () => {
		const f = fakeHandle((c) => ({ ok: true, found: true, text: c.detail === 1 ? SOURCE_DOCS : DOCS, detail: c.detail }));
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		await settle();
		showKernelDocs(view, f.handle);
		await settle();
		expect(showKernelDocs(view, f.handle)).toBe(true);
		await settle();
		expect(f.calls.length).toBe(2);
		expect(tooltipText(view)).toBe(SOURCE_DOCS);
	});

	it('a press while a request is in flight does not start a second one', async () => {
		let release!: (v: InspectOutcome) => void;
		const f = fakeHandle(() => new Promise<InspectOutcome>((res) => (release = res)));
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		showKernelDocs(view, f.handle);
		showKernelDocs(view, f.handle);
		// Two replies in a race would let the loser silently overwrite the winner.
		expect(f.calls.length).toBe(1);
		release({ ok: true, found: true, text: DOCS, detail: 0 });
		await settle();
		expect(tooltipText(view)).toBe(DOCS);
	});
});

describe('dismissal follows the editor’s other overlays', () => {
	async function open(view: EditorView, f: ReturnType<typeof fakeHandle>) {
		showKernelDocs(view, f.handle);
		await settle();
		expect(docTooltipOpen(view.state)).toBe(true);
	}
	const ok = () => fakeHandle(() => ({ ok: true, found: true, text: DOCS, detail: 0 }) as InspectOutcome);

	it('closes when the caret moves', async () => {
		const view = mount('t.hello(');
		await open(view, ok());
		view.dispatch({ selection: { anchor: 2 } });
		expect(docTooltipOpen(view.state)).toBe(false);
		expect(tooltipDom(view)).toBeNull();
	});

	it('closes when the document changes', async () => {
		const view = mount('t.hello(');
		await open(view, ok());
		view.dispatch({ changes: { from: 0, to: 0, insert: 'z' } });
		expect(docTooltipOpen(view.state)).toBe(false);
	});

	it('closes on blur, like the completion popup’s `closeOnBlur`', async () => {
		const view = mount('t.hello(');
		await open(view, ok());
		view.contentDOM.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
		expect(docTooltipOpen(view.state)).toBe(false);
	});

	it('a mousedown INSIDE it is not a blur - the 22em scroll box stays readable', async () => {
		// `.cm-cellar-doc` is `overflow: auto`, so dragging its scrollbar (or clicking
		// its text) would move focus off `.cm-content` and the blur rule above would
		// dismiss the very docstring being read. Cancelling the default is what stops
		// the focus change - the same guard `@codemirror/autocomplete` puts on its own
		// list ("Prevent focus change when clicking the scrollbar").
		const view = mount('t.hello(');
		await open(view, ok());
		const dom = tooltipDom(view)!;
		const onBox = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		dom.dispatchEvent(onBox);
		expect(onBox.defaultPrevented).toBe(true);
		expect(docTooltipOpen(view.state)).toBe(true);

		// A press on the body TEXT bubbles to the same guard, so selecting a signature
		// does not close it either.
		const onBody = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		dom.querySelector('pre')!.dispatchEvent(onBody);
		expect(onBody.defaultPrevented).toBe(true);
		expect(docTooltipOpen(view.state)).toBe(true);

		// The guard is scoped to the tooltip: a press elsewhere on the page is untouched.
		const elsewhere = document.body.appendChild(document.createElement('div'));
		const outside = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		elsewhere.dispatchEvent(outside);
		expect(outside.defaultPrevented).toBe(false);
		elsewhere.remove();

		// And a GENUINE blur - clicking another cell, tabbing away - still closes it.
		view.contentDOM.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
		expect(docTooltipOpen(view.state)).toBe(false);
	});

	it('Escape closes it, and only then falls through to command mode', async () => {
		const view = mount('t.hello(');
		await open(view, ok());
		// `editorOverlayOpen` is what makes the notebook's window-capture dispatcher
		// yield Escape to the editor; `closeDocTooltip` returning false with nothing
		// open is what lets the SAME key reach command mode a moment later.
		expect(closeDocTooltip(view)).toBe(true);
		expect(docTooltipOpen(view.state)).toBe(false);
		expect(closeDocTooltip(view)).toBe(false);
	});
});

describe('a reply that arrives too late repaints nothing', () => {
	it('is dropped when the caret has moved since the ask', async () => {
		let release!: (v: InspectOutcome) => void;
		const f = fakeHandle(() => new Promise<InspectOutcome>((res) => (release = res)));
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		view.dispatch({ selection: { anchor: 1 } }); // closes the tooltip
		release({ ok: true, found: true, text: DOCS, detail: 0 });
		await settle();
		expect(docTooltipOpen(view.state)).toBe(false);
		expect(tooltipDom(view)).toBeNull();
	});

	it('is dropped when a NEWER press already owns the tooltip', async () => {
		const releases: ((v: InspectOutcome) => void)[] = [];
		const f = fakeHandle(() => new Promise<InspectOutcome>((res) => releases.push(res)));
		const view = mount('t.hello(');
		showKernelDocs(view, f.handle);
		// Move away and back: the first request is now stale, and a fresh press owns
		// the tooltip.
		view.dispatch({ selection: { anchor: 1 } });
		view.dispatch({ selection: { anchor: 8 } });
		showKernelDocs(view, f.handle);
		expect(releases.length).toBe(2);
		releases[1]({ ok: true, found: true, text: 'NEW', detail: 0 });
		await settle();
		expect(tooltipText(view)).toBe('NEW');
		releases[0]({ ok: true, found: true, text: 'STALE', detail: 0 });
		await settle();
		expect(tooltipText(view)).toBe('NEW');
	});
});

describe('what it says when there are no docs', () => {
	it('states the refusal - a direct question deserves an answer, not silence', async () => {
		for (const reason of ['no_kernel', 'busy', 'restarting', 'dead', 'not_connected', 'timeout'] as const) {
			const f = fakeHandle(() => ({ ok: false, reason }) as InspectOutcome);
			const view = mount('t.hello(');
			showKernelDocs(view, f.handle);
			await settle();
			expect(tooltipText(view)).toBe(refusalMessage(reason));
			// It is a message, not documentation, so it never offers to expand.
			expect(tooltipDom(view)?.querySelector(`[data-testid="${DOC_TOOLTIP_MORE_TESTID}"]`)).toBeNull();
			}
	});

	it('says the kernel found nothing - which is an ANSWER, not a failure', async () => {
		const f = fakeHandle(() => ({ ok: true, found: false, text: '', detail: 0 }) as InspectOutcome);
		const view = mount('nosuchname(');
		showKernelDocs(view, f.handle);
		await settle();
		expect(tooltipText(view)).toMatch(/No documentation found/);
	});

	it('says only that the server could not be reached when nothing was observed at all', async () => {
		// The handle THROWS for a transport failure rather than inventing a reason: a
		// rejected fetch says nothing about the kernel, so nothing may be claimed
		// about it.
		const handle: KernelIntrospectHandle = {
			complete: async () => ({ ok: false, reason: 'failed' }),
			inspect: () => Promise.reject(new Error('NetworkError'))
		};
		const view = mount('t.hello(');
		showKernelDocs(view, handle);
		await settle();
		expect(tooltipText(view)).toMatch(/could not reach the server/);
	});
});
