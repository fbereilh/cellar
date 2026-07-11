# Homebrew formula for Cellar.
#
# Cellar tracks LATEST (git main), not tagged semver releases, so this is a
# HEAD-only formula: `brew install --HEAD cellar` builds from the current tip of
# fbereilh/cellar, and `cellar --update` runs `brew upgrade --fetch-HEAD cellar`
# to move to the newest main.
#
# The canonical copy of this file lives in the app repo at
# packaging/homebrew/cellar.rb; the installable copy lives in the tap repo
# fbereilh/homebrew-cellar at Formula/cellar.rb. Keep the two in sync.
#
# NOTE: fbereilh/cellar is a PRIVATE repo, so `brew install` needs the invoking
# user's GitHub git credentials (gh auth / SSH / a PAT) to clone main.
class Cellar < Formula
  desc "Agent-first notebook: a live Jupyter workspace with an MCP agent interface"
  homepage "https://github.com/fbereilh/cellar"
  head "https://github.com/fbereilh/cellar.git", branch: "main"

  depends_on "node"
  depends_on "uv"

  def install
    # Stamp the build identity so `cellar --version` is meaningful even on a
    # STABLE install (a source tarball with no `.git`, where a runtime
    # `git rev-parse` returns blank). scripts/gen-build-info.js takes the version
    # from here and, on a `--HEAD` build (which has a `.git`), still resolves the
    # real git sha itself; a stable tarball has no git, so its sha is "release".
    ENV["CELLAR_BUILD_VERSION"] = version.to_s

    # Build the adapter-node production server (build/index.js).
    system "npm", "ci"
    system "npm", "run", "build"

    # Ship the built app + launcher into libexec, then expose a thin `cellar`
    # wrapper that runs the launcher with Homebrew's node.
    libexec.install Dir["*"]
    (bin/"cellar").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/bin/cellar.js" "$@"
    SH
  end

  test do
    # `cellar --version` prints "cellar <pkg-version>" + build metadata and exits 0
    # without booting a server. (The pkg version is package.json's, not the brew
    # HEAD version, so match on the program name rather than `version`.)
    assert_match(/^cellar \d/, shell_output("#{bin}/cellar --version"))
  end
end
