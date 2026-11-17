import { describe, it, expect } from "vitest";
import { isComboReset, summarizeComboEndings } from "../src/pipeline/comboEndings";
import type { ComboEndingEvent } from "../src/pipeline/frameEvents";

function ending(overrides: Partial<ComboEndingEvent> = {}): ComboEndingEvent {
  return {
    attackerSlot: 0,
    conversionStartFrame: 100,
    lastHitFrame: 120,
    conversionEndFrame: 165,
    openerMoveId: 13,
    enderMoveId: 13,
    enderLabel: "nair",
    enderFamily: "aerial",
    openingType: "neutral-win",
    moveCount: 3,
    damage: 27,
    startPercent: 10,
    endPercent: 37,
    didKill: false,
    victimEndState: "onstage",
    victimEndX: 20,
    victimEndY: 0,
    victimEndPercent: 37,
    attackerFirstActionableFrame: 130,
    framesFromLastHitToActionable: 10,
    postHitDecision: "attack",
    postHitMoveId: 14,
    postHitMoveLabel: "fair",
    postHitStartFrame: 131,
    postHitConnected: false,
    postHitOnShield: false,
    extended: false,
    whiffed: true,
    punished: false,
    punishDelay: null,
    punishOpenerMoveId: null,
    punishDamage: 0,
    edgeguardLinked: false,
    victimDeathPercent: null,
    deathFrame: null,
    ...overrides,
  };
}

describe("summarizeComboEndings", () => {
  it("returns an empty, well-formed summary for no endings", () => {
    const summary = summarizeComboEndings([]);
    expect(summary.total).toBe(0);
    expect(summary.killRate).toBe(0);
    expect(summary.enders).toEqual([]);
    expect(summary.victimEndStates).toEqual([]);
    expect(summary.decisions).toEqual([]);
    expect(summary.examples).toEqual([]);
    expect(summary.outcomes.every((row) => row.count === 0 && row.share === 0)).toBe(true);
  });

  it("groups enders by exact label and family with kill rate and end-percent spread", () => {
    const summary = summarizeComboEndings([
      ending({ enderLabel: "nair", endPercent: 40 }),
      ending({ lastHitFrame: 220, enderLabel: "nair", endPercent: 110, didKill: true, victimEndState: "dead" }),
      ending({ lastHitFrame: 320, enderLabel: "fair", enderMoveId: 14, endPercent: 80 }),
      // Same move label but a different family would be a different row; this
      // cannot happen for a real move id, but the grouping key keeps it exact.
      ending({ lastHitFrame: 420, enderLabel: "nair", enderFamily: "special", enderMoveId: 18, endPercent: 60 }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.kills).toBe(1);
    expect(summary.killRate).toBeCloseTo(0.25);
    expect(summary.enders).toHaveLength(3);
    const nair = summary.enders.find((row) => row.family === "aerial" && row.label === "nair")!;
    expect(nair).toMatchObject({
      count: 2,
      share: 0.5,
      kills: 1,
      killRate: 0.5,
      avgDamage: 27,
      avgMoveCount: 3,
      lowSample: true,
    });
    expect(nair.endPercentMean).toBe(75);
    expect(nair.endPercentMedian).toBe(75);
    expect(nair.endPercentBands.map((band) => band.count)).toEqual([0, 1, 0, 1, 0]);
    expect(nair.endStates).toEqual([
      { state: "dead", count: 1, share: 0.5 },
      { state: "onstage", count: 1, share: 0.5 },
    ]);

    const specialNair = summary.enders.find((row) => row.family === "special")!;
    expect(specialNair.count).toBe(1);
    expect(specialNair.endPercentBands.map((band) => band.count)).toEqual([0, 0, 1, 0, 0]);
  });

  it("uses half-open end-percent bands: 30, 60, 90 and 120 belong to the higher band", () => {
    const summary = summarizeComboEndings([
      ending({ endPercent: 29.9 }),
      ending({ endPercent: 30 }),
      ending({ endPercent: 59.9 }),
      ending({ endPercent: 60 }),
      ending({ endPercent: 89.9 }),
      ending({ endPercent: 90 }),
      ending({ endPercent: 119.9 }),
      ending({ endPercent: 120 }),
    ]);
    expect(summary.enders[0]!.endPercentBands.map((band) => band.count)).toEqual([1, 2, 2, 2, 1]);
  });

  it("derives reset only when the victim escaped with no extension, whiff, punish or edgeguard link", () => {
    const reset = ending({ whiffed: false });
    const edgeguard = ending({ whiffed: false, edgeguardLinked: true });
    const extended = ending({ whiffed: false, extended: true });
    const punished = ending({ whiffed: false, punished: true, punishDelay: 5, punishDamage: 18 });

    expect(isComboReset(reset)).toBe(true);
    expect(isComboReset(edgeguard)).toBe(false);
    expect(isComboReset(extended)).toBe(false);
    expect(isComboReset(punished)).toBe(false);

    const summary = summarizeComboEndings([reset, edgeguard, extended, punished]);
    expect(summary.outcomes).toContainEqual({ key: "reset", count: 1, share: 0.25 });
    expect(summary.outcomes).toContainEqual({ key: "edgeguard-linked", count: 1, share: 0.25 });
  });

  it("counts squandered endings as a measured fact: end_percent >= 100 and no kill", () => {
    const summary = summarizeComboEndings([
      ending({ endPercent: 99.9 }),
      ending({ endPercent: 100 }),
      ending({ endPercent: 130 }),
      ending({ endPercent: 140, didKill: true, victimEndState: "dead" }),
    ]);
    expect(summary.squandered).toBe(2);
    expect(summary.squanderedShare).toBe(0.5);
    expect(summary.squanderedEndings.total).toBe(2);
    expect(summary.squanderedEndings.byEnder).toHaveLength(1);
    expect(summary.squanderedEndings.byEnder[0]).toMatchObject({ label: "nair", family: "aerial", count: 2 });
    expect(summary.squanderedEndings.byEnder[0]!.endStates).toEqual([
      { state: "onstage", count: 2, share: 1 },
    ]);
  });

  it("computes cost after the hit and the most common opponent punish openers", () => {
    const summary = summarizeComboEndings([
      ending({ whiffed: false, punished: true, punishDelay: 3, punishOpenerMoveId: 8, punishDamage: 20 }),
      ending({ lastHitFrame: 220, whiffed: false, punished: true, punishDelay: 7, punishOpenerMoveId: 8, punishDamage: 30 }),
      ending({ lastHitFrame: 320, whiffed: false, punished: true, punishDelay: 5, punishOpenerMoveId: 9, punishDamage: 10 }),
      ending({ lastHitFrame: 420, whiffed: false }),
    ]);

    expect(summary.cost).toMatchObject({
      punished: 3,
      punishedShare: 0.75,
      avgPunishDamagePerEnding: 15,
      avgPunishDamageWhenPunished: 20,
      avgPunishDelay: 5,
    });
    expect(summary.cost.topPunishOpeners).toEqual([
      { moveId: 8, label: "utilt", count: 2, share: 0.6667 },
      { moveId: 9, label: "dtilt", count: 1, share: 0.3333 },
    ]);
  });

  it("marks decision rows low-sample below the 10-ending guard and keeps the vocabulary exact", () => {
    const summary = summarizeComboEndings([
      ...Array.from({ length: 9 }, () => ending({ postHitDecision: "attack" })),
      ...Array.from({ length: 10 }, (_, i) => ending({ lastHitFrame: 300 + i, postHitDecision: "defend" })),
    ]);

    const attack = summary.decisions.find((row) => row.decision === "attack")!;
    const defend = summary.decisions.find((row) => row.decision === "defend")!;
    expect(attack.lowSample).toBe(true);
    expect(defend.lowSample).toBe(false);
    expect(summary.decisions.map((row) => row.decision)).toEqual(["attack", "defend"]);
    // No invented intent language: the decision value is the measurement.
    expect(new Set(summary.decisions.map((row) => row.decision))).toEqual(new Set(["attack", "defend"]));
  });

  it("keeps examples newest-first", () => {
    const summary = summarizeComboEndings([
      ending({ gameId: 1, lastHitFrame: 500 }),
      ending({ gameId: 3, lastHitFrame: 100 }),
      ending({ gameId: 3, lastHitFrame: 300 }),
    ]);
    expect(summary.examples.map((example) => [example.gameId, example.lastHitFrame])).toEqual([
      [3, 300],
      [3, 100],
      [1, 500],
    ]);
    expect(summary.examples[0]!.timestamp).toMatch(/^\d+:\d{2}$/);
  });
});
