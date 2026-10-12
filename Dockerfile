# Twoody Server — multi-architecture image (linux/arm64 for a Raspberry Pi 5,
# linux/amd64 for a server or a NAS), with its model engine: llama.cpp's
# server, pinned and checked against its SHA-256 (src/builtin/runtimeManifest.ts,
# docs/builtin-runtime-design.md).
#
#   docker buildx build --platform linux/arm64,linux/amd64 -t twoody-server .
#   docker run --init -p 3000:3000 -v twoody:/data twoody-server
#   docker exec <container> twoody-server models add Qwen3.5-4B-Q4_K_M
#
# The runtime is baked in the image, outside the /data volume
# (TWOODY_RUNTIME_DIR=/opt/twoody/runtime): on amd64 the official llama.cpp
# release from GitHub, on arm64 Osmove's own Clang build of the same commit
# from downloads.twoody.com (a Pi reads prompts 30 % faster with it). The
# models go in the volume (/data/models), installed from the apps or with
# `twoody-server models add`. The build fails when llama-server or one of the
# CPU variants it loads at run time misses a system library.
#
# The only native module, better-sqlite3-multiple-ciphers (better-sqlite3
# built with SQLite3 Multiple Ciphers; this server keeps its database in
# clear on its own, docs/encrypted-storage.md), ships a prebuilt binary for
# linux-x64 and linux-arm64 inside its npm tarball and loads the right one at
# run time: nothing is compiled, so the build needs no toolchain and stays
# short even under emulation (QEMU in the GitHub workflow) or on a Pi. The
# OpenAPI step boots the app, which loads that binary: a build that
# succeeds is an image whose database opens.
#
# The build stages deliberately have no `--platform=$BUILDPLATFORM`: the
# classic builder (Docker without buildx, as `apt install docker.io` gives
# on Raspberry Pi OS) cannot resolve it, and `docker compose up --build`
# must work there too.
#
# Debian trixie (glibc 2.41), not Alpine: llama.cpp's Linux builds are
# glibc programs. An NVIDIA GPU: run Ollama beside it (docker-compose.yml,
# profile « ollama »), the built-in runtime is CPU only on Linux.

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The SQLite module also ships a binding.gyp; skipping install scripts keeps
# npm from compiling a binary the module never opens (no toolchain, no
# minutes spent on a Pi). In this tree only esbuild and fsevents declare
# one, and neither is needed to run `tsc`.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
COPY scripts/write-openapi.mjs ./scripts/write-openapi.mjs
# After the build: only production dependencies, and of the SQLite module only
# the binary this architecture loads (the others and the SQLite sources are
# 24 MB the image would carry for nothing).
RUN npm run build \
 && TWOODY_DATA_DIR=/tmp/openapi-data node scripts/write-openapi.mjs \
 && npm prune --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && cd node_modules/better-sqlite3-multiple-ciphers \
 && find prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete \
 && rm -rf deps src binding.gyp \
 && mkdir -p /skel/data/home

# The engine: fetched by the server's own installer, from the pinned host
# only, refused unless its SHA-256 is the manifest's.
FROM build AS runtime
RUN TWOODY_DATA_DIR=/tmp/runtime-data TWOODY_RUNTIME_DIR=/opt/twoody/runtime \
    node bin/twoody-server.mjs runtime install \
 && rm -rf /tmp/runtime-data

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Twoody Server" \
      org.opencontainers.image.description="Self-hosted, local-first Twoody backend, with llama.cpp" \
      org.opencontainers.image.vendor="Osmove" \
      org.opencontainers.image.url="https://twoody.com" \
      org.opencontainers.image.licenses="BUSL-1.1"

# What llama-server links to beyond glibc: OpenMP (the official amd64
# build) and OpenSSL. Then the check: nothing it or its CPU variants load
# may be missing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libssl3t64 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=runtime /opt/twoody/runtime /opt/twoody/runtime
RUN set -e; \
    dir=$(ls -d /opt/twoody/runtime/b11146-linux-*); \
    for file in "$dir"/llama-server "$dir"/lib*.so*; do \
      if ldd "$file" | grep "not found"; then echo "missing libraries for $file" >&2; exit 1; fi; \
    done; \
    "$dir/llama-server" --version

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.json ./openapi.json
COPY bin ./bin
# /data holds everything that must survive the container: the SQLite
# database, the setup token and the documents index (TWOODY_DATA_DIR), the
# models (/data/models) and the engine preference (/data/runtime.json), and
# under /data/home what the server keeps in its user's home — the bridge
# device id and compute keys, downloaded whisper models. Owned by the
# unprivileged `node` user (uid 1000) the server runs as.
COPY --from=build --chown=node:node /skel/data /data
# `twoody-server …` in `docker exec`.
RUN ln -s /app/bin/twoody-server.mjs /usr/local/bin/twoody-server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TWOODY_DATA_DIR=/data \
    TWOODY_RUNTIME_DIR=/opt/twoody/runtime \
    HOME=/data/home \
    TWOODY_BONJOUR_DISABLED=1

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "bin/twoody-server.mjs"]
