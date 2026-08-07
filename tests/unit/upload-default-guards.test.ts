/**
 * Two rules about the cross-project upload default that live in components, and
 * therefore cannot be mounted here (vitest runs without the SvelteKit plugin - see
 * `vitest.config.ts`). Their behavioural proof is `tests/e2e/upload-name-defaults.spec.ts`,
 * which neither CI nor the no-mistakes gate runs, so the call sites are pinned here
 * too - the `shell-refresh-handlers` precedent.
 *
 *   1. `Settings.svelte` must not PERSIST a default that fails validation. An unusable
 *      per-project affix disables the upload in the one project on screen; an unusable
 *      GLOBAL default disables it in every project that never set its own, under a
 *      message naming a field the user never typed into there. Refuse, never repair -
 *      and never delete a previously valid stored default over a half-typed character.
 *      The verdict must be PER FIELD (`isStorableAffix`), never the pane's combined
 *      `defaultsResolved`: each affix is its own key, so a paired verdict refuses to
 *      store a good postfix while the prefix is invalid and then never writes it.
 *
 *   2. `Databricks.svelte`'s DEFERRED affix seed must not drop an armed replace confirm.
 *      For a `status:'exists'` reply that box is the ENTIRE outcome (`uploadDone` and
 *      `uploadError` are both null), so clearing it leaves nothing at all on screen for
 *      an attempt that has just settled. It is safe to keep because `uploadExistsAffixes`
 *      pins what produced the path it names, so Replace still overwrites that path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETTINGS = readFileSync(join(process.cwd(), 'src/lib/Settings.svelte'), 'utf8');
const PANEL = readFileSync(join(process.cwd(), 'src/lib/Databricks.svelte'), 'utf8');

/**
 * The brace-balanced block opening at `marker`'s FIRST `{`. Reading the real block
 * rather than a window of N lines is what keeps the guard honest when the code
 * around it is reshuffled.
 */
function blockAt(src: string, marker: string, where: string): string {
	const start = src.indexOf(marker);
	expect(start, `anchor not found in ${where}: ${marker}`).toBeGreaterThan(-1);
	const brace = marker.indexOf('{');
	expect(brace, `anchor opens no block: ${marker}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start + brace; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced block at anchor: ${marker}`);
}

/**
 * `src` with its `//` comments dropped.
 *
 * A guard that asserts something is ABSENT has to read the code alone: these blocks
 * carry long comments that NAME the mechanism they were changed away from - which is
 * exactly the prose worth keeping - and a raw scan reads that as the mechanism still
 * being there. (Naive about a `//` inside a string or a regex; neither appears in the
 * blocks pinned here, and a false positive would fail loudly rather than pass.)
 */
function codeOnly(src: string): string {
	return src.replace(/^\s*\/\/.*$/gm, '');
}

describe('Settings: an invalid upload default is refused, not persisted', () => {
	const fn = blockAt(
		SETTINGS,
		"function setUploadDefault(which: 'prefix' | 'postfix', v: string) {",
		'Settings.svelte'
	);

	const GUARD = 'if (!isStorableAffix(v, defaultsNow)) return;';

	it('returns on an unusable affix BEFORE reaching the store', () => {
		const guard = fn.indexOf(GUARD);
		const write = fn.indexOf('setUserSetting(');
		expect(guard, 'no validation guard in setUploadDefault').toBeGreaterThan(-1);
		expect(write, 'setUploadDefault no longer writes the store').toBeGreaterThan(-1);
		// Ordering is the whole rule: a guard after the write refuses nothing.
		expect(guard).toBeLessThan(write);
	});

	it('judges the field being written, never the pane-wide resolve', () => {
		// `defaultsResolved` validates the PAIR against one assembled name, so gating on
		// it lost a valid postfix typed while the prefix was broken - and the recovering
		// write carries only `which`, so nothing ever put that postfix back.
		expect(codeOnly(fn)).not.toContain('defaultsResolved');
	});

	it('still reflects what was typed, so the field shows it and the error explains it', () => {
		// Local state is assigned unconditionally, ahead of the guard - the refusal is
		// about the STORE, never about repairing or discarding the user's text.
		const local = fn.indexOf('uploadPrefixDefault = v;');
		expect(local).toBeGreaterThan(-1);
		expect(local).toBeLessThan(fn.indexOf(GUARD));
	});
});

describe('Databricks: a deferred affix seed keeps the armed replace confirm', () => {
	const fn = blockAt(PANEL, 'function seedUploadAffixes() {', 'Databricks.svelte');

	it('clears the previous feedback only when nothing arrived while it waited', () => {
		expect(fn).toContain('if (!arrived) clearUploadFeedback();');
	});

	it('never tears the confirm down itself', () => {
		// `clearUploadFeedback` is the one owner of that teardown, and it is reachable
		// here only on the not-arrived path above. A direct write would resurrect the
		// bug: the box dismissed a frame after an `exists` reply put it on screen.
		expect(codeOnly(fn)).not.toMatch(/uploadExistsPath\s*=/);
		expect(codeOnly(fn)).not.toMatch(/uploadExistsAffixes\s*=/);
	});
});
