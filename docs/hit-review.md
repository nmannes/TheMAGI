# Headless hit review

`hit-review` is a Linux CLI for reviewing your Melee decisions. It walks forward
through your Slippi replay history one event at a time, renders a short MP4 for
each event, and can send the clips to Telegram. It is designed to run from cron
or a systemd timer on a home server, with no visible desktop session.

It uses MAGI's existing replay parser and measured event data. It does not call
an LLM and it does not make combo videos.

## What a clip is

For the configured player (the **target**), chronological review has exactly two
event types:

1. **Opening hit taken** — the first hit of a conversion landed by the opponent,
   with the target as the victim. Follow-up hits in that conversion are not
   separate events. The clip starts 5 seconds (300 frames) before that first hit
   and ends 2 seconds (120 frames) after it. The caption also reports what the
   full opponent conversion became, without putting those follow-up hits in the
   video.
2. **Conversion landed** — a conversion where the target is the attacker and at
   least two hits connected. The clip starts 5 seconds before the first hit and
   ends 5 seconds (300 frames) after the target's last hit. A one-hit conversion
   is not enough for this event.

Clips are capped at 20 seconds and at the replay's last frame. Both event types
are ordered by the wall-clock instant of their first hit. That instant is
`metadata.startAt` plus `(frame + 123) / 60` seconds: Slippi records `startAt`
when the replay's first frame is written, and replay frames begin at `-123`
(frame 0 is when the in-game timer starts counting down). A local cursor file
records the most recent generated clip, so each run continues with the next
events instead of repeating clips.

Slippi calls both event types **conversions**. A conversion can continue through
a tech chase, a ledge trap, or another interaction that is not hitstun; the CLI
therefore calls a landed event a "conversion," never a confirmed true combo. It
also does not label a sequence with a named technique unless the evidence would
establish every condition of that technique.

The clip caption lists the moves that connected, the percent before and after,
the opening type, and — only when MAGI measured it — the DI result. A
`FAILED_RECOVERY` or `SD` verdict is not displayed as DI: those verdicts come
from the measured-DI search, not from a measured stick input on the final hit.
For throw deaths there is often no measurable final-hit DI, so the caption says
`DI: not measured for this hit` rather than inventing a verdict.

An opening-hit event attributes a stock death to the opponent conversion when
MAGI can match the conversion's final move and stock record. The event still
shows only the opening hit; the caption reports the resulting stock.

## Requirements

- Linux (the renderer uses bash, Xvfb, and Slippi playback).
- Node.js `^20.19.0 || >=22.12.0` and the repo's dependencies (`npm ci`).
- `ffmpeg` and `xvfb-run`.
- The Slippi Playback AppImage (or an extracted `AppRun`) and a Melee ISO.
- Mesa software OpenGL is usually needed on a headless server; install the
  distribution's Mesa DRI package if Dolphin fails to create an OpenGL context.
- A Telegram bot if you want clips delivered.

This feature does not need the Electron app or the SQLite database. `npm ci` is
enough; do not run `npx electron-rebuild` just for this CLI.

### Debian/Ubuntu packages

```bash
sudo apt install ffmpeg xvfb libgl1-mesa-dri libglx-mesa0 libopengl0 libfuse2
```

`libopengl0` is the one people miss: without it the Slippi playback binary
fails at startup with `libOpenGL.so.0: cannot open shared object file`.

If the AppImage cannot mount on the server, extract it once and point
`SLIPPI_PLAYBACK` at the extracted `AppRun`:

```bash
./Slippi_Playback-x86_64.AppImage --appimage-extract
export SLIPPI_PLAYBACK="$PWD/squashfs-root/AppRun"
```

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather): send `/newbot`, then
   copy the token.
2. Send `/start` to your bot, or add it to a group and post a message there.
3. Export the token and run the discovery command:

   ```bash
   export TELEGRAM_BOT_TOKEN='123456:replace-me'
   npx tsx src/hit-review-cli.ts --telegram-check
   ```

   The command prints the bot identity and every chat it has recently seen:

   ```text
   Bot: @pook_clips_bot
   chat_id=123456789 type=private title=pook
   ```

   Telegram only returns updates from roughly the last 24 hours, and only after
   someone has messaged the bot. If the list is empty, send the bot a message and
   run the command again.
4. Put the token and chat id in `key.env` at the repo root (it is gitignored):

   ```bash
   TELEGRAM_BOT_TOKEN=123456:replace-me
   TELEGRAM_CHAT_ID=123456789
   ```

`--telegram-check` does not send a message. To test delivery, render one clip:

```bash
npx tsx src/hit-review-cli.ts \
  --replay /path/to/game.slp \
  --target 'POOK#392' \
  --limit 1 \
  --render --telegram
```

## Configuration

Put these in `key.env` (loaded by the daily script) or the service environment:

| Variable | Purpose |
| --- | --- |
| `MAGI_TARGET` | Player tag or connect code, e.g. `POOK#392`. Also accepts `CLIPPI_TARGET`. |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. |
| `TELEGRAM_CHAT_ID` | Numeric chat id, group id, or `@channelusername`. |
| `SLIPPI_PLAYBACK` | Path to the Slippi Playback AppImage or extracted `AppRun`. |
| `MELEE_ISO` | Path to the Melee ISO. |
| `REPLAY_DIR` | Replay folder to scan. Default `~/Slippi`. |
| `HIT_REVIEW_LIMIT` | Clips per run. Default `2`. |
| `HIT_REVIEW_CURSOR` | Local chronological cursor and parsed-event cache. Default `<repo>/data/hit-review-cursor.json`. |
| `HIT_REVIEW_RESOLUTION` | `480p`, `720p`, `1080p`, `1440p`, `2160p`, or a raw EFBScale. Default `720p`. |
| `HIT_REVIEW_MAX_OUT_SIZE` | Output cap. Default `1GB`; `0` disables pruning. |
| `HIT_REVIEW_OUT` | Output directory. Default `~/.magi-melee/hit-review`. |
| `HIT_REVIEW_TELEGRAM` | `0` renders without contacting Telegram. |
| `HIT_REVIEW_DRY_RUN` | `1` prints planned clips without rendering or sending. |
| `HIT_REVIEW_PATH` | Extra PATH entries for cron, e.g. an nvm Node bin directory. |
| `HIT_REVIEW_KEY_ENV` | Path to the environment file. Default `<repo>/key.env`. |
| `NPX_BIN` | Explicit `npx` path. |

`MAGI_TARGET` falls back to the connect code or player tag in
`~/.magi-melee/config.json`. On a server that has never run the app, set
`MAGI_TARGET` explicitly.

## Output folder and size cap

Clips go to `~/.magi-melee/hit-review` by default. Every run finishes by
pruning **only files this tool created**:

- `*.mp4` whose name matches `<stem>-<hash>-<opening|conversion|hit|death>-<firstHit>-<start>-<end>.mp4`
- the matching `*.json` metadata sidecar

Chronological review writes `opening` and `conversion` labels. The older
cost-ranked mode still writes `hit` and `death` labels; retention recognizes all
four so old clips continue to be pruned normally.

It deletes oldest first until the managed files are at or below the cap. Other
files in the folder are never deleted. A cap of `0` disables pruning:

```bash
npx tsx src/hit-review-cli.ts ... --max-out-size 0
```

Telegram sends happen before the final prune, so a clip that was delivered is
already in your chat. If a send failed and the clip is later pruned, the next run
re-renders it because the replay was not marked processed.

## Usage

Chronological review is the default. Preview the next two events without
rendering:

```bash
npx tsx src/hit-review-cli.ts \
  --dir ~/Slippi \
  --target 'POOK#392' \
  --limit 2 --json
```

Render and send the next two events:

```bash
npx tsx src/hit-review-cli.ts \
  --dir ~/Slippi \
  --target 'POOK#392' \
  --cursor data/hit-review-cursor.json \
  --limit 2 \
  --render --telegram
```

Or use the npm script:

```bash
npm run hit-review -- --dir ~/Slippi --target 'POOK#392' --limit 2 --render
```

`--chronological` is still accepted for compatibility with older scripts, but
it is no longer required.

Useful options:

- `--limit 2` — two clips per run; the daily wrapper sets this by default.
- `--cursor PATH` — use a specific cursor/cache file. The default is
  `./data/hit-review-cursor.json`, which is gitignored.
- `--reset-cursor` — ignore the saved position for this run, starting again at
  the oldest event. The parsed-event cache is kept.
- `--force` — ignore the cursor when selecting, but still advance it after each
  successful clip. Useful for a manual re-send.
- `--deaths-only` — only events whose conversion took a stock.
- `--min-damage 20` — ignore events whose full conversion is below 20%.
- `--limit 0` — render every event after the cursor. This can be a lot of clips.
- `--dry-run` — print the selected events without rendering, sending, or
  changing the cursor.
- `--legacy-ranked` — use the older cost-ranked selection instead of
  chronological review (see below).

The cursor file is local runtime state. It holds the timestamp and identity of
the most recent generated clip plus a cache of parsed events per replay. The
cache is what makes a daily run cheap: unchanged replays are not re-parsed. If
the configured target changes, the cursor and cache reset automatically.

Parsing is lazy. A run reads only the cheap `startAt`/`lastFrame` metadata for
every replay. It orders replays by their recorded start instant, skips any
replay whose latest possible event is before the cursor without parsing it,
then parses (or restores from cache) one replay at a time. Once it has
`--limit` events, it stops as soon as the next replay starts after the last
selected event; only a next replay starting at the same instant is parsed,
because its events could still win the same-millisecond key tie-break. In
`--json` output, `filesSkippedBeforeCursor` counts replays rejected by the
cursor and `filesDeferred` counts replays never needed for the selection.

### Legacy cost-ranked mode

With `--legacy-ranked`, the CLI keeps the older behavior: it ranks the hits you
took by damage, move count, and stock loss, and renders the top `--limit`. The
`--state`, `--since-hours`, `--all`, and `--no-state` options belong to that
mode; passing one without `--legacy-ranked` is an error so a run cannot
silently switch selection strategies. New deployments should use the
chronological daily wrapper below.

## Daily cron job

The wrapper script loads `key.env`, builds `PATH` from the optional
`HIT_REVIEW_PATH` entry (cron does not see a user-installed Node), takes a lock
so two runs cannot overlap, and calls the CLI with
`--limit 2 --render --telegram`. It keeps its cursor at
`<repo>/data/hit-review-cursor.json` unless `HIT_REVIEW_CURSOR` points
somewhere else:

```bash
./scripts/hit-review-daily.sh
```

Add it to cron (the non-zero minute avoids jobs that all start at :00):

```cron
17 20 * * * /opt/clippi/scripts/hit-review-daily.sh >> /home/pook/.magi-melee/hit-review.log 2>&1
```

Cron's `PATH` is small. If Node is installed with nvm, set `HIT_REVIEW_PATH` in
`key.env`, for example:

```bash
HIT_REVIEW_PATH=/home/pook/.nvm/versions/node/v22.12.0/bin
```

Use `--dry-run` first to confirm the selection without rendering:

```bash
HIT_REVIEW_DRY_RUN=1 ./scripts/hit-review-daily.sh
```

### systemd timer (optional)

A user timer with `Persistent=true` catches up after a missed run. Create
`~/.config/systemd/user/magi-hit-review.service`:

```ini
[Unit]
Description=MAGI daily hit review

[Service]
Type=oneshot
WorkingDirectory=%h/clippi
ExecStart=/bin/bash %h/clippi/scripts/hit-review-daily.sh
```

and `~/.config/systemd/user/magi-hit-review.timer`:

```ini
[Unit]
Description=Run the MAGI hit review daily

[Timer]
OnCalendar=*-*-* 20:17:00
Persistent=true

[Install]
WantedBy=timers.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now magi-hit-review.timer
loginctl enable-linger "$USER"   # run while logged out
```

Check it with `systemctl --user list-timers` and
`journalctl --user -u magi-hit-review.service`.

## Home server deployment

1. Install Node, `ffmpeg`, `xvfb`, the Mesa DRI package, and the Slippi
   Playback dependencies.
2. Clone the repo and install dependencies:

   ```bash
   git clone <your-fork-url> /opt/clippi
   cd /opt/clippi
   npm ci
   chmod +x scripts/hit-review-daily.sh
   ```

3. Put the paths, target, and Telegram credentials in `/opt/clippi/key.env`.
   Keep it mode `600`:

   ```bash
   chmod 600 key.env
   ```

4. Sync replays from the gaming machine. `scripts/sync-replays-clyde.sh` does
   this with a lock and a reachability check; replays are immutable, so
   `--ignore-existing` is safe:

   ```bash
   ./scripts/sync-replays-clyde.sh
   ```

   Run it from cron on the machine where Dolphin saves replays, for example
   every 30 minutes:

   ```cron
   7,37 * * * * /opt/clippi/scripts/sync-replays-clyde.sh >> /home/pook/.magi-melee/replay-sync.log 2>&1
   ```

   The script syncs to `~/Slippi` on the server unless `CLYDE_REPLAYS` says
   otherwise; set `REPLAY_DIR` in `key.env` to match. Syncthing works too;
   point `REPLAY_DIR` at the synced folder.

5. Run one dry run, then one real run with `--limit 1`, before enabling the
   timer.

The chronological cursor lives at `data/hit-review-cursor.json` by default. It
records the most recent generated clip and a cache of parsed events keyed by
each replay's size and modification time. A new run re-parses only new or
changed replays. If a clip render or Telegram send fails, the cursor does not
move past that event, so the next run retries it. The older cost-ranked state
file at `~/.magi-melee/hit-review-state.json` is still used only when the CLI is
run without `--chronological`.

## Docker

The pipeline also runs entirely in a container. The image contains Node,
ffmpeg, Xvfb and Mesa; the Melee ISO, Slippi Playback build, replays, output
and Telegram credentials are mounted or passed at run time. See
[Docker deployment](docker.md).

## Troubleshooting

**`Target player "..." not found`** — the tag or connect code is not in that
replay. Offline replays may have a tag but no connect code; use the tag shown in
the replay. Check `--json` output for the players in the game.

**`No frame dump was produced`** — run `scripts/render-clip.sh` directly with
`KEEP_TMP=1` and read the Dolphin log it keeps. Common causes are a missing
display (`xvfb-run` not installed), a missing ISO, or Dolphin failing to create
an OpenGL context on a headless server.

**Rendering is slow** — each clip launches Slippi playback and seek/plays to the
clip end. Keep `HIT_REVIEW_LIMIT` modest on a CPU-only server. 720p is much
cheaper than 1080p.

**Telegram `chat not found`** — the bot has not seen that chat, or the id is
wrong. Send the bot a message and rerun `--telegram-check`. Group ids are
negative. If a bot was removed and re-added, its chat id can change.

**Telegram file too large** — the Bot API caps video uploads at 50 MB. Lower
`HIT_REVIEW_RESOLUTION`, or render fewer/longer clips with a lower bitrate.

**No new clips** — every event is at or before the cursor. Use `--json` to see
the cursor position, or `--reset-cursor` to start the chronological walk again.
In the legacy cost-ranked mode, unchanged replays are skipped through the state
file instead; use `--all` or `--force` there.

**Old clips disappear** — that is the size cap. Raise
`HIT_REVIEW_MAX_OUT_SIZE` or set it to `0` to disable pruning.

## Related documentation

- [Hit-review status and next steps](hit-review-status.md)
- [Docker deployment](docker.md)
- [Development notes](DEVELOPMENT.md)
- [Melee accuracy notes](melee-accuracy.md)
- [Project README](../README.md)
