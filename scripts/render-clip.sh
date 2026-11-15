#!/usr/bin/env bash
# Render one frame range of a Slippi replay to MP4.
#
# Usage:
#   scripts/render-clip.sh --replay game.slp --start 1000 --end 1600 --out clip.mp4
#
# By default this runs under a private Xvfb display, so it works from cron or
# SSH with no visible window and no logged-in desktop session. Pass --no-xvfb
# to use the current DISPLAY instead.
set -euo pipefail

SCRIPT_PATH=$(realpath "${BASH_SOURCE[0]}")
ROOT_DIR=$(dirname "$(dirname "$SCRIPT_PATH")")

REPLAY=""
START=1000
END=1600
OUT=""
RESOLUTION="${CLIPPI_RESOLUTION:-720p}"
BITRATE="${CLIPPI_BITRATE:-12000}"
BACKEND="${CLIPPI_BACKEND:-OGL}"
USE_XVFB=1
KEEP_TMP="${KEEP_TMP:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/render-clip.sh [options]

  --replay PATH       Replay to render (default: newest .slp in ~/Slippi)
  --start FRAME       First Slippi frame to render (default: 1000)
  --end FRAME         Last Slippi frame to render (default: 1600)
  --out PATH          Output MP4 (default: renders/clip-<start>-<end>-<timestamp>.mp4)
  --resolution RES    Dolphin internal scale: 480p, 720p, 1080p, 1440p, 2160p,
                      or a raw integer EFBScale (default: 720p)
  --bitrate KBPS      Dolphin dump bitrate (default: 12000)
  --backend NAME      Dolphin video backend (default: OGL)
  --no-xvfb           Use the current DISPLAY instead of starting Xvfb
  -h, --help          Show this help

Environment:
  SLIPPI_PLAYBACK    Path to Slippi Playback AppImage
  MELEE_ISO          Path to the Melee ISO
  KEEP_TMP=1         Keep the temporary Dolphin dump directory for debugging
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --replay) REPLAY="${2:?--replay needs a path}"; shift 2 ;;
    --start) START="${2:?--start needs a frame}"; shift 2 ;;
    --end) END="${2:?--end needs a frame}"; shift 2 ;;
    --out) OUT="${2:?--out needs a path}"; shift 2 ;;
    --resolution) RESOLUTION="${2:?--resolution needs a value}"; shift 2 ;;
    --bitrate) BITRATE="${2:?--bitrate needs a value}"; shift 2 ;;
    --backend) BACKEND="${2:?--backend needs a value}"; shift 2 ;;
    --no-xvfb) USE_XVFB=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REPLAY" ]]; then
  REPLAY=$(find "$HOME/Slippi" -name '*.slp' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
fi

# Dolphin's EFBScale is an integer enum, not a resolution label. These are
# the mappings used by slp2mp4 for the Slippi/Ishiiruka playback build.
case "$RESOLUTION" in
  480p) EFB_SCALE=2 ;;
  720p) EFB_SCALE=3 ;;
  1080p) EFB_SCALE=5 ;;
  1440p) EFB_SCALE=6 ;;
  2160p) EFB_SCALE=8 ;;
  *) if [[ "$RESOLUTION" =~ ^[0-9]+$ ]]; then
       EFB_SCALE="$RESOLUTION"
     else
       echo "Unknown resolution '$RESOLUTION'; use 480p/720p/1080p/1440p/2160p or an integer EFBScale" >&2
       exit 2
     fi ;;
esac

[[ -f "$REPLAY" ]] || { echo "Replay not found: $REPLAY" >&2; exit 1; }
REPLAY=$(realpath "$REPLAY")
[[ "$START" =~ ^-?[0-9]+$ && "$END" =~ ^-?[0-9]+$ ]] || {
  echo "--start and --end must be integers" >&2; exit 2
}
(( END > START )) || { echo "--end must be greater than --start" >&2; exit 2; }

PLAYBACK="${SLIPPI_PLAYBACK:-$HOME/.config/Slippi Launcher/playback/Slippi_Playback-x86_64.AppImage}"
ISO="${MELEE_ISO:-$HOME/Desktop/smash.iso}"
[[ -x "$PLAYBACK" ]] || { echo "Slippi Playback not found/executable: $PLAYBACK" >&2; exit 1; }
[[ -f "$ISO" ]] || { echo "Melee ISO not found: $ISO" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

OUT="${OUT:-$ROOT_DIR/renders/clip-${START}-${END}-$(date +%Y%m%d-%H%M%S).mp4}"
mkdir -p "$(dirname "$OUT")"
OUT=$(realpath -m "$OUT")

# Re-exec ourselves inside a private virtual X server. This is what makes the
# renderer usable from cron: Dolphin needs a display connection, but it does
# not need to be a visible one.
if (( USE_XVFB )) && [[ "${CLIPPI_IN_XVFB:-0}" != "1" ]]; then
  command -v xvfb-run >/dev/null || {
    echo "xvfb-run not found; install Xvfb or pass --no-xvfb" >&2; exit 1
  }
  echo "Starting private Xvfb display..."
  exec xvfb-run -a -s "-screen 0 1280x720x24" \
    env CLIPPI_IN_XVFB=1 KEEP_TMP="$KEEP_TMP" \
    "$SCRIPT_PATH" \
    --replay "$REPLAY" --start "$START" --end "$END" --out "$OUT" \
    --resolution "$RESOLUTION" --bitrate "$BITRATE" --backend "$BACKEND"
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/clippi-render.XXXXXX")
cleanup() {
  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "Kept work directory: $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

USER_DIR="$WORK_DIR/user"
DUMP_DIR="$WORK_DIR/dump"
mkdir -p "$USER_DIR/Config" "$USER_DIR/GameSettings" "$DUMP_DIR"

# Enable Dolphin's frame and audio dumps. Dolphin ignores unknown keys, so we
# provide both spellings used by different Dolphin branches.
cat > "$USER_DIR/Config/Dolphin.ini" <<'EOF'
[Core]
AdapterRumble0 = False
AdapterRumble1 = False
AdapterRumble2 = False
AdapterRumble3 = False
[Movie]
DumpFrames = True
DumpFramesSilent = True
DumpFramesSlient = True
[DSP]
DumpAudio = True
DumpAudioSilent = True
Backend = ALSA
[Display]
RenderToMain = True
RenderWindowAutoSize = True
EOF

cat > "$USER_DIR/Config/GFX.ini" <<EOF
[Settings]
AspectRatio = 0
InternalResolutionFrameDumps = True
EFBScale = $EFB_SCALE
BitrateKbps = $BITRATE
EOF

cat > "$USER_DIR/GameSettings/GAL.ini" <<EOF
[Video_Settings]
EFBScale = $EFB_SCALE
EOF

REPLAY="$REPLAY" START="$START" END="$END" COMM_PATH="$WORK_DIR/comm.json" node -e '
const fs = require("fs");
const comm = {
  mode: "normal",
  replay: process.env.REPLAY,
  startFrame: Number(process.env.START),
  endFrame: Number(process.env.END),
  isRealTimeMode: false,
  commandId: "clippi-" + Date.now(),
  rollbackDisplayMethod: "off",
  shouldResync: false,
};
fs.writeFileSync(process.env.COMM_PATH, JSON.stringify(comm) + "\n");
'

LOG="$WORK_DIR/dolphin.log"
FRAME_DUMP="$DUMP_DIR/framedump0.avi"
AUDIO_DUMP="$DUMP_DIR/dspdump.wav"

echo "Rendering frames $START-$END of $(basename "$REPLAY") at $RESOLUTION (EFBScale=$EFB_SCALE)..."
START_TS=$(date +%s)

"$PLAYBACK" \
  --exec "$ISO" \
  --batch \
  --video_backend "$BACKEND" \
  --slippi-input "$WORK_DIR/comm.json" \
  --hide-seekbar \
  --output-directory "$DUMP_DIR" \
  --user "$USER_DIR" \
  --cout >"$LOG" 2>&1 &
DOLPHIN_PID=$!

TARGET_LINE="[CURRENT_FRAME] $END"
MAX_WAIT=$(( ${CLIPPI_MAX_WAIT:-240} + (END - START) / 60 * 45 ))
REACHED=0
while kill -0 "$DOLPHIN_PID" 2>/dev/null; do
  if grep -qF "$TARGET_LINE" "$LOG" 2>/dev/null; then
    REACHED=1
    break
  fi
  if (( $(date +%s) - START_TS > MAX_WAIT )); then
    echo "Timed out after ${MAX_WAIT}s waiting for frame $END" >&2
    break
  fi
  sleep 0.25
done

if (( REACHED )); then
  echo "Reached frame $END; letting Dolphin flush dumps..."
else
  echo "Warning: target frame $END was not observed; using whatever was dumped" >&2
fi
sleep 2
kill -TERM "$DOLPHIN_PID" 2>/dev/null || true
wait "$DOLPHIN_PID" 2>/dev/null || true

if [[ ! -s "$FRAME_DUMP" ]]; then
  echo "No frame dump was produced. Dolphin log:" >&2
  tail -60 "$LOG" >&2
  exit 1
fi

echo "Frame dump: $(du -h "$FRAME_DUMP" | cut -f1)"
if [[ -s "$AUDIO_DUMP" ]]; then
  echo "Audio dump: $(du -h "$AUDIO_DUMP" | cut -f1)"
  FFMPEG_ARGS=(-i "$FRAME_DUMP" -i "$AUDIO_DUMP" -map 0:v:0 -map 1:a:0 -c:a aac -b:a 160k -shortest)
else
  echo "No audio dump; rendering silent video" >&2
  FFMPEG_ARGS=(-i "$FRAME_DUMP" -map 0:v:0)
fi

echo "Encoding MP4..."
# Dolphin's frame dump can have odd dimensions (963x792 at 720p); x264
# requires even width/height.
ffmpeg -hide_banner -loglevel warning -y "${FFMPEG_ARGS[@]}" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart \
  "$OUT"

ELAPSED=$(( $(date +%s) - START_TS ))
echo "Done in ${ELAPSED}s: $OUT ($(du -h "$OUT" | cut -f1))"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 "$OUT"
