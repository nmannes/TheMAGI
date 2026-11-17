// ── Combo-ending aggregation: ender choice and post-hit outcomes ──────
//
// Rule-based only (no clustering in v1). Every number is measured from
// persisted combo_ending_events rows; labels describe moves and measured
// outcomes, never intent. "Reset" is derived, not stored:
//   reset = !didKill && !extended && !whiffed && !punished && !edgeguardLinked
//
// Enders are grouped by exact move label × end-percent band. The band is the
// victim's percent when the conversion ended (end_percent), not a combo-validity
// threshold; squandered endings are the factual subset end_percent >= 100 with
// no stock taken.

import { EVENT_SAMPLE_GUARDS, POST_HIT_DECISION_ORDER, VICTIM_END_STATE_ORDER } from "../characterEventProfile.js";
import { OPENING_PERCENT_BANDS } from "../openingPercentBands.js";
import { frameToTimestamp, ratio } from "./helpers.js";
import { displayMoveName } from "./openingEvents.js";
import type { ComboEnderFamily, ComboEndingEvent, PostHitDecision, VictimEndState } from "./frameEvents.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function share(part: number, total: number): number {
  return total === 0 ? 0 : ratio(part, total);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
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

function byDisplayOrder(order: readonly string[], value: string): number {
  const idx = order.indexOf(value);
  return idx === -1 ? order.length : idx;
}

/** A conversion that escaped without a kill, extension, whiff, punish or edgeguard link. */
export function isComboReset(e: ComboEndingEvent): boolean {
  return !e.didKill && !e.extended && !e.whiffed && !e.punished && !e.edgeguardLinked;
}

export interface ComboBandRow {
  key: string;
  label: string;
  count: number;
  kills: number;
  killRate: number;
}

export interface ComboEndStateRow {
  state: VictimEndState;
  count: number;
  share: number;
}

export interface ComboEnderRow {
  label: string;
  family: ComboEnderFamily;
  moveId: number | null;
  count: number;
  share: number;
  kills: number;
  killRate: number;
  avgDamage: number;
  avgMoveCount: number;
  /** Victim percent when the conversion ended: mean, median, middle 50%. */
  endPercentMean: number;
  endPercentMedian: number;
  endPercentP25: number;
  endPercentP75: number;
  /** End-percent distribution; counts partition the ender's sample. */
  endPercentBands: ComboBandRow[];
  endStates: ComboEndStateRow[];
  lowSample: boolean;
}

export interface ComboDecisionRow {
  decision: PostHitDecision;
  count: number;
  share: number;
  killed: number;
  extended: number;
  whiffed: number;
  punished: number;
  reset: number;
  edgeguardLinked: number;
  /** Average frames from first actionable to the opponent's punish conversion. */
  avgPunishDelay: number | null;
  lowSample: boolean;
}

export type ComboOutcomeKey = "killed" | "extended" | "whiffed" | "punished" | "reset" | "edgeguard-linked";

export interface ComboOutcomeRow {
  key: ComboOutcomeKey;
  count: number;
  share: number;
}

export interface ComboPunishOpenerRow {
  moveId: number | null;
  label: string;
  count: number;
  share: number;
}

export interface ComboEndingCost {
  punished: number;
  punishedShare: number;
  /** Mean opponent damage dealt inside the post-hit window, across all endings. */
  avgPunishDamagePerEnding: number;
  /** Mean opponent damage inside the window when the ending was punished. */
  avgPunishDamageWhenPunished: number;
  /** Mean frames from first actionable to the opponent's punish conversion. */
  avgPunishDelay: number | null;
  /** Most common opponent punish openers (exact first move of the punishing conversion). */
  topPunishOpeners: ComboPunishOpenerRow[];
}

export interface ComboSquanderedEnderRow {
  label: string;
  family: ComboEnderFamily;
  count: number;
  endStates: ComboEndStateRow[];
}

export interface ComboSquandered {
  /** end_percent >= 100 && !did_kill — a fact, never a "missed kill" claim. */
  total: number;
  share: number;
  byEnder: ComboSquanderedEnderRow[];
}

export interface ComboEndingExample {
  gameId: number | null;
  lastHitFrame: number;
  /** In-game timestamp like "1:23". */
  timestamp: string;
  enderLabel: string;
  enderFamily: ComboEnderFamily;
  startPercent: number;
  endPercent: number;
  damage: number;
  didKill: boolean;
  victimEndState: VictimEndState;
  postHitDecision: PostHitDecision;
  postHitMoveLabel: string | null;
  extended: boolean;
  whiffed: boolean;
  punished: boolean;
  punishDelay: number | null;
  edgeguardLinked: boolean;
  opponentCharacter: string | null;
}

export interface ComboEndingSummary {
  total: number;
  kills: number;
  killRate: number;
  avgDamage: number;
  avgMoveCount: number;
  avgEndPercent: number;
  endPercentP25: number;
  endPercentMedian: number;
  endPercentP75: number;
  /** end_percent >= 100 && !did_kill. */
  squandered: number;
  squanderedShare: number;
  enders: ComboEnderRow[];
  victimEndStates: ComboEndStateRow[];
  decisions: ComboDecisionRow[];
  /** Outcome flags are not mutually exclusive except reset; partitions are enders/decisions only. */
  outcomes: ComboOutcomeRow[];
  cost: ComboEndingCost;
  squanderedEndings: ComboSquandered;
  examples: ComboEndingExample[];
}

export function comboEndingExample(e: ComboEndingEvent): ComboEndingExample {
  return {
    gameId: e.gameId ?? null,
    lastHitFrame: e.lastHitFrame,
    timestamp: frameToTimestamp(e.lastHitFrame),
    enderLabel: e.enderLabel,
    enderFamily: e.enderFamily,
    startPercent: e.startPercent,
    endPercent: e.endPercent,
    damage: e.damage,
    didKill: e.didKill,
    victimEndState: e.victimEndState,
    postHitDecision: e.postHitDecision,
    postHitMoveLabel: e.postHitMoveLabel,
    extended: e.extended,
    whiffed: e.whiffed,
    punished: e.punished,
    punishDelay: e.punishDelay,
    edgeguardLinked: e.edgeguardLinked,
    opponentCharacter: e.opponentCharacter ?? null,
  };
}

/** Newest-first, so example chips point at the most recent teachable moment. */
function exampleOrder(a: ComboEndingEvent, b: ComboEndingEvent): number {
  const ag = a.gameId ?? -1;
  const bg = b.gameId ?? -1;
  if (ag !== bg) return bg - ag;
  if (a.lastHitFrame !== b.lastHitFrame) return b.lastHitFrame - a.lastHitFrame;
  return a.attackerSlot - b.attackerSlot;
}

function endStateRows(events: ComboEndingEvent[]): ComboEndStateRow[] {
  const counts = new Map<VictimEndState, number>();
  for (const e of events) counts.set(e.victimEndState, (counts.get(e.victimEndState) ?? 0) + 1);
  return [...counts.entries()]
    .map(([state, count]) => ({ state, count, share: share(count, events.length) }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        byDisplayOrder(VICTIM_END_STATE_ORDER, a.state) - byDisplayOrder(VICTIM_END_STATE_ORDER, b.state),
    );
}

function endPercentBands(events: ComboEndingEvent[]): ComboBandRow[] {
  return OPENING_PERCENT_BANDS.map((band) => {
    const inBand = events.filter((e) => e.endPercent >= band.min && (band.max == null || e.endPercent < band.max));
    const kills = inBand.filter((e) => e.didKill).length;
    return { key: band.key, label: band.label, count: inBand.length, kills, killRate: share(kills, inBand.length) };
  });
}

function enderRows(events: ComboEndingEvent[]): ComboEnderRow[] {
  const groups = new Map<string, ComboEndingEvent[]>();
  for (const e of events) {
    const key = `${e.enderFamily}:${e.enderLabel}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      const kills = group.filter((e) => e.didKill).length;
      const endPercents = group.map((e) => e.endPercent);
      return {
        label: first.enderLabel,
        family: first.enderFamily,
        moveId: first.enderMoveId,
        count: group.length,
        share: share(group.length, events.length),
        kills,
        killRate: share(kills, group.length),
        avgDamage: round2(mean(group.map((e) => e.damage))),
        avgMoveCount: round2(mean(group.map((e) => e.moveCount))),
        endPercentMean: round2(mean(endPercents)),
        endPercentMedian: round2(quantile(endPercents, 0.5)),
        endPercentP25: round2(quantile(endPercents, 0.25)),
        endPercentP75: round2(quantile(endPercents, 0.75)),
        endPercentBands: endPercentBands(group),
        endStates: endStateRows(group),
        lowSample: group.length < EVENT_SAMPLE_GUARDS.comboEnderMin,
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function decisionRows(events: ComboEndingEvent[]): ComboDecisionRow[] {
  const groups = new Map<PostHitDecision, ComboEndingEvent[]>();
  for (const e of events) {
    const list = groups.get(e.postHitDecision);
    if (list) list.push(e);
    else groups.set(e.postHitDecision, [e]);
  }
  return [...groups.entries()]
    .map(([decision, group]) => {
      const punishDelays = group.map((e) => e.punishDelay).filter((delay): delay is number => delay != null);
      return {
        decision,
        count: group.length,
        share: share(group.length, events.length),
        killed: group.filter((e) => e.didKill).length,
        extended: group.filter((e) => e.extended).length,
        whiffed: group.filter((e) => e.whiffed).length,
        punished: group.filter((e) => e.punished).length,
        reset: group.filter(isComboReset).length,
        edgeguardLinked: group.filter((e) => e.edgeguardLinked).length,
        avgPunishDelay: punishDelays.length > 0 ? round2(mean(punishDelays)) : null,
        lowSample: group.length < EVENT_SAMPLE_GUARDS.comboDecisionMin,
      };
    })
    .sort(
      (a, b) =>
        byDisplayOrder(POST_HIT_DECISION_ORDER, a.decision) - byDisplayOrder(POST_HIT_DECISION_ORDER, b.decision),
    );
}

function costBlock(events: ComboEndingEvent[]): ComboEndingCost {
  const punishedEvents = events.filter((e) => e.punished);
  const punishDelays = punishedEvents.map((e) => e.punishDelay).filter((delay): delay is number => delay != null);

  const openerGroups = new Map<string, { moveId: number | null; count: number }>();
  for (const e of punishedEvents) {
    const key = e.punishOpenerMoveId == null ? "unattributed" : String(e.punishOpenerMoveId);
    const existing = openerGroups.get(key);
    if (existing) existing.count++;
    else openerGroups.set(key, { moveId: e.punishOpenerMoveId, count: 1 });
  }
  const totalPunished = punishedEvents.length;

  return {
    punished: totalPunished,
    punishedShare: share(totalPunished, events.length),
    avgPunishDamagePerEnding: round2(mean(events.map((e) => e.punishDamage))),
    avgPunishDamageWhenPunished: round2(mean(punishedEvents.map((e) => e.punishDamage))),
    avgPunishDelay: punishDelays.length > 0 ? round2(mean(punishDelays)) : null,
    topPunishOpeners: [...openerGroups.values()]
      .map((row) => ({
        moveId: row.moveId,
        label: row.moveId == null ? "unattributed" : displayMoveName(row.moveId),
        count: row.count,
        share: share(row.count, totalPunished),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 5),
  };
}

function squanderedBlock(events: ComboEndingEvent[]): ComboSquandered {
  const squandered = events.filter((e) => e.endPercent >= 100 && !e.didKill);
  const groups = new Map<string, ComboEndingEvent[]>();
  for (const e of squandered) {
    const key = `${e.enderFamily}:${e.enderLabel}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return {
    total: squandered.length,
    share: share(squandered.length, events.length),
    byEnder: [...groups.values()]
      .map((group) => ({
        label: group[0]!.enderLabel,
        family: group[0]!.enderFamily,
        count: group.length,
        endStates: endStateRows(group),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

export function summarizeComboEndings(events: ComboEndingEvent[]): ComboEndingSummary {
  const total = events.length;
  const kills = events.filter((e) => e.didKill).length;
  const squandered = events.filter((e) => e.endPercent >= 100 && !e.didKill).length;
  const endPercents = events.map((e) => e.endPercent);

  const outcomeCounts: Record<ComboOutcomeKey, number> = {
    killed: kills,
    extended: events.filter((e) => e.extended).length,
    whiffed: events.filter((e) => e.whiffed).length,
    punished: events.filter((e) => e.punished).length,
    reset: events.filter(isComboReset).length,
    "edgeguard-linked": events.filter((e) => e.edgeguardLinked).length,
  };
  const outcomeOrder: ComboOutcomeKey[] = ["killed", "extended", "whiffed", "punished", "reset", "edgeguard-linked"];

  return {
    total,
    kills,
    killRate: share(kills, total),
    avgDamage: round2(mean(events.map((e) => e.damage))),
    avgMoveCount: round2(mean(events.map((e) => e.moveCount))),
    avgEndPercent: round2(mean(endPercents)),
    endPercentP25: round2(quantile(endPercents, 0.25)),
    endPercentMedian: round2(quantile(endPercents, 0.5)),
    endPercentP75: round2(quantile(endPercents, 0.75)),
    squandered,
    squanderedShare: share(squandered, total),
    enders: enderRows(events),
    victimEndStates: endStateRows(events),
    decisions: decisionRows(events),
    outcomes: outcomeOrder.map((key) => ({ key, count: outcomeCounts[key], share: share(outcomeCounts[key], total) })),
    cost: costBlock(events),
    squanderedEndings: squanderedBlock(events),
    examples: [...events].sort(exampleOrder).slice(0, 10).map(comboEndingExample),
  };
}
