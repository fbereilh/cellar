#!/usr/bin/env bash
# Cellar container entrypoint.
#
# Launches Cellar on the mounted /workspace using the baked, pinned kernel venv,
# isolated (no host registry/reaper), bound to 0.0.0.0 so the published ports are
# reachable from the host, and prints the URL to open. Signals are handled by
# tini (PID 1) + Cellar's own SIGTERM shutdown, so `exec` here is deliberate.
set -euo pipefail

APP_PORT="${CELLAR_APP_PORT:-8888}"
MCP_PORT="${CELLAR_MCP_PORT:-39587}"

# Ensure the redirected writable dirs exist (they live under /tmp so this works
# for the default user AND an arbitrary `--user uid:gid`).
mkdir -p \
  "${JUPYTER_RUNTIME_DIR:-/tmp/cellar/jupyter/runtime}" \
  "${JUPYTER_DATA_DIR:-/tmp/cellar/jupyter/data}" \
  "${JUPYTER_CONFIG_DIR:-/tmp/cellar/jupyter/config}" \
  "${IPYTHONDIR:-/tmp/cellar/ipython}" \
  "${MPLCONFIGDIR:-/tmp/cellar/mpl}" \
  "${UV_CACHE_DIR:-/tmp/cellar/uv-cache}" 2>/dev/null || true

# Optional: install extra pinned packages into the kernel venv from a mounted
# requirements file (needs network + write access to /opt/cellar-kernel, i.e. the
# default container user). The primary customization path is rebuilding the image
# with your own docker/kernel-requirements.txt; this is a convenience for ad-hoc
# additions without a rebuild.
if [ -n "${CELLAR_REQUIREMENTS:-}" ]; then
  if [ -f "${CELLAR_REQUIREMENTS}" ]; then
    echo "[cellar-docker] installing extra packages from ${CELLAR_REQUIREMENTS} into the kernel venv …"
    uv pip install --python /opt/cellar-kernel/bin/python -r "${CELLAR_REQUIREMENTS}" || {
      echo "[cellar-docker] WARNING: extra package install failed; continuing with the baked env." >&2
    }
  else
    echo "[cellar-docker] WARNING: CELLAR_REQUIREMENTS=${CELLAR_REQUIREMENTS} not found; skipping." >&2
  fi
fi

# Agents connect to the PUBLISHED MCP HTTP endpoint, not the in-container
# `cellar mcp` stdio bridge — so by default don't write a project .mcp.json
# (its stdio entry would be unusable from a host with no cellar installed).
# Set CELLAR_MCP_CONFIG=1 to opt back in (e.g. an agent running inside the container).
CELLAR_ARGS=()
case "${CELLAR_MCP_CONFIG:-0}" in
  1 | true | yes | TRUE | YES) ;;
  *) CELLAR_ARGS+=("--no-mcp-config") ;;
esac

cat <<BANNER
[cellar-docker] Cellar is starting.
[cellar-docker]   Workspace : /workspace  (mount your project here)
[cellar-docker]   Kernel env: ${CELLAR_VENV:-/opt/cellar-kernel}  (baked, pinned — reproducible)
[cellar-docker]   Open in your browser : http://localhost:${APP_PORT}
[cellar-docker]   MCP (agents)         : http://localhost:${MCP_PORT}/mcp
[cellar-docker] (ports as published on the host; map them 1:1, e.g. -p ${APP_PORT}:${APP_PORT} -p ${MCP_PORT}:${MCP_PORT})
BANNER

# Run in /workspace (WORKDIR). Extra args passed to `docker run` are appended.
exec cellar --yes "${CELLAR_ARGS[@]}" "$@"
