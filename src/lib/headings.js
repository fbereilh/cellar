// Markdown-header helpers shared by the notebook renderer (collapsible headings)
// and the fold-state bookkeeping in LiveNotebook. Same header-level logic the
// sidebar Outline and the MCP `get_notebook_map` section tree use (a cell is a
// header when its first non-empty line is `#`…`######`), so folding sections and
// the outline always agree on where a section begins and ends.

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Header level (1-6) of a markdown cell, or null when it is not a header. */
export function headerLevel(cell) {
	if (!cell || cell.cell_type !== 'markdown') return null;
	const line = (cell.source || '').split('\n').find((l) => l.trim()) ?? '';
	const m = HEADING.exec(line.trim());
	return m ? m[1].length : null;
}

// Given the ordered cell list and the set of folded header cell ids, compute
// which cells are hidden and how many cells sit inside each folded header's
// section. A header's section runs from just after it until the next header of
// the same or higher level (an H2 folds until the next H1/H2; an H1 folds
// everything under it, nested H2/H3 sections included). Nested folds compose:
// a cell hidden by an outer fold stays hidden regardless of inner state, and a
// folded header's count includes every cell in its section (nested ones too).
export function computeFolding(cells, foldedIds) {
	const hidden = new Set();
	const counts = {};
	for (let i = 0; i < cells.length; i++) {
		const level = headerLevel(cells[i]);
		if (level == null || !foldedIds.has(cells[i].id)) continue;
		let count = 0;
		for (let j = i + 1; j < cells.length; j++) {
			const jl = headerLevel(cells[j]);
			if (jl != null && jl <= level) break; // next same-or-higher header ends the section
			hidden.add(cells[j].id);
			count++;
		}
		counts[cells[i].id] = count;
	}
	return { hidden, counts };
}
