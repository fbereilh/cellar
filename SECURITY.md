# Security Policy

Cellar runs an **arbitrary-code-execution Python kernel** and a local **MCP
server** inside your project folder. That is the whole point of the product, but
it also means the security model deserves to be spelled out plainly. Please read
the threat model below before deciding how to run and expose Cellar.

## Reporting a vulnerability

**Please report vulnerabilities privately - do not open a public issue.**

- **Preferred:** GitHub's private vulnerability reporting. Go to the
  [**Security** tab](https://github.com/fbereilh/cellar/security) of this
  repository and click **"Report a vulnerability"**. This opens a private
  advisory visible only to you and the maintainers.
- **Fallback:** email the maintainer at **fbereilh@gmail.com**.

Please include enough detail to reproduce: the Cellar version (`cellar --version`),
your OS and install method, and a minimal set of steps or a proof of concept. We
will acknowledge your report, work with you on a fix, and credit you in the
release notes unless you prefer to remain anonymous.

## Supported versions

Cellar tracks the latest `main`; there are no long-lived release branches. All
fixes land on `main` and flow out through the next tagged release and the
Homebrew tap (`brew install cellar` for the latest stable tag, `brew install
--HEAD cellar` for the tip of `main`). **Older tagged releases are not
back-ported** - the supported version is always the latest.

| Version        | Supported |
| -------------- | --------- |
| latest `main`  | ✅        |
| older releases | ❌        |

If you are affected by a security issue, the fix is to update
(`cellar --update`), not to patch an old release.

## Threat model

Cellar is a **single-user, local-first developer tool**. Its security posture
follows directly from that:

- **No authentication, by design.** The app, the MCP server, and the Jupyter
  sidecar have no login. They are meant to be reached only by you, from the
  machine they run on.
- **The kernel executes arbitrary code, by design.** A notebook cell (whether you
  or a connected agent authors it) runs as your user, with your filesystem and
  network access. Cellar makes no attempt to sandbox cell execution - treat any
  notebook or `.py` you open the way you would treat any script you are about to
  run.
- **The MCP server drives that kernel.** Any client that can reach the MCP
  endpoint can add and run cells, i.e. execute code on your machine. Only
  connect agents you trust to the workspace.
- **Do not expose the ports beyond `localhost`.** The app, MCP, and Jupyter
  ports are for local use only. Publishing them to a network (or to `0.0.0.0`)
  turns "runs code as me" into "runs code as me, for anyone who can reach the
  port." Cellar is **not** built for multi-user or hosted deployment.

The Docker path is the one place Cellar binds to `0.0.0.0` (so the container's
published ports are reachable from the host), and the container runs isolated and
non-root for exactly that reason. The trade-offs and caveats there - single-user
only, don't expose the ports beyond `localhost`, read-only Databricks config
mount, and so on - are covered in the **[Run with Docker](README.md#run-with-docker)**
section of the README; that guidance is part of this policy and is not repeated
in full here.

## Scope

In scope: anything that lets a party who *should not* be able to run code on your
machine do so (e.g. an unauthenticated network path that shouldn't exist, a
path-traversal escape from the workspace root, or an injection that makes Cellar
execute code you did not author). Out of scope: the kernel running code you or a
trusted agent deliberately put in a cell - that is the intended behavior, not a
vulnerability.
