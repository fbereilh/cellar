<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { EditorView, type ViewUpdate } from '@codemirror/view';
	import { EditorState, type Extension } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import { json as jsonLang } from '@codemirror/lang-json';
	import { yaml as yamlLang } from '@codemirror/lang-yaml';
	import { html as htmlLang } from '@codemirror/lang-html';
	import { StreamLanguage } from '@codemirror/language';
	import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
	import { EDITOR_THEME } from '$lib/editorTheme';
	import { gitGutterExtension, setGitBaseline } from '$lib/gitGutter';
	import MarkdownView from '$lib/MarkdownView.svelte';
	import HtmlPreview from '$lib/HtmlPreview.svelte';
	import { isHtmlPath, hasRelativeAssetRefs } from '$lib/htmlPreview';
	import { saveFitsTransport, resolveBodyLimit } from '$lib/saveLimit';
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
	// dirty state up so the tab bar can show the unsaved indicator. `gitRefresh`
	// is the shell's `fsRefreshSignal`: a bump means the workspace's git state may
	// have moved, so re-fetch the HEAD baseline the gutter diffs against.
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
	// The loaded document is bigger than the save PUT's request body may be, so it
	// opens VIEW-ONLY: the editor is read-only and Save is replaced by a chip that
	// says why. Offering an edit whose PUT the server front-end would 413 before
	// any handler runs is the failure this retires - the read cap admits files
	// (a 15 MB self-contained export) far past what the transport accepts, and
	// that transport limit is app-wide and deliberately not raised. The ceiling
	// compared against is the one the RUNNING server enforces (`body.bodyLimit`,
	// uncapped under the Vite dev server), never a client-side guess. Decided
	// ONCE, from the loaded content: a read-only document cannot grow past the
	// line it was measured against, so nothing needs re-measuring per keystroke.
	let saveTooLarge = $state(false);
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
		if (q.endsWith('.py')) return python();
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
			setDirty(false);
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

	// A commit / checkout / stash made outside Cellar changes HEAD under us.
	onMount(() => {
		const onFocus = () => {
			loadGitBaseline();
			loadBlame();
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
			saveTooLarge = !saveFitsTransport(path, content, resolveBodyLimit(body.bodyLimit));
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
					// View-only: only editing goes. The explicit `tabindex` is what keeps
					// the rest true - `editable.of(false)` sets `contenteditable="false"`
					// and adds NO tabindex, so `.cm-content` (where CodeMirror attaches
					// its key handlers) could not take focus at all: a click landed on
					// `.cm-scroller` and every keystroke died there, costing keyboard
					// selection and the editor's own search panel. With it, the document
					// is focusable, selectable and searchable, and still not editable.
					// Cmd/Ctrl+S is not this element's business either way - the shell
					// owns it for every file tab, in every view (see `requestSave`).
					...(saveTooLarge
						? [
								EditorState.readOnly.of(true),
								EditorView.editable.of(false),
								EditorView.contentAttributes.of({ tabindex: '0' })
							]
						: []),
					EditorView.updateListener.of((v: ViewUpdate) => {
						if (v.docChanged) {
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
