import { describe, it, expect } from "vitest";
import type { OpeningEvent } from "../src/pipeline/frameEvents";
import {
  aggregateOpeningBuckets,
  clusterOpenings,
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

function clusterFixture(): OpeningEvent[] {
  const events: OpeningEvent[] = [];
  for (let i = 0; i < 30; i++) {
    events.push(
      opening({
        id: i + 1,
        gameId: Math.floor(i / 5) + 1,
        startFrame: 100 + i,
        stageId: 32,
        situation: "commitment",
        openerFamily: "grounded",
        openerLabel: "dash attack",
        victimPercent: 20 + (i % 5),
        relativeX: -5 + (i % 3),
        relativeY: 0,
        distance: 20 + (i % 3),
        victimX: -50 + (i % 3),
        victimY: 0,
        onPlatform: false,
        damage: 8,
        moveCount: 1,
        didKill: i % 10 === 0,
      }),
    );
  }
  for (let i = 0; i < 30; i++) {
    events.push(
      opening({
        id: 31 + i,
        gameId: Math.floor(i / 5) + 7,
        startFrame: 300 + i,
        stageId: 32,
        situation: "shield",
        openerFamily: "grab",
        openerLabel: "grab (bthrow)",
        grab: true,
        openerMoveId: 54,
        victimPercent: 100 + (i % 5),
        relativeX: 30 + (i % 3),
        relativeY: 10,
        distance: 70 + (i % 3),
        victimX: 60 + (i % 3),
        victimY: 0,
        onPlatform: false,
        damage: 12,
        moveCount: 2,
        didKill: i % 15 === 0,
      }),
    );
  }
  return events;
}

function reverse<T>(items: T[]): T[] {
  return [...items].reverse();
}

describe("openingClusters: statistical clusters", () => {
  it("returns an explicit insufficient-sample result below 40 openings", () => {
    const result = clusterOpenings(clusterFixture().slice(0, 39));
    expect(result).toEqual({
      status: "insufficient-sample",
      reason: "n-below-40",
      n: 39,
      required: 40,
      minClusterSize: 8,
    });
  });

  it("clusters a separated set with valid sizes and descriptive labels", () => {
    const events = clusterFixture();
    const result = clusterOpenings(events);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.n).toBe(60);
    expect(result.k).toBeGreaterThanOrEqual(2);
    expect(result.k).toBeLessThanOrEqual(6);
    expect(result.minClusterSize).toBe(8);
    expect(result.clusters.reduce((sum, c) => sum + c.size, 0)).toBe(60);
    expect(result.clusters.map((c) => c.id)).toEqual(result.clusters.map((_, i) => i + 1));
    for (const cluster of result.clusters) {
      expect(cluster.size).toBeGreaterThanOrEqual(result.minClusterSize);
      expect(cluster.share).toBeGreaterThan(0);
      expect(cluster.examples.length).toBeGreaterThan(0);
      expect(cluster.label).toMatch(/^(close|mid|far) range · /);
      expect(cluster.label).not.toMatch(/ken|combo|wavedash|tech chase|grab|dash attack/i);
    }
    expect(result.weakSeparation).toBe(result.silhouette < 0.2);

    const dash = result.clusters.find((c) => c.dominantOpenerLabel === "dash attack")!;
    expect(dash.dominantSituation).toBe("commitment");
    expect(dash.dominantFamily).toBe("grounded");
    const grab = result.clusters.find((c) => c.dominantOpenerLabel === "grab (bthrow)")!;
    expect(grab.dominantSituation).toBe("shield");
    expect(grab.dominantFamily).toBe("grab");
  });

  it("is deterministic under input shuffling and repeated calls", () => {
    const events = clusterFixture();
    const first = clusterOpenings(events);
    const second = clusterOpenings(events);
    const shuffled = clusterOpenings(reverse(events));
    expect(second).toEqual(first);
    expect(shuffled).toEqual(first);
  });

  it("honors a forced k within 2-6 and rejects an out-of-range k", () => {
    const result = clusterOpenings(clusterFixture(), { k: 3 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.k).toBe(3);

    const invalid = clusterOpenings(clusterFixture(), { k: 1 });
    expect(invalid.status).toBe("insufficient-sample");
    if (invalid.status === "insufficient-sample") expect(invalid.reason).toBe("no-valid-k");
  });

  it("returns no-valid-k when every candidate partitions a point below the minimum size", () => {
    const identical = Array.from({ length: 40 }, (_, i) =>
      opening({ id: i + 1, gameId: 1, startFrame: 100 + i, stageId: 32 }),
    );
    const result = clusterOpenings(identical);
    expect(result.status).toBe("insufficient-sample");
    if (result.status === "insufficient-sample") {
      expect(result.reason).toBe("no-valid-k");
      expect(result.minClusterSize).toBe(8);
    }
  });

  it("enforces the minimum cluster size against a single outlier", () => {
    const withOutlier = [
      ...Array.from({ length: 44 }, (_, i) =>
        opening({
          id: i + 1,
          gameId: 1,
          startFrame: 100 + i,
          stageId: 32,
          victimPercent: 40 + (i % 3),
          relativeX: 10,
          distance: 20,
          victimX: 0,
        }),
      ),
      opening({
        id: 45,
        gameId: 1,
        startFrame: 300,
        stageId: 32,
        victimPercent: 140,
        relativeX: -120,
        relativeY: 80,
        distance: 220,
        victimX: -80,
      }),
    ];
    expect(withOutlier).toHaveLength(45);
    // minClusterSize = max(8, ceil(0.05 * 45)) = 8, so the isolated outlier
    // can never form a legal cluster and no k is accepted.
    const result = clusterOpenings(withOutlier);
    expect(result.status).toBe("insufficient-sample");
    if (result.status === "insufficient-sample") {
      expect(result.reason).toBe("no-valid-k");
      expect(result.minClusterSize).toBe(8);
    }
  });
});
