<script>
	import { onMount } from 'svelte';
	import { EditorView, keymap } from '@codemirror/view';
	import { EditorState, Prec, Compartment } from '@codemirror/state';
	import { basicSetup } from 'codemirror';
	import { python } from '@codemirror/lang-python';
	import { markdown } from '@codemirror/lang-markdown';
	import { json as jsonLang } from '@codemirror/lang-json';
	import { yaml as yamlLang } from '@codemirror/lang-yaml';
	import { StreamLanguage } from '@codemirror/language';
	import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
	import { editorThemeExtensions } from '$lib/editorTheme.js';

	// A workspace file opened into an editor tab. Owns its own load/save; reports
	// dirty state up so the tab bar can show the unsaved indicator.
	let { path, onDirty, theme = 'dim' } = $props();

	const editorTheme = new Compartment();

	let editorEl;
	let view;
	let status = $state('loading'); // 'loading' | 'ready' | 'error'
	let errorMsg = $state('');
	let dirty = $state(false);
	let saving = $state(false);
	let savedFlash = $state(false);

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
		} catch (err) {
			errorMsg = String(err?.message ?? err);
		} finally {
			saving = false;
		}
	}

	// Follow the app's light/dark theme (same pattern as Cell.svelte): read `theme`
	// unconditionally so it stays a tracked dependency even before `view` exists,
	// and reconfigure live on every toggle.
	$effect(() => {
		const extensions = editorThemeExtensions(theme);
		if (view) view.dispatch({ effects: editorTheme.reconfigure(extensions) });
	});

	onMount(async () => {
		let content = '';
		try {
			const res = await fetch(`/api/fs/file?path=${encodeURIComponent(path)}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body?.message || 'could not open file');
			content = body.content;
			status = 'ready';
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
					editorTheme.of(editorThemeExtensions(theme)),
					Prec.highest(keymap.of([{ key: 'Mod-s', run: () => (save(), true) }])),
					EditorView.updateListener.of((v) => {
						if (v.docChanged) setDirty(true);
					}),
					EditorView.theme({
						'&': { fontSize: '13.5px', height: '100%' },
						'.cm-content': { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' },
						'.cm-scroller': { overflow: 'auto' }
					})
				]
			})
		});

		return () => view?.destroy();
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
	<div bind:this={editorEl} class="min-h-0 flex-1 overflow-auto bg-base-100 {status === 'error' ? 'hidden' : ''}"></div>
</div>
