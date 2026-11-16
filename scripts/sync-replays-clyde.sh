#!/usr/bin/env bash
# Sync local Slippi replays to the clyde server.
#
# Replays are immutable once Dolphin writes them, so --ignore-existing keeps
# the server copy additive: a file is transferred once and never overwritten,
# which also makes re-runs and interrupted transfers cheap. Run it from cron on
# the machine where Dolphin saves replays (this is a plain rsync; it does not
# need Node or the repo's dependencies).
#
# Overrides:
#   REPLAY_DIR=~/Slippi     local replay folder
#   CLYDE_HOST=clyde        ssh target (uses your normal ssh config, including
#                           Tailscale fallback)
#   CLYDE_REPLAYS=Slippi    destination folder relative to the remote home
#
# The exit status is non-zero when the source folder is missing or rsync
# fails, so cron logs (and MAILTO, if set) show real problems. A lock in
# TMPDIR prevents overlapping runs if a transfer is slow.
set -euo pipefail

REPLAY_DIR="${REPLAY_DIR:-$HOME/Slippi}"
CLYDE_HOST="${CLYDE_HOST:-clyde}"
CLYDE_REPLAYS="${CLYDE_REPLAYS:-Slippi}"

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

# cron starts with a minimal PATH; name the tools this script relies on.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [[ ! -d "$REPLAY_DIR" ]]; then
  log "replay folder not found: $REPLAY_DIR" >&2
  exit 1
fi

lock_file="${TMPDIR:-/tmp}/clippi-replay-sync.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
  log "another replay sync is already running ($lock_file; skipping)"
  exit 0
fi

# Make sure the destination exists before rsync creates the tree for us.
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$CLYDE_HOST" "mkdir -p \"\$HOME/$CLYDE_REPLAYS\""; then
  log "could not reach $CLYDE_HOST; will retry on the next run" >&2
  exit 1
fi

# -a preserves mtimes, which the hit-review parser cache keys on;
# --ignore-existing never rewrites a replay already on the server.
rsync -a --ignore-existing "$REPLAY_DIR/" "$CLYDE_HOST:$CLYDE_REPLAYS/"

log "replay sync complete ($REPLAY_DIR -> $CLYDE_HOST:~/$CLYDE_REPLAYS)"
