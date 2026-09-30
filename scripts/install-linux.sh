#!/usr/bin/env bash
# twoody-server installer for headless Linux hosts (Raspberry Pi 4/5,
# generic amd64/arm64 boxes). Provisions the runtime dependencies,
# installs the built-in model engine (llama.cpp, pinned), drops the
# systemd unit, and starts the service. Then:
#   twoody-server models add Qwen3.5-4B-Q4_K_M
#
# Ollama is no longer installed by default: the server runs llama.cpp
# itself. TWOODY_WITH_OLLAMA=1 installs it too (an NVIDIA GPU, or to keep
# its models); a host that already has it keeps it.
#
# Usage, from a checkout on the target host:
#   sudo bash scripts/install-linux.sh
#
# (There is no public URL to curl this from: the repository is private.
# Copy the checkout over with scp or rsync, or use scripts/upgrade-linux.sh
# from a machine that has one.)
#
# Idempotent: re-running upgrades node and reinstalls the unit. The
# env file at /etc/twoody-server.env is created on first run from
# `twoody-server.env.example` and never overwritten afterwards.

set -euo pipefail

NODE_MAJOR=22
APP_DIR="/opt/twoody-server"
ENV_FILE="/etc/twoody-server.env"
SERVICE_NAME="twoody-server"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
RUN_USER="${TWOODY_USER:-pi}"

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (or via sudo)." >&2
  exit 1
fi

log() { echo "[install] $*"; }

log "Installing system packages…"
apt-get update -y -qq
# No compiler: the one native module (better-sqlite3) ships a prebuilt
# binary for linux-arm64 and linux-x64 and loads that. It also ships a
# binding.gyp, which npm would compile on sight — several minutes on a
# Pi, for a file the module never opens — so install scripts are skipped
# below instead of a toolchain being installed here.
# libgomp1: the OpenMP runtime the official amd64 llama.cpp build links
# to (Osmove's arm64 build does without it).
apt-get install -y -qq \
  curl ca-certificates gnupg git rsync \
  ripgrep ffmpeg poppler-utils \
  avahi-daemon avahi-utils libnss-mdns \
  sqlite3 libgomp1

log "Installing Node.js ${NODE_MAJOR} via NodeSource…"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
log "  node $(node -v) / npm $(npm -v)"

if [[ "${TWOODY_WITH_OLLAMA:-0}" == "1" ]]; then
  log "Installing Ollama (TWOODY_WITH_OLLAMA=1)…"
  if ! command -v ollama >/dev/null 2>&1; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
fi

log "Preparing application directory at ${APP_DIR}…"
install -d -o "${RUN_USER}" -g "${RUN_USER}" "${APP_DIR}"
# Where the database and the setup token live (DATA_DIR in src/db.ts),
# and where the bridge client keeps its device id. Created up front so
# the service never has to, and owned by the user it runs as.
install -d -m 0700 -o "${RUN_USER}" -g "${RUN_USER}" "/home/${RUN_USER}/.twoody"
install -d -m 0700 -o "${RUN_USER}" -g "${RUN_USER}" "/home/${RUN_USER}/.twoody/data"
install -d -m 0700 -o "${RUN_USER}" -g "${RUN_USER}" "/home/${RUN_USER}/.twoody-server"

if [[ -d "$(dirname "$0")/.." && -f "$(dirname "$0")/../package.json" ]]; then
  log "Copying repo to ${APP_DIR}…"
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude .DS_Store \
    "$(dirname "$0")/../" "${APP_DIR}/"
  chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"
fi

if [[ -f "${APP_DIR}/package.json" ]]; then
  if [[ -f "${APP_DIR}/dist/index.js" ]]; then
    log "Installing runtime dependencies…"
    sudo -u "${RUN_USER}" -H bash -c "cd ${APP_DIR} && npm ci --omit=dev --ignore-scripts"
  else
    # TypeScript is a dev dependency, so the build has to happen before
    # the tree is pruned — installing with --omit=dev first and then
    # reaching for `npx tsc` left nothing to reach for.
    log "Building from source (TypeScript is a dev dependency)…"
    sudo -u "${RUN_USER}" -H bash -c "cd ${APP_DIR} && npm ci --ignore-scripts && npx tsc && npm prune --omit=dev"
  fi
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Seeding ${ENV_FILE} from twoody-server.env.example…"
  install -m 0600 -o root -g root "${APP_DIR}/scripts/twoody-server.env.example" "${ENV_FILE}"
  log "  Edit ${ENV_FILE} to configure HA / folders / backend token, then restart the service."
fi

# The command, for this machine's console: twoody-server login, models add…
ln -sf "${APP_DIR}/bin/twoody-server.mjs" /usr/local/bin/twoody-server

# The built-in engine: llama.cpp for this machine, fetched from its pinned
# host and checked against its SHA-256, into the data directory. Not
# fatal: the server runs without it, and `twoody-server runtime install`
# can be run again later.
DATA_DIR="$(sed -n 's/^TWOODY_DATA_DIR=//p' "${ENV_FILE}" | tail -1)"
DATA_DIR="${DATA_DIR:-/home/${RUN_USER}/.twoody/data}"
log "Installing the built-in model engine (llama.cpp) into ${DATA_DIR}/runtime…"
if ! sudo -u "${RUN_USER}" -H env TWOODY_DATA_DIR="${DATA_DIR}" node "${APP_DIR}/bin/twoody-server.mjs" runtime install; then
  log "  Could not install it now; run: twoody-server runtime install"
fi

log "Installing systemd unit…"
install -m 0644 -o root -g root "${APP_DIR}/scripts/twoody-server.service" "${SERVICE_FILE}"
# Patch the unit's User= with TWOODY_USER if it differs from the
# upstream default (`pi`) so non-Pi hosts boot cleanly.
if [[ "${RUN_USER}" != "pi" ]]; then
  sed -i "s/^User=pi$/User=${RUN_USER}/" "${SERVICE_FILE}"
  sed -i "s/^Group=pi$/Group=${RUN_USER}/" "${SERVICE_FILE}"
  # ProtectHome=read-only makes the whole of /home read-only; the two
  # directories the server writes to have to be named, and they move
  # with the user. Forgetting this starts a service that cannot open
  # its own database.
  sed -i "s#^ReadWritePaths=.*#ReadWritePaths=/home/${RUN_USER}/.twoody /home/${RUN_USER}/.twoody-server#" "${SERVICE_FILE}"
fi

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

sleep 2
systemctl --no-pager --lines=15 status "${SERVICE_NAME}.service" || true

log "Done. View live logs with:"
log "  journalctl -u ${SERVICE_NAME}.service -f"
log "A model for the built-in engine (once, a few GB from Hugging Face):"
log "  twoody-server models list"
log "  twoody-server models add Qwen3.5-4B-Q4_K_M"
