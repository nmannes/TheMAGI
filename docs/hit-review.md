# Headless hit review

`hit-review` is a Linux CLI for reviewing the moments you get hit in Super Smash
Bros. Melee. It reads Slippi replays, ranks the hits you took, renders short MP4
clips of them, and can send the clips to Telegram. It is designed to run from
cron or a systemd timer on a home server, with no visible desktop session.

It uses MAGI's existing replay parser and measured event data. It does not call
an LLM and it does not make combo videos.

## What a clip is

For the configured player (the **target**), the CLI:

1. Keeps conversions where the target is the **victim**. In MAGI's
   `ConversionRecord`, `attackerSlot` is the player who landed the conversion;
   hits where the target is the attacker are ignored.
2. Flattens the individual hit frames. MAGI conversions can span tech chases,
   knockdowns, and ledge traps for many seconds, so a conversion range is **not**
   used as a clip range.
3. Groups hits that are at most 45 frames (0.75 s) apart and splits a group at a
   stock death.
4. Renders 90 frames (1.5 s) before the first hit and 90 frames after the last
   hit. A sequence that took a stock gets 150 frames (2.5 s) after the last hit.
   Clips are capped at 20 seconds and at the replay's last frame.
5. Associates a death with the stock record using the killing conversion's final
   move and stock end frame. If no hit can be associated with a death, it emits
   an `unattributed-death` clip instead of guessing.

The clip caption lists the moves that connected, the percent before and after,
the opening type, and — only when MAGI measured it — the DI result. A
`FAILED_RECOVERY` or `SD` verdict is not displayed as DI: those verdicts come
from the measured-DI search, not from a measured stick input on the final hit.
For throw deaths there is often no measurable final-hit DI, so the caption says
`DI: not measured for this hit` rather than inventing a verdict.

The CLI does not label a sequence with a named technique unless the evidence
would establish every condition of that technique. It describes the hits that
were recorded.

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
sudo apt install ffmpeg xvfb libgl1-mesa-dri libglx-mesa0 libfuse2
```

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
| `HIT_REVIEW_LIMIT` | Clips per run. Default `5`. |
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

- `*.mp4` whose name matches `<stem>-<hash>-<hit|death>-<firstHit>-<start>-<end>.mp4`
- the matching `*.json` metadata sidecar

It deletes oldest first until the managed files are at or below the cap. Other
files in the folder are never deleted. A cap of `0` disables pruning:

```bash
npx tsx src/hit-review-cli.ts ... --max-out-size 0
```

Telegram sends happen before the final prune, so a clip that was delivered is
already in your chat. If a send failed and the clip is later pruned, the next run
re-renders it because the replay was not marked processed.

## Usage

Analyze one replay and print the selected sequences as JSON, without rendering:

```bash
npx tsx src/hit-review-cli.ts \
  --replay /path/to/game.slp \
  --target 'POOK#392' \
  --limit 5 --json
```

Render the top five hits taken across a folder:

```bash
npx tsx src/hit-review-cli.ts \
  --dir ~/Slippi \
  --target 'POOK#392' \
  --limit 5 \
  --render
```

Render and send:

```bash
npx tsx src/hit-review-cli.ts \
  --dir ~/Slippi \
  --target 'POOK#392' \
  --limit 5 \
  --render --telegram
```

Or use the npm script:

```bash
npm run hit-review -- --dir ~/Slippi --target 'POOK#392' --limit 5 --render
```

Useful filters:

- `--deaths-only` — only sequences that took a stock.
- `--min-damage 20` — ignore smaller hits.
- `--limit 0` — render every selected sequence. This can be a lot of clips.
- `--all` — process every discovered replay, ignoring the state file.
- `--force` — reprocess and resend clips already marked delivered.
- `--no-state` — do not read or write state.
- `--since-hours 168` — on a fresh state, scan files from the last week.

## Daily cron job

The wrapper script loads `key.env`, takes a lock so two runs cannot overlap, and
calls the CLI with `--render --telegram`:

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

4. Sync replays from the gaming machine. Replays are immutable, so
   `--ignore-existing` is safe:

   ```bash
   rsync -av --ignore-existing ~/Slippi/ server:/opt/clippi/replays/
   ```

   Then set `REPLAY_DIR=/opt/clippi/replays` in `key.env`. Syncthing works too;
   point `REPLAY_DIR` at the synced folder.

5. Run one dry run, then one real run with `--limit 1`, before enabling the
   timer.

The state file lives at `~/.magi-melee/hit-review-state.json`. It records each
replay's size and modification time, so an unchanged replay is skipped. If a
replay is replaced or moved, it is processed again. Delivered clips are tracked
for 60 days to prevent duplicate Telegram messages.

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

**Replays are skipped** — they are unchanged and already in the state file. Use
`--all` to process everything or `--force` to re-render and resend.

**Old clips disappear** — that is the size cap. Raise
`HIT_REVIEW_MAX_OUT_SIZE` or set it to `0` to disable pruning.

## Related documentation

- [Docker deployment](docker.md)
- [Development notes](DEVELOPMENT.md)
- [Melee accuracy notes](melee-accuracy.md)
- [Project README](../README.md)
