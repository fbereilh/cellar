<script lang="ts">
	// Cmd/Ctrl+K command palette. A searchable, keyboard-navigable overlay over
	// every notebook/app action. Rendered as a daisyUI `.modal-open` so the
	// notebook's modal keyboard stands down while it is open (LiveNotebook's
	// dispatcher bails on `.modal-open`), exactly like the Settings modal.
	//
	// The commands (and their live keybindings) come from the parent via
	// `commands` - built from the shortcut registry plus app actions in
	// `commands.js`, so this component owns only search + navigation, never the
	// command list itself.
	import { tick } from 'svelte';
	import { filterCommands } from '$lib/commands';
	import type { PaletteCommand, ScoredCommand } from '$lib/commands';
	import { chordTokens, formatChord } from '$lib/shortcuts.svelte';

	interface Props {
		open: boolean;
		commands: PaletteCommand[];
		onClose?: () => void;
	}
	let { open, commands, onClose }: Props = $props();

	let query = $state('');
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);

	// One result row: the scored command plus its flat index into `results`.
	type IndexedResult = ScoredCommand & { index: number };

	// Ranked, flat results (disabled commands are already dropped by filterCommands).
	const results = $derived(filterCommands(commands, query));

	// Grouped for rendering while keeping one flat index space for navigation:
	// each row carries its global index into `results`, so ↑/↓ and the highlight
	// agree regardless of category boundaries.
	const groups = $derived(
		(() => {
			const order: string[] = [];
			const byCat = new Map<string, IndexedResult[]>();
			results.forEach((entry, index) => {
				const cat = entry.command.category;
				let bucket = byCat.get(cat);
				if (!bucket) {
					bucket = [];
					byCat.set(cat, bucket);
					order.push(cat);
				}
				bucket.push({ ...entry, index });
			});
			return order.map((cat) => ({ category: cat, items: byCat.get(cat) ?? [] }));
		})()
	);

	// Reset the search + selection each time the palette opens, and focus the box.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			query = '';
			activeIndex = 0;
			tick().then(() => inputEl?.focus());
		}
		wasOpen = open;
	});

	// Keep the highlight in range as the result set shrinks, and scroll it into view.
	$effect(() => {
		if (activeIndex > results.length - 1) activeIndex = Math.max(0, results.length - 1);
	});
	$effect(() => {
		activeIndex;
		listEl?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
	});

	function run(entry: ScoredCommand | undefined) {
		if (!entry) return;
		onClose?.();
		// Run after the modal is torn down so an action that focuses a cell lands
		// there, not back into the (closing) search box.
		entry.command.run();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (results.length) activeIndex = (activeIndex + 1) % results.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (results.length) activeIndex = (activeIndex - 1 + results.length) % results.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			run(results[activeIndex]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onClose?.();
		}
	}

	// Split a title into matched / unmatched runs so matched characters can be bold.
	function segments(title: string, positions: number[]): { text: string; hit: boolean }[] {
		if (!positions?.length) return [{ text: title, hit: false }];
		const set = new Set(positions);
		const out: { text: string; hit: boolean }[] = [];
		let buf = '';
		let hit = set.has(0);
		for (let i = 0; i < title.length; i++) {
			const h = set.has(i);
			if (h !== hit) {
				if (buf) out.push({ text: buf, hit });
				buf = '';
				hit = h;
			}
			buf += title[i];
		}
		if (buf) out.push({ text: buf, hit });
		return out;
	}
</script>

{#if open}
	<div class="modal modal-open items-start" data-testid="command-palette" onkeydown={onKeydown} role="dialog" aria-modal="true" aria-label="Command palette">
		<div class="modal-box mt-[12vh] max-w-xl overflow-hidden p-0 shadow-2xl">
			<!-- Search box -->
			<div class="flex items-center gap-2 border-b border-base-300 px-3">
				<svg class="h-4 w-4 shrink-0 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
				<input
					bind:this={inputEl}
					bind:value={query}
					class="w-full bg-transparent py-3 text-sm outline-none placeholder:text-base-content/40"
					placeholder="Type a command…"
					spellcheck="false"
					autocomplete="off"
					data-testid="command-palette-input"
				/>
				<kbd class="kbd kbd-sm hidden text-base-content/40 sm:inline-flex">Esc</kbd>
			</div>

			<!-- Results -->
			<div bind:this={listEl} class="max-h-[52vh] overflow-y-auto py-1" data-testid="command-palette-list">
				{#if !results.length}
					<div class="px-4 py-6 text-center text-sm text-base-content/40" data-testid="command-palette-empty">No matching commands</div>
				{/if}
				{#each groups as group (group.category)}
					<div class="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/35">{group.category}</div>
					{#each group.items as entry (entry.command.id)}
						<button
							class="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm {entry.index === activeIndex ? 'bg-primary/15 text-base-content' : 'text-base-content/80 hover:bg-base-200'}"
							data-active={entry.index === activeIndex}
							data-testid="command-palette-item"
							onmouseenter={() => (activeIndex = entry.index)}
							onclick={() => run(entry)}
						>
							<span class="min-w-0 truncate">
								{#each segments(entry.command.title, entry.positions) as seg}
									{#if seg.hit}<span class="font-semibold text-primary">{seg.text}</span>{:else}{seg.text}{/if}
								{/each}
							</span>
							{#if entry.command.keys.length}
								<span class="flex shrink-0 items-center gap-1" title={formatChord(entry.command.keys[0])}>
									{#each chordTokens(entry.command.keys[0]) as token}
										<kbd class="kbd kbd-sm">{token}</kbd>
									{/each}
								</span>
							{/if}
						</button>
					{/each}
				{/each}
			</div>
		</div>
		<button class="modal-backdrop" onclick={onClose} aria-label="Close command palette">close</button>
	</div>
{/if}
