/**
 * The nbdev metadata-preservation hazard, as a shared vocabulary and one copy rule.
 *
 * Browser-safe on purpose (the `$lib/hideInput` / `$lib/agentVisibility`
 * precedent): the server detects and writes (`$lib/server/nbdev`), the sidebar
 * renders, and both read the SAME state type and the SAME sentences from here.
 * A second copy of "what is at risk and what the fix is" is how a card comes to
 * promise something the writer will refuse.
 *
 * `nbdevNotice` is also the ONE place that decides whether there is anything to
 * say at all - the "never nag a user who is already fine" rule, by construction
 * rather than by an `{#if}` in a template that vitest cannot mount.
 */

/** The metadata namespace Cellar owns, and the value the allowlists must carry. */
export const CELLAR_METADATA_KEY = 'cellar';

/** nbdev's config table. `tool.nbdev` present in ANY form makes it an nbdev project. */
export const NBDEV_TABLE = ['tool', 'nbdev'];

/** The two keys, notebook-level then cell-level. This is the order they are written in. */
export const ALLOWLIST_KEYS = ['allowed_metadata_keys', 'allowed_cell_metadata_keys'] as const;

/**
 * The lines a user would add by hand. Shown verbatim wherever Cellar refuses to
 * write, because they work whatever shape the file is in - which is what keeps a
 * refusal actionable rather than a dead end.
 */
export const REMEDY_LINES: readonly string[] = Object.freeze([
	`[${NBDEV_TABLE.join('.')}]`,
	...ALLOWLIST_KEYS.map((k) => `${k} = ["${CELLAR_METADATA_KEY}"]`)
]);

export type NbdevState =
	/** No `pyproject.toml` with `[tool.nbdev]` above the workspace: nothing to say. */
	| { kind: 'none' }
	/**
	 * No nbdev `pyproject.toml`, but a legacy `settings.ini` that looks like
	 * nbdev's. nbdev 3.0.0 turned that from a warning into a hard raise, so it is
	 * reported as the actionable condition it is - never migrated, which is
	 * `nbdev-migrate-config`'s job and not Cellar's.
	 */
	| { kind: 'legacy-settings-ini'; path: string }
	/** An nbdev-looking `pyproject.toml` Cellar cannot read with confidence. */
	| { kind: 'unreadable'; path: string; reason: string }
	/** An nbdev project whose `[tool.nbdev]` is not a plain table (1-based line). */
	| { kind: 'other-form'; path: string; line: number }
	/** An nbdev project whose `[tool.nbdev]` holds an allowlist Cellar cannot edit. */
	| { kind: 'unwritable-value'; path: string; key: string; line: number }
	/** Both allowlists already carry `cellar`. Nothing to offer. */
	| { kind: 'protected'; path: string }
	/** The hazard: an nbdev project missing (or short of) the allowlist keys. */
	| { kind: 'unprotected'; path: string; missing: string[] };

export type NbdevNotice = {
	/** Short headline. */
	title: string;
	/** What is at risk, and why. */
	body: string;
	/** The `pyproject.toml` (or `settings.ini`) the notice is about. */
	path: string;
	/** True only when Cellar can do it itself; otherwise the remedy lines are the fix. */
	canWrite: boolean;
	/** What to do when Cellar will not (or cannot) write it. Empty when it can. */
	hint: string;
};

/**
 * What the WIPE costs, in the user's terms rather than nbdev's. Named keys, not
 * "metadata": the point of the sentence is that these are settings the user set.
 */
const AT_RISK =
	"strips every notebook and cell metadata key it does not recognise, so Cellar's export target, report view, header numbering and per-cell export marks are silently erased";

/** Which tools run that cleanup, stated as what the user installed rather than as internals. */
const WHO_CLEANS =
	"nbdev's cleanup (nbdev-clean, and the Jupyter save hook nbdev-install-hooks installs)";

const BY_HAND = `add these lines to [${NBDEV_TABLE.join('.')}] by hand`;

/**
 * The notice for a state, or `null` when there is nothing worth saying.
 *
 * Silent for `none` (not an nbdev project) and for `protected` (already fine) -
 * so the card cannot nag, and cannot re-offer once the keys are present.
 */
export function nbdevNotice(state: NbdevState): NbdevNotice | null {
	switch (state.kind) {
		case 'none':
		case 'protected':
			return null;
		case 'unprotected':
			return {
				title: "nbdev will erase Cellar's notebook settings",
				body: `This is an nbdev project. ${WHO_CLEANS} ${AT_RISK}. nbdev's own fix is two keys in its config.`,
				path: state.path,
				canWrite: true,
				hint: ''
			};
		case 'other-form':
			return {
				title: "nbdev will erase Cellar's notebook settings",
				body: `This is an nbdev project. ${WHO_CLEANS} ${AT_RISK}. Its ${NBDEV_TABLE.join('.')} is not a plain table (line ${state.line}), so Cellar will not edit it rather than risk the rest of the file.`,
				path: state.path,
				canWrite: false,
				hint: BY_HAND
			};
		case 'unwritable-value':
			return {
				title: "nbdev will erase Cellar's notebook settings",
				body: `This is an nbdev project. ${WHO_CLEANS} ${AT_RISK}. ${state.key} (line ${state.line}) is not a plain list of strings, so Cellar will not rewrite it.`,
				path: state.path,
				canWrite: false,
				hint: `set ${state.key} to a list that includes "${CELLAR_METADATA_KEY}"`
			};
		case 'unreadable':
			return {
				title: 'nbdev config could not be read',
				body: `This looks like an nbdev project, but its config ${state.reason}, so Cellar cannot tell whether ${WHO_CLEANS} would erase its notebook settings.`,
				path: state.path,
				canWrite: false,
				hint: `fix the file, then ${BY_HAND}`
			};
		case 'legacy-settings-ini':
			return {
				title: 'nbdev will refuse to run here',
				body:
					'nbdev 3.0.0 moved its config into pyproject.toml and now raises on a leftover settings.ini rather than warning. Until it is migrated nbdev cannot run, and Cellar cannot protect its notebook settings from nbdev\'s cleanup either.',
				path: state.path,
				canWrite: false,
				hint: 'migrate it with nbdev-migrate-config'
			};
	}
}
