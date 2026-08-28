# nbdev export directives: what Cellar reads, and where a directive target lands

**Status:** SHIPPED.
**Scope:** the NARROW slice the captain authorized on 2026-08-28 - Cellar reads nbdev's
`#| export` directive as a source of a cell's export mark, and resolves a `#|default_exp`
target through the project's `lib_path`. Everything else in the nbdev convergence menu was
explicitly excluded; see §5.

Background: `firstmate/data/cellar-nbdev-compat-scout/report.md` (§2.2, §2.3, §5.2, §6.1)
is the investigation this implements. It is not repeated here.

Measured against **nbdev 3.3.13 / fastcore 2.2.16**. Every claim below was driven through
the real library, not remembered - the differential in `tests/unit/nbdev-directives.test.ts`
is what keeps it honest, and it already caught one rule that reasoning got backwards.

---

## 1. Where the code is

| Concern | Module |
|---|---|
| The `#\|` scanner (both directives, one rule) | `src/lib/nbdevDirectives.ts` (pure, browser-safe) |
| Is this cell export-marked? | `src/lib/exportRole.ts` - `isExportCell`, `exportDirectiveOwnsCell` |
| Where does a `#\|default_exp` module land? | `src/lib/server/export-py.ts` - `storedExportTarget` / `directiveBase` |
| nbdev's `lib_path` | `src/lib/server/nbdev.ts` - `nbdevLibPath` |
| Refusals | `notebook.ts` `setCellExport`, the `PATCH /api/cells/[id]` route, MCP `set_cell_export` |

Tests: `nbdev-directives` (the scanner + the differential), `nbdev-export-directive` (the
mark, end to end through the real doc layer / exporter / agent surface),
`nbdev-lib-path` (both resolution paths), `tests/e2e/nbdev-export-directive.spec.ts` (the
browser-only honesty claim).

---

## 2. What counts as a directive

nbdev reads directives from the **leading block** of a cell: the run of lines at the top
that are `#|` lines, cell magics (`%%time`) or blank. The block ends at the first ordinary
line - **a plain `# comment` ends it too**. So none of these is a directive to nbdev:

```python
x = 1
#| export          # after code: the block already ended

# a note
#| export          # after a plain comment: same

s = '''
#| export          # inside a string: the assignment ended the block
'''
```

Cellar's previous `#|default_exp` scan was a `/m` regex over the whole source and honoured
all three. That is the shape of the §5.2 defect: **a target resolved from text nbdev
ignores, written to a file nbdev would never write.** Honouring half of nbdev is worse than
honouring none.

Other measured rules: the prefix is `\s*#\s*\|` (so `#|export`, `#| export`, `# | export`,
indented with spaces or a tab, CRLF); the name runs to the first whitespace or colon; the
literal value `true` normalizes to bare, so `#| export` and `#| export: true` are the same
thing; names are **case-sensitive**; and a repeated name is **LAST**-wins (nbdev builds a
dict over the block, so a later line overwrites an earlier one - the obvious first-wins
guess is wrong, and the differential is what caught it).

---

## 3. The mark: which source wins, and why the question has no answer to argue about

nbdev's rule is comments-beat-metadata (`fastcore/nbio.py` `_directives_get`). Cellar's is
metadata-first. Those look like they must be reconciled. **For this flag they do not**,
because neither source can express a NEGATION:

- nbdev's `#| export` is presence-only. There is no "not exported" directive.
- Cellar's flag is presence-only too: `setCellExports` DELETES the key rather than storing
  `false`, and `isExportCell` is a strict `=== true`, so an absent flag and a hand-edited
  `false` already read alike.

With no way to say "no", comments-win, metadata-win and union are the **same function** on
the values that can occur. A cell is exported if either says so. That is what made this
settleable without a product call: the disagreement the two designs appear to have is not
reachable.

### 3.1 Marking stays metadata-only - the decision that IS a decision

Toggling export in Cellar **never writes a `#|` line into the user's source.** Source is
code the kernel runs and git diffs; the whole reason the flag lives in `metadata.cellar` is
that clean-on-save preserves that namespace byte-for-byte.

The consequence is that a directive-marked cell **cannot be unmarked from Cellar**, and
every surface says so rather than reporting a change the notebook did not take:

- `setCellExport` returns `{ok:false, reason:'export-directive-owns-cell'}`.
- `PATCH /api/cells/[id]` answers 409 with that reason. Its siblings (`no-such-cell`,
  `not-code`) stay silent exactly as before - widening those is a separate change.
- MCP `set_cell_export` refuses all-or-nothing, naming the handle the agent supplied and
  the line to remove.
- The row toggle shows **ON** (an unticked control over a cell the exporter writes is the
  lie this exists to avoid) and stays **live** rather than `disabled`: a disabled button
  gets no pointer events, so its `title` could never be hovered and the one thing the user
  needs - which line to remove - would be unreachable. Clicking declines on the shell's
  notice line. Same live-control-that-explains-itself stance the Databricks card takes.

Clearing the metadata half instead would leave the cell exported with the toggle bouncing
straight back to ON. MARKING a directive-marked cell is an honest no-op: it is already
exported, so the call is satisfied and nothing is written.

The explanation rides `title`, not `aria-label`: the label stays STABLE across states (the
state is `aria-pressed`'s job), and a browser exposes `title` as the accessible DESCRIPTION
beside that name.

---

## 4. `#|default_exp` and `lib_path`

nbdev's `default_exp` names a **dotted module measured from `lib_path`** - not a path
measured from anywhere Cellar knows. Cellar resolved it workspace-relative, so opening
nbdev's own `nbs/api/04_export.ipynb` and marking a cell wrote a stray `export.py` at the
workspace root while the project's real module is `nbdev/export.py`.

The rule, measured: `lib_path` is `[tool.nbdev].lib_path` when present, else
`[project].name` with `-` folded to `_`; either way it is resolved against the **directory
holding the `pyproject.toml`**, and an absent project name degenerates to that directory.

`directiveBase` re-expresses the module workspace-relative and keeps the reported base as
`workspace`. That is deliberate: it keeps `ResolvedExportTarget`'s own invariant literally
true (`path` measured from `base` yields `target`), keeps every consumer correct - the MCP
remedy string included - without widening the persisted `ExportBase` vocabulary the UI
select is built from, and **leaves the name `nbdev` free for the fourth persisted base**
scout §6.1 proposes. The derivation is the same kind this branch always did (a dotted
module is not a stored path either), just measured from the root nbdev actually uses.

**Outside an nbdev project nothing changes.** A directive target stays workspace-relative,
byte for byte, so no existing notebook moves. That is asserted as a positive, not implied.

**Refusing rather than degrading.** An nbdev project whose `lib_path` cannot be read with
confidence (an inline `[tool.nbdev]`, unparseable TOML, a non-string value) makes the
directive target UNRESOLVABLE rather than workspace-relative - falling back is the
wrong-file write above. The escape hatch is untouched: an explicit
`metadata.cellar.export_target` never consults any of this.

A `lib_path` OUTSIDE the workspace is refused by the existing containment guard - and that
is the COMMON real nbdev layout, not an edge case: opening Cellar in `nbs/` while
`lib_path` is a sibling puts the module outside the tree Cellar serves. Refusing is
strictly better than the pre-fix stray `nbs/core.py` nbdev knows nothing about, but the
guard's own "path escapes workspace" is nothing a user can act on, so the refusal names the
layout and both ways out (open Cellar at the project root, or set an explicit target).
Opening Cellar AT the project root - where `pyproject.toml` is - is the case that works,
and it was verified side by side against real `nb_export`: same file, same cells, same
`__all__`.

**Cost.** Only a notebook carrying a `#|default_exp` directive ever asks, so an ordinary
Cellar notebook pays nothing. For those that do, the answer is cached on a short TTL
(`listWorktreesAt`'s tier, for its reason). Deliberately not memoized for the process
lifetime the way `preflight` is: repo identity does not change, a project's `lib_path` can.

**Stated limit:** nbdev also merges a user-level `~/.config/nbdev/config.toml` under the
project's `[tool.nbdev]`. Not modelled - project config wins wherever it is present, and
the failure is visible rather than silent.

---

## 5. What is deliberately NOT read, and what that costs

Only a **bare** `#| export`, and only that exact name.

| Directive | nbdev's module behaviour (measured) | Cellar |
|---|---|---|
| `export` | module code + `__all__` | **read as a mark** |
| `exports` | module code + `__all__` - *identical for the module*; differs only in docs rendering | not read |
| `exporti` | module code, NOT in `__all__` | not read |
| `exportd` | docstring, not module code | not read |
| `export <module>` | a SECOND module beside the `default_exp` one | not read |

`exporti` and `exportd` genuinely cannot be expressed by a single boolean, and a wrong
guess writes an unwanted public name or a markdown blob into a file that is committed to
git. A valued `#| export other` names a module Cellar's one-target-per-notebook model
cannot express, so reading it as a mark would be the §5.2 wrong-file write reached from
the cell side.

**`exports` is the one worth flagging back.** The captain's exclusion rested on "Cellar's
single boolean cannot express them", and for `exports` that premise is FALSE as measured -
it is module-identical to `export`, so recognising it is a one-line change needing no new
modelling. It is left unread because the increment's scope names it; widening it is a
decision, not an oversight.

**The cost, stated plainly:** a module Cellar generates for such a notebook omits those
cells, so a marked cell calling an `exporti` helper yields a module that raises
`NameError` on import. That is not a regression - Cellar saw ZERO nbdev marks before - but
it is a real limit. The clobber guard in `export-py.ts` (refusing to overwrite a file that
does not start with Cellar's header) is what stops it damaging an existing nbdev module.

### 5.1 Known cosmetic divergence: the directive line survives into the module

nbdev STRIPS directives from an exported cell's source (`remove_directives`); Cellar emits
each marked cell's source VERBATIM, so a generated module carries the `#| export` line as a
leading comment. Verified side by side against real nbdev on the same project: the two agree
on the FILE, on WHICH cells, and on `__all__` (`topLevelNames` ignores the comment) - only
the emitted body differs, and it differs by design already (header, cell markers,
docstring; scout §6.3 argues byte-equality is the wrong goal). It is a comment in valid
Python, and stripping source is a change to what the exporter EMITS rather than to what it
reads, so it is recorded rather than done here.

Also out of this slice, per the captain: the docs-pipeline directives (`hide`, `hide_line`,
`echo`, `output`, `code-fold`, `eval: false`, `exec_doc`, `filter_stream`); mirroring
Cellar metadata into `metadata.nbdev`; and adopting nbdev's exporter or tooling.
