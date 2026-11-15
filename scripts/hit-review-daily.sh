#!/usr/bin/env bash
# Daily hit-review job: walk forward through replay history and render the next
# two review events, then send them to Telegram.
#
# An event is either the first hit of an opponent conversion (5 seconds before
# the hit) or a landed conversion of at least two hits (5 seconds after the
# player's last hit). A local cursor file records the most recent generated
# clip, so each run continues chronologically without repeating clips.
#
# Intended for cron or a systemd timer. It loads key.env from the repo root,
# takes an flock so runs cannot overlap, and leaves rendered clips under
# ~/.magi-melee/hit-review/ by default.
#
# Required environment (or key.env):
#   MAGI_TARGET=POOK#392
#   TELEGRAM_BOT_TOKEN=...
#   TELEGRAM_CHAT_ID=...
#   SLIPPI_PLAYBACK=/path/to/Slippi_Playback-x86_64.AppImage
#   MELEE_ISO=/path/to/melee.iso
#
# Useful overrides:
#   REPLAY_DIR=~/Slippi          replay folder to scan
#   HIT_REVIEW_LIMIT=2           clips per run
#   HIT_REVIEW_CURSOR=...        local cursor file (default <repo>/data/hit-review-cursor.json)
#   HIT_REVIEW_RESOLUTION=720p   clip resolution
#   HIT_REVIEW_MAX_OUT_SIZE=1GB  cap on clips kept in the output folder (0 disables)
#   HIT_REVIEW_TELEGRAM=0        render only, do not contact Telegram
#   HIT_REVIEW_DRY_RUN=1         print planned clips, render/send nothing
#   HIT_REVIEW_PATH=...          extra PATH entries for npx/ffmpeg/xvfb-run
#   NPX_BIN=...                  explicit npx path
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)
cd "$ROOT_DIR"

umask 077

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

KEY_ENV="${HIT_REVIEW_KEY_ENV:-$ROOT_DIR/key.env}"
if [[ "${HIT_REVIEW_SKIP_KEY_ENV:-0}" != "1" && -f "$KEY_ENV" ]]; then
  # key.env is shell-format KEY=value. Export everything it defines so child
  # processes (the CLI, Dolphin, ffmpeg) see it.
  set -a
  # shellcheck disable=SC1091
  source "$KEY_ENV"
  set +a
fi

# Build PATH after sourcing key.env: HIT_REVIEW_PATH is usually defined there
# (cron's PATH does not include a user-installed Node), so resolving npx first
# would pick a system Node the project does not support.
export PATH="${HIT_REVIEW_PATH:+$HIT_REVIEW_PATH:}$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOCK_FILE="${HIT_REVIEW_LOCK:-$HOME/.magi-melee/hit-review.lock}"
mkdir -p "$(dirname "$LOCK_FILE")"

LOCK_DIR=""
cleanup() {
  if [[ -n "$LOCK_DIR" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap 'status=$?; cleanup; log "hit review finished (status $status)"' EXIT

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another hit review is already running ($LOCK_FILE); exiting"
    exit 0
  fi
else
  LOCK_DIR="${LOCK_FILE}.d"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "another hit review is already running ($LOCK_DIR); exiting"
    exit 0
  fi
fi

NPX_BIN="${NPX_BIN:-$(command -v npx || true)}"
if [[ -z "$NPX_BIN" ]]; then
  log "npx not found. Set HIT_REVIEW_PATH to the Node bin directory or NPX_BIN to the npx path."
  exit 1
fi

REPLAY_DIR="${REPLAY_DIR:-${HIT_REVIEW_DIR:-$HOME/Slippi}}"
HIT_REVIEW_LIMIT="${HIT_REVIEW_LIMIT:-2}"
HIT_REVIEW_CURSOR="${HIT_REVIEW_CURSOR:-$ROOT_DIR/data/hit-review-cursor.json}"
HIT_REVIEW_RESOLUTION="${HIT_REVIEW_RESOLUTION:-720p}"
HIT_REVIEW_MAX_OUT_SIZE="${HIT_REVIEW_MAX_OUT_SIZE:-1GB}"
HIT_REVIEW_TELEGRAM="${HIT_REVIEW_TELEGRAM:-1}"
HIT_REVIEW_DRY_RUN="${HIT_REVIEW_DRY_RUN:-0}"

if [[ ! -d "$REPLAY_DIR" ]]; then
  log "replay folder not found: $REPLAY_DIR"
  exit 1
fi

ARGS=(
  --dir "$REPLAY_DIR"
  --limit "$HIT_REVIEW_LIMIT"
  --chronological
  --cursor "$HIT_REVIEW_CURSOR"
  --resolution "$HIT_REVIEW_RESOLUTION"
  --max-out-size "$HIT_REVIEW_MAX_OUT_SIZE"
  --render
)

if [[ -n "${MAGI_TARGET:-}" ]]; then
  ARGS+=(--target "$MAGI_TARGET")
fi
if [[ -n "${HIT_REVIEW_OUT:-}" ]]; then
  ARGS+=(--out-dir "$HIT_REVIEW_OUT")
fi
if [[ -n "${HIT_REVIEW_BACKEND:-}" ]]; then
  ARGS+=(--backend "$HIT_REVIEW_BACKEND")
fi
if [[ "${HIT_REVIEW_NO_XVFB:-0}" == "1" ]]; then
  ARGS+=(--no-xvfb)
fi
if [[ "$HIT_REVIEW_DRY_RUN" == "1" ]]; then
  ARGS+=(--dry-run)
fi

if [[ "$HIT_REVIEW_TELEGRAM" == "0" ]]; then
  log "Telegram disabled (HIT_REVIEW_TELEGRAM=0); rendering only"
else
  if [[ "$HIT_REVIEW_DRY_RUN" != "1" ]]; then
    : "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set (add it to key.env)}"
    : "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is not set (add it to key.env)}"
  fi
  ARGS+=(--telegram)
fi

log "starting hit review: replays=$REPLAY_DIR limit=$HIT_REVIEW_LIMIT cursor=$HIT_REVIEW_CURSOR resolution=$HIT_REVIEW_RESOLUTION"

# "$@" lets cron/manual runs add --force, --all, --deaths-only, etc.
"$NPX_BIN" --no-install tsx src/hit-review-cli.ts "${ARGS[@]}" "$@"
