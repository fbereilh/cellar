// The command layer behind the Cmd/Ctrl+K palette.
//
// A command is anything the palette can invoke. Notebook commands name a
// registry `shortcutId`: their keybinding is read live from the shortcut
// registry and their handler dispatches to the *same* action the modal keyboard
// runs (LiveNotebook's `actions` map, reached through the notebook's registered
// api). So the palette and the keyboard can never drift - there is one handler,
// named once. App/kernel commands carry their own handler and, unless they map
// to a registry shortcut, no keybinding.
//
// `buildCommands(ctx)` is pure: it reads the current binding of each shortcut
// from the reactive registry (`shortcuts.list`) and the current app context, so
// calling it inside a `$derived` keeps the palette in sync with rebindings and
// with which notebook is active.

import { shortcuts } from '$lib/shortcuts.svelte';

/** One entry in the command palette. */
export interface PaletteCommand {
	id: string;
	title: string;
	category: string;
	keys: string[];
	run: () => void;
	disabled: boolean;
}

/** The active notebook's action handle, exposed to the palette. */
export interface NotebookCommandHandle {
	dispatch: (shortcutId: string) => void;
	runAll: () => void;
	clearAll: () => void;
}

/** Shell-level handlers the palette invokes (theme, settings, kernel, …). */
export interface AppCommandHandlers {
	toggleTheme: () => void;
	toggleSidebar: () => void;
	interruptKernel: () => void;
	restartKernel: () => void;
	newNotebook: () => void;
	consolidateImports: () => void;
	openSettings: () => void;
}

/** Context passed to `buildCommands`. */
export interface CommandContext {
	notebook: NotebookCommandHandle | null;
	app: AppCommandHandlers;
}

/** The live bindings of a registry shortcut (respects user rebindings). */
export function keysForShortcut(id: string): string[] {
	return shortcuts.list.find((s) => s.id === id)?.keys ?? [];
}

/**
 * Build the palette's command list from the registry plus app/kernel/notebook
 * actions. Pure: reads the current binding of each shortcut and the app context,
 * so calling it inside a `$derived` keeps the palette in sync.
 */
export function buildCommands({ notebook, app }: CommandContext): PaletteCommand[] {
	const hasNotebook = !!notebook;

	// A registry-backed notebook command: keybinding from the registry, handler
	// dispatched into the notebook's own action for that same shortcut id.
	const nb = (shortcutId: string, title: string, category: string): PaletteCommand => ({
		id: `nb:${shortcutId}`,
		title,
		category,
		keys: keysForShortcut(shortcutId),
		disabled: !hasNotebook,
		run: () => notebook?.dispatch(shortcutId)
	});

	// A plain command with its own handler (no registry binding by default).
	const cmd = (
		id: string,
		title: string,
		category: string,
		run: () => void,
		{ keys = [], disabled = false }: { keys?: string[]; disabled?: boolean } = {}
	): PaletteCommand => ({
		id,
		title,
		category,
		keys,
		disabled,
		run
	});

	return [
		// ---- Run -------------------------------------------------------------
		nb('run-cell', 'Run selected cell', 'Run'),
		nb('run-advance', 'Run cell and select below', 'Run'),
		nb('run-insert-below', 'Run cell and insert below', 'Run'),
		cmd('run-all', 'Run all cells', 'Run', () => notebook?.runAll(), { disabled: !hasNotebook }),
		cmd('clear-all-outputs', 'Clear all outputs', 'Run', () => notebook?.clearAll(), { disabled: !hasNotebook }),

		// ---- Cells -----------------------------------------------------------
		nb('insert-above', 'Insert cell above', 'Cells'),
		nb('insert-below', 'Insert cell below', 'Cells'),
		nb('to-code', 'Change cell to code', 'Cells'),
		nb('to-markdown', 'Change cell to Markdown', 'Cells'),
		nb('move-cell-up', 'Move cell up', 'Cells'),
		nb('move-cell-down', 'Move cell down', 'Cells'),
		nb('cut-cell', 'Cut cell', 'Cells'),
		nb('copy-cell', 'Copy cell', 'Cells'),
		nb('paste-below', 'Paste cell below', 'Cells'),
		nb('paste-above', 'Paste cell above', 'Cells'),
		nb('delete-cell', 'Delete cell', 'Cells'),
		nb('undo-delete', 'Undo cell delete', 'Cells'),

		// ---- View ------------------------------------------------------------
		nb('fold-section', 'Collapse heading section', 'View'),
		nb('unfold-section', 'Expand heading section', 'View'),
		cmd('toggle-theme', 'Toggle light / dark theme', 'View', () => app.toggleTheme()),
		cmd('toggle-sidebar', 'Toggle sidebar', 'View', () => app.toggleSidebar()),

		// ---- Kernel ----------------------------------------------------------
		// Always discoverable: both handlers are safe no-ops when no kernel is
		// running, and hiding them would make "Restart kernel" unfindable exactly
		// when a user goes looking for it.
		cmd('kernel-interrupt', 'Interrupt kernel', 'Kernel', () => app.interruptKernel()),
		cmd('kernel-restart', 'Restart kernel', 'Kernel', () => app.restartKernel()),

		// ---- Application -----------------------------------------------------
		cmd('new-notebook', 'New notebook', 'Application', () => app.newNotebook()),
		cmd('consolidate-imports', 'Consolidate imports', 'Application', () => app.consolidateImports(), { disabled: !hasNotebook }),
		cmd('open-settings', 'Open settings', 'Application', () => app.openSettings())
	];
}

// ---- Fuzzy matching --------------------------------------------------------
// A dependency-light subsequence matcher: every query character must appear in
// order in the target. Score rewards matches at a word boundary and runs of
// consecutive matches, so "rc" ranks "Run cell" above "Reorder … c…". Returns
// the matched character positions so the UI can bold them.

export interface FuzzyResult {
	matched: boolean;
	score: number;
	positions: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyResult {
	const q = query.trim().toLowerCase();
	if (!q) return { matched: true, score: 0, positions: [] };
	const t = text.toLowerCase();

	const positions: number[] = [];
	let score = 0;
	let ti = 0;
	let prevMatch = -2;
	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi];
		let found = -1;
		for (let i = ti; i < t.length; i++) {
			if (t[i] === ch) {
				found = i;
				break;
			}
		}
		if (found === -1) return { matched: false, score: 0, positions: [] };
		positions.push(found);
		// Base point per matched char.
		score += 1;
		// Consecutive match bonus.
		if (found === prevMatch + 1) score += 4;
		// Word-boundary bonus (start of string, or after a space/punctuation).
		const before = found === 0 ? ' ' : t[found - 1];
		if (before === ' ' || before === '/' || before === '-' || before === '.') score += 6;
		prevMatch = found;
		ti = found + 1;
	}
	// Prefer shorter targets (a tighter match) and earlier first hit.
	score -= text.length * 0.05;
	score -= positions[0] * 0.1;
	return { matched: true, score, positions };
}

/**
 * Filter + rank commands against a query. Disabled commands are dropped: the
 * palette shows what you can do right now. Ties keep the source order (which is
 * grouped by category), so an empty query renders the full grouped list.
 */
export interface ScoredCommand {
	command: PaletteCommand;
	positions: number[];
	score?: number;
}

export function filterCommands(commands: PaletteCommand[], query: string): ScoredCommand[] {
	const enabled = commands.filter((c) => !c.disabled);
	if (!query.trim()) return enabled.map((command) => ({ command, positions: [] }));
	const scored: ScoredCommand[] = [];
	for (const command of enabled) {
		const m = fuzzyMatch(query, command.title);
		if (m.matched) scored.push({ command, positions: m.positions, score: m.score });
		else {
			// Fall back to a category match so "kernel" surfaces its commands even
			// when the word isn't in the title.
			const cm = fuzzyMatch(query, command.category);
			if (cm.matched) scored.push({ command, positions: [], score: cm.score - 100 });
		}
	}
	scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	return scored;
}
