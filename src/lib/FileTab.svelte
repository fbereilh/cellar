<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { EditorView, keymap } from '@codemirror/view';
	import { EditorState, Prec } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import { json as jsonLang } from '@codemirror/lang-json';
	import { yaml as yamlLang } from '@codemirror/lang-yaml';
	import { StreamLanguage } from '@codemirror/language';
	import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
	import { EDITOR_THEME } from '$lib/editorTheme';
	import { gitGutterExtension, setGitBaseline } from '$lib/gitGutter';
	import MarkdownView from '$lib/MarkdownView.svelte';

	// A workspace file opened into an editor tab. Owns its own load/save; reports
	// dirty state up so the tab bar can show the unsaved indicator. `gitRefresh`
	// is the shell's `fsRefreshSignal`: a bump means the workspace's git state may
	// have moved, so re-fetch the HEAD baseline the gutter diffs against.
	// `onBlame(path, record|null)` reports the git-blame record for the line the
	// cursor sits on, so the shell's bottom status bar can show "who last edited
	// this line, and when" (GitLens-style). `null` = no blame (untracked / non-repo).
	let { path, onDirty, gitRefresh = 0, onBlame } = $props();

	let editorEl;
	// `$state.raw` so the git-baseline effect below re-runs once the editor exists,
	// without Svelte proxying the EditorView itself.
	let view = $state.raw(null);
	let status = $state('loading'); // 'loading' | 'ready' | 'error'
	let errorMsg = $state('');
	let dirty = $state(false);
	let saving = $state(false);
	let savedFlash = $state(false);

	// ---- Markdown preview -----------------------------------------------------
	// A `.md`/`.markdown` file can toggle between the raw source editor and a
	// rendered view (reusing the notebook markdown renderer). `liveSource` mirrors
	// the editor buffer so the preview reflects unsaved edits. The view choice is
	// remembered across files (session-wide preference; source is the default).
	const isMarkdownFile = /\.(md|markdown)$/i.test(path);
	const VIEW_KEY = 'cellar-md-view';
	let mdMode = $state('source'); // 'source' | 'preview'
	let liveSource = $state('');

	function setMdMode(m) {
		mdMode = m;
		try {
			localStorage.setItem(VIEW_KEY, m);
		} catch {}
	}

	// TOML ships no lezer grammar; the official legacy stream mode is the supported
	// path. Its tokens map onto the same highlight tags every other language uses,
	// so both editor themes style it without any theme-side work.
	const tomlLang = () => StreamLanguage.define(tomlMode);

	function langFor(p) {
		if (p.endsWith('.py')) return python();
		if (p.endsWith('.md') || p.endsWith('.markdown')) return markdown();
		if (p.endsWith('.json') || p.endsWith('.ipynb')) return jsonLang();
		if (p.endsWith('.yml') || p.endsWith('.yaml')) return yamlLang();
		if (p.endsWith('.toml')) return tomlLang();
		return [];
	}

	function setDirty(v) {
		if (v !== dirty) {
			dirty = v;
			onDirty?.(path, v);
		}
	}

	async function save() {
		if (saving || !view) return;
		saving = true;
		try {
			const content = view.state.doc.toString();
			const res = await fetch('/api/fs/file', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path, content })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || 'save failed');
			setDirty(false);
			savedFlash = true;
			setTimeout(() => (savedFlash = false), 1200);
			// The working-tree file just changed → re-blame so newly-saved lines
			// stop reading "Not Committed Yet" only where git agrees they moved.
			loadBlame();
		} catch (err) {
			errorMsg = String(err?.message ?? err);
		} finally {
			saving = false;
		}
	}

	// ---- Git change bars (gutter) --------------------------------------------
	// Fetch the file's git-HEAD text and hand it to the gutter extension, which
	// re-diffs the live document against it on every edit. An untracked file (or a
	// workspace that isn't a repo) has no baseline → no bars, like VS Code.
	async function loadGitBaseline() {
		if (!view) return;
		let baseline = null;
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
	let blameLines = null; // Array<record> | null, 0-indexed by file line
	let blameTimer;

	async function loadBlame() {
		blameLines = null;
		try {
			const res = await fetch(`/api/fs/git/blame?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (res.ok && body.tracked) blameLines = body.lines;
		} catch {}
		reportBlame();
	}

	function reportBlame() {
		if (!onBlame) return;
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
	onDestroy(() => view?.destroy());

	onMount(async () => {
		let content = '';
		try {
			const res = await fetch(`/api/fs/file?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'could not open file');
			content = body.content;
			liveSource = content;
			status = 'ready';
			if (isMarkdownFile) {
				try {
					const saved = localStorage.getItem(VIEW_KEY);
					if (saved === 'preview' || saved === 'source') mdMode = saved;
				} catch {}
			}
		} catch (err) {
			status = 'error';
			errorMsg = String(err?.message ?? err);
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
					Prec.highest(keymap.of([{ key: 'Mod-s', run: () => (save(), true) }])),
					EditorView.updateListener.of((v) => {
						if (v.docChanged) {
							setDirty(true);
							if (isMarkdownFile) liveSource = v.state.doc.toString();
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
			{#if isMarkdownFile}
				<!-- Source ↔ rendered toggle (VS Code-style), markdown files only. -->
				<div class="join" role="group" aria-label="Markdown view">
					<button
						class="btn btn-xs join-item {mdMode === 'source' ? 'btn-active' : 'btn-ghost'}"
						onclick={() => setMdMode('source')}
						aria-pressed={mdMode === 'source'}
						data-testid="md-view-source"
					>Source</button>
					<button
						class="btn btn-xs join-item {mdMode === 'preview' ? 'btn-active' : 'btn-ghost'}"
						onclick={() => setMdMode('preview')}
						aria-pressed={mdMode === 'preview'}
						data-testid="md-view-preview"
					>Preview</button>
				</div>
			{/if}
			{#if savedFlash}<span class="text-success">saved</span>{/if}
			<button class="btn btn-xs btn-ghost gap-1" onclick={save} disabled={saving || status !== 'ready'} data-testid="file-save">
				{saving ? 'saving…' : 'Save'}
				<kbd class="kbd kbd-xs">⌘S</kbd>
			</button>
		</div>
	</div>

	{#if status === 'error'}
		<div class="p-6 text-sm text-error" data-testid="file-error">Could not open <code class="font-mono">{path}</code>: {errorMsg}</div>
	{/if}
	<!-- Rendered preview (markdown only). Editor stays mounted-but-hidden beneath
	     so its CodeMirror state, git baseline and unsaved edits survive toggling. -->
	{#if isMarkdownFile && mdMode === 'preview' && status !== 'error'}
		<div class="min-h-0 flex-1 overflow-auto bg-base-100">
			<MarkdownView source={liveSource} />
		</div>
	{/if}
	<div
		bind:this={editorEl}
		class="min-h-0 flex-1 overflow-auto bg-base-100 {status === 'error' || (isMarkdownFile && mdMode === 'preview') ? 'hidden' : ''}"
	></div>
</div>
