/**
 * Sidebar section identity + the rule for reconciling a persisted section order
 * with the current default list.
 *
 * Kept out of `Sidebar.svelte` so the reconciliation is a pure, directly
 * exercisable function: it is the only thing standing between a stale
 * `localStorage['cellar-sidebar-order']` value and the rendered sidebar.
 */

/** Section keys in the order they ship. `sectionBody` in Sidebar.svelte renders exactly these. */
export const DEFAULT_SECTION_ORDER = Object.freeze(['files', 'kernels', 'databricks', 'environment', 'agent', 'outline', 'vars', 'search']);

/**
 * Merge a persisted order with the defaults.
 *
 * - Saved ids the user reordered keep their relative order.
 * - Unknown / duplicate / non-string saved ids are dropped (a duplicate id would
 *   otherwise reach the keyed `{#each}` in Sidebar.svelte).
 * - A section missing from the saved order (i.e. one added since the user last
 *   dragged) is restored at its *default position*: directly after the nearest
 *   default neighbour that precedes it and survived, else before the nearest one
 *   that follows it. Appending to the end would bury a new section below the
 *   user's whole layout.
 *
 * Every default section always comes back exactly once, whatever `saved` holds.
 *
 * @param {unknown} saved value parsed out of localStorage (anything at all)
 * @param {readonly string[]} defaults
 * @returns {string[]}
 */
export function reconcileSectionOrder(saved, defaults = DEFAULT_SECTION_ORDER) {
	const order = [];
	const placed = new Set();

	if (Array.isArray(saved)) {
		for (const key of saved) {
			if (typeof key !== 'string' || !defaults.includes(key) || placed.has(key)) continue;
			placed.add(key);
			order.push(key);
		}
	}

	for (let i = 0; i < defaults.length; i++) {
		const key = defaults[i];
		if (placed.has(key)) continue;
		placed.add(key);
		order.splice(defaultSlot(order, defaults, i), 0, key);
	}
	return order;
}

/** Index in `order` where `defaults[i]` belongs, judged by its surviving default neighbours. */
function defaultSlot(order, defaults, i) {
	for (let j = i - 1; j >= 0; j--) {
		const at = order.indexOf(defaults[j]);
		if (at !== -1) return at + 1;
	}
	for (let j = i + 1; j < defaults.length; j++) {
		const at = order.indexOf(defaults[j]);
		if (at !== -1) return at;
	}
	return order.length; // nothing else placed yet
}
