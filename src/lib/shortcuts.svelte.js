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
//
// A binding may also be a *sequence* of chords separated by a space (`d d`,
// Jupyter's delete-cell). The dispatcher holds the leading chords as a pending
// prefix for `SEQUENCE_TIMEOUT_MS` and fires only on the full match; a lone `d`
// times out and does nothing. Sequences of any length work, so Jupyter's `i i`
// and `0 0` can be added later without touching this file.

import { browser } from '$app/environment';

const STORAGE_KEY = 'cellar-shortcuts';

export const isMac = browser && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** How long the dispatcher waits for the next chord of a key sequence. */
export const SEQUENCE_TIMEOUT_MS = 600;

/** The chords of a binding: `'d d'` → `['d','d']`; `'Shift-Enter'` → `['Shift-Enter']`. */
export function chordSequence(binding) {
	return binding.split(' ').filter(Boolean);
}

// JupyterLab spells the split-cell binding `Ctrl Shift -` on every platform, so
// it names the physical Ctrl key - which is `Ctrl` in our chord vocabulary on
// macOS (where `Mod` is ⌘) and `Mod` everywhere else.
const SPLIT_CELL_CHORD = isMac ? 'Ctrl-Shift--' : 'Mod-Shift--';

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
	{
		id: 'run-insert-below',
		keys: ['Alt-Enter'],
		mode: 'global',
		category: 'Running',
		description: 'Run the selected cell and insert a new cell below'
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
	},

	// ---- Editing -----------------------------------------------------------
	{
		id: 'delete-cell',
		keys: ['d d'],
		mode: 'command',
		category: 'Editing',
		description: 'Delete the selected cell (press d twice)'
	},
	{
		id: 'undo-delete',
		keys: ['z'],
		mode: 'command',
		category: 'Editing',
		description: 'Undo the last cell delete'
	},
	{
		id: 'cut-cell',
		keys: ['x'],
		mode: 'command',
		category: 'Editing',
		description: 'Cut the selected cell'
	},
	{
		id: 'copy-cell',
		keys: ['c'],
		mode: 'command',
		category: 'Editing',
		description: 'Copy the selected cell'
	},
	{
		id: 'paste-below',
		keys: ['v'],
		mode: 'command',
		category: 'Editing',
		description: 'Paste the copied cell below'
	},
	{
		id: 'paste-above',
		keys: ['Shift-v'],
		mode: 'command',
		category: 'Editing',
		description: 'Paste the copied cell above'
	},
	{
		id: 'split-cell',
		keys: [SPLIT_CELL_CHORD],
		mode: 'edit',
		category: 'Editing',
		description: 'Split the cell at the cursor'
	},

	// ---- Headings ----------------------------------------------------------
	// One command per level, so each is rebindable on its own and the registry
	// keeps its "one id, one command" shape.
	...[1, 2, 3, 4, 5, 6].map((level) => ({
		id: `heading-${level}`,
		keys: [String(level)],
		mode: 'command',
		category: 'Headings',
		description: `Make the selected cell a Markdown heading (H${level})`
	}))
];

export const CATEGORIES = ['Modes', 'Running', 'Navigation', 'Structure', 'Editing', 'Headings'];

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

// Physical keys whose character changes under Shift. A *command* chord names the
// unshifted key (`Ctrl-Shift--`, exactly as JupyterLab writes it), but the
// browser reports `e.key === '_'` for that keystroke - so when Shift is held
// together with a real modifier, the key token comes from the physical `e.code`.
// Confined to modifier combinations, it can never affect plain typing.
const SHIFTED_BASE_KEY = { Minus: '-' };

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
	const base = e.shiftKey && (mod || other || e.altKey) ? SHIFTED_BASE_KEY[e.code] : undefined;
	parts.push(base ?? normKey(e.key));
	return parts.join('-');
}

/**
 * A chord split into its modifier tokens and its key token.
 * `Mod--` → `{mods:['Mod'], key:'-'}`; `-` → `{mods:[], key:'-'}`; `k` → `{mods:[], key:'k'}`.
 */
export function parseChord(chord) {
	const parts = chord.split('-');
	// A trailing '-' key (e.g. `Mod--`, or the bare `-`) leaves an empty last part.
	const key = parts.pop() || '-';
	return { mods: parts.filter(Boolean), key };
}

/**
 * True when a binding starts with a keystroke that would otherwise type a
 * character into a text editor. Binding one to a shortcut that fires outside
 * command mode makes that character untypable in every cell. Settings warns
 * loudly, but still lets the user do it (they may well have remapped the mode
 * keys to suit). Only the *first* chord matters: it is the one the dispatcher
 * swallows unconditionally, whether or not the sequence goes on to complete.
 */
export function typesACharacter(binding) {
	const first = chordSequence(binding)[0];
	if (!first) return false;
	const { mods, key } = parseChord(first);
	if (mods.some((m) => m !== 'Shift')) return false; // Shift-a still types "A"
	return key.length === 1 || key === 'Space';
}

/** The bindings of `shortcut` that shadow a typable character (empty when none). */
export function typingHazards(shortcut) {
	if (shortcut.mode === 'command') return []; // command mode is exactly where bare letters belong
	return shortcut.keys.filter(typesACharacter);
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

/** One chord's display tokens: `Shift-Enter` → ['⇧','⏎']. */
function tokensOfChord(chord) {
	const labels = isMac ? MAC_MODS : PC_MODS;
	const { mods, key } = parseChord(chord);
	return [...mods.map((m) => labels[m] ?? m), KEY_LABELS[key] ?? key];
}

/** A binding as display tokens, one per `<kbd>`: `d d` → ['d','d']. */
export function chordTokens(binding) {
	return chordSequence(binding).flatMap(tokensOfChord);
}

/** A binding as one readable string, for titles and aria labels. */
export function formatChord(binding) {
	return chordSequence(binding)
		.map((c) => tokensOfChord(c).join(isMac ? '' : '+'))
		.join(' ');
}

/** Two shortcuts can collide only when their modes can be active together. */
export function modesOverlap(a, b) {
	return a === b || a === 'global' || b === 'global';
}

/**
 * True when two bindings cannot coexist: they are identical, or one is the
 * prefix of the other's sequence (`d` would fire before `d d` ever completes).
 */
export function bindingsCollide(a, b) {
	return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
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
				if (all[i].keys.some((k) => all[j].keys.some((o) => bindingsCollide(k, o)))) {
					bad.add(all[i].id);
					bad.add(all[j].id);
				}
			}
		}
		return bad;
	}

	/** Every shortcut active in `mode` (its own, plus the global ones). */
	#active(mode) {
		return this.list.filter((s) => s.mode === 'global' || s.mode === mode);
	}

	/** The shortcut `binding` (a chord, or a whole chord sequence) triggers in `mode`. */
	lookup(mode, binding) {
		return this.#active(mode).find((s) => s.keys.includes(binding));
	}

	/**
	 * True when `chords` is the start of some longer sequence bound in `mode` -
	 * i.e. the dispatcher should hold them and wait for the next keystroke.
	 */
	isPrefix(mode, chords) {
		const prefix = `${chords.join(' ')} `;
		return this.#active(mode).some((s) => s.keys.some((k) => k.startsWith(prefix)));
	}

	/** Every shortcut (other than `id`) already bound to `chord` in an overlapping mode. */
	conflictsFor(id, chord) {
		const self = this.list.find((s) => s.id === id);
		if (!self) return [];
		return this.list.filter((s) => s.id !== id && modesOverlap(s.mode, self.mode) && s.keys.some((k) => bindingsCollide(k, chord)));
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
