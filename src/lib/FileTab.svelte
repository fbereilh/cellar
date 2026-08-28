<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { EditorView, type ViewUpdate } from '@codemirror/view';
	import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import { json as jsonLang } from '@codemirror/lang-json';
	import { yaml as yamlLang } from '@codemirror/lang-yaml';
	import { html as htmlLang } from '@codemirror/lang-html';
	import { StreamLanguage } from '@codemirror/language';
	import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
	import { EDITOR_THEME } from '$lib/editorTheme';
	import { directiveCommentHighlight } from '$lib/directiveComment';
	import { gitGutterExtension, setGitBaseline } from '$lib/gitGutter';
	import MarkdownView from '$lib/MarkdownView.svelte';
	import HtmlPreview from '$lib/HtmlPreview.svelte';
	import { isHtmlPath, hasRelativeAssetRefs } from '$lib/htmlPreview';
	import { saveFitsTransport, resolveBodyLimit } from '$lib/saveLimit';
	import { subscribeEvents } from '$lib/events-client';
	import { externalEdits } from '$lib/externalSync';
	import type { FileChangedEvent } from '$lib/server/fileWatch';
	import type { FileStat } from '$lib/server/fstree';
	import type { BlameLine } from '$lib/server/git';
	import type { BlameReport } from '$lib/blame';
	import type { FileTabApiHandle } from '$lib/types';

	interface Props {
		path: string;
		/** Reports (path, dirty) so the tab bar can show the unsaved indicator. */
		onDirty?: (path: string, dirty: boolean) => void;
		/**
		 * Publishes this tab's imperative handle (today: `requestSave`) to the shell,
		 * which owns the Cmd/Ctrl+S binding for every tab kind. Null on unmount.
		 */
		onRegisterApi?: (path: string, api: FileTabApiHandle | null) => void;
		/** The shell's fsRefreshSignal: a bump re-fetches the git-HEAD baseline. */
		gitRefresh?: number;
		/**
		 * Reports what the status bar should say for the cursor's line: a blame
		 * record, `{unavailable}` when there IS a reason worth saying, or null when
		 * there is simply no blame (untracked / non-repo).
		 */
		onBlame?: (path: string, record: BlameReport | null) => void;
	}

	// A workspace file opened into an editor tab. Owns its own load/save; reports
	// dirty state up so the tab bar can show the unsaved indicator. It also tracks
	// the file on DISK — the server watches it and publishes `file:changed`, which
	// this tab applies as a minimal edit when the buffer is clean and offers behind
	// a Reload / Keep-mine banner when it is not (see the "External on-disk
	// changes" section below for the full rule). `gitRefresh` is the shell's
	// `fsRefreshSignal`: a bump means the workspace's git state may have moved, so
	// re-fetch the HEAD baseline the gutter diffs against.
	// `onBlame(path, record|null)` reports the git-blame record for the line the
	// cursor sits on, so the shell's bottom status bar can show "who last edited
	// this line, and when" (GitLens-style). `null` = no blame (untracked / non-repo).
	let { path, onDirty, gitRefresh = 0, onBlame, onRegisterApi }: Props = $props();

	let editorEl: HTMLDivElement;
	// `$state.raw` so the git-baseline effect below re-runs once the editor exists,
	// without Svelte proxying the EditorView itself.
	let view = $state.raw<EditorView | null>(null);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let errorMsg = $state('');
	// Kept apart from `errorMsg`/`status`: a failed SAVE must not make a perfectly
	// loaded document render as a load error, and it must not be silent either —
	// it shows in the header, where the user just clicked Save.
	let saveError = $state('');
	let dirty = $state(false);
	let saving = $state(false);
	let savedFlash = $state(false);
	// The document is bigger than the save PUT's request body may be, so it is
	// VIEW-ONLY: the editor is read-only and Save is replaced by a chip that says
	// why. Offering an edit whose PUT the server front-end would 413 before any
	// handler runs is the failure this retires - the read cap admits files (a 15 MB
	// self-contained export) far past what the transport accepts, and that
	// transport limit is app-wide and deliberately not raised. The ceiling compared
	// against is the one the RUNNING server enforces (`body.bodyLimit`, uncapped
	// under the Vite dev server), never a client-side guess.
	//
	// Decided at LOAD and re-decided on every EXTERNAL APPLY, never per keystroke.
	// The keystroke half still holds for the reason it always did - a read-only
	// document cannot be typed past the line it was measured against - but an
	// external sync is not typing: `view.dispatch` applies changes regardless of
	// `EditorState.readOnly`, so a file really can cross the line in either
	// direction while open. Decided once, a file grown past it stayed editable and
	// only failed as a 413 on save, and a file shrunk back under it kept a
	// now-false "too large" chip for the life of the tab. Hence the compartment:
	// the read-only extensions are reconfigured with the verdict rather than being
	// frozen into the initial state.
	let saveTooLarge = $state(false);
	/** The in-force request-body ceiling, captured from the load GET. */
	let bodyLimit = Infinity;
	const viewOnly = new Compartment();

	// View-only: only editing goes. The explicit `tabindex` is what keeps the rest
	// true - `editable.of(false)` sets `contenteditable="false"` and adds NO
	// tabindex, so `.cm-content` (where CodeMirror attaches its key handlers) could
	// not take focus at all: a click landed on `.cm-scroller` and every keystroke
	// died there, costing keyboard selection and the editor's own search panel.
	// With it, the document is focusable, selectable and searchable, and still not
	// editable. Cmd/Ctrl+S is not this element's business either way - the shell
	// owns it for every file tab, in every view (see `requestSave`).
	function viewOnlyExtensions(tooLarge: boolean): Extension {
		return tooLarge
			? [
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ tabindex: '0' })
				]
			: [];
	}
	// Cmd/Ctrl+S in a view-only tab is still HANDLED (the shell's capture handler
	// suppresses the browser's own "Save page as…" dialog for every file tab), but
	// there is nothing to persist — and a keystroke that appears to do nothing
	// reads as a bug. So it pulses the chip that already says why, rather than
	// adding a second copy of the same text.
	let viewOnlyFlash = $state(false);
	let viewOnlyTimer: ReturnType<typeof setTimeout> | undefined;

	function flashViewOnly() {
		viewOnlyFlash = true;
		clearTimeout(viewOnlyTimer);
		viewOnlyTimer = setTimeout(() => (viewOnlyFlash = false), 2500);
	}

	// ---- Rendered preview (markdown + html) -----------------------------------
	// Two file kinds can toggle between the raw source editor and a rendered view:
	// `.md`/`.markdown` (the notebook markdown renderer) and `.html`/`.htm` (a
	// SANDBOXED iframe — see `HtmlPreview.svelte`). `liveSource` carries the editor
	// buffer into the preview, so a preview always reflects unsaved edits and
	// toggling back re-renders from the current content. It is sampled when a
	// preview is entered (and after the initial load), never per keystroke: the
	// editor is `display:none` under a preview, so its document cannot change
	// while one is on screen, and a 2 MB export must not be serialized on the
	// edit path. The view choice is remembered across files as a session-wide
	// preference, per kind — markdown defaults to source (you open a `.md` to
	// edit it), HTML defaults to preview (you open an export to look at it).
	type ViewMode = 'source' | 'preview';
	type PreviewKind = 'markdown' | 'html' | null;

	function previewKindOf(p: string): PreviewKind {
		if (/\.(md|markdown)$/i.test(p)) return 'markdown';
		return isHtmlPath(p) ? 'html' : null;
	}
	function viewKeyFor(kind: PreviewKind): string {
		return kind === 'html' ? 'cellar-html-view' : 'cellar-md-view';
	}
	const previewKind = $derived(previewKindOf(path));
	const viewKey = $derived(viewKeyFor(previewKind));

	// The remembered choice is read synchronously at init, not in `onMount`, so an
	// HTML file paints its preview on the first frame instead of flashing the
	// source toggle while the fetch is in flight. `localStorage` is absent under
	// SSR; the catch covers it.
	function initialViewMode(): ViewMode {
		const kind = previewKindOf(path);
		if (!kind) return 'source';
		try {
			const saved = localStorage.getItem(viewKeyFor(kind));
			if (saved === 'preview' || saved === 'source') return saved;
		} catch {}
		return kind === 'html' ? 'preview' : 'source';
	}
	let viewMode = $state<ViewMode>(initialViewMode());
	let liveSource = $state('');
	// Only the HTML preview has the sandbox's relative-asset limitation, and only
	// while it is on screen — `$derived` is lazy, so a source-mode edit never
	// pays for the scan.
	const relativeAssets = $derived(
		previewKind === 'html' && viewMode === 'preview' && hasRelativeAssetRefs(liveSource)
	);

	function setViewMode(m: ViewMode) {
		if (m === 'preview' && view) liveSource = view.state.doc.toString();
		viewMode = m;
		try {
			localStorage.setItem(viewKey, m);
		} catch {}
	}

	// Gated on `ready`, not merely "not error": a preview mounted while the fetch
	// is still in flight would render an empty document — an "Empty file"
	// placeholder for a file that is simply not loaded yet.
	const showPreview = $derived(previewKind !== null && viewMode === 'preview' && status === 'ready');

	// Toggle order: the kind's default view leads.
	const viewModes = $derived<ViewMode[]>(
		previewKind === 'html' ? ['preview', 'source'] : ['source', 'preview']
	);

	// TOML ships no lezer grammar; the official legacy stream mode is the supported
	// path. Its tokens map onto the same highlight tags every other language uses,
	// so both editor themes style it without any theme-side work.
	const tomlLang = () => StreamLanguage.define(tomlMode);

	// Matched on a lowercased path, so every kind is case-insensitive like
	// `previewKindOf`/`isHtmlPath` — a `README.MD` that gets the rendered-preview
	// toggle must also get markdown highlighting in Source mode.
	function langFor(p: string): Extension {
		const q = p.toLowerCase();
		// A jupytext `.py` notebook carries nbdev/Quarto `#|` directives in its cell
		// bodies, so the python branch gets that highlight too - scoped here rather
		// than in `EDITOR_THEME`, which every other kind below shares and where `#|`
		// carries no such meaning. See `directiveComment.ts`.
		if (q.endsWith('.py')) return [python(), directiveCommentHighlight];
		if (q.endsWith('.md') || q.endsWith('.markdown')) return markdown();
		if (q.endsWith('.json') || q.endsWith('.ipynb')) return jsonLang();
		if (q.endsWith('.yml') || q.endsWith('.yaml')) return yamlLang();
		if (q.endsWith('.toml')) return tomlLang();
		if (isHtmlPath(q)) return htmlLang();
		return [];
	}

	function setDirty(v: boolean) {
		if (v !== dirty) {
			dirty = v;
			onDirty?.(path, v);
		}
	}

	// Publish the tab's ONE save entry point (`save()`, shared with the header
	// button) so the shell can drive Cmd/Ctrl+S. The shortcut is owned by the TAB
	// rather than by the editor's keymap because a keymap fires only while
	// `.cm-content` holds focus — and the editor is `display:none` under a
	// rendered preview, the view every `.html` opens in, so the keystroke reached
	// the browser's "Save page as…" dialog with a dirty document still unsaved.
	onMount(() => {
		onRegisterApi?.(path, { requestSave: () => void save() });
		return () => onRegisterApi?.(path, null);
	});

	async function save() {
		if (saving || !view) return;
		if (saveTooLarge) {
			flashViewOnly();
			return;
		}
		saving = true;
		saveError = '';
		try {
			const content = view.state.doc.toString();
			const res = await fetch('/api/fs/file', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path, content })
			});
			if (!res.ok) {
				// An oversize body is rejected by the server BEFORE the route runs, so
				// it carries no JSON message of ours — key it off the status, never off
				// parsing the body (that parse is what used to swallow the failure).
				if (res.status === 413) throw new Error('file too large to save');
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message || `save failed (${res.status})`);
			}
			// The bytes have landed, so this is now the newest word on what disk holds -
			// claimed before reading the response body, so a revalidation still in
			// flight cannot slip in between and be believed. Reading the body is itself
			// an await, though, so this path FETCHES and must therefore re-check its
			// claim afterwards like every other one: an inline `file:changed` landing
			// in that window claims a higher seq and (with `dirty` still true) stashes
			// the newer content behind the banner, which the writes below would
			// otherwise discard while recording OUR bytes as what disk holds.
			const seq = claimDisk();
			// The stat of what we just wrote becomes the baseline, which is what stops
			// the next window focus re-reading a file this tab wrote itself. `parseStat`
			// answers null on anything less than a complete stat, and null simply means
			// "read it next time".
			const written = (await res.json().catch(() => null)) as { stat?: unknown } | null;
			// Only clear dirty if the buffer STILL holds exactly what we just wrote:
			// keystrokes typed during the in-flight PUT are unsaved, and a false clean
			// flag does not merely mislabel them any more - it routes the next external
			// change down the SILENT-apply path instead of the Reload / Keep-mine
			// banner, so those characters would be replaced without being offered.
			// It is decided on the buffer alone, so it holds whether or not this save
			// is still the newest word on disk.
			if (view?.state.doc.toString() === content) setDirty(false);
			if (seq === diskSeq) {
				savedContent = content;
				diskStatBaseline = parseStat(written?.stat);
				// Our bytes are now the disk's bytes, so any stashed external change is
				// resolved: the user chose theirs.
				diskState = 'clean';
				pendingDisk = null;
			}
			savedFlash = true;
			setTimeout(() => (savedFlash = false), 1200);
			// The working-tree file just changed → re-blame so newly-saved lines
			// stop reading "Not Committed Yet" only where git agrees they moved.
			loadBlame();
		} catch (err) {
			saveError = String((err as Error)?.message ?? err);
		} finally {
			saving = false;
		}
	}

	// ---- External on-disk changes --------------------------------------------
	// A `FileTab` used to read its file exactly once, in `onMount`: no polling, no
	// revalidation, so its content was a snapshot taken at open time forever - and
	// a save from that stale tab wrote the snapshot back over whatever an agent had
	// since written. The server now watches the file (`$lib/server/fileWatch.ts`)
	// and publishes `file:changed` on the ordinary event bus; this is the tab's
	// half of that.
	//
	// The rule mirrors the notebook's "changed on server" banner, because the hard
	// thinking about never clobbering active typing was already done there:
	//
	//   clean   → apply silently. This is the common case and the thing being asked
	//             for. Applied as the MINIMAL edit (see `externalEdits`) so the
	//             caret, selection, scroll and undo history survive.
	//   dirty   → do NOT touch the buffer. Stash the incoming content and offer
	//             Reload / Keep mine.
	//   deleted → banner only, whatever the dirty state. The buffer is kept (a save
	//             recreates the file); clearing the editor would destroy work in
	//             response to something the user did not do here.
	//
	// Cellar's OWN saves never reach this path - the watcher suppresses them by
	// content hash server-side (`noteKnownContent`), so a save cannot bounce back.

	/**
	 * Marks a transaction as an external sync rather than the user's typing, so
	 * the update listener does not report the tab dirty for content that came FROM
	 * disk. An annotation rather than a mutable flag: it travels with the
	 * transaction, so it cannot be left set by an early return.
	 */
	const externalSync = Annotation.define<boolean>();

	/** What we believe is on disk right now: the last content read, applied, or saved. */
	let savedContent = '';
	let diskState = $state<'clean' | 'changed' | 'deleted'>('clean');
	/** Disk content held back because the buffer is dirty; applied by Reload. */
	let pendingDisk: string | null = null;
	/** An event that arrived before the editor existed, flushed once it does. */
	let preReadyDisk: string | null = null;

	/**
	 * The `stat` that describes the content we believe disk holds, or null when we
	 * do not know - the baseline for the stat-first revalidation below. Recorded
	 * wherever that belief changes (the load, an accepted observation that carried
	 * a stat, a successful save), and deliberately CLEARED wherever it changes
	 * without one: correctness must never depend on catching every such path, so a
	 * stale or absent baseline has to degrade to an extra read, never to a swallowed
	 * change.
	 */
	let diskStatBaseline: FileStat | null = null;

	const diskBanner = $derived(status === 'ready' && diskState !== 'clean');

	/** A stat is only usable if it is fully there: anything else counts as "unknown". */
	function parseStat(raw: unknown): FileStat | null {
		if (!raw || typeof raw !== 'object') return null;
		const { size, mtimeMs } = raw as { size?: unknown; mtimeMs?: unknown };
		return typeof size === 'number' && typeof mtimeMs === 'number' ? { size, mtimeMs } : null;
	}

	async function fetchDiskContent(): Promise<{ content: string; stat: FileStat | null } | null> {
		try {
			const res = await fetch(`/api/fs/file?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) return null;
			return { content: body.content as string, stat: parseStat(body.stat) };
		} catch {
			return null;
		}
	}

	/**
	 * Has disk moved since we last recorded a stat for it? The cheap half of the
	 * window-focus revalidation - one `stat` instead of a whole-file read.
	 *
	 * THE INVARIANT: this is a short-circuit that may only ever cause an EXTRA
	 * read, never a MISSED change. So every form of doubt answers `true` (go read
	 * it): no baseline recorded, a stat request that failed, an unparseable body,
	 * a file that is gone. A failure is emphatically NOT a deletion either -
	 * reporting one is the watcher's job, and `revalidateFromDisk` returns rather
	 * than inventing one.
	 *
	 * The one residual, stated honestly: a write leaving BOTH size and mtime
	 * identical is not detected on this path. That is a non-issue for every file
	 * under `MAX_WATCHED_FILE_BYTES`, whose content HASH the watcher checks on each
	 * settle; this fallback only carries the oversize and LRU-evicted cases.
	 */
	async function diskMayHaveMoved(): Promise<boolean> {
		const baseline = diskStatBaseline;
		if (!baseline) return true;
		let stat: FileStat | null = null;
		try {
			const res = await fetch(`/api/fs/file/stat?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (res.ok) stat = parseStat(body?.stat);
		} catch {
			return true;
		}
		if (!stat) return true;
		return stat.size !== baseline.size || stat.mtimeMs !== baseline.mtimeMs;
	}

	/** Apply disk content to a CLEAN buffer as one minimal, caret-preserving edit. */
	function applyDiskContent(next: string) {
		if (!view) return;
		const edits = externalEdits(view.state.doc.toString(), next);
		// The document just changed size under the view-only decision, so re-decide
		// it against the same in-force ceiling the load used. Both directions matter:
		// grown past it the tab must stop offering a save that would 413, shrunk back
		// under it the tab must stop claiming a limit it no longer breaches.
		const tooLarge = !saveFitsTransport(path, next, bodyLimit);
		const effects = tooLarge === saveTooLarge ? [] : [viewOnly.reconfigure(viewOnlyExtensions(tooLarge))];
		saveTooLarge = tooLarge;
		// An empty edit list means the buffer already matches; dispatching it would
		// only push a no-op onto the undo history.
		if (edits.length || effects.length) {
			view.dispatch({ changes: edits, effects, annotations: externalSync.of(true) });
		}
		savedContent = next;
		// Assign explicitly: `liveSource` is SAMPLED on entering a preview, never
		// mirrored per keystroke, so without this the rendered markdown would keep
		// showing the pre-sync text while the hidden editor held the new one.
		liveSource = next;
		setDirty(false);
		diskState = 'clean';
		pendingDisk = null;
		// The working tree moved under the gutter and the blame cache.
		loadGitBaseline();
		loadBlame();
	}

	/**
	 * Ordering guard for disk observations, the convention this codebase already
	 * uses for unordered responses (`kernelReqSeq` in `+page.svelte`, `statusSeq`
	 * in `Databricks.svelte`). Every observation claims the newest slot before it
	 * can act; one that had to fetch re-checks its claim afterwards and drops the
	 * result if anything newer landed while it was in flight.
	 *
	 * Without it a slow GET silently REVERTS the editor and then records the stale
	 * bytes as `savedContent`, which suppresses the correction: a window-focus
	 * revalidation fetches A; an inline `file:changed` carrying newer content B
	 * arrives and is applied synchronously; A resolves, differs from B, finds a
	 * clean buffer and overwrites it. No further watcher event follows (the
	 * server's known hash is already B's), so the tab shows A until the next focus.
	 * A synchronous apply therefore has to claim the slot too, not just a fetch.
	 */
	let diskSeq = 0;

	/**
	 * Claim the newest-observation slot, superseding any fetch still in flight.
	 * Called by every path that settles what we believe disk holds - an inline
	 * event, a save, a Reload, a Keep-mine - not just by the fetching ones, since
	 * a stale GET resolving after any of those reverts it just as surely.
	 */
	function claimDisk(): number {
		return ++diskSeq;
	}

	/**
	 * The ONE place a disk observation is acted on (`null` = deleted). Both entry
	 * points funnel here so the no-clobber rules - and what "disk already agrees"
	 * means - exist once; a second copy is how a stale banner survives the backstop.
	 */
	function applyDiskObservation(seq: number, next: string | null, stat: FileStat | null = null) {
		if (seq !== diskSeq) return; // a newer observation landed while this was in flight
		if (status === 'error') return;
		// The stat baseline follows what we believe disk holds. An observation that
		// carried one records it; one that did not (an inline event carries content,
		// never a stat) CLEARS it, so the next focus re-reads rather than trusting a
		// baseline that now describes older bytes. The exception is an observation
		// that moves nothing: disk agreeing with `savedContent` leaves whatever
		// baseline already described `savedContent` perfectly valid, and clearing it
		// there would buy a pointless read on every focus.
		if (stat) diskStatBaseline = stat;
		else if (next !== savedContent) diskStatBaseline = null;
		if (next === null) {
			diskState = 'deleted';
			pendingDisk = null;
			return;
		}
		if (next === savedContent) {
			// Disk agrees with what we believe it holds, so there is nothing new to
			// say - AND anything we were holding back describes a state that no longer
			// exists: a stash whose content an external revert has since undone (the
			// banner would offer to Reload bytes disk does not hold), or a deletion
			// banner for a file that has come back with exactly the content we had.
			// Clearing before the return is what stops either outliving its cause.
			pendingDisk = null;
			preReadyDisk = null;
			diskState = 'clean';
			return;
		}
		if (!view) {
			preReadyDisk = next;
			return;
		}
		if (dirty) {
			pendingDisk = next;
			diskState = 'changed';
			return;
		}
		applyDiskContent(next);
	}

	async function handleDiskChange(ev: FileChangedEvent) {
		if (status === 'error') return;
		const seq = claimDisk();
		if (ev.deleted || ev.content != null) {
			applyDiskObservation(seq, ev.deleted ? null : (ev.content as string));
			return;
		}
		// A file past the inline-event ceiling is announced without its content, so
		// the SSE stream never carries a multi-MB payload; fetch it instead - which
		// is why this path needs the claim re-checked inside `applyDiskObservation`.
		const next = await fetchDiskContent();
		if (next == null) return;
		applyDiskObservation(seq, next.content, next.stat);
	}

	function reloadFromDisk() {
		if (pendingDisk == null) return;
		claimDisk();
		applyDiskContent(pendingDisk);
	}

	/**
	 * Dismiss without touching the buffer. `savedContent` is advanced to what disk
	 * holds so the same change is not re-announced on every window focus - the user
	 * has seen it and chosen their own version; a LATER, different disk change
	 * still raises the banner again.
	 */
	function keepLocalVersion() {
		claimDisk();
		if (pendingDisk != null) savedContent = pendingDisk;
		pendingDisk = null;
		diskState = 'clean';
	}

	onMount(() =>
		subscribeEvents((ev) => {
			// The stream (re)connected. `file:changed` is published globally and is
			// NOT replayed to a late subscriber the way `queue:changed`/`kernel:status`
			// are, so anything published while this tab was disconnected is simply
			// gone - and the only other backstop is `window.focus`, which never fires
			// when the browser window kept focus throughout. So an app-server restart
			// (the documented single-instance takeover) or a transient drop would leave
			// the tab permanently stale. Revalidating here is the same backstop
			// `LiveNotebook` already runs on this frame, and it is stat-first, so a
			// reconnect is cheap.
			if (ev.type === 'sse:open') {
				void revalidateFromDisk();
				return;
			}
			if (ev.type !== 'file:changed') return;
			const fe = ev as unknown as FileChangedEvent;
			if (fe.path !== path) return;
			void handleDiskChange(fe);
		})
	);

	/**
	 * Backstop for any watcher event the platform drops (network/virtual
	 * filesystems deliver unreliably), for a file the watcher refuses for its size,
	 * and for one evicted from its LRU. Runs on window focus and on an SSE
	 * reconnect.
	 *
	 * STAT-FIRST: every mounted file tab runs this, and `readWorkspaceFile` admits
	 * an `.html` export up to 15 MB - the very file the watcher declines, so this is
	 * its ONLY mechanism - so an unconditional read here would put a multi-MB read +
	 * serialize + transfer on the shared event loop for every open tab on each
	 * alt-tab back into the browser. `diskMayHaveMoved` settles the unchanged case
	 * for one `stat` and, per the invariant stated there, only ever errs toward
	 * doing the read anyway.
	 */
	async function revalidateFromDisk() {
		if (status !== 'ready') return;
		if (!(await diskMayHaveMoved())) return;
		const seq = claimDisk();
		const next = await fetchDiskContent();
		// A read failure is not a deletion - the watcher is what reports those.
		if (next == null) return;
		// Content EQUAL to what we hold is deliberately not short-circuited here:
		// it is `applyDiskObservation` that decides what "disk already agrees"
		// means, and it means dropping a stash the world has moved past, not just
		// staying quiet. Two copies of that rule is how a stale banner survives the
		// backstop. The seq claimed BEFORE the fetch is what stops this slow read
		// reverting a newer change that landed while it was in flight.
		applyDiskObservation(seq, next.content, next.stat);
	}

	// ---- Git change bars (gutter) --------------------------------------------
	// Fetch the file's git-HEAD text and hand it to the gutter extension, which
	// re-diffs the live document against it on every edit. An untracked file (or a
	// workspace that isn't a repo) has no baseline → no bars, like VS Code. A file
	// past the decoration ceiling answers `tooLarge` (no `git show` runs) and
	// likewise gets no bars — absent, never wrong.
	async function loadGitBaseline() {
		if (!view) return;
		let baseline: string | null = null;
		try {
			const res = await fetch(`/api/fs/git/head?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (res.ok && body.tracked) baseline = body.content;
		} catch {}
		// The editor may have been torn down while the request was in flight.
		view?.dispatch({ effects: setGitBaseline.of(baseline) });
	}

	// Re-baseline when the editor appears, and whenever the shell signals that the
	// workspace's git state may have moved (a save, a file op, a tree refresh).
	$effect(() => {
		gitRefresh;
		if (view) loadGitBaseline();
	});

	// ---- Git blame (bottom status bar) ---------------------------------------
	// Blame the whole file once (cached), then map the cursor's line to a record
	// as it moves — cheap: no `git` process per keystroke, refreshed only on save
	// / git-state changes. An untracked file or non-repo reports null (no blame).
	let blameLines: BlameLine[] | null = null; // 0-indexed by file line
	// The server refused to blame this file for its size. Asking is what carries
	// that reason back — and it costs one `stat`, not the blame — so the fetch
	// still happens; what it must not do is read as "untracked" in the status bar.
	let blameTooLarge = false;
	let blameTimer: ReturnType<typeof setTimeout>;

	async function loadBlame() {
		blameLines = null;
		blameTooLarge = false;
		try {
			const res = await fetch(`/api/fs/git/blame?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (res.ok && body.tracked) blameLines = body.lines;
			else if (res.ok && body.tooLarge) blameTooLarge = true;
		} catch {}
		reportBlame();
	}

	function reportBlame() {
		if (!onBlame) return;
		if (blameTooLarge) {
			onBlame(path, { unavailable: 'too_large' });
			return;
		}
		if (!view || !blameLines) {
			onBlame(path, null);
			return;
		}
		const head = view.state.selection.main.head;
		const ln = view.state.doc.lineAt(head).number; // 1-based
		onBlame(path, blameLines[ln - 1] ?? null);
	}

	// Debounce cursor moves so a held arrow key doesn't spam the shell.
	function scheduleBlame() {
		clearTimeout(blameTimer);
		blameTimer = setTimeout(reportBlame, 90);
	}

	// A commit / checkout / stash made outside Cellar changes HEAD under us — and
	// so may the file's own content, which is why the content revalidation rides
	// this same "the world may have moved" signal.
	onMount(() => {
		const onFocus = () => {
			loadGitBaseline();
			loadBlame();
			void revalidateFromDisk();
		};
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	// Refresh the blame cache when the workspace's git state may have moved (a
	// save, a file op) — same signal the gutter baseline listens to.
	$effect(() => {
		gitRefresh;
		if (view) loadBlame();
	});

	onDestroy(() => clearTimeout(blameTimer));

	// An `async` onMount returns a promise, so its return value is never used as a
	// cleanup — the editor is torn down here instead.
	onDestroy(() => {
		clearTimeout(viewOnlyTimer);
		view?.destroy();
	});

	onMount(async () => {
		let content = '';
		try {
			const res = await fetch(`/api/fs/file?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'could not open file');
			content = body.content;
			liveSource = content;
			savedContent = content;
			// The route stats BEFORE it reads, so a write landing between the two
			// leaves this describing the OLDER file and the next focus re-reads -
			// the only direction the short-circuit may fail in.
			diskStatBaseline = parseStat(body.stat);
			// Kept for the life of the tab: the ceiling belongs to the running server,
			// so it cannot move under us, and every later re-decision must be made
			// against the same number the load used rather than a re-fetched one.
			bodyLimit = resolveBodyLimit(body.bodyLimit);
			saveTooLarge = !saveFitsTransport(path, content, bodyLimit);
			status = 'ready';
		} catch (err) {
			status = 'error';
			errorMsg = String((err as Error)?.message ?? err);
			return;
		}

		view = new EditorView({
			parent: editorEl,
			state: EditorState.create({
				doc: content,
				extensions: [
					basicSetup,
					langFor(path),
					// After `basicSetup` so the change bar is the rightmost gutter, hard
					// against the code (VS Code's placement).
					gitGutterExtension(),
					EDITOR_THEME,
					// In a compartment so an external sync that changes the document's
					// size can re-decide it (see `saveTooLarge` and `applyDiskContent`).
					viewOnly.of(viewOnlyExtensions(saveTooLarge)),
					EditorView.updateListener.of((v: ViewUpdate) => {
						// Content pulled in FROM disk is not an unsaved local edit.
						const fromDisk = v.transactions.some((t) => t.annotation(externalSync));
						if (v.docChanged && !fromDisk) {
							setDirty(true);
							// The message described content the user has since changed.
							if (saveError) saveError = '';
						}
						// Cursor moved (or the doc shifted the line under it) → re-map blame.
						if (v.selectionSet || v.docChanged) scheduleBlame();
					}),
					EditorView.theme({
						'&': { fontSize: '13.5px', height: '100%' },
						'.cm-content': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
						'.cm-scroller': { overflow: 'auto' }
					})
				]
			})
		});

		// A disk change that landed between the read and the editor existing: the
		// buffer is clean by construction, so apply it rather than drop it. Through
		// the observation funnel, never straight to `applyDiskContent` - a second
		// entry point is exactly what that funnel's contract forbids, and skipping it
		// cost both of its rules here: the "disk already agrees" short-circuit (the
		// common case, where the event carries the same bytes the load GET returned,
		// yet a full apply ran including a redundant git-baseline + `git blame` pair)
		// and the seq check (an event whose settle-read PREDATES the load's read
		// would revert the editor).
		if (preReadyDisk != null) {
			const pending = preReadyDisk;
			preReadyDisk = null;
			applyDiskObservation(claimDisk(), pending);
		}
	});
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between border-b border-base-300 bg-base-100 px-4 py-1.5 text-xs">
		<span class="flex items-center gap-2 font-mono text-base-content/70">
			<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
			{path}
			{#if dirty}<span class="text-warning" title="Unsaved changes">●</span>{/if}
		</span>
		<div class="flex items-center gap-2">
			{#if previewKind}
				<!-- Source ↔ rendered toggle (VS Code-style), for the file kinds that
				     have a rendered view. Preview leads for HTML (it is the default
				     view), source leads for markdown. -->
				<div class="join" role="group" aria-label="{previewKind === 'html' ? 'HTML' : 'Markdown'} view">
					{#each viewModes as m (m)}
						<button
							class="btn btn-xs join-item {viewMode === m ? 'btn-active' : 'btn-ghost'}"
							onclick={() => setViewMode(m)}
							aria-pressed={viewMode === m}
							data-testid="file-view-{m}"
						>{m === 'source' ? 'Source' : 'Preview'}</button>
					{/each}
				</div>
			{/if}
			{#if savedFlash}<span class="text-success">saved</span>{/if}
			{#if saveError}<span class="text-error" title={saveError} data-testid="file-save-error">{saveError}</span>{/if}
			{#if saveTooLarge}
				<!-- Save is absent, not merely disabled: there is no edit to persist. -->
				<span
					class="transition-colors {viewOnlyFlash ? 'text-warning' : 'text-base-content/55'}"
					title="This file is larger than a save request may carry, so it opens read-only. The rendered preview is unaffected."
					data-flash={viewOnlyFlash ? 'true' : 'false'}
					data-testid="file-view-only">view-only · too large to save</span
				>
			{:else}
				<button class="btn btn-xs btn-ghost gap-1" onclick={save} disabled={saving || status !== 'ready'} data-testid="file-save">
					{saving ? 'saving…' : 'Save'}
					<kbd class="kbd kbd-xs">⌘S</kbd>
				</button>
			{/if}
		</div>
	</div>

	{#if diskBanner}
		<!-- The buffer is untouched behind this: an external change never discards
		     unsaved work, it asks. Shown in both Source and Preview, since the file
		     is equally stale in either.
		     Takes the notebook banner's warning TINT (border + background), but its
		     copy is `base-content`, not `text-warning`. Amber-on-amber measures
		     1.8:1 against this background in the light theme - far under WCAG AA -
		     so the icon carries the signal and the words stay readable. Both buttons
		     are equally quiet on purpose: Reload DISCARDS unsaved edits, so
		     emphasising it would make the destructive choice the one a misclick
		     lands on. -->
		<div
			class="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs text-base-content/80"
			data-testid="file-disk-changed"
			data-disk-state={diskState}
		>
			<svg class="h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
			<span>
				{#if diskState === 'deleted'}
					Deleted on disk. Your version is still open here - save to recreate the file.
				{:else}
					Changed on disk outside Cellar. Your unsaved edits are kept.
				{/if}
			</span>
			<div class="ml-auto flex shrink-0 items-center gap-1">
				{#if diskState === 'changed'}
					<button
						class="btn btn-ghost btn-xs h-5 min-h-0 px-2 hover:bg-warning/20"
						onclick={reloadFromDisk}
						data-testid="file-disk-reload">Reload</button
					>
				{/if}
				<button
					class="btn btn-ghost btn-xs h-5 min-h-0 px-2 hover:bg-warning/20"
					onclick={keepLocalVersion}
					data-testid="file-disk-dismiss">{diskState === 'deleted' ? 'Dismiss' : 'Keep mine'}</button
				>
			</div>
		</div>
	{/if}

	{#if status === 'error'}
		<div class="p-6 text-sm text-error" data-testid="file-error">Could not open <code class="font-mono">{path}</code>: {errorMsg}</div>
	{/if}
	<!-- Rendered preview. The editor stays mounted-but-hidden beneath it so its
	     CodeMirror state, git baseline and unsaved edits survive toggling. -->
	{#if showPreview && previewKind === 'markdown'}
		<div class="min-h-0 flex-1 overflow-auto bg-base-100">
			<MarkdownView source={liveSource} />
		</div>
	{:else if showPreview && previewKind === 'html'}
		<!-- The iframe owns its own scrolling, so the pane must NOT add a second one. -->
		<div class="min-h-0 flex-1 overflow-hidden bg-base-100">
			<HtmlPreview source={liveSource} {relativeAssets} />
		</div>
	{/if}
	<div
		bind:this={editorEl}
		class="min-h-0 flex-1 overflow-auto bg-base-100 {status === 'error' || showPreview ? 'hidden' : ''}"
	></div>
</div>
