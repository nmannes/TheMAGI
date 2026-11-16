# MAGI TODO

Feature-development tracker. The checkbox trees are the source of truth for progress; the definitions above each tree record the Melee and data constraints a future implementation must preserve.

**Convention:** every task is a checkbox bullet. `[x]` = done, `[ ]` = pending. Tick a parent only when all of its children are ticked. Update this file in the same commit that completes a task.

**Current state:** Feature 1 is implemented and tested except for two environment-bound checks (Electron-Node backfill and an interactive UI smoke test); Feature 2 is still planning only.

---

## Feature 1: Openings Against Me — clustered first-hit ledger

**Status:** implemented; two verification boxes pending (Electron-Node backfill and interactive UI smoke test).

### Why

MAGI persists opponent conversions (`conversions.attacker_is_player = 0`) and rich per-instance events, but nothing groups the moment an opening starts by situation, move, position, or percent, and nothing links it to cost/outcome. This feature shows the openings the player keeps losing ("what I keep on falling for") through two parallel grouping views: explainable rule-based buckets and deterministic statistical shape clusters.

### Definition (Melee-accurate)

- Unit = the **first hit in neutral** of an opponent conversion where the target is the player, not follow-up combo hits.
- Event frame = `conversion.startFrame` (the first stun/grab frame). For a grab, this is the grab frame, not the later throw.
- Inspect both players' `post` state on `startFrame - 1`; inspect `startFrame` to detect a grab.
- **Include** when the victim is onstage and not already in hitstun, knocked down, teching, on the ledge, offstage, dead/dying, or respawning. Own attack/special/air-dodge commitments, landing lag, shield, and shieldstun are **included and labeled** — these are the decisions that get punished.
- **Exclude** combo continuations, tech-chase follow-ups that begin from down/tech states, ledge/offstage hits (recovery and habit ledgers own those), and SDs with no conversion (`stock_deaths.verdict = 'SD'` owns those).
- **Trades**: both conversions produce an event; each is flagged `traded`.
- **Grab conversions**: `opener_family = "grab"`; persisted `opener_move_id` remains the conversion's first damaging move (throw/pummel), and the label says `grab (bthrow)` so nothing claims a grab was a throw.

Victim situation vocabulary:
`neutral-grounded | neutral-airborne | shield | shieldstun | commitment | landing`

Opener family vocabulary:
`aerial | grounded | special | projectile | grab`

Positions and percent come from the pre-hit frame. Relative position is expressed in the victim's facing frame: `(attacker.x - victim.x) * facing`. Cornered reuses the habit definition (`|x| > 0.7 * STAGE_LEDGE_X` and attacker between victim and center).

### Data model and pipeline

New migration **v18** (current max is 17). New `opening_events` table persisted for both player perspectives (`victim_is_player`), following the existing event-table pattern:

```
opening_events(
  id, game_id, victim_is_player, start_frame, end_frame,
  opener_move_id, opener_label, opener_family, grab, opening_type, traded,
  situation, victim_state, attacker_state,
  victim_percent, attacker_percent,
  victim_x, victim_y, attacker_x, attacker_y,
  relative_x, relative_y, distance, cornered, on_platform,
  damage, move_count, did_kill,
  stock_number, death_frame, death_verdict
)
```

Indexes: `(game_id)`, `(game_id, victim_is_player)`, `(victim_is_player, situation, opener_family)`.

- New `src/pipeline/openingEvents.ts` exports `extractOpeningEvents(...)`, called from `extractFrameEvents` (`src/pipeline/frameEvents.ts`). It consumes conversions, frames, and stage, reusing `helpers.ts` (`STAGE_LEDGE_X`, `isOffstage`, `isOnPlatform`, action-state ranges, `getMoveName`) and slippi-js predicates (`isDamaged`, `isGrabbed`, `isCommandGrabbed`, `isDead`, `isDown`, `isTeching`).
- Add `OpeningEvent` to `src/pipeline/frameEvents.ts` and `GameFrameEvents.openings`.
- **Bump `FRAME_EVENTS_VERSION` 3 → 4** with a comment describing the new event set, so a plain `npm run backfill` re-parses existing games and populates the table.
- Persist in `persistFrameEvents` (`src/importer.ts`); add `insertOpeningEvents` near `db.ts:1370`; add the table to `deleteFrameEventRows` (`db.ts:1354`).
- Match each opening to a `stock_deaths` row by game, victim, and death-frame window for `stock_number` / `death_verdict`; leave null when it did not kill.

### Grouping

**Rule-based (authoritative, stable)** — `src/pipeline/openingClusters.ts`:

- `aggregateOpeningBuckets(events)` groups by `situation × opener_family × opener_label` and returns count, share, kills, kill rate, average damage, average follow-up hits, cornered share, distinct games, and example events (game id, frame, timestamp) per bucket.
- Percent bands (0–30, 30–60, 60–90, 90–120, 120+) and cornered/on-platform are qualifier splits shown in the UI.
- Sort by count; offer a "most costly" sort by raw kill count (no invented composite score).
- Sample guards: add `openingsBucketMin` (8) and `openingsTotalMin` (25) to `EVENT_SAMPLE_GUARDS`. Low-n rows are returned but marked/dimmed, never hidden silently.

**Statistical (exploratory, descriptive)** — same module, hand-rolled deterministic k-means (no new dependency):

- Numeric feature vector: victim percent, relative x/y in the victim-facing frame, distance, victim x normalized to stage ledge, on-platform. Rule-based `situation`/`opener_family` are **not** inputs; the methods stay parallel and independent. Clusters are characterized by dominant situation/move afterward.
- Deterministic seeded k-means++ initialization, seed derived from sorted event ids, so the same filtered set always produces the same clusters.
- k tried from 2 to 6, chosen by silhouette on a deterministic sample (cap ~500 points); minimum cluster size `max(8, ceil(0.05n))`; require `n ≥ 40` or return an explicit `insufficient-sample` reason.
- Output: size/share, mean/median percent, distance, cornered share, dominant situation/family/exact move, kill rate, average damage, distinct games, examples, and `weakSeparation` when the best silhouette is poor.
- Labels describe measurements only (e.g. "Close range · 20–50% · center"), never a named technique. Cluster ids are **not persisted** and never used for Library filters or cached coaching; they are recomputed per query.

### Surfaces

1. **Shared contract** `src/openingsAgainst.ts`: filters (`character`, `opponentCharacter`, `stage`, `opponentKey`, game `limit` default 200/max 1000), coverage (`gamesInScope`, `gamesWithOpenings`), baseline, buckets, clusters, examples. Mirrors `src/characterEventProfile.ts`.
2. **DB + IPC**: `getOpeningsAgainst(filters)` in `src/db.ts` (scoped by games, version-gated by the new rows, raw rows loaded once and aggregated/clustered in TS); `stats:openingsAgainst` registered with `safeHandle` in `src/main/handlers/stats.ts`; expose in `src/preload/index.ts`; type in `src/renderer/global.d.ts`; add `useOpeningsAgainst` in `src/renderer/hooks/queries.ts`.
3. **Performance Lab**: new section `src/renderer/pages/performance/OpeningsAgainst.tsx` (plus CSS), inserted after "What to act on" in `PerformanceLab.tsx`. Rule buckets grouped like `HabitLedger.tsx` (situation sections, share bars, kill-rate column, low-n dimming); cluster cards below; filters (recency, your character, opponent character, stage); coverage warning when some games predate the backfill; examples click through to `/game/:id` with `{ seekFrame }` like `Library.tsx`.
4. **Library**: add an `opening` bucket filter to `LibraryGameFilters` / `buildLibraryWhere` using `EXISTS` on `opening_events` (`victim_is_player = 1`, matching `situation` + `opener_family`); return distinct bucket options in the response; add the select to `Library.tsx` and `library/filter.ts`; include it in clear-filters state.
5. **Coaching prompt**: extend `PatternData` (`src/pipeline/patterns.ts`) with `openingsAgainst { total, games, kills, buckets[] }`; fill from `patternsFromFrameEvents` (this game/set), `mergePatternData`, and `getPatternData` (DB history, same scope/current-version gating). Add a compact "Openings against you" section to `formatRecurringPatterns` and `formatPatternBreakdown`, with sample guards. Add one prompt instruction line so the coach names the repeated door, its n-of cost, and a replacement. Statistical clusters stay out of the prompt (unstable by dataset; descriptive view only). Bump `COACHING_PROMPT_VERSION` 4 → 5.
6. **CLI**: `src/openings-cli.ts` with `--target`, `--character`, `--opponent`, `--stage`, `--limit`, `--k`, `--no-clusters`, `--json`; prints coverage, rule buckets, statistical clusters, and top examples. Add an `openings` npm script and document the command. Follows the `stats.ts` standalone CLI pattern.
7. **Clip delivery**: `--render`/`--send` selects a rule bucket (default: most frequent) or shape cluster and renders its newest examples with the chronological opening-hit bounds (5 seconds before, 2 seconds after, capped at the replay's last frame). Rendering is shared with hit-review (`src/clipRender.ts`); `--send` delivers through Telegram. Captions state the measured situation/family/move, sample size, pre-hit percent, and the full conversion's damage and stock outcome. This path needs the SQLite ledger, unlike chronological hit-review.

### Tasks

- [ ] **Feature 1 complete** (tick when every section below is ticked)
- [x] Plan defined (this document)
- [x] `TODO.md` created at repo root with this feature entry
- [x] `TODO.md` committed on branch `docs/todo-tracker`

#### 1. Detector

- [x] Add `OpeningEvent` interface + `GameFrameEvents.openings`
- [x] Implement `extractOpeningEvents` in `src/pipeline/openingEvents.ts`
- [x] Implement the neutral gate (onstage; not hitstun/down/tech/ledge/offstage/dead/respawn)
- [x] Classify `situation` (`neutral-grounded`, `neutral-airborne`, `shield`, `shieldstun`, `commitment`, `landing`)
- [x] Classify `opener_family` (`aerial`, `grounded`, `special`, `projectile`, `grab`) and exact move label
- [x] Handle grabs (event frame = grab frame, family = grab, throw shown as detail)
- [x] Handle trades (two events, `traded = true`)
- [x] Record percent, positions, victim-facing relative x/y, distance, cornered, on-platform, damage, move count, kill, stock/verdict
- [x] Bump `FRAME_EVENTS_VERSION` 3 → 4 with a version comment
- [x] Call `extractOpeningEvents` from `extractFrameEvents`
- [x] Tests: grounded neutral hit, shield→grab, commitment, landing
- [x] Tests: negatives for hitstun continuation, ledge, offstage, dead/respawn, SD
- [x] Tests: trade produces two events; grab frame/label; cornered/relative-position math
- [x] Test: `game1.slp` fixture well-formedness invariants

#### 2. Persistence and backfill

- [x] Add `opening_events` to `SCHEMA`
- [x] Add migration v18 with table + indexes
- [x] Add `insertOpeningEvents`
- [x] Add `opening_events` to `deleteFrameEventRows`
- [x] Persist both perspectives in `persistFrameEvents`
- [x] Match each opening to `stock_deaths` for stock number / death verdict
- [x] Confirm plain backfill re-parses games at version 4 and fills the table
- [x] Tests: schema/migration/index/helper assertions in `tests/db.test.ts`
- [x] Test: persist mapping for both `victim_is_player` perspectives

#### 3. Rule buckets and statistical clustering

- [x] `aggregateOpeningBuckets` with count, share, kills, kill rate, avg damage, avg follow-up hits, cornered share, distinct games, examples
- [x] Percent bands and cornered/on-platform qualifier splits
- [x] Add `openingsBucketMin` + `openingsTotalMin` to `EVENT_SAMPLE_GUARDS`
- [x] Deterministic k-means: numeric shape features only, seeded from sorted event ids
- [x] k selection 2–6 by silhouette on a deterministic sample, min cluster size guard
- [x] `n ≥ 40` guard with explicit `insufficient-sample` reason
- [x] `weakSeparation` flag and descriptive (non-technique) cluster labels
- [x] Tests: bucket counts/rates/guards
- [x] Tests: determinism under shuffling; k/min-size/insufficient-sample guards
- [x] Tests: cluster descriptors pick the correct dominant situation/move

#### 4. Query, contract, and IPC

- [x] Add shared contract `src/openingsAgainst.ts` (filters, coverage, baseline, buckets, clusters, examples)
- [x] Add `getOpeningsAgainst(filters)` in `src/db.ts` with scope + version gating
- [x] Register `stats:openingsAgainst` with `safeHandle`
- [x] Expose in preload
- [x] Type in `src/renderer/global.d.ts`
- [x] Add `useOpeningsAgainst` React Query hook
- [x] Tests: seeded temp-DB perspective isolation, filters, coverage, version gating

#### 5. UI

- [x] Performance Lab `OpeningsAgainst.tsx` rule-bucket sections (HabitLedger-style)
- [x] Cluster cards with descriptors, sample counts, weak-separation note
- [x] Filters: recency, your character, opponent character, stage
- [x] Coverage warning + backfill hint when games predate the backfill
- [x] Example chips navigate to `/game/:id` with `seekFrame`
- [x] Insert section into `PerformanceLab.tsx`
- [x] Library: `opening` filter in `LibraryGameFilters` / `buildLibraryWhere` via `EXISTS`
- [x] Library: distinct bucket options in response, select in `Library.tsx`, `filter.ts`, clear-filters
- [x] Tests: Library `EXISTS` filter behavior

#### 6. Coaching prompt

- [x] Add `PatternData.openingsAgainst`
- [x] Fill it in `patternsFromFrameEvents` and `mergePatternData`
- [x] Aggregate it in `getPatternData` with current-version gating
- [x] Format "Openings against you" in `formatRecurringPatterns`
- [x] Format one-line scope in `formatPatternBreakdown`
- [x] Add a prompt instruction line (name the door, n-of cost, replacement)
- [x] Bump `COACHING_PROMPT_VERSION` 4 → 5
- [x] Keep statistical clusters out of the prompt
- [x] Tests: formatter output, sample-guard suppression, updated `PatternData` fixtures

#### 7. CLI

- [x] Add `src/openings-cli.ts` (`--target`, `--character`, `--opponent`, `--stage`, `--limit`, `--k`, `--no-clusters`, `--json`)
- [x] Print coverage, rule buckets, clusters, top examples
- [x] Add `--render`/`--send` clip delivery for a selected bucket or cluster (`--bucket`, `--cluster`, `--clips`)
- [x] Shared renderer extracted to `src/clipRender.ts`; clip selection/caption logic in `src/openingClips.ts`
- [x] Add `openings` npm script
- [x] Document the command and clip delivery

#### 8. Docs and release

- [x] `docs/melee-accuracy.md`: opening definition, situation/family states, grab/trade handling, cluster caveats
- [x] `docs/DEVELOPMENT.md`: new event table, version bump, backfill note
- [x] `CLAUDE.md`: module and command bullets
- [x] `README.md`: feature bullet
- [x] `CHANGELOG.md`: entry
- [x] Version **1.15.0** in `package.json` + both `package-lock.json` entries + version docs
- [x] `npm run verify:release`

#### 9. Verification

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run format:check`
- [x] `npm run verify:docs`
- [x] `npm run verify:release`
- [x] Fixture parse/CLI JSON spot-check: neutral gate counts, grab and trade cases
- [ ] `npm run backfill -- --limit 5` through Electron's Node, confirm rows + coverage — blocked here: better-sqlite3 is built for Node 26 (ABI 147), Electron 41 needs ABI 145; backfill engine verified under Node instead (stale game → v4, rows restored)
- [ ] Performance Lab and Library smoke test: filters and example navigation — not run (no app database/display in this environment); renderer bundle builds

---

## Feature 2: How I End My Combos — ender choice and post-hit decisions

**Status:** planned, not started.

### Why

MAGI persists own conversions (`last_move_id`, `did_kill`, `end_percent`, `move_count`) but has no parse-time record of the attacker's first post-hit decision, the victim's end state, or the outcome (extended, whiffed, punished, reset, edgeguarded). What the player does after landing a hit matters as much as how the combo starts.

### Definition (Melee-accurate)

- Unit = one **own conversion** (`ConversionRecord.attackerSlot === userSlot`), not a true-combo claim; conversions can span tech chases and ledge traps (`docs/hit-review.md`).
- **Anchor on the final connected hit** (`moves.at(-1).frame`), never `conversion.endFrame`: slippi-js ends a conversion only after the victim has been out of stun for 45 frames (or on stock loss), and on a kill `endFrame` is the stock-drop frame (`killEvidence.ts`). Using `endFrame` would miss early post-hit decisions.
- Ender = final move (`lastMoveId` / `moves.at(-1).moveId`), exact label and family. Grabs never appear as moves; pummel (52) and throws (53–56) can be enders.
- **Attacker first actionable frame** after the final hit: match the attacker's `AttackInstance` containing the final-hit frame and use `firstActionableFrame`; fall back to `resolveCommitmentEnd` (`frameEvents.ts`), then a bounded forward scan. Multihit/grab sequences can make the instance match ambiguous; document the fallback.
- **Post-hit decision window**: from the attacker's first actionable frame through +30 frames (same convention as shield punish-taken). Classify the first commitment:
  - `attack` / `special` / `grab` — attempted extension; record move, connected, on-shield, whiffed.
  - `reposition` — dash/run/jump/land/wait/drop.
  - `defend` — shield/spot dodge/roll.
  - `edgeguard` — victim offstage/ledging; link the victim's recovery span when one opens.
  - `none` — no commitment in the window.
- **Victim end state** from frame data at the final hit/escape: `dead | offstage | ledge | knockdown | airborne | onstage | unknown`. Recovery-span overlap is a coarse signal, not a direct field.
- Outcomes, all measured:
  - `killed` — conversion `didKill`, or stock death matched by the existing attribution rule.
  - `extended` — a new own conversion starts inside the window.
  - `whiffed` — post-hit attack instance never connected.
  - `punished` — an opponent conversion starts inside the window; record delay and opponent opener.
  - `reset` — victim escaped, no extension/whiff/punish.
  - `edgeguard-linked` — victim offstage and a recovery span overlaps the post-hit window.
- **Do not claim intent or techniques the data cannot establish**: no "dropped combo", "missed kill", or "overextension" as a mental-state claim. Display the measured sequence plus punished/whiffed flags. Squandered high-percent enders are shown as "ended at ≥100% without a stock", which is a fact.

### Data model and pipeline

New migration **v19** (coordinate with Feature 1's v18; if both land together, use one migration and one `FRAME_EVENTS_VERSION` bump). New `combo_ending_events` table persisted for both perspectives:

```
combo_ending_events(
  id, game_id, attacker_is_player,
  conversion_start_frame, last_hit_frame, conversion_end_frame,
  opener_move_id, ender_move_id, ender_label, ender_family,
  opening_type, move_count, damage, start_percent, end_percent, did_kill,
  victim_end_state, victim_end_x, victim_end_y, victim_end_percent,
  attacker_first_actionable_frame, frames_from_last_hit_to_actionable,
  post_hit_decision, post_hit_move_id, post_hit_move_label,
  post_hit_start_frame, post_hit_connected, post_hit_on_shield,
  extended, whiffed, punished, punish_delay, punish_opener_move_id,
  edgeguard_linked, victim_death_percent, death_frame
)
```

Indexes: `(game_id)`, `(game_id, attacker_is_player)`, `(attacker_is_player, ender_move_id)`, `(attacker_is_player, post_hit_decision, punished)`.

- New `src/pipeline/comboEndingEvents.ts`; consumes conversions, attack instances, frames, stocks, and recovery spans; reuses `isActionable`, `resolveCommitmentEnd`, `isOffstage`, `isOnLedge`, `isKnockdown`, `killEvidence`, and the punish-window conventions above.
- Add the type to `frameEvents.ts`, call it from `extractFrameEvents`, persist in `persistFrameEvents`, add to `deleteFrameEventRows`.
- A post-hit attack start can fall **inside** the conversion's tail (the 45-frame reset window), so the detector must not reuse `inConversionWindow` blindly; anchor on the last hit and first actionable frame.
- Bump `FRAME_EVENTS_VERSION` (to 5 if Feature 1 lands first) so backfill rewrites the new rows.

### Aggregation (rule-based; no clustering in v1)

`src/pipeline/comboEndings.ts`:

- Ender table by `enderLabel × percent band`: count, share, kill rate, average damage, average combo length, end-percent distribution.
- End-state distribution per ender: dead/offstage/ledge/knockdown/airborne/onstage.
- Post-hit decision × outcome matrix: counts and rates for `extended`, `whiffed`, `punished`, `reset`, `edgeguard-linked`; punish delay.
- "Cost after the hit": share punished, average damage taken in the post-hit window, and the opponent's most common punish opener.
- Squandered conversions: `end_percent >= 100 && !did_kill`, broken down by ender and end state (factual, not a missed-kill claim).
- Sample guards: `comboEnderMin` (5) and `comboDecisionMin` (10) in `EVENT_SAMPLE_GUARDS`; low-n rows marked, not hidden.

### Surfaces

1. Shared contract `src/comboEndings.ts`; `getComboEndings(filters)` in `src/db.ts`; `stats:comboEndings` IPC; preload/`global.d.ts`/`useComboEndings`.
2. **Characters** detail module `src/renderer/pages/characters/ComboEnders.tsx`, wired into `Characters.tsx` beside `PunishEconomy`/`DeathReport` (enders are character-specific). Ender table, end-state breakdown, post-hit outcome matrix, examples with `seekFrame`.
3. **Performance Lab** compact cross-character section: top enders, post-hit punish/whiff rates, high-percent non-kill endings.
4. **Coaching prompt**: `PatternData.comboEndings` (top enders, kill rates, post-hit punished/whiffed rates, squandered high-percent endings), formatter section, one instruction line ("compare ender choice and post-hit behavior; cite n-of evidence"), bump `COACHING_PROMPT_VERSION` to the next version.
5. **CLI**: `src/combo-endings-cli.ts` with `--target`, `--character`, `--opponent`, `--stage`, `--limit`, `--json`; npm script.
6. Library filter by ender/outcome: stretch, not v1.

### Tasks

- [ ] **Feature 2 complete** (tick when every section below is ticked)
- [x] Plan defined (this document)

#### 1. Detector

- [ ] Add `ComboEndingEvent` interface + `GameFrameEvents.comboEndings`
- [ ] Implement `extractComboEndingEvents` in `src/pipeline/comboEndingEvents.ts`
- [ ] Anchor on the final connected hit (`moves.at(-1).frame`), never `endFrame`
- [ ] Match the final hit to the attacker's `AttackInstance`; fall back to `resolveCommitmentEnd` + bounded scan
- [ ] Classify victim end state (`dead`, `offstage`, `ledge`, `knockdown`, `airborne`, `onstage`, `unknown`)
- [ ] Classify the first post-hit decision in the +30-frame window (`attack`, `special`, `grab`, `reposition`, `defend`, `edgeguard`, `none`)
- [ ] Record outcomes: `killed`, `extended`, `whiffed`, `punished`, `reset`, `edgeguard-linked`
- [ ] Link recovery spans for edgeguard outcomes; link stock deaths for kills
- [ ] Document multihit/grab instance-matching ambiguity and grab/throw enders
- [ ] Bump `FRAME_EVENTS_VERSION` (5 if Feature 1 lands first) with a version comment
- [ ] Call `extractComboEndingEvents` from `extractFrameEvents`
- [ ] Tests: extend after actionable, whiff after actionable, opponent punish, reset, edgeguard link, kill
- [ ] Tests: negatives for decisions during endlag, killed conversions, conversion tail inside the 45-frame window, no false punish before the actionable frame
- [ ] Test: ender/last-hit anchor differs from `endFrame`
- [ ] Test: `game1.slp` fixture well-formedness invariants

#### 2. Persistence and backfill

- [ ] Add `combo_ending_events` to `SCHEMA`
- [ ] Add migration v19 (or a combined migration if both features land together)
- [ ] Add `insertComboEndingEvents`
- [ ] Add the table to `deleteFrameEventRows`
- [ ] Persist both perspectives in `persistFrameEvents`
- [ ] Confirm plain backfill re-parses games at the new version and fills the table
- [ ] Tests: schema/migration/index/helper assertions in `tests/db.test.ts`
- [ ] Test: persist mapping for both perspectives

#### 3. Aggregation

- [ ] Ender table by `enderLabel × percent band` with count, share, kill rate, avg damage, avg length, end-percent spread
- [ ] Victim end-state distribution per ender
- [ ] Post-hit decision × outcome matrix with counts/rates and punish delay
- [ ] Cost after the hit: punish share, damage taken, most common opponent punish opener
- [ ] Squandered conversions (`end_percent >= 100 && !did_kill`) by ender + end state
- [ ] Add `comboEnderMin` + `comboDecisionMin` sample guards
- [ ] Tests: counts/rates/guards, no intent claims in labels

#### 4. Query, contract, and IPC

- [ ] Add shared contract `src/comboEndings.ts`
- [ ] Add `getComboEndings(filters)` in `src/db.ts`
- [ ] Register `stats:comboEndings` with `safeHandle`
- [ ] Expose in preload, type in `global.d.ts`, add `useComboEndings`
- [ ] Tests: perspective isolation, filters, coverage, version gating

#### 5. UI

- [ ] Characters detail module `ComboEnders.tsx` (ender table, end states, post-hit matrix, examples)
- [ ] Wire into `Characters.tsx` beside `PunishEconomy`/`DeathReport`
- [ ] Performance Lab compact cross-character section
- [ ] Example chips navigate to `/game/:id` with `seekFrame`
- [ ] Tests: no UI test harness required; verify build + smoke test

#### 6. Coaching prompt

- [ ] Add `PatternData.comboEndings`
- [ ] Fill in `patternsFromFrameEvents` and `mergePatternData`
- [ ] Aggregate in `getPatternData`
- [ ] Format a "How your combos end" section
- [ ] Add a prompt instruction line (compare enders and post-hit behavior; cite n-of evidence)
- [ ] Bump `COACHING_PROMPT_VERSION` to the next version
- [ ] Tests: formatter output, sample-guard suppression, updated fixtures

#### 7. CLI

- [ ] Add `src/combo-endings-cli.ts` (`--target`, `--character`, `--opponent`, `--stage`, `--limit`, `--json`)
- [ ] Print ender table, end states, post-hit matrix, squandered endings, examples
- [ ] Add npm script
- [ ] Document the command

#### 8. Docs and release

- [ ] `docs/melee-accuracy.md`: final-hit anchor, end-state/decision definitions, outcome semantics, grab/multihit caveats
- [ ] `docs/DEVELOPMENT.md`: new event table, version bump, backfill note
- [ ] `CLAUDE.md`: module and command bullets
- [ ] `README.md`: feature bullet
- [ ] `CHANGELOG.md`: entry
- [ ] Version **1.16.0** (or one combined release if both features land together) in `package.json` + both `package-lock.json` entries + version docs
- [ ] `npm run verify:release`

#### 9. Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run verify:docs`
- [ ] `npm run verify:release`
- [ ] Fixture/CLI JSON spot-check: ender anchor, end states, post-hit outcomes
- [ ] Backfill smoke test, confirm rows + coverage
- [ ] Characters and Performance Lab smoke test

---

## Stretch (unticked, not part of v1)

- [ ] Group consecutive own conversions while the victim stays in down/tech/ledge as a "pressure sequence"
- [ ] Statistical clustering of post-hit decision patterns
- [ ] Library filter by ender/outcome

---

## Shared accuracy guardrails

- **Pre-backfill coverage:** existing games have no rows until `FRAME_EVENTS_VERSION` bumps and backfill runs. Every UI surface must show `gamesWithOpenings / gamesInScope` and a backfill hint instead of implying zero openings.
- **`analyze:run` path:** persists no frame events (existing caveat); the coverage line covers this too.
- **Performance:** aggregation loads raw rows for the scoped games in the main process; cap the default/max game scope and keep only aggregated examples in the IPC payload.
- **Cluster instability:** adding or removing games changes clusters by design. Never persist cluster ids, never use them for filters, and label them exploratory.
- **Accuracy:** commitments/landing/shield openings are included but labeled so "neutral" never overclaims. Grabs are not described as throws. No named technique is inferred from a cluster.
- **One classifier:** rule classification lives in one TypeScript module used by detector-derived rows and aggregation. SQL only filters persisted columns; do not re-implement the classifier in SQL.
- **PatternData/frame-version churn:** update test fixtures. Bumping `FRAME_EVENTS_VERSION` means version-gated history (habit punished, death verdicts) temporarily only counts backfilled games, which is the established pattern.
- **Conversion-end anchor:** `conversion.endFrame` is a 45-frame-reset/stock-drop frame, not the last hit. Combo-ending detection must anchor on `moves.at(-1).frame`; an `endFrame` anchor would miss early follow-ups and misclassify outcomes.
- **Post-hit action ambiguity:** decisions during endlag are not choices; only the first commitment after the attacker's first actionable frame counts. Multihit/grab sequences and rolled-into-another-commitment cases can make the attack-instance match ambiguous; fall back explicitly and document it.
- **No intent claims:** "what I do after I hit" is measured as actions and outcomes, not intent. Never label a sequence "dropped combo", "missed kill", or "overextension" unless the data directly establishes the outcome; show the measured decision and punish/whiff flags instead.
- **Combined-release coordination:** if both features are implemented together, use one migration and one `FRAME_EVENTS_VERSION` bump; otherwise keep migrations sequential and bump the version once per feature.
