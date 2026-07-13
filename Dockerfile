# syntax=docker/dockerfile:1
#
# Cellar — reproducible, zero-prerequisite Docker image.
#
# Goals (see docker/README-docker section in README.md):
#   1. Reproducible, PINNED kernel environment — a uv-managed venv baked into the
#      image from docker/kernel-requirements.txt, so every run is identical.
#   2. Zero prerequisites — only Docker on the host. Node, Python and uv all live
#      inside the image; you mount your work dir and open the printed URL.
#
# Base choice (self-contained node + uv + python, NOT a jupyter/docker-stacks
# conda image): Cellar is uv-first by design — it hard-requires `uv` and manages
# every venv (kernel bind, runtime rebind, Databricks installs) through it. A
# conda-based docker-stacks base would bolt on a second, foreign package manager
# that Cellar never uses for the kernel, and docker-stacks ships no Node (which
# Cellar needs) — so we would be layering Node + uv onto conda anyway. Starting
# from the official Node image and adding a uv-managed, explicitly-pinned kernel
# venv is smaller, single-toolchain, exactly matches Cellar's real runtime model,
# and gives a crisp "reproducible pinned env" story you fully control in
# docker/kernel-requirements.txt. See the README for the full rationale.

# ---- Pinned build inputs (override at build time with --build-arg) -----------
ARG NODE_IMAGE=node:22.13.1-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.5.14

# =============================================================================
# Stage 1 — build the SvelteKit app (needs dev deps + the full source tree).
# =============================================================================
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Install deps first (cached until package*.json change).
COPY package.json package-lock.json ./
RUN npm ci

# Build the adapter-node output into build/.
COPY . .
# CELLAR_BUILD_SHA/VERSION let `cellar --version` report a real build identity
# even though .git is not copied into the image (see scripts/gen-build-info.js).
ARG CELLAR_BUILD_SHA=docker
ARG CELLAR_BUILD_VERSION
ENV CELLAR_BUILD_SHA=${CELLAR_BUILD_SHA} \
    CELLAR_BUILD_VERSION=${CELLAR_BUILD_VERSION}
RUN npm run build

# =============================================================================
# Stage 2 — the runtime image: Node + uv + a baked, pinned kernel + host venv.
# =============================================================================
FROM ${NODE_IMAGE} AS runtime
ARG UV_IMAGE

# uv — the single toolchain Cellar uses for all Python venv/package work.
COPY --from=${UV_IMAGE} /uv /usr/local/bin/uv

# System Python (stable, world-readable — the interpreter the baked venvs link
# to), tini (PID 1: forwards signals + reaps the kernel/sidecar children Cellar
# spawns), and ca-certificates for HTTPS package installs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (docker-stacks convention). Home holds the baked Jupyter host env.
RUN groupadd --gid 1000 cellar \
    && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/cellar cellar

ENV HOME=/home/cellar

# ---- Baked kernel venv (goal #1: reproducible pinned env) --------------------
# A uv venv at /opt/cellar-kernel with the pinned scientific stack. Cellar binds
# its kernel to this venv (CELLAR_VENV below), so the kernel env is identical on
# every run with no network access at start.
# Owned by the cellar user so the optional runtime `CELLAR_REQUIREMENTS` install
# can add packages; world-readable/executable so an arbitrary `--user` can still
# use the kernel.
COPY docker/kernel-requirements.txt /opt/kernel-requirements.txt
RUN uv venv --python /usr/bin/python3 /opt/cellar-kernel \
    && uv pip install --python /opt/cellar-kernel/bin/python -r /opt/kernel-requirements.txt \
    && chown -R cellar:cellar /opt/cellar-kernel \
    && chmod -R a+rX /opt/cellar-kernel

# ---- Baked Jupyter host env --------------------------------------------------
# Cellar runs a headless jupyter_server sidecar from a private host venv
# (~/.cellar/host-venv). Pre-create it exactly as venv.js#ensureHostEnv expects
# (marker file included) so the container starts instantly and offline.
RUN uv venv --python /usr/bin/python3 /home/cellar/.cellar/host-venv \
    && uv pip install --python /home/cellar/.cellar/host-venv/bin/python jupyter-server \
    && touch /home/cellar/.cellar/host-venv/.cellar-host-ready \
    && chmod -R a+rX /home/cellar

# ---- App + launcher ----------------------------------------------------------
WORKDIR /app
# Prod-only node_modules (the launcher runs `node build/index.js` from here).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The built app, the launcher, and the node-only server modules it imports.
COPY --from=build /app/build ./build
COPY bin ./bin
COPY src/lib/server ./src/lib/server
COPY docker/entrypoint.sh /usr/local/bin/cellar-entrypoint
RUN ln -s /app/bin/cellar.js /usr/local/bin/cellar \
    && chmod +x /app/bin/cellar.js /usr/local/bin/cellar-entrypoint

# ---- Runtime environment -----------------------------------------------------
# Fixed, predictable ports so they can be published/mapped from the host.
ENV CELLAR_APP_PORT=8888 \
    CELLAR_MCP_PORT=39587
# Bind the app (adapter-node HOST) + MCP on all interfaces so the published ports
# are reachable from the host.
ENV HOST=0.0.0.0 \
    CELLAR_MCP_HOST=0.0.0.0
# Containerized behavior: isolated (no host registry/reaper), no browser, bind
# the kernel to the baked pinned venv, and don't write a .mcp.json (agents
# connect to the published MCP HTTP URL, not the in-container `cellar mcp` bridge;
# set CELLAR_MCP_CONFIG=1 for an agent running inside the container).
ENV CELLAR_ISOLATED=1 \
    CELLAR_NO_BROWSER=1 \
    CELLAR_VENV=/opt/cellar-kernel \
    CELLAR_MCP_CONFIG=0
# Redirect all writable caches out of $HOME to a world-writable dir so the image
# also works under an arbitrary `--user uid:gid` (Linux bind-mount uid match);
# $HOME stays read-only, holding only the baked host venv.
ENV JUPYTER_RUNTIME_DIR=/tmp/cellar/jupyter/runtime \
    JUPYTER_DATA_DIR=/tmp/cellar/jupyter/data \
    JUPYTER_CONFIG_DIR=/tmp/cellar/jupyter/config \
    IPYTHONDIR=/tmp/cellar/ipython \
    MPLCONFIGDIR=/tmp/cellar/mpl \
    UV_CACHE_DIR=/tmp/cellar/uv-cache \
    XDG_CACHE_HOME=/tmp/cellar/cache \
    XDG_CONFIG_HOME=/tmp/cellar/config \
    XDG_DATA_HOME=/tmp/cellar/data

# The workspace is normally a bind mount (which shadows this), but create it
# cellar-owned so a no-mount run and the .cellar/runtime.json write still work.
RUN mkdir -p /workspace && chown cellar:cellar /workspace

USER cellar
WORKDIR /workspace
EXPOSE 8888 39587

# tini as PID 1 reaps the kernel/sidecar children and forwards SIGTERM so
# `docker stop` shuts Cellar down cleanly.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/cellar-entrypoint"]
