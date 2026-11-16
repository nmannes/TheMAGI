import { describe, expect, it } from "vitest";
import { Frames } from "@slippi/slippi-js/node";

import {
  OPENING_CLIP_MAX_FRAMES,
  OPENING_CLIP_POST_ROLL_FRAMES,
  OPENING_CLIP_PRE_ROLL_FRAMES,
  formatOpeningClipCaption,
  openingClipBounds,
  selectOpeningClipExamples,
} from "../src/openingClips";
import type {
  OpeningBaseline,
  OpeningBucket,
  OpeningClusterSummary,
  OpeningExample,
} from "../src/pipeline/openingClusters";
import type { OpeningsAgainstResult } from "../src/openingsAgainst";
import { FPS } from "../src/pipeline/helpers";

function example(overrides: Partial<OpeningExample> = {}): OpeningExample {
  return {
    gameId: 10,
    startFrame: 1000,
    timestamp: "0:20",
    situation: "commitment",
    openerFamily: "aerial",
    openerLabel: "dair",
    victimPercent: 42,
    damage: 31.5,
    didKill: false,
    ...overrides,
  };
}

function bucket(overrides: Partial<OpeningBucket> = {}): OpeningBucket {
  return {
    situation: "commitment",
    openerFamily: "aerial",
    openerLabel: "dair",
    count: 30,
    share: 0.3,
    kills: 8,
    killRate: 0.27,
    avgDamage: 31.5,
    avgFollowUpHits: 1.2,
    corneredShare: 0.2,
    onPlatformShare: 0.1,
    distinctGames: 12,
    splits: {
      percentBands: [],
      cornered: { count: 6, kills: 2, killRate: 0.33 },
      onPlatform: { count: 3, kills: 0, killRate: 0 },
    },
    examples: [example()],
    ...overrides,
  };
}

function cluster(overrides: Partial<OpeningClusterSummary> = {}): OpeningClusterSummary {
  return {
    id: 1,
    size: 22,
    share: 0.22,
    percentMean: 48,
    percentMedian: 45,
    distanceMean: 3.2,
    corneredShare: 0.3,
    onPlatformShare: 0.1,
    dominantSituation: "neutral-grounded",
    dominantFamily: "grounded",
    dominantOpenerLabel: "dash attack",
    killRate: 0.18,
    avgDamage: 24,
    distinctGames: 9,
    examples: [example({ situation: "neutral-grounded", openerFamily: "grounded", openerLabel: "dash attack" })],
    label: "Close range · 30–60% · center",
    ...overrides,
  };
}

const baseline: OpeningBaseline = {
  total: 100,
  kills: 22,
  killRate: 0.22,
  avgDamage: 28,
  avgMoveCount: 2.4,
  avgPercent: 45,
  corneredShare: 0.2,
  onPlatformShare: 0.1,
  situations: [],
  families: [],
  percentBands: [],
};

function result(overrides: Partial<OpeningsAgainstResult> = {}): OpeningsAgainstResult {
  return {
    coverage: { gamesInScope: 20, gamesWithOpenings: 18, gamesParsedCurrent: 18 },
    baseline,
    buckets: [bucket()],
    clusters: {
      status: "ok",
      n: 100,
      k: 2,
      minClusterSize: 8,
      silhouette: 0.42,
      weakSeparation: false,
      clusters: [cluster(), cluster({ id: 2, size: 78, share: 0.78, label: "Mid range · 60–90% · side" })],
    },
    examples: [example()],
    options: { characters: ["Fox"], opponentCharacters: ["Marth"], stages: ["Battlefield"] },
    ...overrides,
  };
}

describe("selectOpeningClipExamples", () => {
  it("defaults to the most frequent rule bucket and its most recent example", () => {
    const selected = selectOpeningClipExamples(result());
    expect(selected.source).toBe("bucket");
    expect(selected.id).toBe(1);
    expect(selected.title).toBe("commitment · aerial · dair");
    expect(selected.context).toContain("30 openings");
    expect(selected.context).toContain("8 kills");
    expect(selected.examples).toHaveLength(1);
  });

  it("selects an explicit bucket and up to --clips distinct navigable examples", () => {
    const buckets = [
      bucket(),
      bucket({
        situation: "shield",
        openerFamily: "grab",
        openerLabel: "grab (bthrow)",
        count: 18,
        examples: [
          example({ gameId: 11, startFrame: 500 }),
          example({ gameId: 11, startFrame: 500 }),
          example({ gameId: 12, startFrame: 700, didKill: true }),
          example({ gameId: null, startFrame: 900 }),
          example({ gameId: 13, startFrame: 950 }),
        ],
      }),
    ];
    const selected = selectOpeningClipExamples(result({ buckets }), { bucket: 2, limit: 3 });
    expect(selected.source).toBe("bucket");
    expect(selected.id).toBe(2);
    expect(selected.title).toBe("shield · grab · grab (bthrow)");
    expect(selected.examples.map((e) => [e.gameId, e.startFrame])).toEqual([
      [11, 500],
      [12, 700],
      [13, 950],
    ]);
  });

  it("selects a shape cluster by its displayed id", () => {
    const selected = selectOpeningClipExamples(result(), { cluster: 2 });
    expect(selected.source).toBe("cluster");
    expect(selected.id).toBe(2);
    expect(selected.title).toBe("neutral-grounded · grounded · dash attack");
    expect(selected.context).toContain("shape cluster #2");
    expect(selected.context).toContain("78 openings");
    expect(selected.examples).toHaveLength(1);
  });

  it("NEGATIVE: rejects an insufficient cluster sample instead of clipping an arbitrary event", () => {
    const insufficient = result({
      clusters: { status: "insufficient-sample", reason: "n-below-40", n: 12, required: 40, minClusterSize: 8 },
    });
    expect(() => selectOpeningClipExamples(insufficient, { cluster: 1 })).toThrow(/need 40 openings.*12 so far/i);
  });

  it("NEGATIVE: rejects both selectors, missing bucket positions and missing cluster ids", () => {
    expect(() => selectOpeningClipExamples(result(), { bucket: 1, cluster: 1 })).toThrow(/either --bucket or --cluster/);
    expect(() => selectOpeningClipExamples(result(), { bucket: 2 })).toThrow(/No rule bucket #2.*1–1/);
    expect(() => selectOpeningClipExamples(result(), { cluster: 9 })).toThrow(/No shape cluster #9.*1, 2/);
  });

  it("NEGATIVE: reports when the scope has no openings to clip", () => {
    expect(() => selectOpeningClipExamples(result({ buckets: [] }))).toThrow(/No rule buckets/);
    expect(() => selectOpeningClipExamples(result({ buckets: [bucket({ examples: [] })] }))).toThrow(
      /no navigable examples/,
    );
  });
});

describe("openingClipBounds", () => {
  it("uses the chronological opening-hit rolls: 5s lead-in and 2s follow-through", () => {
    const bounds = openingClipBounds(3000, 300);
    expect(bounds.startFrame).toBe(3000 - OPENING_CLIP_PRE_ROLL_FRAMES);
    expect(bounds.endFrame).toBe(3000 + OPENING_CLIP_POST_ROLL_FRAMES);
  });

  it("never starts before frame 0", () => {
    expect(openingClipBounds(60, 300).startFrame).toBe(0);
  });

  it("caps the end at the replay's last playable frame", () => {
    const durationSeconds = 100;
    const lastFrame = Frames.FIRST_PLAYABLE + Math.floor(durationSeconds * FPS);
    const hitFrame = lastFrame - 10;
    const bounds = openingClipBounds(hitFrame, durationSeconds);
    expect(bounds.endFrame).toBe(lastFrame);
    expect(bounds.endFrame).toBeGreaterThan(hitFrame);
  });

  it("keeps a clip under the 20-second cap even with inconsistent durations", () => {
    const bounds = openingClipBounds(5000, 0);
    expect(bounds.endFrame - bounds.startFrame).toBeLessThanOrEqual(OPENING_CLIP_MAX_FRAMES);
  });
});

describe("formatOpeningClipCaption", () => {
  const game = {
    playerTag: "POOK",
    playerCharacter: "Fox",
    opponentTag: "RIVAL",
    opponentCharacter: "Marth",
    stage: "Battlefield",
  };

  it("POSITIVE: names the exact measured opening, its cost and the bucket sample size", () => {
    const selected = selectOpeningClipExamples(result());
    const caption = formatOpeningClipCaption(
      selected,
      example({ didKill: true, damage: 55.2, victimPercent: 71 }),
      game,
    );
    expect(caption).toContain("Opening against you — commitment · aerial · dair");
    expect(caption).toContain("POOK (Fox) vs RIVAL (Marth) · Battlefield");
    expect(caption).toContain("71% before the hit");
    expect(caption).toContain("55.2% over the full conversion · took the stock");
    expect(caption).toContain("rule bucket #1 · 30 openings");
  });

  it("NEGATIVE: does not claim a stock was taken when the conversion did not kill", () => {
    const selected = selectOpeningClipExamples(result());
    const caption = formatOpeningClipCaption(selected, example({ didKill: false }), game);
    expect(caption).not.toContain("took the stock");
    expect(caption).toContain("🟥");
  });

  it("keeps the grab label exactly as measured and stays under Telegram's caption limit", () => {
    const selected = selectOpeningClipExamples(result());
    const caption = formatOpeningClipCaption(
      selected,
      example({ situation: "shield", openerFamily: "grab", openerLabel: "grab (bthrow)", damage: 10 }),
      { ...game, playerTag: "x".repeat(2000) },
    );
    expect(caption).toContain("grab (bthrow)");
    expect(caption.length).toBeLessThanOrEqual(1024);
  });
});
