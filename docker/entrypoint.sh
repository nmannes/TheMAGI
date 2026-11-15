#!/usr/bin/env bash
# Container entrypoint for the headless hit-review job.
#
# Runtime assets are never baked into the image. It looks for the Melee ISO
# and Slippi Playback under /assets, then runs scripts/hit-review-daily.sh.
# Any arguments are passed through to the CLI (for example --dry-run).
set -euo pipefail

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

export REPLAY_DIR="${REPLAY_DIR:-/replays}"
export ASSETS_DIR="${ASSETS_DIR:-/assets}"
export HIT_REVIEW_OUT="${HIT_REVIEW_OUT:-/data/hit-review}"
export HIT_REVIEW_STATE="${HIT_REVIEW_STATE:-/data/hit-review-state.json}"

# Dolphin/Qt wants a private runtime directory. The image creates one for
# UID 1000; fall back to a per-UID directory when run with --user.
if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -w "$XDG_RUNTIME_DIR" ]]; then
  export XDG_RUNTIME_DIR="/tmp/xdg-runtime-$(id -u)"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
fi

# A key.env copied from a host can point PATH at a directory that does not
# exist in the container. Drop it rather than breaking npx/ffmpeg.
if [[ -n "${HIT_REVIEW_PATH:-}" && ! -d "$HIT_REVIEW_PATH" ]]; then
  echo "Ignoring HIT_REVIEW_PATH=$HIT_REVIEW_PATH (not present in the container)" >&2
  unset HIT_REVIEW_PATH
fi

if [[ -z "${HIT_REVIEW_KEY_ENV:-}" ]]; then
  if [[ -f /run/secrets/key.env ]]; then
    export HIT_REVIEW_KEY_ENV=/run/secrets/key.env
  elif [[ -f "$APP_DIR/key.env" ]]; then
    export HIT_REVIEW_KEY_ENV="$APP_DIR/key.env"
  fi
fi

find_asset() {
  local candidate
  for candidate in "$@"; do
    if [[ -e "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ -z "${SLIPPI_PLAYBACK:-}" ]]; then
  if SLIPPI_PLAYBACK=$(find_asset \
    "$ASSETS_DIR/slippi-playback/squashfs-root/AppRun" \
    "$ASSETS_DIR/slippi-playback/AppRun" \
    "$ASSETS_DIR/AppRun"); then
    export SLIPPI_PLAYBACK
  elif [[ -f "$ASSETS_DIR/Slippi_Playback-x86_64.AppImage" ]]; then
    # APPIMAGE_EXTRACT_AND_RUN works without /dev/fuse.
    export SLIPPI_PLAYBACK="$ASSETS_DIR/Slippi_Playback-x86_64.AppImage"
    export APPIMAGE_EXTRACT_AND_RUN=1
  else
    echo "Slippi Playback not found under $ASSETS_DIR." >&2
    echo "Mount an extracted AppRun at $ASSETS_DIR/slippi-playback/squashfs-root/AppRun," >&2
    echo "or put Slippi_Playback-x86_64.AppImage in $ASSETS_DIR." >&2
    exit 1
  fi
fi

if [[ ! -x "$SLIPPI_PLAYBACK" ]]; then
  echo "Slippi Playback is not executable: $SLIPPI_PLAYBACK" >&2
  exit 1
fi

if [[ -z "${MELEE_ISO:-}" ]]; then
  if MELEE_ISO=$(find_asset \
    "$ASSETS_DIR/smash.iso" \
    "$ASSETS_DIR/melee.iso" \
    "$ASSETS_DIR/Melee.iso"); then
    export MELEE_ISO
  else
    echo "Melee ISO not found under $ASSETS_DIR (expected smash.iso or melee.iso)." >&2
    exit 1
  fi
fi

if [[ ! -f "$MELEE_ISO" ]]; then
  echo "Melee ISO not found: $MELEE_ISO" >&2
  exit 1
fi

mkdir -p "$HIT_REVIEW_OUT" "$(dirname "$HIT_REVIEW_STATE")"

echo "hit-review container"
echo "  replays:  $REPLAY_DIR"
echo "  assets:   $ASSETS_DIR"
echo "  output:   $HIT_REVIEW_OUT"
echo "  state:    $HIT_REVIEW_STATE"
echo "  target:   ${MAGI_TARGET:-(from key.env or config)}"
echo "  telegram: ${HIT_REVIEW_TELEGRAM:-1}"

exec "$APP_DIR/scripts/hit-review-daily.sh" "$@"
