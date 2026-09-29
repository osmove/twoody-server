# Twoody Server — multi-architecture image (linux/arm64 for a Raspberry Pi 5,
# linux/amd64 for a server or a NAS).
#
#   docker buildx build --platform linux/arm64,linux/amd64 -t twoody-server .
#
# The only native module, better-sqlite3, ships a prebuilt binary for
# linux-x64, linux-arm64 and their musl variants inside its npm tarball and
# loads the right one at run time: nothing is compiled, so the build needs no
# toolchain and stays short even under emulation (QEMU in the GitHub
# workflow) or on a Pi. The OpenAPI step boots the app, which loads that
# binary: a build that succeeds is an image whose database opens.
#
# The build stage deliberately has no `--platform=$BUILDPLATFORM`: the
# classic builder (Docker without buildx, as `apt install docker.io` gives
# on Raspberry Pi OS) cannot resolve it, and `docker compose up --build`
# must work there too.
#
# There is no model in this image. Run Ollama next to it (docker-compose.yml)
# or point BRIDGE_LOCAL_LLM_ENDPOINT at any OpenAI-compatible runtime.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 also ships a binding.gyp; skipping install scripts keeps
# npm from compiling a binary the module never opens (no toolchain, no
# minutes spent on a Pi). In this tree only esbuild and fsevents declare
# one, and neither is needed to run `tsc`.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts/write-openapi.mjs ./scripts/write-openapi.mjs
# After the build: only production dependencies, and of better-sqlite3 only
# the binary this architecture loads (the others and the SQLite sources are
# 24 MB the image would carry for nothing).
RUN npm run build \
 && TWOODY_DATA_DIR=/tmp/openapi-data node scripts/write-openapi.mjs \
 && npm prune --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && cd node_modules/better-sqlite3 \
 && find prebuilds -type f ! -name "linuxmusl-$(node -p process.arch).node" -delete \
 && rm -rf deps src binding.gyp \
 && mkdir -p /skel/data/home

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Twoody Server" \
      org.opencontainers.image.description="Self-hosted, local-first Twoody backend" \
      org.opencontainers.image.vendor="Osmove" \
      org.opencontainers.image.url="https://twoody.com" \
      org.opencontainers.image.licenses="BUSL-1.1"

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.json ./openapi.json
COPY bin ./bin
# /data holds everything that must survive the container: the SQLite
# database, the setup token and the documents index (TWOODY_DATA_DIR), and
# under /data/home what the server keeps in its user's home — the bridge
# device id and compute keys, downloaded whisper models. Owned by the
# unprivileged `node` user (uid 1000) the server runs as.
COPY --from=build --chown=node:node /skel/data /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TWOODY_DATA_DIR=/data \
    HOME=/data/home \
    TWOODY_BONJOUR_DISABLED=1

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "bin/twoody-server.mjs"]
