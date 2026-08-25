/**
 * Server error text on its way to a user-facing surface.
 *
 * A server throw knows only ABSOLUTE paths - `loadDoc` raises
 * `'notebook not found: ' + abs` - and this UI addresses notebooks
 * workspace-relative everywhere else. Forwarding such a message verbatim put
 * `/private/var/folders/.../beta.ipynb` into a toast, which names a location the
 * user has no way to act on and leaks the machine's layout into the interface.
 *
 * The repo already settled this for the sibling case: `GitNotebooks`' `unreadable`
 * flag deliberately carries NO message, because the only thing that throw knows is
 * an absolute server path. This is the same rule where it was missed - but applied
 * so the REASON survives, since the caller here has a genuinely useful one to show
 * ("notebook not found") and the caller already names the notebook itself, in its
 * workspace-relative form. So what is removed is the PATH, not the explanation.
 *
 * Deliberately blunt: it drops any token that begins with `/` or a Windows drive
 * root, which is what an absolute path looks like and what a relative path (the
 * form this UI speaks) never does. A message left empty by that removal is
 * reported as nothing rather than as a stray fragment - the caller decides what to
 * say when there is no reason left worth showing.
 */

/** An absolute POSIX path, a UNC path, or a Windows drive path. */
const ABSOLUTE_PATH = /(?:^|\s)(?:[A-Za-z]:)?[\\/][^\s]*/g;

/**
 * `message` with every absolute filesystem path removed, tidied so it still reads
 * as a sentence fragment. Returns '' when nothing usable is left.
 */
export function reasonWithoutServerPath(message: string): string {
	return message
		.replace(ABSOLUTE_PATH, '')
		.replace(/\s+/g, ' ')
		.replace(/[\s:;,.-]+$/, '')
		.trim();
}
