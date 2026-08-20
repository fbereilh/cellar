// @vitest-environment jsdom
//
// The DOM ids that pair the tab strip with its panes (`$lib/tabIds`).
//
// A tab id is `notebook` or `file:<workspace-relative path>`, so it carries
// whatever the user's filenames carry - and a space is ordinary. An HTML `id`
// may not contain ASCII whitespace, and `aria-controls`/`aria-labelledby` are
// IDREF *LISTS*, so a raw `tabpanel:file:my report.html` parses as two tokens and
// neither resolves: the tab silently loses the pane it controls and the pane
// loses its accessible name.
//
// This runs under jsdom rather than the suite's default `node` environment for
// the same reason `markdown-math.test.ts` does: the claim is about what a real
// DOM does with these strings (does `getElementById` find it, does the IDREF
// resolve), not about the shape of the string, and only a DOM can answer that.

import { describe, it, expect } from 'vitest';
import { tabDomId, tabPanelDomId } from '../../src/lib/tabIds';

/** Every tab id shape the shell can mint, awkward filenames included. */
const TAB_IDS = [
	'notebook',
	'file:alpha.txt',
	'file:my report.html',
	'file:my notes (draft).txt',
	'file:sub dir/deep file.md',
	'file:tabbed\tname.txt',
	'file:100% done.txt',
	// The near-misses a lossy "replace whitespace with a dash" would collapse together.
	'file:a b.txt',
	'file:a-b.txt',
	'file:a%20b.txt'
];

/** Wire one tab + its pane into a real document exactly as the two components do. */
function mount(id: string): { tab: HTMLElement; panel: HTMLElement } {
	const tab = document.createElement('div');
	tab.setAttribute('role', 'tab');
	tab.id = tabDomId(id);
	tab.setAttribute('aria-controls', tabPanelDomId(id));

	const panel = document.createElement('div');
	panel.setAttribute('role', 'tabpanel');
	panel.id = tabPanelDomId(id);
	panel.setAttribute('aria-labelledby', tabDomId(id));

	document.body.append(tab, panel);
	return { tab, panel };
}

/** Resolve an IDREF-LIST attribute the way assistive tech does: split on whitespace. */
function resolveIdrefs(el: Element, attr: string): Element[] {
	const raw = el.getAttribute(attr) ?? '';
	return raw
		.split(/[\t\n\f\r ]+/)
		.filter(Boolean)
		.map((token) => document.getElementById(token))
		.filter((n): n is HTMLElement => n != null);
}

describe('tab DOM ids', () => {
	it('the tab↔panel pairing resolves for every tab id shape, filenames with spaces included', () => {
		for (const id of TAB_IDS) {
			document.body.innerHTML = '';
			const { tab, panel } = mount(id);

			// The half that broke: an id carrying a space is TWO IDREF tokens, so this
			// resolved to nothing at all rather than to the pane.
			const controlled = resolveIdrefs(tab, 'aria-controls');
			expect(controlled, `aria-controls for ${id}`).toEqual([panel]);
			expect(resolveIdrefs(panel, 'aria-labelledby'), `aria-labelledby for ${id}`).toEqual([tab]);

			// And the ids really are the ones the document indexed - a DOM id that the
			// parser mangles would not come back from `getElementById`.
			expect(document.getElementById(tabDomId(id))).toBe(tab);
			expect(document.getElementById(tabPanelDomId(id))).toBe(panel);
		}
	});

	it('no minted id contains ASCII whitespace, and none is empty', () => {
		for (const id of TAB_IDS) {
			for (const domId of [tabDomId(id), tabPanelDomId(id)]) {
				expect(domId, id).not.toMatch(/[\t\n\f\r ]/);
				expect(domId.length, id).toBeGreaterThan(0);
			}
		}
	});

	it('distinct tabs get distinct ids - the escaping may not collapse two open tabs onto one', () => {
		// The trap a lossy `replace(/\s/g, '-')` falls into: `a b` and `a-b` are two
		// real, simultaneously-openable files, and one DOM id between them means one
		// tab's `aria-controls` resolves to the OTHER tab's pane.
		const tabIds = TAB_IDS.map(tabDomId);
		const panelIds = TAB_IDS.map(tabPanelDomId);
		expect(new Set(tabIds).size).toBe(TAB_IDS.length);
		expect(new Set(panelIds).size).toBe(TAB_IDS.length);
		// A tab id can never collide with a panel id either.
		expect(new Set([...tabIds, ...panelIds]).size).toBe(TAB_IDS.length * 2);
	});

	it('an id is stable for a given tab id, so the two components agree across renders', () => {
		for (const id of TAB_IDS) {
			expect(tabDomId(id)).toBe(tabDomId(id));
			expect(tabPanelDomId(id)).toBe(tabPanelDomId(id));
		}
	});

	it('an ordinary tab id is left readable in the DOM', () => {
		expect(tabDomId('notebook')).toBe('tab:notebook');
		expect(tabPanelDomId('file:alpha.txt')).toBe('tabpanel:file:alpha.txt');
	});
});
