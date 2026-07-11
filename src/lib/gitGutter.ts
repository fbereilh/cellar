/**
 * Cellar — VS Code-style git change bars in the CodeMirror gutter.
 *
 * The server hands out the file's git-HEAD text once (`/api/fs/git/head`); this
 * extension re-diffs the live document against that baseline on every change, so
 * a marker appears as you type and vanishes the moment you undo back to HEAD.
 * Added lines get a green bar, modified lines a blue bar, and a deleted run
 * leaves a red triangle at the seam it was removed from.
 *
 * Colors come from the shared `--cellar-git-*` palette in `app.css`, which
 * resolves per light/dark theme on its own — nothing to reconfigure here when
 * the app theme toggles.
 */
import { EditorView, gutter, GutterMarker } from '@codemirror/view';
import {
	EditorState,
	type Extension,
	RangeSet,
	RangeSetBuilder,
	StateEffect,
	StateField
} from '@codemirror/state';
import { lineChanges, type LineChangeType } from '$lib/gitdiff';

/** Set (or clear, with `null`) the git-HEAD text this editor diffs against. */
export const setGitBaseline = StateEffect.define<string | null>();

/** One marker per distinct class string; identity is what `RangeSet` dedupes on. */
const markers = new Map<string, GitMarker>();
class GitMarker extends GutterMarker {
	constructor(cls: string) {
		super();
		this.elementClass = cls;
	}
}
function marker(cls: string): GitMarker {
	let m = markers.get(cls);
	if (!m) markers.set(cls, (m = new GitMarker(cls)));
	return m;
}

const CLASS: Record<LineChangeType, string> = { add: 'cm-gitChange-add', mod: 'cm-gitChange-mod' };

/** Point markers at the start of every decorated line, in ascending position. */
function buildMarkers(state: EditorState, baseline: string | null): RangeSet<GitMarker> {
	if (baseline == null) return RangeSet.empty;
	const doc = state.doc.toString();
	if (doc === baseline) return RangeSet.empty;

	const { lines, deletedBefore, deletedAtEnd } = lineChanges(baseline, doc);
	const total = state.doc.lines;
	// A line can carry both a change bar and a deletion seam (a run deleted at the
	// end of a modified block), so classes accumulate per line.
	const classes = new Map<number, string>();
	const add = (line: number, cls: string) => {
		if (line < 1 || line > total) return;
		const cur = classes.get(line);
		classes.set(line, cur ? `${cur} ${cls}` : cls);
	};
	for (const [line, type] of lines) add(line, CLASS[type]);
	for (const [line] of deletedBefore) add(line, 'cm-gitChange-delBefore');
	if (deletedAtEnd) add(total, 'cm-gitChange-delAfter');

	const builder = new RangeSetBuilder<GitMarker>();
	for (const line of [...classes.keys()].sort((a, b) => a - b)) {
		const at = state.doc.line(line).from;
		builder.add(at, at, marker(classes.get(line)!));
	}
	return builder.finish();
}

/** The `gitChanges` state field value: the current baseline + its computed markers. */
interface GitChangesState {
	baseline: string | null;
	markers: RangeSet<GitMarker>;
}

const gitChanges = StateField.define<GitChangesState>({
	create: () => ({ baseline: null, markers: RangeSet.empty }),
	update(value, tr) {
		let baseline = value.baseline;
		let rebased = false;
		for (const e of tr.effects) {
			if (e.is(setGitBaseline)) {
				baseline = e.value;
				rebased = true;
			}
		}
		if (!rebased && !tr.docChanged) return value;
		return { baseline, markers: buildMarkers(tr.state, baseline) };
	}
});

// The gutter is always present (an empty 4px strip when the file matches HEAD or
// isn't tracked), so the code column never shifts as markers come and go.
const gitGutter = gutter({
	class: 'cm-gitGutter',
	markers: (view: EditorView) => view.state.field(gitChanges).markers,
	initialSpacer: () => marker('cm-gitChange-spacer')
});

const BAR = 4; // px — the change bar's width, and the deletion triangle's depth
const TRI = 3; // px — half the deletion triangle's height

const gitGutterTheme = EditorView.baseTheme({
	'.cm-gitGutter': { width: `${BAR}px`, padding: '0', marginRight: '3px' },
	// `background: transparent` is load-bearing: `highlightActiveLineGutter` (in
	// `basicSetup`) classes the current line in EVERY gutter, so without this the
	// caret's line would show a phantom bar here. The change bars are drawn as
	// `::before` overlays instead of the element's own background, so they survive.
	'.cm-gitGutter .cm-gutterElement': {
		position: 'relative',
		width: `${BAR}px`,
		minWidth: `${BAR}px`,
		padding: '0',
		backgroundColor: 'transparent'
	},
	'.cm-gitChange-add::before, .cm-gitChange-mod::before': {
		content: '""',
		position: 'absolute',
		inset: '0'
	},
	'.cm-gitChange-add::before': { backgroundColor: 'var(--cellar-git-added)' },
	'.cm-gitChange-mod::before': { backgroundColor: 'var(--cellar-git-modified)' },
	// A deleted run has no line of its own; mark the seam with a small triangle
	// pointing into the code, at the top (deleted above) or bottom (deleted off
	// the end) edge of the surviving line.
	'.cm-gitChange-delBefore::after, .cm-gitChange-delAfter::after': {
		content: '""',
		position: 'absolute',
		left: '0',
		width: '0',
		height: '0',
		borderLeft: `${BAR + 1}px solid var(--cellar-git-removed)`,
		borderTop: `${TRI}px solid transparent`,
		borderBottom: `${TRI}px solid transparent`
	},
	'.cm-gitChange-delBefore::after': { top: `-${TRI}px` },
	'.cm-gitChange-delAfter::after': { bottom: `-${TRI}px` }
});

/**
 * The extension. Listed *after* `basicSetup` so the bar renders as the rightmost
 * gutter, hard against the code — where VS Code puts it.
 */
export function gitGutterExtension(): Extension[] {
	return [gitChanges, gitGutter, gitGutterTheme];
}
