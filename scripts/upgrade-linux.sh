#!/usr/bin/env bash
# Push the locally-built twoody-server dist to a remote Linux host
# (Raspberry Pi, generic amd64/arm64) and restart the systemd service.
#
# Idempotent: rebuilds the TS sources if needed, rsyncs `dist/`, runs
# `npm ci --omit=dev --ignore-scripts` if `package.json` changed, and
# nudges systemd. Safe to re-run after every commit. Nothing is compiled
# on the target: better-sqlite3-multiple-ciphers ships a prebuilt binary per platform.
#
# Usage (from a twoody-server checkout on your laptop):
#   scripts/upgrade-linux.sh                       # uses defaults
#   scripts/upgrade-linux.sh user@host             # custom SSH target
#   scripts/upgrade-linux.sh twoody-pi /opt/foo    # custom remote path
#
# Defaults:
#   TARGET=twoody-pi              (SSH alias in ~/.ssh/config)
#   REMOTE_PATH=/opt/twoody-server
#   SERVICE=twoody-server.service
#
# Env overrides:
#   TWOODY_PI_HOST, TWOODY_PI_PATH, TWOODY_PI_SERVICE
#
# Pre-conditions:
#   - Passwordless SSH from this host to the target
#   - Target user has sudo for `systemctl restart`
#   - Target host already provisioned via `install-linux.sh`

set -euo pipefail

TARGET="${1:-${TWOODY_PI_HOST:-twoody-pi}}"
REMOTE_PATH="${2:-${TWOODY_PI_PATH:-/opt/twoody-server}}"
SERVICE="${TWOODY_PI_SERVICE:-twoody-server.service}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[upgrade] $*"; }

if [[ ! -f package.json ]]; then
  echo "[upgrade] No package.json in $(pwd) — run from a twoody-server checkout." >&2
  exit 1
fi

log "Building TypeScript dist…"
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build

log "Rsyncing dist/ + package metadata to ${TARGET}:${REMOTE_PATH}/"
rsync -az --delete \
  --exclude '.DS_Store' \
  bin \
  dist \
  package.json \
  package-lock.json \
  openapi.json \
  README.md \
  LICENSE \
  scripts \
  "${TARGET}:${REMOTE_PATH}/"

# Hash-compare package-lock.json on the remote; only run npm ci if
# the lock changed, otherwise the native rebuild is wasted effort.
LOCAL_LOCK_HASH=$(shasum -a 256 package-lock.json | awk '{print $1}')
REMOTE_LOCK_HASH=$(ssh "$TARGET" "shasum -a 256 ${REMOTE_PATH}/package-lock.json 2>/dev/null | awk '{print \$1}'" || echo "")
LAST_LOCK_HASH=$(ssh "$TARGET" "cat ${REMOTE_PATH}/.last-lock-hash 2>/dev/null" || echo "")

if [[ -z "$LAST_LOCK_HASH" || "$LOCAL_LOCK_HASH" != "$LAST_LOCK_HASH" ]]; then
  log "package-lock.json changed → npm ci --omit=dev --ignore-scripts on ${TARGET}"
  ssh "$TARGET" "cd ${REMOTE_PATH} && npm ci --omit=dev --ignore-scripts"
  ssh "$TARGET" "echo '${LOCAL_LOCK_HASH}' > ${REMOTE_PATH}/.last-lock-hash"
else
  log "package-lock.json unchanged, skipping npm ci"
fi

# A new llama.cpp tag is a new runtime folder: installed before the
# restart, so the server finds it. Not fatal (the server runs without it).
log "Built-in model engine: twoody-server runtime install on ${TARGET}"
ssh "$TARGET" "cd ${REMOTE_PATH} && node bin/twoody-server.mjs runtime install" || log "  (not installed now; run twoody-server runtime install there)"

# The unit is not replaced here (install-linux.sh adapts it to its host):
# say when this checkout's differs from the one installed.
if ! ssh "$TARGET" "diff -q ${REMOTE_PATH}/scripts/twoody-server.service /etc/systemd/system/${SERVICE}" >/dev/null 2>&1; then
  log "Note: scripts/twoody-server.service changed (KillMode=control-group, TimeoutStopSec=10 for the built-in engine); re-run install-linux.sh there to apply it."
fi

log "Restarting ${SERVICE}…"
ssh "$TARGET" "sudo systemctl restart ${SERVICE}"

sleep 2
log "Service status:"
ssh "$TARGET" "sudo systemctl is-active ${SERVICE} && curl -s -m 3 http://localhost:3000/health || echo '(health probe failed)'"

log "Done. Tail logs with: ssh ${TARGET} 'sudo journalctl -u ${SERVICE} -f'"
