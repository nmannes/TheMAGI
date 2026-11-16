// ── Opening grouping: rule buckets + conversion-sequence clusters ────────────
//
// Two parallel, independent views of the opening ledger:
//  1. Rule buckets (authoritative, stable): situation × opener family × exact
//     move. Every row is explainable from persisted fields.
//  2. Conversion-sequence clusters (exploratory, descriptive): openings grouped by
//     the ordered damaging moves of the opponent conversion the opening
//     started, within each opponent character. Exact sequences seen at least
//     EVENT_SAMPLE_GUARDS.openingsBucketMin times are their own cluster; rarer
//     continuations are collected under their first move ("down b · …") with
//     the number of distinct continuations, so nothing is hidden and no group
//     mixes different openers. Cluster ids are recomputed per query, never
//     persisted, and never used for filters or coaching prompts. Labels list
//     observed move names only — never a named technique. A slippi-js
//     conversion can continue through resets and tech chases, so a sequence is
//     recorded hit order, not a verified true combo.
//
// A cluster describes the measured move sequence of the punish, not evidence
// that the player was doing anything in particular.

import { frameToTimestamp, moveIdToName, ratio } from "./helpers.js";
import type { OpeningEvent } from "./frameEvents.js";
import { EVENT_SAMPLE_GUARDS, OPENING_FAMILY_ORDER, OPENING_SITUATION_ORDER } from "../characterEventProfile.js";
import { OPENING_PERCENT_BANDS, type OpeningPercentBand } from "../openingPercentBands.js";

export { OPENING_FAMILY_ORDER, OPENING_SITUATION_ORDER };
export { OPENING_PERCENT_BANDS, openingPercentBand } from "../openingPercentBands.js";
export type { OpeningPercentBand, OpeningPercentBandKey } from "../openingPercentBands.js";

const EXAMPLE_LIMIT = 3;
const UNKNOWN_OPPONENT = "Unknown opponent";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Linear-interpolated quantile (q in [0, 1]); 0 for an empty sample. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function share(part: number, total: number): number {
  return total === 0 ? 0 : ratio(part, total);
}

function byDisplayOrder(order: readonly string[], value: string): number {
  const idx = order.indexOf(value);
  return idx === -1 ? order.length : idx;
}

function compareLabels(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface OpeningExample {
  gameId: number | null;
  startFrame: number;
  /** In-game timestamp like "1:23". */
  timestamp: string;
  situation: string;
  openerFamily: string;
  openerLabel: string;
  victimPercent: number;
  damage: number;
  didKill: boolean;
}

export interface OpeningCountKills {
  count: number;
  kills: number;
  killRate: number;
}

export interface OpeningBucket {
  situation: string;
  openerFamily: string;
  openerLabel: string;
  count: number;
  /** Share of all openings in the filtered set. */
  share: number;
  kills: number;
  killRate: number;
  avgDamage: number;
  /** Average damaging hits after the opening (moveCount - 1, floored at 0). */
  avgFollowUpHits: number;
  corneredShare: number;
  onPlatformShare: number;
  /** Distinct game ids when the rows came from the DB; 0 for in-memory events. */
  distinctGames: number;
  splits: {
    percentBands: OpeningPercentBand[];
    cornered: OpeningCountKills;
    onPlatform: OpeningCountKills;
  };
  examples: OpeningExample[];
}

export interface OpeningGroupAgg {
  key: string;
  count: number;
  share: number;
  kills: number;
  killRate: number;
}

export interface OpeningBaseline {
  total: number;
  kills: number;
  killRate: number;
  avgDamage: number;
  avgMoveCount: number;
  avgPercent: number;
  corneredShare: number;
  onPlatformShare: number;
  situations: OpeningGroupAgg[];
  families: OpeningGroupAgg[];
  percentBands: OpeningPercentBand[];
}

export function openingExample(e: OpeningEvent): OpeningExample {
  return {
    gameId: e.gameId ?? null,
    startFrame: e.startFrame,
    timestamp: frameToTimestamp(e.startFrame),
    situation: e.situation,
    openerFamily: e.openerFamily,
    openerLabel: e.openerLabel,
    victimPercent: e.victimPercent,
    damage: e.damage,
    didKill: e.didKill,
  };
}

/** Newest-first, so example chips point at the most recent teachable moment. */
function exampleOrder(a: OpeningEvent, b: OpeningEvent): number {
  const ag = a.gameId ?? -1;
  const bg = b.gameId ?? -1;
  if (ag !== bg) return bg - ag;
  if (a.startFrame !== b.startFrame) return b.startFrame - a.startFrame;
  return a.victimSlot - b.victimSlot;
}

function countKills(events: OpeningEvent[]): OpeningCountKills {
  const kills = events.filter((e) => e.didKill).length;
  return { count: events.length, kills, killRate: share(kills, events.length) };
}

function percentBands(events: OpeningEvent[]): OpeningPercentBand[] {
  return OPENING_PERCENT_BANDS.map((band) => {
    const inBand = events.filter(
      (e) => e.victimPercent >= band.min && (band.max == null || e.victimPercent < band.max),
    );
    const kills = inBand.filter((e) => e.didKill).length;
    return { key: band.key, label: band.label, count: inBand.length, kills, killRate: share(kills, inBand.length) };
  });
}

function groupAgg(key: string, events: OpeningEvent[], total: number): OpeningGroupAgg {
  const kills = events.filter((e) => e.didKill).length;
  return {
    key,
    count: events.length,
    share: share(events.length, total),
    kills,
    killRate: share(kills, events.length),
  };
}

function buildBucket(events: OpeningEvent[], total: number): OpeningBucket {
  const [first] = events;
  const kills = events.filter((e) => e.didKill).length;
  const gameIds = new Set<number>();
  for (const e of events) if (e.gameId != null) gameIds.add(e.gameId);
  return {
    situation: first!.situation,
    openerFamily: first!.openerFamily,
    openerLabel: first!.openerLabel,
    count: events.length,
    share: share(events.length, total),
    kills,
    killRate: share(kills, events.length),
    avgDamage: round2(mean(events.map((e) => e.damage))),
    avgFollowUpHits: round2(mean(events.map((e) => Math.max(0, e.moveCount - 1)))),
    corneredShare: share(events.filter((e) => e.cornered).length, events.length),
    onPlatformShare: share(events.filter((e) => e.onPlatform).length, events.length),
    distinctGames: gameIds.size,
    splits: {
      percentBands: percentBands(events),
      cornered: countKills(events.filter((e) => e.cornered)),
      onPlatform: countKills(events.filter((e) => e.onPlatform)),
    },
    examples: [...events].sort(exampleOrder).slice(0, EXAMPLE_LIMIT).map(openingExample),
  };
}

/**
 * Group openings by situation × opener family × exact move. Low-n buckets are
 * returned, never hidden; consumers dim them using
 * EVENT_SAMPLE_GUARDS.openingsBucketMin.
 */
export function aggregateOpeningBuckets(events: OpeningEvent[]): OpeningBucket[] {
  const groups = new Map<string, OpeningEvent[]>();
  for (const e of events) {
    const key = `${e.situation}\u0000${e.openerFamily}\u0000${e.openerLabel}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const total = events.length;
  return [...groups.values()]
    .map((group) => buildBucket(group, total))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.kills !== a.kills) return b.kills - a.kills;
      const s =
        byDisplayOrder(OPENING_SITUATION_ORDER, a.situation) - byDisplayOrder(OPENING_SITUATION_ORDER, b.situation);
      if (s !== 0) return s;
      const f =
        byDisplayOrder(OPENING_FAMILY_ORDER, a.openerFamily) - byDisplayOrder(OPENING_FAMILY_ORDER, b.openerFamily);
      if (f !== 0) return f;
      return compareLabels(a.openerLabel, b.openerLabel);
    });
}

/** Re-sort already-aggregated buckets; "kills" is a raw count, not a composite score. */
export function sortOpeningBuckets(buckets: OpeningBucket[], by: "count" | "kills"): OpeningBucket[] {
  return [...buckets].sort((a, b) => {
    if (by === "kills" && b.kills !== a.kills) return b.kills - a.kills;
    if (b.count !== a.count) return b.count - a.count;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return compareLabels(a.openerLabel, b.openerLabel);
  });
}

export function summarizeOpenings(events: OpeningEvent[]): OpeningBaseline {
  const total = events.length;
  const kills = events.filter((e) => e.didKill).length;

  const groupBy = (keyOf: (e: OpeningEvent) => string, order: readonly string[]): OpeningGroupAgg[] => {
    const groups = new Map<string, OpeningEvent[]>();
    for (const e of events) {
      const key = keyOf(e);
      const list = groups.get(key);
      if (list) list.push(e);
      else groups.set(key, [e]);
    }
    return [...groups.entries()]
      .map(([key, group]) => groupAgg(key, group, total))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return byDisplayOrder(order, a.key) - byDisplayOrder(order, b.key);
      });
  };

  return {
    total,
    kills,
    killRate: share(kills, total),
    avgDamage: round2(mean(events.map((e) => e.damage))),
    avgMoveCount: round2(mean(events.map((e) => e.moveCount))),
    avgPercent: round2(mean(events.map((e) => e.victimPercent))),
    corneredShare: share(events.filter((e) => e.cornered).length, total),
    onPlatformShare: share(events.filter((e) => e.onPlatform).length, total),
    situations: groupBy((e) => e.situation, OPENING_SITUATION_ORDER),
    families: groupBy((e) => e.openerFamily, OPENING_FAMILY_ORDER),
    percentBands: percentBands(events),
  };
}

// ── Conversion-sequence clusters ────────────────────────────────────────────

export type OpeningSequenceKind = "exact" | "tail";

export interface OpeningSequenceCluster {
  /** 1-based display id, unique across opponent groups; recomputed per query. */
  id: number;
  opponentCharacter: string;
  /** "exact": one observed sequence. "tail": rarer continuations under one first move. */
  kind: OpeningSequenceKind;
  /** The exact move sequence, or the shared first move for a tail cluster. */
  sequence: string[];
  /** "dair · dair · nair" for exact, "down b · …" for tail. */
  label: string;
  size: number;
  /** Share of this opponent group's openings that have a recorded move list. */
  share: number;
  kills: number;
  killRate: number;
  avgDamage: number;
  avgMoveCount: number;
  /** Pre-hit victim percent: mean, median and the middle 50% (p25–p75). */
  percentMean: number;
  percentMedian: number;
  percentP25: number;
  percentP75: number;
  /** Pre-hit victim-percent distribution; counts partition the cluster. */
  percentBands: OpeningPercentBand[];
  corneredShare: number;
  onPlatformShare: number;
  distinctGames: number;
  dominantSituation: string;
  dominantFamily: string;
  /** Distinct full sequences covered; 1 for an exact cluster. */
  variants: number;
  examples: OpeningExample[];
}

export interface OpeningOpponentSequenceGroup {
  opponentCharacter: string;
  /** Openings against this opponent in the scope. */
  n: number;
  /** Openings with a recorded conversion move list. Clusters partition these. */
  withSequence: number;
  /** Openings whose conversion move list was unavailable; excluded from clusters. */
  withoutSequence: number;
  /** Below EVENT_SAMPLE_GUARDS.openingsTotalMin: descriptive only. */
  lowSample: boolean;
  clusters: OpeningSequenceCluster[];
}

export type OpeningSequenceClusterResult =
  | { status: "insufficient-sample"; reason: "n-below-25"; n: number; required: number }
  | { status: "insufficient-sample"; reason: "no-sequences"; n: number }
  | { status: "ok"; groups: OpeningOpponentSequenceGroup[] };

/** Parser move name; unmapped ids keep their id instead of guessing a technique. */
function moveLabel(moveId: number): string {
  return moveIdToName[moveId] ?? `move #${moveId}`;
}

/**
 * Ordered move labels for the full conversion an opening started. The first
 * label keeps the opening ledger's grab/projectile notation; later labels use
 * the parser's move names. Returns null when the move list was not recorded,
 * so callers can report the missing evidence instead of inventing a sequence.
 */
export function openingSequenceLabels(event: OpeningEvent): string[] | null {
  if (!event.moveIds || event.moveIds.length === 0) return null;
  return event.moveIds.map((moveId, index) => {
    if (index === 0 && (event.grab || event.openerFamily === "projectile")) return event.openerLabel;
    return moveLabel(moveId);
  });
}

function dominantKey(values: string[], order: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = "";
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
      continue;
    }
    if (count === bestCount) {
      const cmp = byDisplayOrder(order, value) - byDisplayOrder(order, best) || compareLabels(value, best);
      if (cmp < 0) best = value;
    }
  }
  return best;
}

interface SequenceClusterInput {
  opponentCharacter: string;
  kind: OpeningSequenceKind;
  sequence: string[];
  events: OpeningEvent[];
  variants: number;
  /** Openings in the opponent group with a recorded move list (share denominator). */
  shareOf: number;
}

function buildSequenceCluster(input: SequenceClusterInput): Omit<OpeningSequenceCluster, "id"> {
  const { events } = input;
  const kills = events.filter((e) => e.didKill).length;
  const gameIds = new Set<number>();
  for (const e of events) if (e.gameId != null) gameIds.add(e.gameId);
  return {
    opponentCharacter: input.opponentCharacter,
    kind: input.kind,
    sequence: input.sequence,
    label: input.kind === "exact" ? input.sequence.join(" · ") : `${input.sequence[0]} · …`,
    size: events.length,
    share: share(events.length, input.shareOf),
    kills,
    killRate: share(kills, events.length),
    avgDamage: round2(mean(events.map((e) => e.damage))),
    avgMoveCount: round2(mean(events.map((e) => e.moveCount))),
    percentMean: round2(mean(events.map((e) => e.victimPercent))),
    percentMedian: round2(median(events.map((e) => e.victimPercent))),
    percentP25: round2(
      quantile(
        events.map((e) => e.victimPercent),
        0.25,
      ),
    ),
    percentP75: round2(
      quantile(
        events.map((e) => e.victimPercent),
        0.75,
      ),
    ),
    percentBands: percentBands(events),
    corneredShare: share(events.filter((e) => e.cornered).length, events.length),
    onPlatformShare: share(events.filter((e) => e.onPlatform).length, events.length),
    distinctGames: gameIds.size,
    dominantSituation: dominantKey(
      events.map((e) => e.situation),
      OPENING_SITUATION_ORDER,
    ),
    dominantFamily: dominantKey(
      events.map((e) => e.openerFamily),
      OPENING_FAMILY_ORDER,
    ),
    variants: input.variants,
    examples: [...events].sort(exampleOrder).slice(0, EXAMPLE_LIMIT).map(openingExample),
  };
}

function compareSequenceClusters(a: Omit<OpeningSequenceCluster, "id">, b: Omit<OpeningSequenceCluster, "id">): number {
  if (b.size !== a.size) return b.size - a.size;
  const kindRank = (kind: OpeningSequenceKind): number => (kind === "exact" ? 0 : 1);
  if (kindRank(a.kind) !== kindRank(b.kind)) return kindRank(a.kind) - kindRank(b.kind);
  if (b.variants !== a.variants) return b.variants - a.variants;
  return compareLabels(a.label, b.label);
}

interface OpponentPartition {
  opponentCharacter: string;
  events: OpeningEvent[];
  /** Exact sequence key → its labels and events. */
  sequences: Map<string, { labels: string[]; events: OpeningEvent[] }>;
  withoutSequence: number;
}

function partitionByOpponent(events: OpeningEvent[]): OpponentPartition[] {
  const partitions = new Map<string, OpponentPartition>();
  for (const event of events) {
    const opponentCharacter = event.opponentCharacter?.trim() || UNKNOWN_OPPONENT;
    let partition = partitions.get(opponentCharacter);
    if (!partition) {
      partition = { opponentCharacter, events: [], sequences: new Map(), withoutSequence: 0 };
      partitions.set(opponentCharacter, partition);
    }
    partition.events.push(event);

    const labels = openingSequenceLabels(event);
    if (!labels) {
      partition.withoutSequence += 1;
      continue;
    }
    const key = labels.join("\u0000");
    const entry = partition.sequences.get(key);
    if (entry) entry.events.push(event);
    else partition.sequences.set(key, { labels, events: [event] });
  }
  return [...partitions.values()];
}

/**
 * One opponent group: exact sequences at or above the bucket minimum become
 * their own cluster; every rarer sequence joins a tail cluster keyed by its
 * first move, so all recorded sequences are represented and clusters never
 * mix different openers. Ids are assigned after sorting, in display order.
 */
function buildOpponentGroup(partition: OpponentPartition, nextId: () => number): OpeningOpponentSequenceGroup {
  const withSequence = partition.events.length - partition.withoutSequence;
  const clusters: Omit<OpeningSequenceCluster, "id">[] = [];
  const tails = new Map<string, { events: OpeningEvent[]; variants: number }>();

  for (const entry of partition.sequences.values()) {
    if (entry.events.length >= EVENT_SAMPLE_GUARDS.openingsBucketMin) {
      clusters.push(
        buildSequenceCluster({
          opponentCharacter: partition.opponentCharacter,
          kind: "exact",
          sequence: entry.labels,
          events: entry.events,
          variants: 1,
          shareOf: withSequence,
        }),
      );
    } else {
      const first = entry.labels[0]!;
      const tail = tails.get(first) ?? { events: [], variants: 0 };
      tail.events.push(...entry.events);
      tail.variants += 1;
      tails.set(first, tail);
    }
  }

  for (const [first, tail] of tails) {
    clusters.push(
      buildSequenceCluster({
        opponentCharacter: partition.opponentCharacter,
        kind: "tail",
        sequence: [first],
        events: tail.events,
        variants: tail.variants,
        shareOf: withSequence,
      }),
    );
  }

  return {
    opponentCharacter: partition.opponentCharacter,
    n: partition.events.length,
    withSequence,
    withoutSequence: partition.withoutSequence,
    lowSample: partition.events.length < EVENT_SAMPLE_GUARDS.openingsTotalMin,
    clusters: clusters.sort(compareSequenceClusters).map((cluster) => ({ ...cluster, id: nextId() })),
  };
}

/**
 * Cluster openings by the opponent's measured conversion sequence, within each
 * opponent character. Deterministic for a fixed event set: exact sequences
 * are counted, sorted and partitioned without randomness, and ids are
 * recomputed per query. Below 25 openings the result is explicitly
 * insufficient; when no opening has a recorded move list it says so instead
 * of inventing sequences.
 */
export function clusterOpenings(events: OpeningEvent[]): OpeningSequenceClusterResult {
  const n = events.length;
  if (n < EVENT_SAMPLE_GUARDS.openingsTotalMin) {
    return {
      status: "insufficient-sample",
      reason: "n-below-25",
      n,
      required: EVENT_SAMPLE_GUARDS.openingsTotalMin,
    };
  }

  const partitions = partitionByOpponent(events).sort(
    (a, b) => b.events.length - a.events.length || compareLabels(a.opponentCharacter, b.opponentCharacter),
  );
  const withSequence = partitions.reduce(
    (sum, partition) => sum + partition.events.length - partition.withoutSequence,
    0,
  );
  if (withSequence === 0) {
    return { status: "insufficient-sample", reason: "no-sequences", n };
  }

  let nextIdValue = 0;
  const nextId = (): number => {
    nextIdValue += 1;
    return nextIdValue;
  };
  return { status: "ok", groups: partitions.map((partition) => buildOpponentGroup(partition, nextId)) };
}

export { EVENT_SAMPLE_GUARDS };
