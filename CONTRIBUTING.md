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

`npm run test:e2e` **builds first** (the `pretest:e2e` hook, `scripts/ensure-build.js`)
and rebuilds only when `build/` is older than `src/`, so a re-run against an
already-fresh build pays nothing. This matters: the specs boot the real launcher
*without* `--dev`, so they run the production build - and a stale one used to be
served silently, testing code that was never compiled. That produced 11 false
failures burning ~18 minutes of expect-timeouts on results that were meaningless
in both directions. The launcher now refuses a stale build outright
(`src/lib/server/build-freshness.js`; `CELLAR_SKIP_BUILD_CHECK=1` overrides).

The suite runs at **`workers: 2`** locally (`playwright.config.ts`) - ~2.5 min
instead of ~6, verified green across repeated full runs. `fullyParallel` stays
`false` (tests within a file share one launcher, workspace and kernel). Don't
raise workers past 2: 4 was no faster and broke four timing-sensitive real-kernel
specs.

## Conventions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `feat(mcp): …`, `fix(kernel): …`, `docs(readme): …`,
  `chore(ci): …`, `perf(dataflow): …`. Browse `git log` for the house style.
- **PRs are squash-merged**, so the PR title becomes the commit on `main` (with the
  `(#NNN)` PR number appended). Give the PR a Conventional-Commits-style title.
- **Don't hand-edit auto-generated files.** `CHANGELOG.md` is generated from the
  git history by [git-cliff](https://git-cliff.org) (run `make changelog` to
  regenerate; see below) - never edit it by hand. Your Conventional-Commits
  commit title is what lands in it.
- Match the surrounding code's style, comment density, and naming. Cellar's
  in-repo agent/architecture notes live in `CLAUDE.md`; skim the relevant entry
  before changing a subsystem.

## Releasing (maintainers)

Cutting a stable release is one tag push, which triggers the GitHub Release and
the Homebrew tap bump. See **[RELEASING.md](RELEASING.md)** for the full flow.
