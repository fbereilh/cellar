#!/usr/bin/env node
// Dev-only: generate a synthetic N-cell notebook for the cell-virtualization
// measurement harness (report `data/cellar-perf-cell-virtualization-a2/report.md` §8).
//
//   node scripts/gen-large-notebook.js <N> [outPath]
//   node scripts/gen-large-notebook.js 150 /tmp/cellar-bench/notebook.ipynb
//
// Produces a realistic mix — short 1-line code, tall multi-line code, markdown
// headings/prose, and a few cells carrying large text/dataframe-ish outputs — so a
// baseline/after DevTools trace exercises the real render pipeline, not a uniform
// toy. Deterministic (no randomness) so re-runs at the same N are byte-identical.
//
// This writes an nbformat 4.5 `.ipynb` with per-cell UUID-shaped ids (Cellar owns
// ids, but a valid file already carries them). No product code; not shipped.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const N = Number.parseInt(process.argv[2] ?? '150', 10);
if (!Number.isFinite(N) || N <= 0) {
	console.error('usage: node scripts/gen-large-notebook.js <N> [outPath]');
	process.exit(1);
}
const outPath = resolve(process.argv[3] ?? `notebook.ipynb`);

// Deterministic UUID-shaped id from an index (no crypto randomness → reproducible).
function id(i) {
	const h = (i * 2654435761 >>> 0).toString(16).padStart(8, '0');
	return `${h}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function markdownCell(i, source) {
	return {
		cell_type: 'markdown',
		id: id(i),
		metadata: { cellar: { visible: true } },
		source: source.split('\n').map((l, k, a) => (k === a.length - 1 ? l : l + '\n'))
	};
}
function codeCell(i, source, outputs = []) {
	return {
		cell_type: 'code',
		id: id(i),
		metadata: { cellar: { visible: true } },
		execution_count: null,
		outputs,
		source: source.split('\n').map((l, k, a) => (k === a.length - 1 ? l : l + '\n'))
	};
}

function streamOutput(text) {
	return { output_type: 'stream', name: 'stdout', text: text.split('\n').map((l, k, a) => (k === a.length - 1 ? l : l + '\n')) };
}
function tallTextOutput(rows) {
	const lines = Array.from({ length: rows }, (_, r) => `row ${r}: ${'x'.repeat(60)}`).join('\n');
	return streamOutput(lines);
}

const cells = [];
for (let i = 0; i < N; i++) {
	const mod = i % 6;
	if (mod === 0) {
		// Section heading + short prose (markdown).
		cells.push(
			markdownCell(
				i,
				`## Section ${Math.floor(i / 6) + 1}\n\nSome descriptive prose about what this section does. ` +
					`It spans a couple of sentences so the rendered markdown has real height.`
			)
		);
	} else if (mod === 1) {
		// Short 1-line code cell.
		cells.push(codeCell(i, `x_${i} = ${i} * 2`));
	} else if (mod === 2) {
		// Tall multi-line code cell.
		const body = Array.from({ length: 24 }, (_, k) => `    step_${k} = compute(x_${i}, ${k})`).join('\n');
		cells.push(codeCell(i, `def process_${i}(x_${i}):\n${body}\n    return step_23`));
	} else if (mod === 3) {
		// Short code with a small output.
		cells.push(codeCell(i, `print(x_${i})`, [streamOutput(`${i * 2}`)]));
	} else if (mod === 4) {
		// Code with a LARGE output (a few of these per notebook).
		cells.push(codeCell(i, `dump_${i}()`, [tallTextOutput(40)]));
	} else {
		// Medium markdown with a list.
		cells.push(
			markdownCell(i, `Notes for cell ${i}:\n\n- point one\n- point two\n- point three\n- point four`)
		);
	}
}

const nb = {
	cells,
	metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
	nbformat: 4,
	nbformat_minor: 5
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(nb, null, 1) + '\n');
console.log(`[gen-large-notebook] wrote ${N} cells → ${outPath}`);
