# Cell virtualization — P0 measurement harness + baseline

Foundation phase (P0+P1) of windowed cell rendering. Design + rationale:
`data/cellar-perf-cell-virtualization-a2/report.md` (§3 controller, §4.1 heights, §8 recipe).

## Harness

Generate a synthetic N-cell notebook (mixed short/tall code, markdown, a few large
outputs; deterministic so re-runs are byte-identical):

```
node scripts/gen-large-notebook.js <N> [outPath]
# e.g.
node scripts/gen-large-notebook.js 150 /tmp/cellar-bench-150/notebook.ipynb
```

Then launch Cellar in that workspace and drive a DevTools trace (report §8):

```
cd /tmp/cellar-bench-150
CELLAR_NO_BROWSER=1 node <repo>/bin/cellar.js --yes --no-mcp-config --new
# open http://localhost:<appPort>/?ws=<url-encoded-workspace>, double-click
# notebook.ipynb in the file tree, then eval a DOM/heap/scroll harness:
#   mounted   = document.querySelectorAll('[data-testid="cell"]').length
#   spacers   = document.querySelectorAll('[data-testid="cell-spacer"]').length
#   nodes     = document.querySelectorAll('*').length
#   heap      = performance.memory.usedJSHeapSize
#   longtasks = PerformanceObserver({entryTypes:['longtask']}) around a scripted
#               top→bottom rAF scroll of the overflow-y-auto pane
```

## Baseline (flag OFF — eager `{#each}`, every cell mounted)

Captured via `chrome-devtools-axi` on the fixtures above (headless Chrome).

| N   | mounted cells | total DOM nodes | nodes/cell | JS heap (MB)¹ | scroll long-task ms² | click→active (ms) | Σheights+gaps vs scrollHeight³ |
|-----|--------------:|----------------:|-----------:|--------------:|---------------------:|------------------:|-------------------------------:|
| 50  |            50 |           7,102 |        142 |          28.5 |                    0 |               3.0 | 0.72% chrome                   |
| 150 |           150 |          20,768 |        138 |          18.5 |                    0 |               1.8 | 0.23% chrome                   |
| 300 |           300 |          41,168 |        137 |          61.1 |                    0 |               3.5 | 0.11% chrome                   |

All three: **spacers = 0** — the `virtualize` flag defaults OFF, so every cell mounts
exactly as before (the core P1 safety property: byte-identical to today).

**Headline baseline:** mounted-cell count and total DOM nodes scale **O(N)** (~137–142
nodes/cell). Windowing (P2) should cut both to O(viewport + overscan), independent of N.

¹ JS heap is GC-timing noisy at rest (the 150 sample happened to be post-GC); node
  count is the stable size signal. Treat heap as a coarse before/after, not exact.

² **Gap to note (report §8):** during a scripted rAF scroll of a fully-mounted notebook,
  the long-task counter reads 0 — steady-state scrolling of already-mounted cells is pure
  compositor repaint with no JS/layout on the scroll thread. The scout's cited ceiling is
  at **mount time** and in the **notebook-wide reactive fan-out / per-run** paths, not
  steady-state scroll. So the win P2 targets is primarily the O(N) mounted DOM + reactive
  graph (node count, heap, per-cell `$derived`/`$effect`/ResizeObservers), which the
  node-count column captures; a scroll-jank delta is a weaker signal on this app and should
  be measured under a concurrent run, not an idle scroll.

³ Height-cache trustworthiness (P1 acceptance). Σ of measured cell `offsetHeight` + flow
  gaps (`space-y-4` = 16px) reconstructs the pane's `scrollHeight` to within **0.11%–0.72%**
  (the remainder is fixed page padding + the add-cell bar, which sit outside the cache and
  are identical whether a row renders as a cell or a spacer). Well inside the ±2% bar, so a
  spacer of a cell's cached height faithfully reproduces its flow box — the cache P2 relies
  on is trustworthy.
