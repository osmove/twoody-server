#!/usr/bin/env bash
# Pull twoody-server's SQLite state from the Pi to a rotating snapshot
# on this Mac. The Pi is the only host that holds the local-server
# database (auth tokens, paired devices, household members, discussions,
# memories, notes, tasks, reminders); without backups, a fried SD card
# means re-pairing every client.
#
# Schedule from ~/Library/LaunchAgents/com.twoody.pi-backup.plist
# (every 12 h, retains the last 14 daily snapshots).

set -euo pipefail

REMOTE_HOST="${TWOODY_PI_HOST:-twoody-pi}"
REMOTE_SRC="/home/pi/.twoody/data/"
BACKUP_ROOT="$HOME/Library/Twoody/backups"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
LATEST="$BACKUP_ROOT/latest"
SNAPSHOT="$BACKUP_ROOT/$TIMESTAMP"
LOG_DIR="$HOME/Library/Twoody/logs"
LOG="$LOG_DIR/pi-backup.log"

mkdir -p "$BACKUP_ROOT" "$LOG_DIR"

if [[ -f "$LOG" && $(stat -f%z "$LOG" 2>/dev/null || echo 0) -gt 5242880 ]]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

{
  echo "=== $(date +'%Y-%m-%dT%H:%M:%S%z') backup starting ($REMOTE_HOST) ==="

  mkdir -p "$SNAPSHOT"

  # Per the SQLite docs, a hot copy of the .db file without quiescing
  # can produce a corrupt snapshot. The Pi server uses better-sqlite3
  # with WAL — we pull the .db + .db-wal + .db-shm together and let
  # sqlite recover on first read.
  /usr/bin/rsync -az --delete \
    "$REMOTE_HOST:$REMOTE_SRC" \
    "$SNAPSHOT/"

  # Update the `latest` symlink so a recovery script can grab the
  # most recent backup without scanning timestamps.
  rm -f "$LATEST"
  ln -s "$SNAPSHOT" "$LATEST"

  # Rotate: keep the last 14 timestamped snapshots, drop older ones.
  cd "$BACKUP_ROOT"
  ls -1dt 20*T* 2>/dev/null | tail -n +15 | xargs -I {} rm -rf -- {} || true

  echo "=== $(date +'%Y-%m-%dT%H:%M:%S%z') backup done (snapshot=$TIMESTAMP) ==="
} >> "$LOG" 2>&1
