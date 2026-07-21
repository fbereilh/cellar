# Releasing Cellar

Cellar ships two ways from the same `main`:

- `brew install --HEAD cellar` - the current tip of `main` (bleeding edge).
- `brew install cellar` - the latest **stable tagged release** (`url` + `sha256`
  in the tap formula).

Cutting a stable release is now **one push**. Pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which:

1. Creates the **GitHub Release** for the tag with auto-generated notes.
2. Bumps the **Homebrew tap** (`fbereilh/homebrew-cellar`, `Formula/cellar.rb`)
   so its `url` + `sha256` point at the new tag's tarball - so `brew install
   cellar` resolves the new version.

No more hand-editing checksums.

## Cut a release

From a clean `main` with your work merged:

```sh
git checkout main && git pull

# Bump package.json and create the matching tag in one step:
npm version patch      # or: minor | major  -> creates commit + tag vX.Y.Z

# Refresh the changelog now that the tag exists, and commit it:
make changelog
git add CHANGELOG.md && git commit -m "chore(changelog): vX.Y.Z"

# Push the commits and the tag:
git push --follow-tags
```

That's it. Watch **Actions -> release**. When it's green:

- The GitHub Release exists at `https://github.com/fbereilh/cellar/releases`.
- The tap formula has been bumped (commit `cellar vX.Y.Z` on
  `fbereilh/homebrew-cellar`), so `brew update && brew install cellar` (or
  `brew upgrade cellar`) installs the new version.

### Prereleases

Tags with a `-rc`, `-beta`, or `-alpha` suffix (e.g. `v1.2.0-rc1`) are marked as
**prereleases** on GitHub and **do not** bump the stable tap formula - so
`brew install cellar` stays on the last stable tag. Use them to publish a
release for testing without promoting it to everyone's `brew install`.

### Manual fallback

If a tag push didn't run (or you need to re-run the tap bump after adding
`TAP_TOKEN`), go to **Actions -> release -> Run workflow** and enter an existing
tag. It re-creates/refreshes the release and re-bumps the tap.

## The changelog

`CHANGELOG.md` is **auto-generated** from the git history by
[git-cliff](https://git-cliff.org) (config in `cliff.toml`) - it is never
hand-edited. Regenerate it any time with:

```sh
make changelog          # = bash scripts/gen-changelog.sh  (= npm run changelog)
```

git-cliff groups commits by their Conventional-Commit type (Features / Bug
Fixes / Performance / …) into one dated section per release tag. git-cliff is a
`devDependency`, so `make changelog` needs no global install; regeneration is
deterministic (same history in, same file out).

One wrinkle the script handles: a history rewrite of `main` after v0.1.0 shipped
left the `v0.1.0` tag on a commit that is no longer an ancestor of `HEAD`, so a
single git-cliff pass would fold the initial-development commits into v0.2.0. The
script (`scripts/gen-changelog.sh`) generates the mainline releases and the
v0.1.0 section in two passes and concatenates them - see its header comment.

**Why regeneration is a manual release step, not CI:** refreshing the changelog
for a new tag means committing `CHANGELOG.md` back to `main`. Doing that from the
tag-triggered `release.yml` is fiddly and fragile - the push needs write
credentials that clear branch protection, the tagged commit still wouldn't
contain its own changelog entry (chicken-and-egg), and an auto-commit risks
re-triggering CI. So the flow above regenerates + commits it as part of cutting
the release instead. If you forget, just run `make changelog` on `main` afterward
and commit.

## One-time setup: the `TAP_TOKEN` secret

Job B commits to a **different repo** (the tap), so the default `GITHUB_TOKEN`
(scoped to `fbereilh/cellar`) can't be used. The workflow reads
`secrets.TAP_TOKEN` and **fails with a clear message if it's missing** - the
GitHub Release is still created, but the tap bump is skipped until the secret
exists.

Create a **fine-grained personal access token** scoped to the tap:

1. GitHub -> **Settings -> Developer settings -> Personal access tokens ->
   Fine-grained tokens -> Generate new token**.
2. **Resource owner:** `fbereilh`.
3. **Repository access:** *Only select repositories* -> `fbereilh/homebrew-cellar`.
4. **Permissions -> Repository permissions -> Contents:** **Read and write**.
   (Everything else can stay "No access".)
5. Set an expiry you're comfortable with and **Generate token**. Copy it.

Add it as a secret on **this** repo (`fbereilh/cellar`):

```sh
gh secret set TAP_TOKEN -R fbereilh/cellar
# paste the token when prompted
```

(Or **Settings -> Secrets and variables -> Actions -> New repository secret**,
name `TAP_TOKEN`.)

When the token expires, regenerate it and re-run `gh secret set TAP_TOKEN`. If a
release ran while the secret was absent/expired, re-run the workflow via the
manual fallback above once it's fixed.

## What the workflow touches

- `fbereilh/cellar` - creates a GitHub Release (default `GITHUB_TOKEN`).
- `fbereilh/homebrew-cellar` - commits the bumped `Formula/cellar.rb` directly
  to its default branch (a solo tap; a PR would just be self-merged). Uses
  `TAP_TOKEN`.

Keep `packaging/homebrew/cellar.rb` (the canonical copy in this repo) in sync
with the tap's `Formula/cellar.rb` when the formula's *structure* changes; the
per-release `url`/`sha256` bump is automated on the tap side only.
