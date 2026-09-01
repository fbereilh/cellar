/**
 * `reasonWithoutServerPath` - server error text on its way to a user-facing toast.
 *
 * Executed, not read: this is a pure string rule, so every case below drives the
 * real function. The defect it fixes was a stale-card toast reading "Cannot open
 * beta.ipynb: notebook not found: /private/var/folders/.../beta.ipynb" - a
 * location the user cannot act on, and the machine's layout in the interface.
 * The repo settled this for the sibling case (GitNotebooks' `unreadable` carries
 * no message precisely because the throw knows only an absolute path); here the
 * REASON is worth keeping, so only the path is removed.
 */
import { describe, it, expect } from 'vitest';
import { reasonWithoutServerPath } from '../../src/lib/serverMessage';

describe('reasonWithoutServerPath', () => {
	it('keeps the reason and drops the absolute path loadDoc appends', () => {
		// The exact shape `loadDoc` throws: `'notebook not found: ' + abs`.
		expect(
			reasonWithoutServerPath('notebook not found: /private/var/folders/ds/T/cellar-kcard-x/beta.ipynb')
		).toBe('notebook not found');
	});

	it('leaves a message that names no path untouched', () => {
		expect(reasonWithoutServerPath('notebook not found')).toBe('notebook not found');
		expect(reasonWithoutServerPath('kernel is busy')).toBe('kernel is busy');
	});

	it('keeps a WORKSPACE-RELATIVE path, which is how this UI addresses notebooks', () => {
		expect(reasonWithoutServerPath('notebook not found: sub/dir/beta.ipynb')).toBe(
			'notebook not found: sub/dir/beta.ipynb'
		);
	});

	it('drops a Windows drive path and a UNC path too', () => {
		expect(reasonWithoutServerPath('notebook not found: C:\\Users\\me\\beta.ipynb')).toBe('notebook not found');
		expect(reasonWithoutServerPath('notebook not found: \\\\host\\share\\beta.ipynb')).toBe('notebook not found');
	});

	it('drops a path that appears mid-sentence, keeping the words either side', () => {
		expect(reasonWithoutServerPath('could not read /etc/hosts while resolving')).toBe(
			'could not read while resolving'
		);
	});

	it('reports nothing when the message was ONLY a path - the caller decides what to say', () => {
		expect(reasonWithoutServerPath('/private/var/folders/ds/T/beta.ipynb')).toBe('');
		expect(reasonWithoutServerPath('')).toBe('');
		expect(reasonWithoutServerPath('   ')).toBe('');
	});

	it('strips a QUOTED path - the shape every Node fs error uses', () => {
		// `readFileSync` on an unreadable notebook throws exactly this, and it reaches
		// a user-facing surface through both the SSR canonical read and the notebook
		// route. The quote is why a whitespace-only boundary missed it.
		expect(reasonWithoutServerPath(`EACCES: permission denied, open '/Users/me/ws/notebook.ipynb'`)).toBe(
			'EACCES: permission denied, open'
		);
		expect(reasonWithoutServerPath('ELOOP: too many symbolic links, open "/var/ws/notebook.ipynb"')).toBe(
			'ELOOP: too many symbolic links, open'
		);
	});

	it('a path holding brackets still goes whole', () => {
		// Brackets terminate nothing, so the tail of the path cannot survive.
		expect(reasonWithoutServerPath("open '/Users/me/report(2)/nb.ipynb'")).toBe('open');
		expect(reasonWithoutServerPath('read /var/a[1]/b.ipynb here')).toBe('read here');
	});

	it('never returns a string containing an absolute path, for any of the above', () => {
		const cases = [
			'notebook not found: /a/b/c.ipynb',
			'x /a y /b z',
			'C:\\x\\y',
			'\\\\srv\\s\\f',
			'/only/a/path',
			`EACCES: permission denied, open '/a/b/c.ipynb'`,
			'ELOOP: too many symbolic links, open "/a/b/c.ipynb"',
			"open '/a/b(2)/c.ipynb'"
		];
		for (const c of cases) {
			const out = reasonWithoutServerPath(c);
			expect(out, c).not.toMatch(/(?:^|[\s'"`([{<])(?:[A-Za-z]:)?[\\/]/);
		}
	});
});
