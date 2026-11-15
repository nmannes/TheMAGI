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
- [x] Anchored event instants to Slippi's real frame numbering:
      `metadata.startAt + (frame + 123) / 60`. Slippi writes `startAt` when the
      replay's first frame is recorded, and replay frames start at `-123`
      (frame 0 is when the in-game timer starts counting down). Verified
      against Dolphin's `GAME_FIRST_FRAME = -123` and a 200-replay check where
      the `-123` anchor was closer for every file.
- [x] Kept conversion totals parser-authoritative: damage and percent ranges
      come from the conversion record, not the sum of listed move damages.
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
- [x] Passed the full gate: `npm run typecheck`, `npm test` (72 files, 546
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

## What is next

1. **Telegram credentials.** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are
   still unset. Send the bot a message, run
   `npx tsx src/hit-review-cli.ts --telegram-check`, then put both values in
   `key.env`.
2. **One real end-to-end run.** Render and send two clips from the real replay
   folder with a temporary cursor, then inspect the captions and the Telegram
   messages:

   ```bash
   npx tsx src/hit-review-cli.ts \
     --dir ~/Slippi --target 'POOK#392' \
     --chronological --cursor data/hit-review-cursor.json \
     --limit 2 --render --telegram
   ```

3. **Deploy to clyde.** Sync source/assets/replays with
   `scripts/deploy-clyde.sh`, confirm the new chronological smoke query passes,
   then do one server-side dry run before any real render.
4. **Enable the schedule.** Install cron or the systemd timer described in
   [the daily job section](hit-review.md#daily-cron-job) only after the real run
   succeeds.
5. **Docker verification.** Build the image and run the same two-clip query
   with real mounts, since the container path now defaults to
   `/data/hit-review-cursor.json`.
6. **Decide on the legacy mode.** The cost-ranked mode (`hit`/`death` labels,
   `--state`, `--since-hours`, `--all`) still exists for manual use. Remove it
   once the chronological job has run for a while.

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
