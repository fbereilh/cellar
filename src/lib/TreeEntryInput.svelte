<script lang="ts">
	import { iconSvg } from '$lib/fileIcons';

	// Inline editable row used by the file tree for renaming an entry and for
	// creating a new file/folder. Enter submits, Escape (or blur) cancels. Kept
	// deliberately dumb: the parent owns what happens on submit/cancel.
	interface Props {
		depth?: number;
		initial?: string;
		/** For a new entry, picks the placeholder icon ('file' | 'dir'). */
		kind?: string;
		/** Explicit icon html (rename passes the entry's own icon). */
		icon?: string | null;
		onSubmit?: (name: string) => void;
		onCancel?: () => void;
	}
	let {
		depth = 0,
		initial = '',
		kind = 'file',
		icon = null,
		onSubmit,
		onCancel
	}: Props = $props();

	let value = $state(initial);
	let done = false; // guard so blur after Enter/Escape doesn't double-fire

	const iconHtml = $derived(icon ?? iconSvg(kind === 'dir' ? 'folder' : 'untitled', { dir: kind === 'dir' }));

	function submit() {
		if (done) return;
		done = true;
		const name = value.trim();
		if (name) onSubmit?.(name);
		else onCancel?.();
	}
	function cancel() {
		if (done) return;
		done = true;
		onCancel?.();
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		}
	}
	// Autofocus + select the name stem (before the extension) on mount.
	function init(el: HTMLInputElement) {
		el.focus();
		const dot = value.lastIndexOf('.');
		if (dot > 0) el.setSelectionRange(0, dot);
		else el.select();
	}
</script>

<div class="flex w-full items-center gap-1 px-1 py-0.5" style="padding-left: {depth * 12 + 4}px" data-testid="tree-entry-input">
	<span class="h-3 w-3 shrink-0"></span>
	<span class="shrink-0">{@html iconHtml}</span>
	<input
		class="input input-xs h-5 min-h-0 w-full flex-1 rounded border border-primary/60 bg-base-100 px-1 py-0 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
		bind:value
		use:init
		onkeydown={onKeydown}
		onblur={cancel}
		data-testid="tree-entry-field"
		spellcheck="false"
		autocomplete="off"
	/>
</div>
