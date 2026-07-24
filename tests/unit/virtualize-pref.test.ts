import { describe, it, expect } from 'vitest';
import {
	parseVirtualizeParam,
	resolveVirtualize,
	VIRTUALIZE_DEFAULT,
	VIRTUALIZE_PREF_KEY
} from '../../src/lib/virtualizePref';

/**
 * Virtualization P5: windowed cell rendering is ON by default, and the opt-out has
 * a strict precedence - the `?virtualize=` URL param always beats the persisted
 * viewer preference, so a support session can pin either mode deterministically.
 */
describe('virtualize preference', () => {
	it('defaults to ON with no param and no stored preference', () => {
		expect(VIRTUALIZE_DEFAULT).toBe(true);
		expect(resolveVirtualize(null, undefined)).toEqual({ enabled: true, forced: false });
	});

	it('honors the persisted opt-out when no param is present', () => {
		expect(resolveVirtualize(null, false)).toEqual({ enabled: false, forced: false });
		expect(resolveVirtualize(null, true)).toEqual({ enabled: true, forced: false });
	});

	it('lets the URL param override the stored preference in BOTH directions', () => {
		// The whole point of the escape hatch: off wins over a stored on…
		expect(resolveVirtualize('0', true)).toEqual({ enabled: false, forced: true });
		// …and on wins over a stored off, so a user who opted out can still be asked
		// to reproduce a report with windowing on.
		expect(resolveVirtualize('1', false)).toEqual({ enabled: true, forced: true });
	});

	it('accepts the readable spellings of each side', () => {
		for (const on of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
			expect(parseVirtualizeParam(on)).toBe(true);
		}
		for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
			expect(parseVirtualizeParam(off)).toBe(false);
		}
	});

	it('treats an unrecognized or bare param as no override, not as a side', () => {
		// `?virtualize` alone reads as '' through URLSearchParams; junk is junk. Both
		// fall through to the preference rather than silently picking a mode.
		for (const junk of ['', '  ', 'maybe', '2', null, undefined]) {
			expect(parseVirtualizeParam(junk)).toBeNull();
			expect(resolveVirtualize(junk, false)).toEqual({ enabled: false, forced: false });
			expect(resolveVirtualize(junk, undefined)).toEqual({ enabled: true, forced: false });
		}
	});

	it('ignores a non-boolean stored value (hand-edited store / older build)', () => {
		for (const bad of ['true', 1, 0, {}, [], null]) {
			expect(resolveVirtualize(null, bad)).toEqual({ enabled: true, forced: false });
		}
	});

	it('keys the preference in the per-project UI-state store namespace', () => {
		// Not `localStorage`: the dev port is dynamic, so a per-origin store would
		// reset the opt-out on every relaunch (see `$lib/uiState`).
		expect(VIRTUALIZE_PREF_KEY).toBe('cellar-virtualize-cells');
	});
});
