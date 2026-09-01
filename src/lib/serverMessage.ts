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
 *
 * A path is not always introduced by a SPACE, and the commonest source of these
 * messages is the one that proves it: Node quotes it (`EACCES: permission denied,
 * open '/Users/<name>/ws/notebook.ipynb'`), so a whitespace-only boundary matched
 * nothing and forwarded the whole path verbatim. The boundary therefore includes
 * the usual openers, and the token runs to whitespace OR the matching closer so
 * the quotes go with what they wrap.
 */

/** Characters an absolute path may be introduced by, besides the start of the string. */
const OPENERS = "\\s'\"`([{<";
/**
 * Characters an absolute path may be terminated by, besides whitespace. Quotes
 * ONLY: a bracket is far commoner INSIDE a path (`report(2).ipynb`) than around
 * one, and stopping there would leave the tail of the path on screen.
 */
const CLOSERS = "'\"`";

/** An absolute POSIX path, a UNC path, or a Windows drive path, with any quoting. */
const ABSOLUTE_PATH = new RegExp(
	`(?:^|[${OPENERS}])(?:[A-Za-z]:)?[\\\\/][^\\s${CLOSERS}]*[${CLOSERS}]?`,
	'g'
);

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
