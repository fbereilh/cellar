# Contributing to Cellar

Thanks for your interest in improving Cellar! This guide covers how to get set
up, what CI expects before a PR can merge, and the project's conventions.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
Found a security issue? Please **don't** open a public issue - see
[SECURITY.md](SECURITY.md) for private reporting.

## Dev setup

The clone-to-run walkthrough, the kernel/venv resolution order, and every
configuration knob live in **[docs/SETUP.md](docs/SETUP.md)** - start there.
The short version, from a fresh clone:

```sh
git clone https://github.com/fbereilh/cellar.git
cd cellar
make setup   # installs deps, builds, and links `cellar` onto your PATH
```

You'll need Node 18+, Python 3.9+, and [`uv`](https://docs.astral.sh/uv/) on your
`PATH` (Cellar uses `uv` for all venv and package management). `make` with no
target lists the available commands.

## Making a change

1. **Branch off `main`.** Never commit directly to `main`.
2. Make your change, keeping edits focused and in the repo's existing style.
3. **Run the CI gate locally before you push** (see below).
4. Open a pull request against `main`.

### The CI gate

Every PR into `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml),
which must pass before merge. It runs three checks - run all three locally first:

```sh
npm run build   # vite build
npm run check   # svelte-kit sync && svelte-check (type-check)
npm run test    # vitest run (unit tests)
```

The unit suite (`tests/unit/`) is the must-pass merge gate. Its crown jewel is
clean-on-save: idempotent, git-clean round-trips, the metadata allowlist, and the
notebook model. If you touch that pipeline, expect to touch its tests.

CI installs Node only - building and type-checking are pure Node, so CI stays
fast and needs no kernel runtime.

### Playwright E2E (best-effort, local)

The end-to-end suite (`tests/e2e/`) drives the real `cellar` launcher in a
browser and needs the full kernel runtime (`uv` + `python3` + the cached
host-venv). Because CI doesn't provide that runtime, E2E is **deliberately not
run in CI** - it is a local, best-effort layer that skips itself when the runtime
is absent. Run it locally when your change touches behavior only the full stack
can show:

```sh
npx playwright install chromium   # once
npm run test:e2e
```

## Conventions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `feat(mcp): …`, `fix(kernel): …`, `docs(readme): …`,
  `chore(ci): …`, `perf(dataflow): …`. Browse `git log` for the house style.
- **PRs are squash-merged**, so the PR title becomes the commit on `main` (with the
  `(#NNN)` PR number appended). Give the PR a Conventional-Commits-style title.
- **Don't hand-edit auto-generated files** (e.g. `CHANGELOG.md` if present, or
  generated build info). There is intentionally no hand-maintained changelog -
  release notes are auto-generated (see below).
- Match the surrounding code's style, comment density, and naming. Cellar's
  in-repo agent/architecture notes live in `CLAUDE.md`; skim the relevant entry
  before changing a subsystem.

## Releasing (maintainers)

Cutting a stable release is one tag push, which triggers the GitHub Release and
the Homebrew tap bump. See **[RELEASING.md](RELEASING.md)** for the full flow.
