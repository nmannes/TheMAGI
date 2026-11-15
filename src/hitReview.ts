import { Frames } from "@slippi/slippi-js/node";

import { FPS, frameToTimestamp, moveIdToName } from "./pipeline/helpers.js";
import type {
  ConversionRecord,
  DeathVerdict,
  GameResult,
  PlayerSlot,
  PlayerSummary,
  StockRecord,
} from "./pipeline/types.js";

/**
 * Hit review: describe and clip the moments where the target player is the
 * victim. This deliberately does not use slippi-js conversion ranges as clip
 * bounds: MAGI conversions can span tech chases and ledge traps for many
 * seconds. Clips are built from the individual hit frames instead.
 */

export const HIT_REVIEW_PRE_ROLL_FRAMES = 90;
export const HIT_REVIEW_POST_ROLL_FRAMES = 90;
export const HIT_REVIEW_DEATH_POST_ROLL_FRAMES = 150;
/** Chronological review: 5 seconds of lead-in before an opening hit taken. */
export const HIT_REVIEW_EVENT_PRE_ROLL_FRAMES = 5 * FPS;
/** A landed conversion keeps rolling for 5 seconds after the player's last hit. */
export const HIT_REVIEW_EVENT_LANDED_POST_ROLL_FRAMES = 5 * FPS;
/** An opening hit taken shows the immediate response, then stops. */
export const HIT_REVIEW_EVENT_POST_ROLL_FRAMES = 2 * FPS;
/** Hits within this frame gap are treated as one sequence (0.75s at 60fps). */
export const HIT_REVIEW_MERGE_GAP_FRAMES = 45;
/** Hard cap for a clip, so a long conversion cannot produce a huge video. */
export const HIT_REVIEW_MAX_CLIP_FRAMES = 20 * FPS;
/** How long after the last hit a stock may end and still be attributed to it. */
const DEATH_LOOKAHEAD_FRAMES = 300;
/** MAGI matches a killing conversion to a stock within this many frames. */
const STOCK_MATCH_TOLERANCE_FRAMES = 10;
/** A death with no attributed hit gets a lookback this long before its end. */
const UNATTRIBUTED_DEATH_LOOKBACK_FRAMES = 180;
const UNATTRIBUTED_DEATH_POST_ROLL_FRAMES = 30;

export class HitReviewTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HitReviewTargetError";
  }
}

export interface HitReviewPlayer {
  slot: PlayerSlot;
  tag: string;
  connectCode: string;
  character: string;
}

export interface HitReviewMove {
  frame: number;
  moveId: number;
  moveName: string;
  damage: number;
}

export interface HitReviewDeath {
  stockNumber: number;
  endFrame: number;
  deathPercent: number | null;
  killerMoveId: number | null;
  killerMoveName: string | null;
  deathDirection: StockRecord["deathDirection"];
  verdict: DeathVerdict | null;
  /** Only set when measuredDI recorded the final-hit stick input. */
  diScore: number | null;
  resourceFault: boolean;
}

export type HitReviewKind = "hits" | "unattributed-death" | "opening-hit-taken" | "conversion-landed";

/**
 * The full conversion an event belongs to. The clip itself may show only the
 * opening hit (opening-hit-taken); this summary reports what the opponent got
 * from it without putting the follow-up hits in the video.
 */
export interface HitReviewConversionSummary {
  moveCount: number;
  damage: number;
  startPercent: number;
  endPercent: number;
  didKill: boolean;
}

export interface HitReviewSequence {
  kind: HitReviewKind;
  replayPath: string;
  gameNumber: number;
  startAt: string | null;
  stage: string;
  target: HitReviewPlayer;
  opponent: HitReviewPlayer;
  /** Frames to pass to the playback renderer. First hit is inside this range. */
  clipStartFrame: number;
  clipEndFrame: number;
  firstHitFrame: number;
  lastHitFrame: number;
  timestamp: string;
  startPercent: number;
  endPercent: number;
  damage: number;
  moveCount: number;
  hits: HitReviewMove[];
  openingTypes: string[];
  didKill: boolean;
  death: HitReviewDeath | null;
  /** Set for chronological review events; absent on the legacy hit sequences. */
  conversion?: HitReviewConversionSummary;
  /** Ranking score; deaths outrank nonlethal sequences of similar damage. */
  score: number;
}

/** A cursor point is a wall-clock instant plus a deterministic event identity. */
export interface HitReviewCursorPoint {
  atMs: number;
  key: string;
}

/**
 * Resolve a tag or connect code to the player's settings-order slot.
 * Accepts "pook", "POOK#392", or a bare "POOK" code prefix.
 */
export function findTargetSlot(
  players: readonly Pick<PlayerSummary, "tag" | "connectCode">[],
  target: string,
): PlayerSlot {
  const wanted = normalizeIdentity(target);
  if (!wanted) throw new HitReviewTargetError("Target player is empty");

  const aliases = new Set([wanted]);
  const hashIndex = wanted.indexOf("#");
  if (hashIndex > 0) aliases.add(wanted.slice(0, hashIndex));

  const matches: PlayerSlot[] = [];
  for (let slot = 0; slot < players.length && slot < 2; slot++) {
    const player = players[slot];
    if (!player) continue;
    const candidates = [normalizeIdentity(player.tag), normalizeIdentity(player.connectCode)];
    const codePrefix = normalizeIdentity(player.connectCode).split("#")[0] ?? "";
    if (codePrefix) candidates.push(codePrefix);
    if (candidates.some((candidate) => candidate !== "" && aliases.has(candidate))) {
      matches.push(slot as PlayerSlot);
    }
  }

  if (matches.length === 0) {
    const available = players.map((p) => `${p.tag || "?"} (${p.connectCode || "no code"})`).join(", ");
    throw new HitReviewTargetError(`Target player "${target}" not found. Players in this game: ${available}`);
  }
  if (matches.length > 1) {
    throw new HitReviewTargetError(`Target player "${target}" matches both slots; use a full connect code`);
  }
  return matches[0]!;
}

/** Extract every hit sequence where the target is the victim, chronologically. */
export function extractHitReview(result: GameResult, target: string, replayPath: string): HitReviewSequence[] {
  const targetSlot = findTargetSlot(result.gameSummary.players, target);
  const opponentSlot = (targetSlot === 0 ? 1 : 0) as PlayerSlot;
  const targetPlayer = result.gameSummary.players[targetSlot];
  const opponentPlayer = result.gameSummary.players[opponentSlot];
  if (!targetPlayer || !opponentPlayer) throw new Error("Game does not have two players");

  const targetInfo: HitReviewPlayer = playerInfo(targetPlayer, targetSlot);
  const opponentInfo: HitReviewPlayer = playerInfo(opponentPlayer, opponentSlot);
  const lastFrame = gameLastFrame(result);

  const hits = flattenHitsTaken(result.frameEvents.conversions, targetSlot);
  const groups = groupHits(hits, deathFrames(result.frameEvents.stocks, targetSlot));
  const sequences = groups.map((group) =>
    buildSequence(group, result, targetSlot, targetInfo, opponentInfo, replayPath, lastFrame),
  );

  const attributedStocks = new Set<number>();
  for (const sequence of sequences) {
    if (sequence.death) attributedStocks.add(sequence.death.stockNumber);
  }
  const unattributed = buildUnattributedDeaths(
    result,
    targetSlot,
    targetInfo,
    opponentInfo,
    replayPath,
    lastFrame,
    attributedStocks,
  );

  return [...sequences, ...unattributed].sort(
    (a, b) => a.firstHitFrame - b.firstHitFrame || a.clipStartFrame - b.clipStartFrame,
  );
}

/**
 * Extract the two chronological-review events:
 *   1. the FIRST hit of every opponent conversion where the target is the victim
 *   2. every target-owned conversion with at least two hits (a landed conversion)
 *
 * Follow-up hits in an opponent conversion are deliberately not separate
 * events. The opening-hit event shows 5 seconds before that first hit; the
 * landed-conversion event shows 5 seconds after the target's last hit.
 */
export function extractReviewEvents(result: GameResult, target: string, replayPath: string): HitReviewSequence[] {
  const targetSlot = findTargetSlot(result.gameSummary.players, target);
  const opponentSlot = (targetSlot === 0 ? 1 : 0) as PlayerSlot;
  const targetPlayer = result.gameSummary.players[targetSlot];
  const opponentPlayer = result.gameSummary.players[opponentSlot];
  if (!targetPlayer || !opponentPlayer) throw new Error("Game does not have two players");

  const targetInfo = playerInfo(targetPlayer, targetSlot);
  const opponentInfo = playerInfo(opponentPlayer, opponentSlot);
  const lastFrame = gameLastFrame(result);
  const events: HitReviewSequence[] = [];

  for (const conversion of result.frameEvents.conversions) {
    const hits = flattenConversion(conversion);
    const first = hits[0];
    const last = hits[hits.length - 1];
    if (!first || !last) continue;

    const summary = summarizeConversion(conversion, hits);

    if (conversion.attackerSlot === targetSlot) {
      // A landed conversion needs at least two connected hits. One-hit
      // conversions are already covered by the opening-hit ledger when the
      // target is the victim, but they are not a combo when the target landed it.
      if (hits.length < 2) continue;
      const deathStock = matchDeath(hits, result.frameEvents.stocks, opponentSlot);
      const death = deathStock ? toHitReviewDeath(deathStock) : null;
      const { startFrame, endFrame } = eventClipBounds(
        first.frame,
        last.frame,
        HIT_REVIEW_EVENT_LANDED_POST_ROLL_FRAMES,
        lastFrame,
      );
      events.push({
        kind: "conversion-landed",
        replayPath,
        gameNumber: result.gameSummary.gameNumber,
        startAt: result.startAt,
        stage: result.gameSummary.stage,
        target: targetInfo,
        opponent: opponentInfo,
        clipStartFrame: startFrame,
        clipEndFrame: endFrame,
        firstHitFrame: first.frame,
        lastHitFrame: last.frame,
        timestamp: frameToTimestamp(first.frame),
        startPercent: summary.startPercent,
        endPercent: summary.endPercent,
        damage: summary.damage,
        moveCount: hits.length,
        hits: hits.map(toHitReviewMove),
        openingTypes: conversion.openingType ? [conversion.openingType] : [],
        didKill: summary.didKill || death !== null,
        death,
        conversion: summary,
        score: scoreSequence(summary.damage, hits.length, death),
      });
      continue;
    }

    // Opponent conversion: clip only the first hit, not the follow-ups.
    const deathStock = matchDeath(hits, result.frameEvents.stocks, targetSlot);
    const death = deathStock ? toHitReviewDeath(deathStock) : null;
    const postRoll =
      hits.length === 1 && death !== null ? HIT_REVIEW_DEATH_POST_ROLL_FRAMES : HIT_REVIEW_EVENT_POST_ROLL_FRAMES;
    const { startFrame, endFrame } = eventClipBounds(first.frame, first.frame, postRoll, lastFrame);
    events.push({
      kind: "opening-hit-taken",
      replayPath,
      gameNumber: result.gameSummary.gameNumber,
      startAt: result.startAt,
      stage: result.gameSummary.stage,
      target: targetInfo,
      opponent: opponentInfo,
      clipStartFrame: startFrame,
      clipEndFrame: endFrame,
      firstHitFrame: first.frame,
      lastHitFrame: first.frame,
      timestamp: frameToTimestamp(first.frame),
      startPercent: round2(first.percentBefore),
      endPercent: round2(first.percentBefore + first.damage),
      damage: round2(first.damage),
      moveCount: 1,
      hits: [toHitReviewMove(first)],
      openingTypes: conversion.openingType ? [conversion.openingType] : [],
      didKill: summary.didKill || death !== null,
      death,
      conversion: summary,
      score: scoreSequence(first.damage, 1, death),
    });
  }

  return events.sort((a, b) => a.firstHitFrame - b.firstHitFrame || reviewEventKey(a).localeCompare(reviewEventKey(b)));
}

/** Wall-clock instant of an event, used by the persistent chronological cursor. */
export function reviewEventAtMs(sequence: HitReviewSequence, fallbackMtimeMs = 0): number {
  const parsed = sequence.startAt ? Date.parse(sequence.startAt) : Number.NaN;
  const base = Number.isFinite(parsed) ? parsed : fallbackMtimeMs;
  // Slippi writes metadata.startAt when the Game Start event is recorded, which
  // is the replay's first frame: -123 in Slippi's numbering (Dolphin's
  // GAME_FIRST_FRAME, slippi-js Frames.FIRST). Frame 0 is when the in-game
  // timer starts counting down, 123 frames later. Counting from frame 0 would
  // place every event 2.05 seconds late.
  return base + ((sequence.firstHitFrame - Frames.FIRST) / FPS) * 1000;
}

/** Deterministic tie-break when two events share the same wall-clock millisecond. */
export function reviewEventKey(sequence: HitReviewSequence): string {
  return `${sequence.kind}|${sequence.replayPath}|${sequence.firstHitFrame}|${sequence.lastHitFrame}`;
}

export function reviewEventPoint(sequence: HitReviewSequence, fallbackMtimeMs = 0): HitReviewCursorPoint {
  // Cursor files store whole milliseconds. Round here too, or an event whose
  // instant is 28.7833s would compare as later than its own saved 28.783s cursor
  // and repeat forever.
  return { atMs: Math.floor(reviewEventAtMs(sequence, fallbackMtimeMs)), key: reviewEventKey(sequence) };
}

/** True when an event comes strictly after the saved cursor in chronological order. */
export function isReviewEventAfterPoint(
  sequence: HitReviewSequence,
  cursor: HitReviewCursorPoint,
  fallbackMtimeMs = 0,
): boolean {
  const point = reviewEventPoint(sequence, fallbackMtimeMs);
  if (point.atMs !== cursor.atMs) return point.atMs > cursor.atMs;
  return point.key > cursor.key;
}

export function compareReviewEvents(a: HitReviewSequence, b: HitReviewSequence, fallbackMtimeMs = 0): number {
  const atDelta = reviewEventAtMs(a, fallbackMtimeMs) - reviewEventAtMs(b, fallbackMtimeMs);
  return atDelta !== 0 ? atDelta : reviewEventKey(a).localeCompare(reviewEventKey(b));
}

/**
 * Rank sequences and return the top `limit` (0 means no limit). The returned
 * list is in rank order; renderers can re-sort chronologically when sending.
 */
export function selectHitSequences(
  sequences: readonly HitReviewSequence[],
  options: { limit?: number; minDamage?: number; deathsOnly?: boolean } = {},
): HitReviewSequence[] {
  const filtered = sequences.filter((sequence) => {
    if (options.deathsOnly && !sequence.didKill) return false;
    if (options.minDamage !== undefined && sequence.damage < options.minDamage) return false;
    return true;
  });
  const ranked = [...filtered].sort(
    (a, b) => b.score - a.score || b.damage - a.damage || a.firstHitFrame - b.firstHitFrame,
  );
  const limit = options.limit ?? 5;
  return limit > 0 ? ranked.slice(0, limit) : ranked;
}

/** Sort selected sequences so a Telegram batch reads in game order. */
export function sortHitSequencesChronologically(sequences: readonly HitReviewSequence[]): HitReviewSequence[] {
  return [...sequences].sort(
    (a, b) =>
      (a.startAt ?? "").localeCompare(b.startAt ?? "") ||
      a.replayPath.localeCompare(b.replayPath) ||
      a.firstHitFrame - b.firstHitFrame,
  );
}

const OPENING_TYPE_LABELS: Record<string, string> = {
  "neutral-win": "won neutral",
  "counter-attack": "counter-attack",
  trade: "trade",
};

const DI_VERDICT_LABELS: Partial<Record<DeathVerdict, string>> = {
  NO_DI: "no DI",
  WRONG_DI: "wrong DI",
  OK_DI: "OK DI",
  GOOD_DI: "good DI",
};

/**
 * Plain-text Telegram caption. Keep it under Telegram's 1024-character video
 * caption limit. We do not use parse_mode: move names and tags can contain
 * characters that would otherwise need escaping.
 */
export function formatHitReviewCaption(sequence: HitReviewSequence): string {
  if (sequence.kind === "opening-hit-taken" || sequence.kind === "conversion-landed") {
    return formatChronologicalCaption(sequence);
  }

  const lines: string[] = [];
  const hitWord = sequence.moveCount === 1 ? "hit" : "hits";

  if (sequence.kind === "unattributed-death") {
    lines.push("💀 Stock lost — no hit attributed");
  } else if (sequence.didKill) {
    lines.push(`💀 Stock lost — ${formatPercent(sequence.damage)}% taken in ${sequence.moveCount} ${hitWord}`);
  } else {
    lines.push(`🟥 Got hit — ${formatPercent(sequence.damage)}% taken in ${sequence.moveCount} ${hitWord}`);
  }

  lines.push(
    `${sequence.target.tag || "You"} (${sequence.target.character}) vs ` +
      `${sequence.opponent.tag || "Opponent"} (${sequence.opponent.character}) · ${sequence.stage}`,
  );

  const opening = sequence.openingTypes.map((type) => OPENING_TYPE_LABELS[type] ?? type).join(", ");
  lines.push(`${sequence.timestamp}${opening ? ` · ${opening}` : ""}`);

  if (sequence.hits.length > 0) {
    const moveList = sequence.hits.map((hit) => hit.moveName).join(" → ");
    lines.push(
      `${formatPercent(sequence.startPercent)} → ${formatPercent(sequence.endPercent)} · ${truncate(moveList, 400)}`,
    );
  } else {
    lines.push(`${formatPercent(sequence.startPercent)} → ${formatPercent(sequence.endPercent)}`);
  }

  if (sequence.death) {
    const death = sequence.death;
    const percent = death.deathPercent === null ? "" : ` at ${formatPercent(death.deathPercent)}`;
    const killer = death.killerMoveName ? ` · killed by ${death.killerMoveName}` : "";
    lines.push(`Stock ${death.stockNumber}${percent}${killer}`);

    const diLabel = death.verdict ? DI_VERDICT_LABELS[death.verdict] : undefined;
    if (death.diScore !== null && diLabel) {
      lines.push(`DI: ${diLabel} (${death.diScore.toFixed(2)})`);
    } else if (death.killerMoveId !== null) {
      lines.push("DI: not measured for this hit");
    }
    if (death.resourceFault) {
      lines.push("Offstage at death with double jump unspent");
    }
  }

  if (sequence.startAt) {
    const date = sequence.startAt.slice(0, 10);
    if (date) lines.push(date);
  }

  return truncate(lines.join("\n"), 1024);
}

function formatChronologicalCaption(sequence: HitReviewSequence): string {
  const lines: string[] = [];
  const hitWord = sequence.moveCount === 1 ? "hit" : "hits";
  const first = sequence.hits[0];
  const move = first?.moveName ?? "hit";

  if (sequence.kind === "opening-hit-taken") {
    lines.push(`${sequence.didKill ? "💀" : "🟥"} Opening hit taken — ${move} (${formatPercent(sequence.damage)})`);
  } else {
    const stock = sequence.didKill ? " · took a stock" : "";
    lines.push(`🟩 Conversion landed — ${formatPercent(sequence.damage)} in ${sequence.moveCount} ${hitWord}${stock}`);
  }

  lines.push(
    `${sequence.target.tag || "You"} (${sequence.target.character}) vs ` +
      `${sequence.opponent.tag || "Opponent"} (${sequence.opponent.character}) · ${sequence.stage}`,
  );

  const opening = sequence.openingTypes.map((type) => OPENING_TYPE_LABELS[type] ?? type).join(", ");
  lines.push(`${sequence.timestamp}${opening ? ` · ${opening}` : ""}`);

  if (sequence.kind === "opening-hit-taken") {
    lines.push(`Opening: ${formatPercent(sequence.startPercent)} → ${formatPercent(sequence.endPercent)} · ${move}`);
    const conversion = sequence.conversion;
    if (conversion && conversion.moveCount > 1) {
      const result = conversion.didKill ? " · took a stock" : "";
      lines.push(
        `Conversion: ${conversion.moveCount} hits, ${formatPercent(conversion.startPercent)} → ` +
          `${formatPercent(conversion.endPercent)}${result}`,
      );
    }
  } else {
    const moveList = sequence.hits.map((hit) => hit.moveName).join(" → ");
    lines.push(
      `${formatPercent(sequence.startPercent)} → ${formatPercent(sequence.endPercent)} · ${truncate(moveList, 400)}`,
    );
  }

  if (sequence.death) appendDeathDetails(lines, sequence.death);
  if (sequence.startAt) {
    const date = sequence.startAt.slice(0, 10);
    if (date) lines.push(date);
  }
  return truncate(lines.join("\n"), 1024);
}

function appendDeathDetails(lines: string[], death: HitReviewDeath): void {
  const percent = death.deathPercent === null ? "" : ` at ${formatPercent(death.deathPercent)}`;
  const killer = death.killerMoveName ? ` · killed by ${death.killerMoveName}` : "";
  lines.push(`Stock ${death.stockNumber}${percent}${killer}`);

  const diLabel = death.verdict ? DI_VERDICT_LABELS[death.verdict] : undefined;
  if (death.diScore !== null && diLabel) {
    lines.push(`DI: ${diLabel} (${death.diScore.toFixed(2)})`);
  } else if (death.killerMoveId !== null) {
    lines.push("DI: not measured for this hit");
  }
  if (death.resourceFault) {
    lines.push("Offstage at death with double jump unspent");
  }
}

// ── Internals ─────────────────────────────────────────────────────────

interface FlatHit {
  frame: number;
  moveId: number;
  damage: number;
  percentBefore: number;
  conversion: ConversionRecord;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function playerInfo(player: PlayerSummary, slot: PlayerSlot): HitReviewPlayer {
  return {
    slot,
    tag: player.tag,
    connectCode: player.connectCode,
    character: player.character,
  };
}

function moveName(moveId: number): string {
  return moveIdToName[moveId] ?? `move ${moveId}`;
}

function gameLastFrame(result: GameResult): number {
  // duration is framesToSeconds(lastFrame - FIRST_PLAYABLE), rounded to 2dp.
  // Flooring the product can only undershoot, which keeps the render request
  // inside the replay instead of waiting for a frame that never arrives.
  return Frames.FIRST_PLAYABLE + Math.floor(result.gameSummary.duration * FPS);
}

function flattenConversion(conversion: ConversionRecord): FlatHit[] {
  const moves = [...conversion.moves].sort((a, b) => a.frame - b.frame);
  let percent = conversion.startPercent;
  return moves.map((move) => {
    const hit: FlatHit = {
      frame: move.frame,
      moveId: move.moveId,
      damage: move.damage,
      percentBefore: percent,
      conversion,
    };
    percent += move.damage;
    return hit;
  });
}

function flattenHitsTaken(conversions: readonly ConversionRecord[], targetSlot: PlayerSlot): FlatHit[] {
  const hits: FlatHit[] = [];
  for (const conversion of conversions) {
    // conversion.attackerSlot is the player who landed it; the victim is the
    // other slot. Hits where the target is the attacker are not hits taken.
    if (conversion.attackerSlot === targetSlot) continue;
    hits.push(...flattenConversion(conversion));
  }
  hits.sort((a, b) => a.frame - b.frame);
  return hits;
}

function summarizeConversion(conversion: ConversionRecord, hits: readonly FlatHit[]): HitReviewConversionSummary {
  // The parser's conversion totals are authoritative. They can exceed the sum
  // of the listed move damages (the move list is evidence, not a ledger), and
  // the measured end percent can include percent the hit list does not itemize.
  return {
    moveCount: hits.length,
    damage: round2(conversion.damage),
    startPercent: round2(conversion.startPercent),
    endPercent: round2(conversion.endPercent),
    didKill: conversion.didKill,
  };
}

function toHitReviewMove(hit: FlatHit): HitReviewMove {
  return {
    frame: hit.frame,
    moveId: hit.moveId,
    moveName: moveName(hit.moveId),
    damage: hit.damage,
  };
}

function deathFrames(stocks: readonly StockRecord[], targetSlot: PlayerSlot): number[] {
  return stocks
    .filter((stock) => stock.victimSlot === targetSlot && stock.died && stock.endFrame !== null)
    .map((stock) => stock.endFrame!)
    .sort((a, b) => a - b);
}

function groupHits(hits: readonly FlatHit[], targetDeathFrames: readonly number[]): FlatHit[][] {
  const groups: FlatHit[][] = [];
  let current: FlatHit[] = [];

  for (const hit of hits) {
    const previous = current[current.length - 1];
    const crossedDeath =
      previous !== undefined &&
      targetDeathFrames.some((deathFrame) => deathFrame > previous.frame && deathFrame < hit.frame);

    if (previous !== undefined && hit.frame - previous.frame <= HIT_REVIEW_MERGE_GAP_FRAMES && !crossedDeath) {
      current.push(hit);
    } else {
      if (current.length > 0) groups.push(current);
      current = [hit];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildSequence(
  group: FlatHit[],
  result: GameResult,
  targetSlot: PlayerSlot,
  target: HitReviewPlayer,
  opponent: HitReviewPlayer,
  replayPath: string,
  lastFrame: number,
): HitReviewSequence {
  const first = group[0];
  const last = group[group.length - 1];
  if (!first || !last) throw new Error("Cannot build a hit sequence from an empty group");

  const deathStock = matchDeath(group, result.frameEvents.stocks, targetSlot);
  const death = deathStock ? toHitReviewDeath(deathStock) : null;
  const { startFrame, endFrame } = clipBounds(first.frame, last.frame, death !== null, lastFrame);
  const damage = round2(group.reduce((total, hit) => total + hit.damage, 0));
  const moves: HitReviewMove[] = group.map((hit) => ({
    frame: hit.frame,
    moveId: hit.moveId,
    moveName: moveName(hit.moveId),
    damage: hit.damage,
  }));

  return {
    kind: "hits",
    replayPath,
    gameNumber: result.gameSummary.gameNumber,
    startAt: result.startAt,
    stage: result.gameSummary.stage,
    target,
    opponent,
    clipStartFrame: startFrame,
    clipEndFrame: endFrame,
    firstHitFrame: first.frame,
    lastHitFrame: last.frame,
    timestamp: frameToTimestamp(first.frame),
    startPercent: round2(first.percentBefore),
    endPercent: round2(last.percentBefore + last.damage),
    damage,
    moveCount: group.length,
    hits: moves,
    openingTypes: [...new Set(group.map((hit) => hit.conversion.openingType).filter((type) => type.length > 0))],
    didKill: death !== null,
    death,
    score: scoreSequence(damage, group.length, death),
  };
}

/**
 * Associate a hit group with the stock it took. A conversion marked didKill
 * whose final move is in this group is the strongest evidence; the fallback
 * requires the stock's recorded killing move to be this group's last hit.
 */
function matchDeath(
  group: readonly FlatHit[],
  stocks: readonly StockRecord[],
  targetSlot: PlayerSlot,
): StockRecord | null {
  const lastHit = group[group.length - 1];
  if (!lastHit) return null;
  const targetStocks = stocks.filter(
    (stock) => stock.victimSlot === targetSlot && stock.died && stock.endFrame !== null,
  );

  const killingConversions = [...new Set(group.map((hit) => hit.conversion))].filter(
    (conversion) => conversion.didKill,
  );
  for (const conversion of killingConversions) {
    const finalMove = conversion.moves[conversion.moves.length - 1];
    if (!finalMove) continue;
    const finalMoveIsHere = group.some(
      (hit) => hit.conversion === conversion && hit.frame === finalMove.frame && hit.moveId === finalMove.moveId,
    );
    if (!finalMoveIsHere) continue;

    const directMatch = targetStocks.find((stock) => {
      if (conversion.endFrame !== null && stock.endFrame !== null) {
        return Math.abs(stock.endFrame - conversion.endFrame) <= STOCK_MATCH_TOLERANCE_FRAMES;
      }
      const killerMoveId = conversion.lastMoveId ?? finalMove.moveId;
      return stock.killerMoveId !== null && stock.killerMoveId === killerMoveId;
    });
    if (directMatch) return directMatch;
  }

  const fallback = targetStocks
    .filter(
      (stock) =>
        stock.killerMoveId !== null &&
        stock.killerMoveId === lastHit.moveId &&
        stock.endFrame !== null &&
        stock.endFrame >= lastHit.frame &&
        stock.endFrame - lastHit.frame <= DEATH_LOOKAHEAD_FRAMES,
    )
    .sort((a, b) => (a.endFrame ?? 0) - (b.endFrame ?? 0))[0];
  return fallback ?? null;
}

function toHitReviewDeath(stock: StockRecord): HitReviewDeath {
  return {
    stockNumber: stock.stockNumber,
    endFrame: stock.endFrame ?? 0,
    deathPercent: stock.deathPercent,
    killerMoveId: stock.killerMoveId,
    killerMoveName: stock.killerMoveId === null ? null : moveName(stock.killerMoveId),
    deathDirection: stock.deathDirection,
    verdict: stock.verdict,
    diScore: stock.diScore,
    resourceFault: stock.resourceFault,
  };
}

function buildUnattributedDeaths(
  result: GameResult,
  targetSlot: PlayerSlot,
  target: HitReviewPlayer,
  opponent: HitReviewPlayer,
  replayPath: string,
  lastFrame: number,
  attributedStocks: ReadonlySet<number>,
): HitReviewSequence[] {
  const sequences: HitReviewSequence[] = [];
  for (const stock of result.frameEvents.stocks) {
    if (stock.victimSlot !== targetSlot || !stock.died || stock.endFrame === null) continue;
    if (attributedStocks.has(stock.stockNumber)) continue;

    const center = stock.finalHitFrame ?? stock.endFrame;
    const startFrame = Math.max(0, center - UNATTRIBUTED_DEATH_LOOKBACK_FRAMES);
    const endFrame = Math.max(center + 1, Math.min(stock.endFrame + UNATTRIBUTED_DEATH_POST_ROLL_FRAMES, lastFrame));

    sequences.push({
      kind: "unattributed-death",
      replayPath,
      gameNumber: result.gameSummary.gameNumber,
      startAt: result.startAt,
      stage: result.gameSummary.stage,
      target,
      opponent,
      clipStartFrame: startFrame,
      clipEndFrame: endFrame,
      firstHitFrame: center,
      lastHitFrame: center,
      timestamp: frameToTimestamp(center),
      startPercent: round2(stock.startPercent),
      endPercent: round2(stock.deathPercent ?? stock.startPercent),
      damage: 0,
      moveCount: 0,
      hits: [],
      openingTypes: [],
      didKill: true,
      death: toHitReviewDeath(stock),
      score: 70,
    });
  }
  return sequences;
}

function clipBounds(
  firstHitFrame: number,
  lastHitFrame: number,
  isDeath: boolean,
  replayLastFrame: number,
): { startFrame: number; endFrame: number } {
  const postRoll = isDeath ? HIT_REVIEW_DEATH_POST_ROLL_FRAMES : HIT_REVIEW_POST_ROLL_FRAMES;
  return boundedClip(firstHitFrame, lastHitFrame, postRoll, HIT_REVIEW_PRE_ROLL_FRAMES, replayLastFrame);
}

function eventClipBounds(
  firstHitFrame: number,
  lastHitFrame: number,
  postRoll: number,
  replayLastFrame: number,
): { startFrame: number; endFrame: number } {
  return boundedClip(firstHitFrame, lastHitFrame, postRoll, HIT_REVIEW_EVENT_PRE_ROLL_FRAMES, replayLastFrame);
}

function boundedClip(
  firstHitFrame: number,
  lastHitFrame: number,
  postRoll: number,
  preRoll: number,
  replayLastFrame: number,
): { startFrame: number; endFrame: number } {
  const computedEnd = lastHitFrame + postRoll;
  const endFrame = Math.max(firstHitFrame + 1, Math.min(computedEnd, replayLastFrame));
  let startFrame = Math.max(0, firstHitFrame - preRoll);
  if (endFrame - startFrame > HIT_REVIEW_MAX_CLIP_FRAMES) {
    startFrame = Math.max(0, endFrame - HIT_REVIEW_MAX_CLIP_FRAMES);
  }
  return { startFrame, endFrame };
}

function scoreSequence(damage: number, moveCount: number, death: HitReviewDeath | null): number {
  const deathBonus = death ? 100 : 0;
  const badDIBonus =
    death !== null && death.diScore !== null && (death.verdict === "NO_DI" || death.verdict === "WRONG_DI") ? 15 : 0;
  return round2(damage + moveCount * 4 + deathBonus + badDIBonus);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
