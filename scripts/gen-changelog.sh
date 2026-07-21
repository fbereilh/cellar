#!/usr/bin/env bash
#
# Generate CHANGELOG.md from the git history with git-cliff.
#
# CHANGELOG.md is AUTO-GENERATED - do not edit it by hand. Run `make changelog`
# (or this script) to regenerate. Grouping/format config lives in cliff.toml.
#
# Why two git-cliff passes? A rewrite of `main` after v0.1.0 shipped left the
# v0.1.0 tag on a commit that is no longer an ancestor of today's HEAD, so a
# single walk from HEAD folds the initial-development commits into v0.2.0. We
# therefore generate the changelog in two ranges and concatenate them:
#   pass 1: the tagged releases on mainline (v0.2.0 .. latest), starting just
#           after the point where v0.1.0 diverged (their merge-base)
#   pass 2: the v0.1.0 tag's own history, walked directly so git-cliff dates it
#           from the real tag
# Future release tags land on mainline and are picked up by pass 1 with no
# change here; only the orphaned v0.1.0 needs pass 2.
set -euo pipefail
cd "$(dirname "$0")/.."

cliff() { npx --no-install git-cliff --config cliff.toml "$@"; }

# Where v0.1.0 diverged from mainline = the last commit that shipped in v0.1.0.
boundary=$(git merge-base v0.1.0 HEAD)

# Pass 1 emits the header + the mainline releases. Pass 2 emits the v0.1.0
# section; awk drops its duplicate header (everything before the first `## [`).
# `cat -s` collapses the blank-line seam between the two passes; the trailing
# command substitution normalizes the file to a single terminating newline.
changelog=$(
  {
    cliff "${boundary}..HEAD"
    cliff "$(git rev-parse v0.1.0)" | awk 'f {print} /^## \[/ {f = 1; print}'
  } | cat -s
)
printf '%s\n' "$changelog" >CHANGELOG.md
echo "Wrote CHANGELOG.md"
