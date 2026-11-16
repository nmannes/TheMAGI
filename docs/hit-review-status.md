# Hit-review status

Working notes for the headless hit-review pipeline. Last updated 2026-11-15.

The user-facing reference is [Headless hit review](hit-review.md); deployment
details are in [Docker deployment](docker.md).

## What it does now

The daily job walks replay history in chronological order and produces two
clips per run. A clip is always one of:

1. **Opening hit taken** — the first hit of a conversion the opponent lands on
   the target player. Follow-up hits in that conversion are not separate
   events. The clip starts 5 seconds before the hit and ends 2 seconds after it
   (2.5 seconds when the hit itself took the stock). The caption reports what
   the full conversion became.
2. **Conversion landed** — a conversion where the target player is the attacker
   and at least two hits connected. The clip starts 5 seconds before the first
   hit and ends 5 seconds after the player's last hit. One-hit conversions do
   not qualify.

Both clip types are capped at 20 seconds and at the replay's last frame. Clips
are called "conversions," never "true combos," because Slippi conversions can
continue through tech chases and ledge traps.

## What we have done

- [x] Replaced the cost-ranked hit picker with chronological event selection
      (`--chronological`) in `src/hit-review-cli.ts` and `src/hitReview.ts`.
- [x] Defined the two event types from MAGI's parsed `frameEvents.conversions`
      with the evidence each event requires:
      - opening hit taken = first move of an opponent conversion;
      - landed conversion = target-attacker conversion with two or more
        connected moves.
- [x] Set clip windows: 5 s pre-roll for both types, 2 s post-roll for an
      opening hit, 5 s post-roll after the last hit of a landed conversion.
- [x] Added a local, gitignored cursor at `data/hit-review-cursor.json`
      (override with `--cursor` / `HIT_REVIEW_CURSOR`). The cursor stores the
      most recent generated clip as wall-clock instant + deterministic event
      key, so it can sit mid-game, not only between games. It advances only
      after the clip is rendered and delivered; a failed render or Telegram
      send retries the same event next run.
- [x] Added a parsed-event cache keyed by replay size and modification time, so
      a daily run re-parses only new or changed replays. A target change resets
      both the cursor and the cache.
- [x] Made parsing lazy. A run reads only `startAt`/`lastFrame` metadata for
      every replay, skips replays whose latest possible event predates the
      cursor without parsing them, parses or restores one replay at a time, and
      stops once `--limit` events are selected and the next replay starts after
      the last selected event (ties still parse). On the 800-replay local
      library a fresh-cursor query took 0.98 s, parsed 2 replays, and deferred
      798; a mid-library cursor skipped 92 replays before the cursor and
      deferred 707. `--json` now reports `filesSkippedBeforeCursor` and
      `filesDeferred`.
- [x] Anchored event instants to Slippi's real frame numbering:
      `metadata.startAt + (frame + 123) / 60`. Slippi writes `startAt` when the
      replay's first frame is recorded, and replay frames start at `-123`
      (frame 0 is when the in-game timer starts counting down). Verified
      against Dolphin's `GAME_FIRST_FRAME = -123` and a 200-replay check where
      the `-123` anchor was closer for every file.
- [x] Kept conversion totals parser-authoritative: damage and percent ranges
      come from the conversion record, not the sum of listed move damages.
- [x] Made chronological review the CLI's default. The earlier cost-ranked mode
      now requires `--legacy-ranked`, and its `--state`, `--since-hours`,
      `--all`, and `--no-state` options are rejected without it. The argument
      parser moved to `src/hitReviewCliArgs.ts` with regression tests in
      `tests/hitReviewCliArgs.test.ts`.
- [x] Fixed the daily wrapper building `PATH` before sourcing `key.env`, which
      ignored the `HIT_REVIEW_PATH` the deploy writes and could resolve a
      system Node the project does not support (observed as npm warning about
      Node 18.19.1 through a non-interactive SSH run).
- [x] Made `--limit` default to 2 and added `--reset-cursor`, `--deaths-only`,
      and `--min-damage` for the chronological flow.
- [x] Updated output retention to recognize the new `opening` and `conversion`
      filename labels while still pruning legacy `hit`/`death` clips.
- [x] Updated the daily wrapper, Docker entrypoint, Compose file, and
      environment examples to use `HIT_REVIEW_CURSOR` (`/data` in Docker).
- [x] Updated the deploy smoke test to run a chronological query with a
      throwaway cursor so it cannot disturb the production cursor.
- [x] Updated `docs/hit-review.md`, `docs/docker.md`, `CHANGELOG.md`, and
      `README.md`.
- [x] Added regression tests for event extraction, ordering, captions, stock
      attribution, cursor comparisons (including "not after its own cursor"),
      the `-123` frame anchor, and mid-replay cursor advancement.
- [x] Passed the full gate: `npm run typecheck`, `npm test` (73 files, 555
      tests), `npm run lint`, `npm run format:check`, `npm run verify:docs`,
      `npm run verify:release`.

### Rendering smoke test (already verified)

Two clips were rendered from `tests/fixtures/game1.slp` in a real
Xvfb/Dolphin/ffmpeg run:

- Landed conversion at frame 167: clip frames 0-497, 8.27 s, 9.4 MiB,
  962x792, H.264 + AAC.
- Opening hit taken at frame 581: clip frames 281-701, 6.98 s, 7.3 MiB, same
  codecs.
- The second run advanced the cursor to frame 581 inside the same replay,
  which is the mid-game behavior the cursor is meant to have. The second run
  also reused the parsed-event cache.

### End-to-end delivery (verified 2026-11-15)

A headless run against the real 800-replay library rendered and delivered
clips to Telegram. The first run read metadata for all 800 replays, parsed 2,
deferred 798, and selected the first two events of
`Game_20260213T235334.slp`:

- Opening hit at frame 350: 7.8 MiB MP4, sent.
- Landed conversion at frame 424: 12 MiB MP4, rendered but the upload failed
  with a transient `fetch failed`. The cursor advanced only to the opening hit
  (frame 350), so the failed event stayed eligible.

A second run reused the cache (1 cached, 0 parsed, 1 replay before the
cursor), selected the failed conversion again plus the next opening hit
(frame 561), and sent both: `2 rendered, 2 sent, 0 send failure(s)`. The
cursor advanced to frame 561 inside the same replay. This confirms the
retry-on-failure behavior: a failed render or send is retried by the next run
because the cursor only moves after delivery succeeds.

### Current deployment (2026-11-15)

- `~/clippi` on clyde is an actual `git clone` of
  `nmannes/TheMAGI`; `scripts/deploy-clyde.sh` now pushes and fast-forwards
  instead of rsyncing. `key.env`, `docker.env` and `data/` were restored as
  untracked runtime files after the clone, and the clone reports a clean
  `git status` at the pushed commit.
- The clip job runs **on clyde** from cron every hour at :17:
  `17 * * * * bash /home/nathan/clippi/scripts/hit-review-daily.sh >> /home/nathan/.magi-melee/hit-review.log 2>&1`,
  with `HIT_REVIEW_LIMIT=1` in clyde's `key.env`, so one clip is delivered per
  hour (24/day). A dry run with a cron-minimal environment (`env -i`, PATH
  `/usr/bin:/bin`) confirmed the wrapper resolves Node through
  `HIT_REVIEW_PATH` and selects the next event after the cursor.
- `scripts/sync-replays-clyde.sh` runs on the **local machine** from cron at
  :07 and :37 (it has to: that is where Dolphin writes replays) and mirrors
  `~/Slippi` to `clyde:~/Slippi` with `--ignore-existing`.

## What is next

1. **First scheduled run.** Check `/home/nathan/.magi-melee/hit-review.log` on
   clyde and Telegram after the next :17 to confirm the cron path renders and
   delivers a clip.
2. **Docker verification.** Build the image and run the same two-clip query
   with real mounts, since the container path now defaults to
   `/data/hit-review-cursor.json`.
3. **Decide on the legacy mode.** The cost-ranked mode (`hit`/`death` labels,
   `--state`, `--since-hours`, `--all`) still exists for manual use behind
   `--legacy-ranked`. Remove it once the chronological job has run for a
   while.

## Open questions and known limits

- **Clip lead-in floor.** Clip bounds clamp at frame 0, but a replay's first
  frame is `-123`. For an opening hit inside the first 5 seconds, the clip
  currently loses up to 39 frames (0.65 s) of available lead-in compared with
  starting at `-123`. The playback build accepts a start frame of `-123`
  (Dolphin's `GAME_FIRST_FRAME`), but negative starts were not part of the
  verified render smoke test. Verify one render starting at `-123` before
  changing the floor.
- **Duplicate replay files.** The CLI walks files; two copies of the same
  replay under different names produce duplicate clips. Deduplicating by file
  hash is possible but not implemented.
- **`startAt` granularity.** Slippi records `startAt` in whole seconds, so
  cross-replay ordering inherits up to one second of rounding. Games are
  normally minutes apart, and within-replay ordering is exact frame ordering.
- **Legacy state file.** `~/.magi-melee/hit-review-state.json` is still used
  only when the CLI runs without `--chronological`.

## Constraints

- Do not start production work on clyde, install cron, or enable the timer
  without explicit direction.
- Never commit `key.env`, `.slp` files, local databases, cursors, or rendered
  clips.
- Building an artifact does not authorize publishing or tagging a release.
