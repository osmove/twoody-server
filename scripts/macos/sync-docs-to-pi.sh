#!/usr/bin/env bash
# Manual / Terminal-driven push of selected ~/Documents subfolders to
# a household Twoody Pi.
#
# Companion to scripts/macos/com.twoody.doc-sync.plist.example — that
# launchd job runs the same rsync every 30 minutes once the user has
# granted Full Disk Access to /usr/bin/rsync. Run this script from a
# terminal that already has FDA (Terminal.app / iTerm) when you want
# an immediate refresh.
#
# Pre-requisites:
#   - `twoody-pi` aliased in ~/.ssh/config with passwordless key auth
#     to pi@<your-pi> and pi user able to write /home/pi/mac-share/
#   - /home/pi/mac-share/ exists on the Pi (mkdir before first run)
#
# Edit FOLDERS for your install.

set -euo pipefail

FOLDERS=(
  "_Permanent"
  "Osmove"
  "Ordatel"
  "Hyundai"
  "Kobi"
  "PhoneVoice"
)

SRC_BASE="$HOME/Documents"
DEST="twoody-pi:/home/pi/mac-share/"

LOG_DIR="$HOME/Library/Twoody/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/sync-docs.log"

if [[ -f "$LOG" && $(stat -f%z "$LOG" 2>/dev/null || echo 0) -gt 5242880 ]]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

{
  echo "=== $(date +'%Y-%m-%dT%H:%M:%S%z') sync starting ==="
  # --max-size skips large binaries; the executor's read cap is 10 MB.
  /usr/bin/rsync -az --delete --max-size=25M \
    --exclude '.DS_Store' --exclude '.localized' \
    --exclude 'node_modules' --exclude '*.tmp' \
    "${FOLDERS[@]/#/$SRC_BASE/}" \
    "$DEST" 2>&1
  echo "=== $(date +'%Y-%m-%dT%H:%M:%S%z') sync done (exit $?) ==="
} >> "$LOG" 2>&1
