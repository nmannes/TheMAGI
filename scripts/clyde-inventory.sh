#!/usr/bin/env bash
# Read-only inventory of the clyde home server before deploying hit review.
# Usage: ./scripts/clyde-inventory.sh [ssh-host]   (default: clyde)
#
# It prints the OS, required commands and Debian packages, whether the repo,
# replays, Melee ISO and Slippi Playback already exist, free disk space, and
# whether sudo is non-interactive. It changes nothing on the server.
set -euo pipefail

HOST="${1:-${CLYDE_HOST:-clyde}}"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'bash -s' <<'REMOTE'
set -u

echo "== system =="
hostname
if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "${PRETTY_NAME:-unknown}"
fi
uname -m
printf 'kernel: '; uname -r

echo
echo "== commands =="
for cmd in node npm npx git rsync ffmpeg xvfb-run; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '%-9s %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '%-9s MISSING\n' "$cmd"
  fi
done
printf '%-9s ' node; node --version 2>/dev/null || echo unknown

echo
echo "== Debian packages =="
for pkg in ffmpeg xvfb libgl1-mesa-dri libglx-mesa0 libfuse2; do
  if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
    printf '%-16s installed\n' "$pkg"
  else
    printf '%-16s MISSING\n' "$pkg"
  fi
done

echo
echo "== repo and replay locations =="
for dir in "$HOME/clippi" "$HOME/TheMAGI" /opt/clippi "$HOME/Slippi" "$HOME/replays"; do
  if [ -d "$dir" ]; then
    printf '%-24s dir exists\n' "$dir"
  else
    printf '%-24s missing\n' "$dir"
  fi
done
if [ -d "$HOME/Slippi" ]; then
  printf 'Slippi replays: %s\n' "$(find "$HOME/Slippi" -type f -name '*.slp' 2>/dev/null | wc -l)"
fi

echo
echo "== Melee assets =="
found_asset=0
while IFS= read -r f; do
  found_asset=1
  ls -lh "$f"
done < <(find "$HOME" -maxdepth 4 -type f \
  \( -iname '*.iso' -o -iname '*.gcm' -o -iname '*Slippi*Playback*' -o -iname 'AppRun' \) \
  2>/dev/null | head -30)
[ "$found_asset" -eq 1 ] || echo "no ISO or Slippi Playback found under $HOME (depth 4)"

echo
echo "== disk =="
df -h "$HOME" | tail -n 1

echo
echo "== privilege =="
if sudo -n true 2>/dev/null; then
  echo 'passwordless sudo: yes'
else
  echo 'passwordless sudo: no'
fi
REMOTE
