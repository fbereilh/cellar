/**
 * Cellar — VS Code-style file-type icons for the shell (file tree + tabs).
 *
 * Fully self-contained inline SVG (no CDN / network / external asset), keyed by
 * extension so the app stays offline-capable. Colors are fixed brand hues so
 * icons read the same under either daisyui theme, the way VS Code icon themes
 * (Seti / Material) look. `iconSvg()` returns a trusted static SVG string meant
 * for `{@html}` — never interpolates caller/user input.
 */

// A colored rounded-square badge with a 1-2 char monogram (JS/TS/Py/etc.).
function badge(bg, text, label, size = 7) {
	return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="${size}" font-weight="700" fill="${text}">${label}</text></svg>`;
}

const ICONS = {
	python: badge('#3776ab', '#ffd43b', 'Py'),
	// Jupyter: an orange notebook glyph (distinct shape from the orange Svelte badge).
	jupyter:
		'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#f37726" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
	js: badge('#f0db4f', '#323330', 'JS'),
	ts: badge('#3178c6', '#ffffff', 'TS'),
	json: badge('#cb8f2a', '#ffffff', '{ }', 6),
	svelte: badge('#ff3e00', '#ffffff', 'S', 8),
	// Markdown: the classic "M▾" mark in a rounded outline.
	markdown:
		'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1" y="3.5" width="14" height="9" rx="1.5" fill="none" stroke="#42a5f5" stroke-width="1.3"/><path d="M3.4 10.6V6.2l2 2 2-2v4.4" fill="none" stroke="#42a5f5" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/><path d="M10.6 6.4v3.4m0 0-1.3-1.4m1.3 1.4 1.3-1.4" fill="none" stroke="#42a5f5" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
	// Config (yaml/toml): a violet gear, the way icon themes mark settings files.
	config:
		'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.9l1.05 1.36 1.7-.28.32 1.7 1.55.76-.84 1.5.84 1.5-1.55.76-.32 1.7-1.7-.28L8 14.1l-1.05-1.36-1.7.28-.32-1.7-1.55-.76.84-1.5-.84-1.5 1.55-.76.32-1.7 1.7.28z" fill="none" stroke="#a074c4" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.9" fill="none" stroke="#a074c4" stroke-width="1.2"/></svg>',
	// Image: a teal picture frame with sun + mountain.
	image:
		'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="#26a69a" stroke-width="1.3"/><circle cx="5.6" cy="6" r="1.15" fill="#26a69a"/><path d="M3 12.2l3-3 2 2 2.6-3.2 2.4 3.4" fill="none" stroke="#26a69a" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
	folder:
		'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4.2a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .74.33L7.3 4.6h6.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="#e0a83e"/></svg>',
	folderOpen:
		'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4.2a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .74.33L7.3 4.6h6.2a1 1 0 0 1 1 1v1.1H4.4a1 1 0 0 0-.95.68L1.5 12.4z" fill="#e0a83e"/><path d="M3.45 7.7a1 1 0 0 1 .95-.7h10.1a.7.7 0 0 1 .67.92l-1.4 4.2a1 1 0 0 1-.95.68H1.9z" fill="#f0c064"/></svg>',
	// Plain document with a folded corner (default / unknown types).
	file:
		'<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.8 1.8h5.2l3.4 3.4v8.9a.5.5 0 0 1-.5.5H3.8a.5.5 0 0 1-.5-.5V2.3a.5.5 0 0 1 .5-.5z" fill="none" stroke="#9aa3b2" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.9 1.9v3.4h3.3" fill="none" stroke="#9aa3b2" stroke-width="1.2" stroke-linejoin="round"/></svg>'
};

const EXT_MAP = {
	py: 'python',
	pyi: 'python',
	ipynb: 'jupyter',
	js: 'js',
	jsx: 'js',
	mjs: 'js',
	cjs: 'js',
	ts: 'ts',
	tsx: 'ts',
	json: 'json',
	jsonc: 'json',
	md: 'markdown',
	markdown: 'markdown',
	svelte: 'svelte',
	yml: 'config',
	yaml: 'config',
	toml: 'config',
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	gif: 'image',
	webp: 'image',
	svg: 'image',
	bmp: 'image',
	ico: 'image'
};

/** Icon key for a filename (or 'folder'/'folderOpen' for directories). */
export function iconKind(name, { dir = false, open = false } = {}) {
	if (dir) return open ? 'folderOpen' : 'folder';
	const dot = name.lastIndexOf('.');
	const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
	return EXT_MAP[ext] || 'file';
}

/** Trusted static SVG string for a filename (for `{@html}`). */
export function iconSvg(name, opts) {
	return ICONS[iconKind(name, opts)];
}
