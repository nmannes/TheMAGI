# Running clip jobs in Docker

The headless hit-review pipeline and the openings clip renderer can run
entirely in a container: Node, ffmpeg, Xvfb and Mesa are in the image, while
the Melee ISO, Slippi Playback build, replays, database, output and credentials
are mounted or passed at run time. Nothing large or secret is copied into the
image or committed to git.

This container is for the command-line clip jobs. It is not a container for the
Electron desktop app.

## What is in the image and what is mounted

| Path in container | Source | Purpose |
| --- | --- | --- |
| `/app` | image | Source, `node_modules`, scripts |
| `/replays` | host mount | Slippi `.slp` files (read-only; also mounted at its host path for opening-ledger clips) |
| `/assets` | host mount | Melee ISO and Slippi Playback (read-only) |
| `/data` | host mount | Rendered clips, chronological cursor/cache, logs |
| `/home/node/.magi-melee` | host mount | `magi.db`, `config.json` and clip output for `openings` |
| `MAGI_TARGET`, Telegram variables | `docker.env` or `-e` | Player and delivery settings |

`node_modules` is installed by `npm ci` while the image is built. The ISO,
AppImage, replays, database, rendered clips and `docker.env` are covered by
`.gitignore` and `.dockerignore`; they never enter version control.

## Build

```bash
docker build -t magi-hit-review:local .
```

The image is based on Node 22 and does not require a GPU. Dolphin uses Mesa's
software OpenGL renderer (`LIBGL_ALWAYS_SOFTWARE=1` is set in the image). The
image also configures a null ALSA default device, so Dolphin can initialize its
audio backend and write `dspdump.wav`; ffmpeg muxes that into the MP4 as AAC.
The rendered clip keeps the game audio.

Dolphin needs more than Docker's default 64 MB of shared memory. Compose sets
`shm_size: "1gb"`; `docker run` must pass `--shm-size=1g`.

## Prepare assets

Keep assets outside the repository, for example in `~/hit-review-assets`:

```text
hit-review-assets/
  smash.iso
  slippi-playback/
    squashfs-root/
      AppRun
```

Extract the Slippi Playback AppImage once on the host, so the container does
not need `/dev/fuse` and does not re-extract it for every clip:

```bash
cd ~/hit-review-assets
chmod +x Slippi_Playback-x86_64.AppImage
mkdir -p slippi-playback
cd slippi-playback
../Slippi_Playback-x86_64.AppImage --appimage-extract
```

The entrypoint also accepts `Slippi_Playback-x86_64.AppImage` directly in the
asset folder; it then sets `APPIMAGE_EXTRACT_AND_RUN=1`, which is slower because
the AppImage is unpacked on each Dolphin launch.

## Configure

Copy the example environment file and fill in the target and Telegram
credentials:

```bash
cp docker.env.example docker.env
$EDITOR docker.env
```

`docker.env` is gitignored. It contains only:

- `MAGI_TARGET` (for example `POOK#392`)
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` if delivering
- optional `HIT_REVIEW_*` settings

Do not copy a host `key.env` into the container unless you remove
`HIT_REVIEW_PATH`; host paths such as `/home/linuxbrew/...` do not exist inside
the image. The entrypoint ignores a missing `HIT_REVIEW_PATH` with a warning.

## Run with Compose

The compose file mounts `~/Slippi`, `~/clippi-assets`, the repo's `./data` and
`~/.magi-melee` by default. Point them at your real folders with environment
variables (the mount sources must be absolute):

```bash
HOST_REPLAYS_DIR="$HOME/Slippi" \
HOST_ASSETS_DIR="$HOME/hit-review-assets" \
HOST_DATA_DIR="$HOME/hit-review-data" \
docker compose run --rm hit-review
```

A dry run prints the clips it would render without starting Dolphin:

```bash
HOST_REPLAYS_DIR="$HOME/Slippi" \
HOST_ASSETS_DIR="$HOME/hit-review-assets" \
HOST_DATA_DIR="$HOME/hit-review-data" \
docker compose run --rm hit-review --dry-run
```

Render without sending while you test:

```bash
HOST_REPLAYS_DIR="$HOME/Slippi" \
HOST_ASSETS_DIR="$HOME/hit-review-assets" \
HOST_DATA_DIR="$HOME/hit-review-data" \
docker compose run --rm -e HIT_REVIEW_TELEGRAM=0 hit-review
```

The container user defaults to UID/GID 1000. If your user differs, set
`HOST_UID` and `HOST_GID`; the host data directory must be writable by that
user:

```bash
HOST_UID="$(id -u)" HOST_GID="$(id -g)" docker compose run --rm hit-review
```

### Openings clips

The same image, service and wrapper render clips from the opening ledger (the
`npm run openings -- --render/--send` path). Put `openings` first; the remaining
arguments go to `src/openings-cli.ts`:

```bash
scripts/hit-review-docker.sh openings --cluster 4 --clips 3 --send
scripts/hit-review-docker.sh openings --bucket 1 --render
scripts/hit-review-docker.sh openings --json --no-clusters
```

The host `~/.magi-melee` directory is mounted at the container user's home, so
the CLI reads `magi.db` and `config.json` and writes clips to
`~/.magi-melee/hit-review` exactly like the host command. `HOST_MAGI_DIR`
overrides the source directory. Games must already be imported or backfilled at
the current `FRAME_EVENTS_VERSION` (the `opening_events` ledger); the CLI prints
a coverage warning when they are not.

Opening rows store each replay's absolute path from import time, so the replay
folder is mounted at its host path as well as at `/replays`. `HOST_REPLAYS_DIR`
must be the absolute folder that was imported (the default is `~/Slippi`). If
files have moved since import, rendering those rows fails rather than using a
different replay with the same name.

`--send` reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from `docker.env`,
like the chronological job. Pass `--out` to choose another output directory
inside the container; mount it if the clips must remain on the host.

The equivalent direct Compose invocation is:

```bash
HOST_REPLAYS_DIR="$HOME/Slippi" HOST_ASSETS_DIR="$HOME/clippi-assets" \
docker compose run --rm hit-review openings --cluster 4 --clips 1 --render
```

## Run with docker run

```bash
docker run --rm --init \
  --shm-size=1g \
  --user "$(id -u):$(id -g)" \
  --env-file docker.env \
  -e HIT_REVIEW_TELEGRAM=0 \
  -v "$HOME/Slippi:/replays:ro" \
  -v "$HOME/hit-review-assets:/assets:ro" \
  -v "$HOME/hit-review-data:/data" \
  magi-hit-review:local --dry-run
```

Remove `--dry-run` and the `HIT_REVIEW_TELEGRAM=0` override to render and send.
Arguments after the image name are passed through to the daily wrapper, so
`--force`, `--all`, `--deaths-only` and `--limit` work as they do on the host.

For openings clips, pass `openings` before the CLI arguments and mount the
replay folder at its host path plus the MAGI data directory:

```bash
docker run --rm --init \
  --shm-size=1g \
  --user "$(id -u):$(id -g)" \
  --env-file docker.env \
  -v "$HOME/Slippi:/replays:ro" \
  -v "$HOME/Slippi:$HOME/Slippi:ro" \
  -v "$HOME/hit-review-assets:/assets:ro" \
  -v "$HOME/.magi-melee:/home/node/.magi-melee" \
  magi-hit-review:local openings --cluster 4 --clips 1 --render
```

To invoke the CLI directly (for example to print one replay as JSON), override
the entrypoint:

```bash
docker run --rm --init \
  --shm-size=1g \
  --user "$(id -u):$(id -g)" \
  -v "$HOME/Slippi:/replays:ro" \
  --entrypoint bash \
  magi-hit-review:local -lc \
  'npx --no-install tsx src/hit-review-cli.ts --replay /replays/game.slp --target "POOK#392" --limit 1 --json'
```

## Schedule it

The container exits after each run, so use the host's cron or a systemd timer.
`scripts/hit-review-docker.sh` wraps `docker compose run` with the host paths
pinned, so the cron entry stays short:

```cron
17 * * * * bash /opt/clippi/scripts/hit-review-docker.sh >> /var/log/hit-review.log 2>&1
```

It defaults to `~/Slippi`, `~/clippi-assets`, the repo's `data/` folder and
`~/.magi-melee`; override with `HOST_REPLAYS_DIR`, `HOST_ASSETS_DIR`,
`HOST_DATA_DIR` and `HOST_MAGI_DIR`, and rebuild the image after source changes
with `scripts/hit-review-docker.sh --build`. The explicit form, if you prefer it
in cron:

```cron
17 20 * * * cd /opt/clippi && HOST_REPLAYS_DIR=/srv/slippi HOST_ASSETS_DIR=/opt/hit-review-assets HOST_DATA_DIR=/srv/hit-review docker compose run --rm hit-review >> /var/log/hit-review.log 2>&1
```

`docker compose run --rm` cleans up the one-shot container. The cursor file at
`/data/hit-review-cursor.json` records the most recent clip and caches parsed
events, so each run continues with the next two events instead of repeating
clips or re-parsing unchanged replays. The output cap prunes only clips this
tool created.

## Troubleshooting

**`Slippi Playback not found under /assets`** — mount the folder containing
`smash.iso` and either `slippi-playback/squashfs-root/AppRun` or the AppImage at
`/assets`. The ISO may also be named `melee.iso`.

**`openings` reports the database is missing** — mount the host MAGI data
directory (`HOST_MAGI_DIR`, default `~/.magi-melee`) at
`/home/node/.magi-melee`. The compose service does this automatically.

**An openings clip cannot find its replay** — the opening ledger stores the
replay's absolute path from import time. Set `HOST_REPLAYS_DIR` to that same
absolute folder; the compose service mounts it both at `/replays` and at its
host path. Rows whose files moved since import must be re-imported instead.

**Dolphin prints OpenGL or display errors** — the image includes Xvfb and Mesa.
If you changed the image, confirm `libgl1-mesa-dri` and `xvfb` are still
installed. A GPU is not required.

**Dolphin aborts with a core dump** — Docker's default 64 MB `/dev/shm` is too
small. Run with `--shm-size=1g` (Compose already sets `shm_size: "1gb"`).

**Permission denied writing clips** — the container UID/GID must be able to
write the host data directory. Set `HOST_UID`/`HOST_GID` or `chown` the data
directory.

**AppImage fails with a FUSE error** — use the extracted
`slippi-playback/squashfs-root/AppRun` layout; do not rely on `/dev/fuse` being
available inside the container.

**Telegram errors** — check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in
`docker.env`, and see the Telegram setup section in
[hit-review.md](hit-review.md#telegram-setup).

**Rendering is slow** — 720p is much cheaper than 1080p, and each clip launches
Dolphin. Keep `HIT_REVIEW_LIMIT` modest on a CPU-only server.

## Related documentation

- [Headless hit review](hit-review.md)
- [Development notes](DEVELOPMENT.md)
- [Project README](../README.md)
