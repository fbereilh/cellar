// The one source of truth for notebook keyboard shortcuts.
//
// Every keystroke the notebook reacts to is declared once in DEFAULT_SHORTCUTS
// and dispatched from a single mode-aware handler (`LiveNotebook.onKeydown`),
// so the Settings panel can list (and rebind) exactly what the notebook
// actually does. Nothing else may bind a notebook key: adding a shortcut means
// adding a registry entry plus an action in LiveNotebook's `actions` map.
//
// Modes mirror Jupyter:
//   'edit'    - the cell's CodeMirror editor has focus; you are typing.
//   'command' - a cell is selected but not focused; keystrokes are commands.
//   'global'  - fires in both modes.
//
// A binding is a *chord* string: modifiers in the canonical order
// `Mod-Ctrl/Meta-Alt-Shift-<key>`, where `Mod` is ⌘ on macOS and Ctrl
// elsewhere, and `<key>` is a lowercased single character or a DOM key name
// (`Enter`, `Escape`, `ArrowUp`, …). This is deliberately CodeMirror's chord
// syntax, so a binding reads the same wherever it is used.

import { browser } from '$app/environment';

const STORAGE_KEY = 'cellar-shortcuts';

export const isMac = browser && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** @typedef {{id:string, keys:string[], mode:'command'|'edit'|'global', description:string, category:string}} Shortcut */

/** @type {Shortcut[]} */
export const DEFAULT_SHORTCUTS = [
	// ---- Modes -------------------------------------------------------------
	{
		id: 'command-mode',
		keys: ['Escape', 'Mod-.'],
		mode: 'edit',
		category: 'Modes',
		description: 'Leave the editor and enter command mode'
	},
	{
		id: 'edit-mode',
		keys: ['Enter'],
		mode: 'command',
		category: 'Modes',
		description: 'Edit the selected cell'
	},

	// ---- Running -----------------------------------------------------------
	{
		id: 'run-cell',
		keys: ['Mod-Enter'],
		mode: 'global',
		category: 'Running',
		description: 'Run the selected cell in place'
	},
	{
		id: 'run-advance',
		keys: ['Shift-Enter'],
		mode: 'global',
		category: 'Running',
		description: 'Run the selected cell and advance to the next'
	},

	// ---- Navigation (command mode) -----------------------------------------
	{
		id: 'select-prev',
		keys: ['ArrowUp', 'k'],
		mode: 'command',
		category: 'Navigation',
		description: 'Select the cell above'
	},
	{
		id: 'select-next',
		keys: ['ArrowDown', 'j'],
		mode: 'command',
		category: 'Navigation',
		description: 'Select the cell below'
	},
	{
		id: 'fold-section',
		keys: ['ArrowLeft', 'h'],
		mode: 'command',
		category: 'Navigation',
		description: "Collapse the selected heading's section"
	},
	{
		id: 'unfold-section',
		keys: ['ArrowRight', 'l'],
		mode: 'command',
		category: 'Navigation',
		description: "Expand the selected heading's section"
	},

	// ---- Structure ---------------------------------------------------------
	{
		id: 'move-cell-up',
		keys: ['Mod-Shift-ArrowUp'],
		mode: 'global',
		category: 'Structure',
		description: 'Move the selected cell up'
	},
	{
		id: 'move-cell-down',
		keys: ['Mod-Shift-ArrowDown'],
		mode: 'global',
		category: 'Structure',
		description: 'Move the selected cell down'
	},
	{
		id: 'insert-above',
		keys: ['a'],
		mode: 'command',
		category: 'Structure',
		description: 'Insert a code cell above'
	},
	{
		id: 'insert-below',
		keys: ['b'],
		mode: 'command',
		category: 'Structure',
		description: 'Insert a code cell below'
	},
	{
		id: 'to-markdown',
		keys: ['m'],
		mode: 'command',
		category: 'Structure',
		description: 'Change the selected cell to Markdown'
	},
	{
		id: 'to-code',
		keys: ['y'],
		mode: 'command',
		category: 'Structure',
		description: 'Change the selected cell to code'
	}
];

export const CATEGORIES = ['Modes', 'Running', 'Navigation', 'Structure'];

export const MODE_LABEL = { command: 'Command mode', edit: 'Edit mode', global: 'Anywhere' };

// ---- Chords ----------------------------------------------------------------

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead']);

/** DOM key → the canonical chord token for it. */
function normKey(key) {
	if (key === ' ' || key === 'Spacebar') return 'Space';
	// A printable character is stored lowercase so `Shift-a` (not `Shift-A`) is
	// the single spelling of that chord, whatever the keyboard reports.
	return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * The chord a keydown event represents, or null when it carries no real key
 * (a bare modifier press, or an IME composition).
 */
export function chordFromEvent(e) {
	if (!e?.key || e.isComposing || MODIFIER_KEYS.has(e.key)) return null;
	const mod = isMac ? e.metaKey : e.ctrlKey;
	const other = isMac ? e.ctrlKey : e.metaKey; // the *non*-primary control key
	const parts = [];
	if (mod) parts.push('Mod');
	if (other) parts.push(isMac ? 'Ctrl' : 'Meta');
	if (e.altKey) parts.push('Alt');
	if (e.shiftKey) parts.push('Shift');
	parts.push(normKey(e.key));
	return parts.join('-');
}

const MAC_MODS = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Meta: '⌘' };
const PC_MODS = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl', Meta: 'Win' };
const KEY_LABELS = {
	Enter: '⏎',
	Escape: 'Esc',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Backspace: '⌫',
	Delete: 'Del',
	Tab: '⇥'
};

/** A chord as display tokens, one per `<kbd>`: `Shift-Enter` → ['⇧','⏎']. */
export function chordTokens(chord) {
	const mods = isMac ? MAC_MODS : PC_MODS;
	const parts = chord.split('-');
	// A trailing '-' key (e.g. `Mod--`) leaves an empty last part; restore it.
	const key = parts.pop() || '-';
	return [...parts.map((p) => mods[p] ?? p), KEY_LABELS[key] ?? key];
}

/** A chord as one readable string, for titles and aria labels. */
export function formatChord(chord) {
	return chordTokens(chord).join(isMac ? '' : '+');
}

/** Two shortcuts can collide only when their modes can be active together. */
export function modesOverlap(a, b) {
	return a === b || a === 'global' || b === 'global';
}

// ---- Store -----------------------------------------------------------------

// User rebindings, merged over the defaults and persisted to localStorage:
// `{ [shortcutId]: string[] }`. Only ids present here are customized, so a
// later change to a default binding reaches every user who never touched it.
class ShortcutStore {
	overrides = $state({});

	/** The effective shortcut list: defaults with any user rebinding applied. */
	get list() {
		return DEFAULT_SHORTCUTS.map((s) => {
			const custom = this.overrides[s.id];
			return { ...s, keys: custom ?? s.keys, customized: !!custom };
		});
	}

	/** Shortcut ids whose bindings collide with another shortcut in the same mode. */
	get conflicts() {
		const bad = new Set();
		const all = this.list;
		for (let i = 0; i < all.length; i++) {
			for (let j = i + 1; j < all.length; j++) {
				if (!modesOverlap(all[i].mode, all[j].mode)) continue;
				if (all[i].keys.some((k) => all[j].keys.includes(k))) {
					bad.add(all[i].id);
					bad.add(all[j].id);
				}
			}
		}
		return bad;
	}

	/** The shortcut a chord triggers in `mode`, or undefined. */
	lookup(mode, chord) {
		return this.list.find((s) => (s.mode === 'global' || s.mode === mode) && s.keys.includes(chord));
	}

	/** Every shortcut (other than `id`) already bound to `chord` in an overlapping mode. */
	conflictsFor(id, chord) {
		const self = this.list.find((s) => s.id === id);
		if (!self) return [];
		return this.list.filter((s) => s.id !== id && modesOverlap(s.mode, self.mode) && s.keys.includes(chord));
	}

	/** Rebind the binding at `index` of shortcut `id` to `chord`. */
	rebind(id, index, chord) {
		const current = this.list.find((s) => s.id === id);
		if (!current) return;
		const keys = [...current.keys];
		if (keys.includes(chord) && keys[index] !== chord) return; // already one of this shortcut's own bindings
		keys[index] = chord;
		this.overrides = { ...this.overrides, [id]: keys };
		this.#save();
	}

	reset(id) {
		const { [id]: _dropped, ...rest } = this.overrides;
		this.overrides = rest;
		this.#save();
	}

	resetAll() {
		this.overrides = {};
		this.#save();
	}

	load() {
		if (!browser) return;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed = raw ? JSON.parse(raw) : {};
			// Drop entries for shortcuts that no longer exist, and any malformed value.
			const known = new Set(DEFAULT_SHORTCUTS.map((s) => s.id));
			this.overrides = Object.fromEntries(
				Object.entries(parsed).filter(
					([id, keys]) => known.has(id) && Array.isArray(keys) && keys.length > 0 && keys.every((k) => typeof k === 'string' && k)
				)
			);
		} catch {
			this.overrides = {};
		}
	}

	#save() {
		if (!browser) return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
		} catch {}
	}
}

export const shortcuts = new ShortcutStore();
shortcuts.load();
