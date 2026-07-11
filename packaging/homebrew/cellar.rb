# Homebrew formula for Cellar.
#
# Two install channels:
#   brew install cellar          -> latest STABLE tagged release (url + sha256)
#   brew install --HEAD cellar   -> current git main (bleeding edge)
# `cellar --update` is install-method aware (brew upgrade vs git pull).
#
# The canonical copy of this file lives in the app repo at
# packaging/homebrew/cellar.rb; the installable copy lives in the tap repo
# fbereilh/homebrew-cellar at Formula/cellar.rb. Keep the two in sync.
#
# On each release: point `url` at the new tag tarball and update `sha256`
# (`shasum -a 256` of archive/refs/tags/vX.Y.Z.tar.gz). Both repos are public,
# so no credentials are needed to install.
class Cellar < Formula
  desc "Agent-first notebook: a live Jupyter workspace with an MCP agent interface"
  homepage "https://github.com/fbereilh/cellar"
  url "https://github.com/fbereilh/cellar/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "3db6eae6f5dc06991d4fe37c0be296338124abcab13ca20046a720bbff568794"
  license "MIT"
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
    # without booting a server.
    assert_match(/^cellar \d/, shell_output("#{bin}/cellar --version"))
  end
end
