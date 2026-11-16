import { describe, it, expect } from "vitest";
import type { OpeningEvent } from "../src/pipeline/frameEvents";
import {
  aggregateOpeningBuckets,
  clusterOpenings,
  openingSequenceLabels,
  sortOpeningBuckets,
  summarizeOpenings,
} from "../src/pipeline/openingClusters";
import { EVENT_SAMPLE_GUARDS } from "../src/characterEventProfile";

function opening(overrides: Partial<OpeningEvent> = {}): OpeningEvent {
  return {
    victimSlot: 0,
    attackerSlot: 1,
    startFrame: 100,
    endFrame: 120,
    openerMoveId: 6,
    openerLabel: "dash attack",
    openerFamily: "grounded",
    grab: false,
    openingType: "neutral-win",
    traded: false,
    situation: "neutral-grounded",
    victimState: 14,
    attackerState: 14,
    victimPercent: 30,
    attackerPercent: 20,
    victimX: 0,
    victimY: 0,
    attackerX: 10,
    attackerY: 0,
    relativeX: 10,
    relativeY: 0,
    distance: 10,
    cornered: false,
    onPlatform: false,
    damage: 10,
    moveCount: 1,
    didKill: false,
    stockNumber: null,
    deathFrame: null,
    deathVerdict: null,
    ...overrides,
  };
}

function bucketFixture(): OpeningEvent[] {
  return [
    opening({
      id: 1,
      gameId: 10,
      startFrame: 100,
      situation: "commitment",
      openerFamily: "grounded",
      openerLabel: "dash attack",
      victimPercent: 25,
      damage: 10,
      moveCount: 1,
      cornered: true,
    }),
    opening({
      id: 2,
      gameId: 10,
      startFrame: 200,
      situation: "commitment",
      openerFamily: "grounded",
      openerLabel: "dash attack",
      victimPercent: 35,
      damage: 10,
      moveCount: 2,
      didKill: true,
    }),
    opening({
      id: 3,
      gameId: 11,
      startFrame: 150,
      situation: "commitment",
      openerFamily: "grounded",
      openerLabel: "dash attack",
      victimPercent: 65,
      damage: 20,
      moveCount: 3,
      cornered: true,
      onPlatform: true,
      didKill: true,
    }),
    opening({
      id: 4,
      gameId: 11,
      startFrame: 250,
      situation: "commitment",
      openerFamily: "grounded",
      openerLabel: "dash attack",
      victimPercent: 100,
      damage: 0,
      moveCount: 1,
    }),
    opening({
      id: 5,
      gameId: 12,
      startFrame: 300,
      situation: "shield",
      openerFamily: "grab",
      openerLabel: "grab (bthrow)",
      grab: true,
      openerMoveId: 54,
      victimPercent: 40,
      damage: 12,
      moveCount: 2,
    }),
    opening({
      id: 6,
      gameId: 12,
      startFrame: 400,
      situation: "shield",
      openerFamily: "grab",
      openerLabel: "grab (bthrow)",
      grab: true,
      openerMoveId: 54,
      victimPercent: 45,
      damage: 12,
      moveCount: 2,
    }),
    opening({
      id: 7,
      gameId: 13,
      startFrame: 500,
      situation: "shield",
      openerFamily: "grab",
      openerLabel: "grab (bthrow)",
      grab: true,
      openerMoveId: 54,
      victimPercent: 50,
      damage: 12,
      moveCount: 2,
    }),
    opening({
      id: 8,
      gameId: 13,
      startFrame: 600,
      situation: "neutral-airborne",
      openerFamily: "aerial",
      openerLabel: "nair",
      openerMoveId: 13,
      victimPercent: 130,
      damage: 8,
      moveCount: 1,
    }),
  ];
}

describe("openingClusters: rule buckets", () => {
  it("aggregates counts, shares, kills, rates, damage, follow-ups and games", () => {
    const buckets = aggregateOpeningBuckets(bucketFixture());
    expect(buckets).toHaveLength(3);

    const dash = buckets.find((b) => b.openerLabel === "dash attack")!;
    expect(dash.situation).toBe("commitment");
    expect(dash.openerFamily).toBe("grounded");
    expect(dash.count).toBe(4);
    expect(dash.share).toBe(0.5);
    expect(dash.kills).toBe(2);
    expect(dash.killRate).toBe(0.5);
    expect(dash.avgDamage).toBe(10);
    // moveCount 1, 2, 3, 1 → follow-ups 0, 1, 2, 0
    expect(dash.avgFollowUpHits).toBe(0.75);
    expect(dash.corneredShare).toBe(0.5);
    expect(dash.onPlatformShare).toBe(0.25);
    expect(dash.distinctGames).toBe(2);
    expect(dash.examples).toHaveLength(3);
    // Newest game/frame first.
    expect(dash.examples.map((e) => [e.gameId, e.startFrame])).toEqual([
      [11, 250],
      [11, 150],
      [10, 200],
    ]);
    expect(dash.examples[0]!.timestamp).toMatch(/^\d+:\d{2}$/);
    expect(dash.examples[0]!.didKill).toBe(false);
  });

  it("splits percent bands on [min, max) boundaries and cornered/on-platform qualifiers", () => {
    const dash = aggregateOpeningBuckets(bucketFixture()).find((b) => b.openerLabel === "dash attack")!;
    expect(dash.splits.percentBands.map((b) => [b.label, b.count, b.kills])).toEqual([
      ["0–30%", 1, 0],
      ["30–60%", 1, 1],
      ["60–90%", 1, 1],
      ["90–120%", 1, 0],
      ["120%+", 0, 0],
    ]);
    expect(dash.splits.cornered).toEqual({ count: 2, kills: 1, killRate: 0.5 });
    expect(dash.splits.onPlatform).toEqual({ count: 1, kills: 1, killRate: 1 });
  });

  it("returns low-n buckets rather than hiding them, and exposes the sample guards", () => {
    expect(EVENT_SAMPLE_GUARDS.openingsBucketMin).toBe(8);
    expect(EVENT_SAMPLE_GUARDS.openingsTotalMin).toBe(25);
    const buckets = aggregateOpeningBuckets(bucketFixture());
    expect(buckets.some((b) => b.count === 1)).toBe(true);
  });

  it("sorts by count by default and offers a raw kill-count sort", () => {
    const buckets = aggregateOpeningBuckets(bucketFixture());
    expect(buckets.map((b) => b.count)).toEqual([4, 3, 1]);

    const byKills = sortOpeningBuckets(buckets, "kills");
    expect(byKills[0]!.openerLabel).toBe("dash attack");
    expect(byKills[0]!.kills).toBe(2);
    expect(byKills.at(-1)!.kills).toBe(0);
  });

  it("summarizes the baseline with ordered situation/family groups", () => {
    const baseline = summarizeOpenings(bucketFixture());
    expect(baseline.total).toBe(8);
    expect(baseline.kills).toBe(2);
    expect(baseline.killRate).toBe(0.25);
    // 25+35+65+100+40+45+50+130 = 490 over 8 events.
    expect(baseline.avgPercent).toBe(61.25);
    expect(baseline.corneredShare).toBe(0.25);
    expect(baseline.onPlatformShare).toBe(0.125);
    expect(baseline.situations[0]).toMatchObject({ key: "commitment", count: 4, kills: 2, killRate: 0.5 });
    expect(baseline.families[0]).toMatchObject({ key: "grounded", count: 4 });
    expect(baseline.percentBands.map((b) => b.count)).toEqual([1, 4, 1, 1, 1]);
  });
});

const MOVE_LABEL: Record<number, string> = {
  1: "misc",
  6: "dash attack",
  13: "nair",
  14: "fair",
  15: "bair",
  16: "uair",
  17: "dair",
  18: "neutral b",
  19: "side b",
  54: "bthrow",
};

/** Opening with an explicit opponent conversion move list. */
function sequenceEvent(options: {
  id: number;
  opponentCharacter?: string;
  moves: number[];
  openerLabel?: string;
  grab?: boolean;
  openerFamily?: OpeningEvent["openerFamily"];
  startFrame?: number;
  gameId?: number;
  didKill?: boolean;
  damage?: number;
  cornered?: boolean;
  onPlatform?: boolean;
  victimPercent?: number;
}): OpeningEvent {
  const firstMoveId = options.moves[0]!;
  return opening({
    id: options.id,
    gameId: options.gameId ?? Math.floor((options.id - 1) / 5) + 1,
    startFrame: options.startFrame ?? 100 + options.id,
    opponentCharacter: options.opponentCharacter ?? "Falco",
    openerMoveId: firstMoveId,
    openerLabel: options.openerLabel ?? MOVE_LABEL[firstMoveId] ?? `move #${firstMoveId}`,
    openerFamily: options.openerFamily ?? "aerial",
    grab: options.grab ?? false,
    moveIds: options.moves,
    moveCount: options.moves.length,
    damage: options.damage ?? 10,
    didKill: options.didKill ?? false,
    cornered: options.cornered ?? false,
    onPlatform: options.onPlatform ?? false,
    victimPercent: options.victimPercent ?? 40,
  });
}

function reverse<T>(items: T[]): T[] {
  return [...items].reverse();
}

function sequenceFixture(): OpeningEvent[] {
  const events: OpeningEvent[] = [];
  let id = 1;
  // Falco exact sequences at and above the 8-opening exact minimum.
  for (let i = 0; i < 10; i++) events.push(sequenceEvent({ id: id++, moves: [14, 14, 13] }));
  for (let i = 0; i < 10; i++) events.push(sequenceEvent({ id: id++, moves: [17, 17] }));
  for (let i = 0; i < 8; i++) events.push(sequenceEvent({ id: id++, moves: [18], openerFamily: "special" }));
  // Falco tail: two rare side-b continuations (5 each, below the minimum).
  for (let i = 0; i < 5; i++) events.push(sequenceEvent({ id: id++, moves: [19, 13], openerFamily: "special" }));
  for (let i = 0; i < 5; i++) events.push(sequenceEvent({ id: id++, moves: [19, 14], openerFamily: "special" }));
  // Marth: the same fair-fair-nair label, in its own opponent group.
  for (let i = 0; i < 9; i++) events.push(sequenceEvent({ id: id++, opponentCharacter: "Marth", moves: [14, 14, 13] }));
  for (let i = 0; i < 3; i++) events.push(sequenceEvent({ id: id++, opponentCharacter: "Marth", moves: [17, 13] }));
  return events;
}

describe("openingClusters: conversion sequences by opponent", () => {
  it("groups exact sequences by opponent, preserving order, repeats and labels", () => {
    const result = clusterOpenings(sequenceFixture());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.groups.map((group) => group.opponentCharacter)).toEqual(["Falco", "Marth"]);

    const falco = result.groups[0]!;
    expect(falco.n).toBe(38);
    expect(falco.withSequence).toBe(38);
    expect(falco.withoutSequence).toBe(0);
    expect(falco.lowSample).toBe(false);
    expect(falco.clusters.reduce((sum, cluster) => sum + cluster.size, 0)).toBe(38);

    const fairFairNair = falco.clusters.find((cluster) => cluster.label === "fair · fair · nair")!;
    expect(fairFairNair.kind).toBe("exact");
    expect(fairFairNair.sequence).toEqual(["fair", "fair", "nair"]);
    expect(fairFairNair.size).toBe(10);
    expect(fairFairNair.variants).toBe(1);

    expect(falco.clusters.find((cluster) => cluster.label === "dair · dair")!.size).toBe(10);
    // Exactly at the exact-sequence minimum.
    expect(falco.clusters.find((cluster) => cluster.label === "neutral b")!.size).toBe(8);

    const tail = falco.clusters.find((cluster) => cluster.kind === "tail")!;
    expect(tail.label).toBe("side b · …");
    expect(tail.sequence).toEqual(["side b"]);
    expect(tail.size).toBe(10);
    expect(tail.variants).toBe(2);

    // The same sequence label in another opponent group stays separate.
    const marth = result.groups[1]!;
    expect(marth.lowSample).toBe(true);
    expect(marth.clusters.find((cluster) => cluster.label === "fair · fair · nair")!.size).toBe(9);

    // Display ids are unique across groups (used by --cluster).
    const ids = result.groups.flatMap((group) => group.clusters.map((cluster) => cluster.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.map((_, index) => index + 1));
  });

  it("keeps the opening ledger's grab/projectile notation as the first element", () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) =>
        sequenceEvent({
          id: i + 1,
          moves: [54, 14, 14],
          grab: true,
          openerLabel: "grab (bthrow)",
          openerFamily: "grab",
        }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        sequenceEvent({ id: 100 + i, moves: [1, 13], openerLabel: "projectile", openerFamily: "projectile" }),
      ),
      ...Array.from({ length: 9 }, (_, i) => sequenceEvent({ id: 200 + i, moves: [13, 13] })),
    ];
    const result = clusterOpenings(events);
    if (result.status !== "ok") throw new Error("expected clusters");
    const labels = result.groups[0]!.clusters.map((cluster) => cluster.label);
    expect(labels).toContain("grab (bthrow) · fair · fair");
    expect(labels).toContain("projectile · nair");
  });

  it("labels unmapped move ids with their id instead of guessing a technique", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => sequenceEvent({ id: i + 1, moves: [59, 16], openerFamily: "special" })),
      ...Array.from({ length: 15 }, (_, i) => sequenceEvent({ id: 100 + i, moves: [13] })),
    ];
    const result = clusterOpenings(events);
    if (result.status !== "ok") throw new Error("expected clusters");
    expect(result.groups[0]!.clusters.some((cluster) => cluster.label === "move #59 · uair")).toBe(true);
  });

  it("reports openings without a recorded move list instead of inventing a sequence", () => {
    const noSequence = Array.from({ length: 30 }, (_, i) =>
      opening({ id: i + 1, gameId: 1, startFrame: 100 + i, opponentCharacter: "Falco" }),
    );
    const empty = clusterOpenings(noSequence);
    expect(empty.status).toBe("insufficient-sample");
    if (empty.status === "insufficient-sample") expect(empty.reason).toBe("no-sequences");

    const partial = [
      ...Array.from({ length: 20 }, (_, i) => sequenceEvent({ id: i + 1, moves: [13] })),
      ...Array.from({ length: 10 }, (_, i) =>
        opening({ id: 100 + i, gameId: 1, startFrame: 200 + i, opponentCharacter: "Falco" }),
      ),
    ];
    const result = clusterOpenings(partial);
    if (result.status !== "ok") throw new Error("expected clusters");
    expect(result.groups[0]!.withoutSequence).toBe(10);
    expect(result.groups[0]!.withSequence).toBe(20);
    expect(result.groups[0]!.clusters.reduce((sum, cluster) => sum + cluster.size, 0)).toBe(20);
  });

  it("reports the pre-hit percent distribution and quartiles for each sequence", () => {
    const percents = [0, 10, 20, 29, 30, 40, 50, 59, 60, 70, 80, 89, 90, 100, 110, 119, 120, 130, 150, 200];
    const events = [
      ...percents.map((victimPercent, i) =>
        sequenceEvent({
          id: i + 1,
          moves: [14, 14, 13],
          victimPercent,
          didKill: victimPercent >= 150 || (victimPercent >= 90 && victimPercent < 120),
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) => sequenceEvent({ id: 100 + i, moves: [13] })),
    ];
    const result = clusterOpenings(events);
    if (result.status !== "ok") throw new Error("expected clusters");
    const cluster = result.groups[0]!.clusters.find((candidate) => candidate.label === "fair · fair · nair")!;
    expect(cluster.size).toBe(20);
    // Half-open bands: 29 stays in 0–30, 30 starts 30–60, 120 starts 120%+.
    expect(cluster.percentBands.map((band) => [band.label, band.count])).toEqual([
      ["0–30%", 4],
      ["30–60%", 4],
      ["60–90%", 4],
      ["90–120%", 4],
      ["120%+", 4],
    ]);
    expect(cluster.percentBands.map((band) => band.kills)).toEqual([0, 0, 0, 4, 2]);
    expect(cluster.percentBands.map((band) => band.killRate)).toEqual([0, 0, 0, 1, 0.5]);
    expect(cluster.percentP25).toBe(37.5);
    expect(cluster.percentMedian).toBe(75);
    expect(cluster.percentP75).toBe(112.25);
  });

  it("returns an explicit insufficient-sample result below 25 openings", () => {
    const result = clusterOpenings(sequenceFixture().slice(0, 24));
    expect(result).toEqual({ status: "insufficient-sample", reason: "n-below-25", n: 24, required: 25 });
  });

  it("is deterministic under input shuffling", () => {
    const events = sequenceFixture();
    expect(clusterOpenings(reverse(events))).toEqual(clusterOpenings(events));
  });
});

describe("openingSequenceLabels", () => {
  it("returns null without a move list and maps ids in order", () => {
    expect(openingSequenceLabels(opening())).toBeNull();
    expect(openingSequenceLabels(opening({ moveIds: [14, 14, 13] }))).toEqual(["fair", "fair", "nair"]);
    expect(openingSequenceLabels(opening({ moveIds: [59], openerFamily: "special" }))).toEqual(["move #59"]);
  });

  it("uses the opening label for grab and projectile first hits only", () => {
    expect(openingSequenceLabels(opening({ moveIds: [54, 14], grab: true, openerLabel: "grab (bthrow)" }))).toEqual([
      "grab (bthrow)",
      "fair",
    ]);
    expect(
      openingSequenceLabels(opening({ moveIds: [1, 13], openerFamily: "projectile", openerLabel: "projectile" })),
    ).toEqual(["projectile", "nair"]);
  });
});
