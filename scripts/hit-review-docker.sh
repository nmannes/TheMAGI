#!/usr/bin/env bash
# Run the hit-review job in the Docker image on this host.
#
# The image carries Node, ffmpeg, Xvfb and Mesa/OpenGL, so the host needs no
# render dependencies at all — only Docker. Replays and game assets are
# mounted read-only; the chronological cursor, parsed-event cache and rendered
# clips stay in data/ (gitignored) on the host. Arguments are passed through
# to the daily wrapper, e.g. `--dry-run`.
#
# Usage:
#   scripts/hit-review-docker.sh              # one scheduled run
#   scripts/hit-review-docker.sh --dry-run    # print the selection only
#   scripts/hit-review-docker.sh --build      # rebuild after source changes
#
# Overrides:
#   HOST_REPLAYS_DIR=~/Slippi          replay folder (mounted at /replays)
#   HOST_ASSETS_DIR=~/clippi-assets    Melee ISO + Slippi Playback (/assets)
#   HOST_DATA_DIR=<repo>/data          cursor + clips (/data)
#   DOCKER=docker                      docker binary
#
# Intended for cron on the machine that owns the replays, so the render
# environment is exactly the image and does not depend on host packages.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)
cd "$ROOT_DIR"

DOCKER="${DOCKER:-docker}"

# Compose resolves these against the compose.yaml defaults; pin them so a cron
# run never depends on the caller's working directory or shell.
export HOST_REPLAYS_DIR="${HOST_REPLAYS_DIR:-$HOME/Slippi}"
export HOST_ASSETS_DIR="${HOST_ASSETS_DIR:-$HOME/clippi-assets}"
export HOST_DATA_DIR="${HOST_DATA_DIR:-$ROOT_DIR/data}"
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

if [[ "${1:-}" == "--build" ]]; then
  exec "$DOCKER" compose build
fi

# One run at a time. The wrapper's own file lock lives inside the container's
# filesystem and disappears with it, so the host lock is what keeps a stuck
# render from letting the next cron tick start a second job that could select
# and send the same clips.
LOCK_FILE="${HIT_REVIEW_DOCKER_LOCK:-${TMPDIR:-/tmp}/clippi-hit-review-docker.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another hit-review container is already running; skipping this run."
  exit 0
fi

exec "$DOCKER" compose run --rm hit-review "$@"
