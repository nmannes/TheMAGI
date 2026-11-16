// ── Opening grouping: rule buckets + deterministic shape clusters ───────
//
// Two parallel, independent views of the opening ledger:
//  1. Rule buckets (authoritative, stable): situation × opener family × exact
//     move. Every row is explainable from persisted fields.
//  2. Shape clusters (exploratory, descriptive): a hand-rolled seeded k-means
//     over numeric pre-hit position/percent features. k is selected by
//     silhouette on a deterministic sample; cluster ids are recomputed per
//     query, never persisted, and never used for filters or coaching prompts.
//     Labels describe measurements only ("close range · 20–50% · center") —
//     never a named technique.
//
// A cluster is a description of where openings happen, not evidence that the
// players were doing any particular thing.

import { STAGE_LEDGE_X, frameToTimestamp, ratio } from "./helpers.js";
import type { OpeningEvent } from "./frameEvents.js";
import { EVENT_SAMPLE_GUARDS, OPENING_FAMILY_ORDER, OPENING_SITUATION_ORDER } from "../characterEventProfile.js";

export { OPENING_FAMILY_ORDER, OPENING_SITUATION_ORDER };

const CLUSTER_MIN_EVENTS = 40;
const CLUSTER_MIN_K = 2;
const CLUSTER_MAX_K = 6;
const CLUSTER_SILHOUETTE_SAMPLE = 500;
const WEAK_SEPARATION_SILHOUETTE = 0.2;
const EXAMPLE_LIMIT = 3;

const PERCENT_BAND_DEFS = [
  { key: "0-30", label: "0–30%", min: 0, max: 30 },
  { key: "30-60", label: "30–60%", min: 30, max: 60 },
  { key: "60-90", label: "60–90%", min: 60, max: 90 },
  { key: "90-120", label: "90–120%", min: 90, max: 120 },
  { key: "120+", label: "120%+", min: 120, max: null },
] as const;

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

export interface OpeningPercentBand {
  key: string;
  label: string;
  count: number;
  kills: number;
  killRate: number;
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
  return PERCENT_BAND_DEFS.map((band) => {
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

// ── Deterministic k-means ─────────────────────────────────────────────

export interface OpeningClusterSummary {
  /** 1-based display id; recomputed per query and never persisted. */
  id: number;
  size: number;
  share: number;
  percentMean: number;
  percentMedian: number;
  distanceMean: number;
  corneredShare: number;
  onPlatformShare: number;
  dominantSituation: string;
  dominantFamily: string;
  dominantOpenerLabel: string;
  killRate: number;
  avgDamage: number;
  distinctGames: number;
  examples: OpeningExample[];
  /** Measurement-only descriptor, e.g. "close range · 20–50% · center". */
  label: string;
}

export type OpeningClusterResult =
  | {
      status: "insufficient-sample";
      reason: "n-below-40" | "no-valid-k";
      n: number;
      required: number;
      minClusterSize: number;
    }
  | {
      status: "ok";
      n: number;
      k: number;
      minClusterSize: number;
      silhouette: number;
      weakSeparation: boolean;
      clusters: OpeningClusterSummary[];
    };

export interface OpeningClusterOptions {
  /** Force a k (2-6) instead of selecting by silhouette. */
  k?: number;
}

interface Point {
  event: OpeningEvent;
  features: number[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(events: OpeningEvent[], k: number): number {
  let h = 2166136261;
  for (const e of events) {
    const value = e.id ?? (e.gameId ?? 0) * 1_000_000 + (e.startFrame + 200) * 2 + e.victimSlot;
    h ^= value;
    h = Math.imul(h, 16777619);
  }
  h ^= k;
  return h >>> 0 || 1;
}

function sqDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return sum;
}

function sortedForClustering(events: OpeningEvent[]): OpeningEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const aId = a.event.id;
      const bId = b.event.id;
      if (aId != null && bId != null && aId !== bId) return aId - bId;
      const aGame = a.event.gameId ?? -1;
      const bGame = b.event.gameId ?? -1;
      if (aGame !== bGame) return aGame - bGame;
      if (a.event.startFrame !== b.event.startFrame) return a.event.startFrame - b.event.startFrame;
      if (a.event.victimSlot !== b.event.victimSlot) return a.event.victimSlot - b.event.victimSlot;
      return a.index - b.index;
    })
    .map((x) => x.event);
}

function toPoints(events: OpeningEvent[]): Point[] {
  return events.map((event) => {
    const ledgeX = STAGE_LEDGE_X[event.stageId ?? 0] ?? 80;
    return {
      event,
      features: [
        event.victimPercent,
        event.relativeX,
        event.relativeY,
        event.distance,
        ledgeX === 0 ? 0 : event.victimX / ledgeX,
        event.onPlatform ? 1 : 0,
      ],
    };
  });
}

/** Z-score every feature so percent/units/platform all contribute comparably. */
function standardize(points: Point[]): number[][] {
  const dims = points[0]!.features.length;
  const means: number[] = [];
  const stds: number[] = [];
  for (let d = 0; d < dims; d++) {
    const values = points.map((p) => p.features[d]!);
    const m = mean(values);
    means.push(m);
    stds.push(Math.sqrt(mean(values.map((v) => (v - m) * (v - m)))));
  }
  return points.map((p) =>
    p.features.map((v, d) => {
      const std = stds[d]!;
      return std > 1e-9 ? (v - means[d]!) / std : 0;
    }),
  );
}

interface KmeansResult {
  assignments: number[];
  centroids: number[][];
}

function initCentroids(x: number[][], k: number, seed: number): number[][] {
  const n = x.length;
  const rng = mulberry32(seed);
  const centroids: number[][] = [[...x[Math.min(n - 1, Math.floor(rng() * n))]!]];
  const nearest = new Array<number>(n).fill(Infinity);

  while (centroids.length < k) {
    const latest = centroids[centroids.length - 1]!;
    let total = 0;
    for (let i = 0; i < n; i++) {
      nearest[i] = Math.min(nearest[i]!, sqDistance(x[i]!, latest));
      total += nearest[i]!;
    }

    let pick = -1;
    if (total > 1e-12) {
      let target = rng() * total;
      for (let i = 0; i < n; i++) {
        target -= nearest[i]!;
        if (target <= 0) {
          pick = i;
          break;
        }
      }
    }
    if (pick === -1 || nearest[pick]! <= 1e-12) {
      // Duplicate/identical points: choose the next unused index deterministically.
      for (let i = 0; i < n; i++) {
        if (nearest[i]! > 1e-12) {
          pick = i;
          break;
        }
      }
    }
    if (pick === -1) pick = centroids.length % n;
    centroids.push([...x[pick]!]);
  }
  return centroids;
}

function runKmeans(x: number[][], k: number, seed: number): KmeansResult {
  const n = x.length;
  const dims = x[0]!.length;
  let centroids = initCentroids(x, k, seed);
  const assignments = new Array<number>(n).fill(-1);

  for (let iteration = 0; iteration < 100; iteration++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDistance(x[i]!, centroids[c]!);
        if (d < bestDistance - 1e-12) {
          bestDistance = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => new Array<number>(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i]!;
      counts[c]! += 1;
      for (let d = 0; d < dims; d++) sums[c]![d]! += x[i]![d]!;
    }

    const next: number[][] = [];
    for (let c = 0; c < k; c++) {
      if (counts[c]! > 0) {
        next.push(sums[c]!.map((sum) => sum / counts[c]!));
      } else {
        // Re-seed an empty cluster at the worst-fitting point.
        let far = 0;
        let farDistance = -1;
        for (let i = 0; i < n; i++) {
          const d = sqDistance(x[i]!, centroids[assignments[i]!]!);
          if (d > farDistance) {
            farDistance = d;
            far = i;
          }
        }
        next.push([...x[far]!]);
      }
    }
    centroids = next;
    if (!changed) break;
  }

  return { assignments, centroids };
}

function sampleIndices(n: number, cap: number): number[] {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const step = n / cap;
  for (let i = 0; i < cap; i++) out.push(Math.min(n - 1, Math.floor(i * step)));
  return out;
}

function silhouetteScore(x: number[][], assignments: number[], k: number): number {
  const sample = sampleIndices(x.length, CLUSTER_SILHOUETTE_SAMPLE);
  const sums = new Float64Array(k);
  const counts = new Uint32Array(k);
  let total = 0;
  let scored = 0;

  for (const i of sample) {
    sums.fill(0);
    counts.fill(0);
    let sameSum = 0;
    let sameCount = 0;
    for (let j = 0; j < x.length; j++) {
      if (i === j) continue;
      const d = Math.sqrt(sqDistance(x[i]!, x[j]!));
      const c = assignments[j]!;
      if (c === assignments[i]) {
        sameSum += d;
        sameCount++;
      } else {
        sums[c]! += d;
        counts[c]! += 1;
      }
    }
    if (sameCount === 0) continue; // singleton cluster: silhouette defined as 0
    const a = sameSum / sameCount;
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === assignments[i] || counts[c] === 0) continue;
      b = Math.min(b, sums[c]! / counts[c]!);
    }
    if (!Number.isFinite(b)) continue;
    const denom = Math.max(a, b);
    total += denom > 0 ? (b - a) / denom : 0;
    scored++;
  }

  return scored === 0 ? 0 : total / scored;
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

function clusterLabel(events: OpeningEvent[], distanceMean: number): string {
  const distanceBand = distanceMean < 30 ? "close range" : distanceMean < 60 ? "mid range" : "far range";
  const percents = events.map((e) => e.victimPercent);
  const lo = Math.floor(Math.min(...percents) / 10) * 10;
  const hi = Math.ceil(Math.max(...percents) / 10) * 10;
  const percentBand = lo === hi ? `${lo}%` : `${lo}–${hi}%`;

  const xNorm = mean(
    events.map((e) => {
      const ledgeX = STAGE_LEDGE_X[e.stageId ?? 0] ?? 80;
      return ledgeX === 0 ? 0 : e.victimX / ledgeX;
    }),
  );
  const position = Math.abs(xNorm) > 0.7 ? "corner" : Math.abs(xNorm) > 0.35 ? "off-center" : "center";
  const platform = events.filter((e) => e.onPlatform).length / events.length >= 0.5 ? " · platform" : "";
  return `${distanceBand} · ${percentBand} · ${position}${platform}`;
}

function buildClusterSummary(id: number, events: OpeningEvent[], total: number): OpeningClusterSummary {
  const kills = events.filter((e) => e.didKill).length;
  const gameIds = new Set<number>();
  for (const e of events) if (e.gameId != null) gameIds.add(e.gameId);
  const distanceMean = round2(mean(events.map((e) => e.distance)));
  return {
    id,
    size: events.length,
    share: share(events.length, total),
    percentMean: round2(mean(events.map((e) => e.victimPercent))),
    percentMedian: round2(median(events.map((e) => e.victimPercent))),
    distanceMean,
    corneredShare: share(events.filter((e) => e.cornered).length, events.length),
    onPlatformShare: share(events.filter((e) => e.onPlatform).length, events.length),
    dominantSituation: dominantKey(
      events.map((e) => e.situation),
      OPENING_SITUATION_ORDER,
    ),
    dominantFamily: dominantKey(
      events.map((e) => e.openerFamily),
      OPENING_FAMILY_ORDER,
    ),
    dominantOpenerLabel: dominantKey(
      events.map((e) => e.openerLabel),
      [],
    ),
    killRate: share(kills, events.length),
    avgDamage: round2(mean(events.map((e) => e.damage))),
    distinctGames: gameIds.size,
    examples: [...events].sort(exampleOrder).slice(0, EXAMPLE_LIMIT).map(openingExample),
    label: clusterLabel(events, distanceMean),
  };
}

/**
 * Deterministic seeded k-means over numeric shape features only. Rule fields
 * (situation/family) are not inputs; they characterize the clusters afterward.
 * Returns an explicit insufficient-sample result below 40 openings or when no k
 * satisfies the minimum cluster size.
 */
export function clusterOpenings(events: OpeningEvent[], options: OpeningClusterOptions = {}): OpeningClusterResult {
  const n = events.length;
  const minClusterSize = Math.max(8, Math.ceil(0.05 * n));
  if (n < CLUSTER_MIN_EVENTS) {
    return { status: "insufficient-sample", reason: "n-below-40", n, required: CLUSTER_MIN_EVENTS, minClusterSize };
  }

  const sorted = sortedForClustering(events);
  const points = toPoints(sorted);
  const x = standardize(points);

  const candidateKs: number[] = [];
  if (options.k != null) {
    if (options.k < CLUSTER_MIN_K || options.k > CLUSTER_MAX_K) {
      return { status: "insufficient-sample", reason: "no-valid-k", n, required: CLUSTER_MIN_EVENTS, minClusterSize };
    }
    candidateKs.push(Math.floor(options.k));
  } else {
    for (let k = CLUSTER_MIN_K; k <= CLUSTER_MAX_K; k++) candidateKs.push(k);
  }

  let best: { k: number; silhouette: number; assignments: number[] } | null = null;

  for (const k of candidateKs) {
    if (k >= n) continue;
    const { assignments } = runKmeans(x, k, hashSeed(sorted, k));
    const counts = new Array<number>(k).fill(0);
    for (const c of assignments) counts[c]! += 1;
    if (counts.some((count) => count < minClusterSize)) continue;

    const silhouette = silhouetteScore(x, assignments, k);
    if (best == null || silhouette > best.silhouette + 1e-9) {
      best = { k, silhouette, assignments };
    }
  }

  if (best == null) {
    return { status: "insufficient-sample", reason: "no-valid-k", n, required: CLUSTER_MIN_EVENTS, minClusterSize };
  }

  const groups = Array.from({ length: best.k }, () => [] as OpeningEvent[]);
  for (let i = 0; i < sorted.length; i++) groups[best.assignments[i]!]!.push(sorted[i]!);

  // Deterministic display order: biggest cluster first, then percent, then label.
  const summaries = groups
    .filter((group) => group.length > 0)
    .map((group) => buildClusterSummary(0, group, n))
    .sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size;
      if (a.percentMean !== b.percentMean) return a.percentMean - b.percentMean;
      return compareLabels(a.dominantOpenerLabel, b.dominantOpenerLabel);
    })
    .map((cluster, index) => ({ ...cluster, id: index + 1 }));

  const silhouette = Math.round(best.silhouette * 10000) / 10000;
  return {
    status: "ok",
    n,
    k: best.k,
    minClusterSize,
    silhouette,
    weakSeparation: silhouette < WEAK_SEPARATION_SILHOUETTE,
    clusters: summaries,
  };
}

export { EVENT_SAMPLE_GUARDS };
