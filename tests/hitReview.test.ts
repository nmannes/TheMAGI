import { describe, expect, it } from "vitest";

import {
  extractHitReview,
  findTargetSlot,
  formatHitReviewCaption,
  HitReviewTargetError,
  selectHitSequences,
  type HitReviewSequence,
} from "../src/hitReview";
import type { ConversionRecord, GameResult, StockRecord } from "../src/pipeline/types";

function makeGame(conversions: ConversionRecord[], stocks: StockRecord[], duration = 300): GameResult {
  return {
    gameSummary: {
      gameNumber: 1,
      stage: "Battlefield",
      duration,
      result: {
        winner: "pook",
        endMethod: "NORMAL",
        finalStocks: [4, 0],
        finalPercents: [0, 0],
      },
      players: [
        { tag: "pook", connectCode: "POOK#392", character: "Fox" },
        { tag: "rival", connectCode: "RIVAL#1", character: "Ness" },
      ],
    },
    derivedInsights: [{}, {}],
    highlights: [[], []],
    frameEvents: {
      conversions,
      stocks,
      habits: [],
      throwDI: [],
      recoverySpans: [],
      shieldBlocks: [],
      whiffs: [],
      attacks: [[], []],
      neutralSegments: [],
    },
    startAt: "2026-11-15T10:00:00.000Z",
  } as unknown as GameResult;
}

function makeConversion(
  moves: { frame: number; moveId: number; damage: number }[],
  overrides: Partial<ConversionRecord> = {},
): ConversionRecord {
  const damage = moves.reduce((total, move) => total + move.damage, 0);
  return {
    attackerSlot: 1,
    startFrame: moves[0]?.frame ?? 0,
    endFrame: moves[moves.length - 1]?.frame ?? 0,
    startPercent: 0,
    endPercent: damage,
    damage,
    moveCount: moves.length,
    openerMoveId: moves[0]?.moveId ?? null,
    lastMoveId: moves[moves.length - 1]?.moveId ?? null,
    openingType: "neutral-win",
    didKill: false,
    moves,
    ...overrides,
  };
}

function makeStock(overrides: Partial<StockRecord> = {}): StockRecord {
  return {
    victimSlot: 0,
    stockNumber: 1,
    startFrame: 0,
    endFrame: 1000,
    startPercent: 0,
    deathPercent: 100,
    killerMoveId: 14,
    deathDirection: "left",
    died: true,
    verdict: "GOOD_DI",
    diScore: 0.9,
    diStickX: null,
    diStickY: null,
    launchAngleDeg: null,
    resourceFault: false,
    finalHitFrame: null,
    ...overrides,
  };
}

function onlySequence(sequences: HitReviewSequence[]): HitReviewSequence {
  expect(sequences).toHaveLength(1);
  return sequences[0]!;
}

describe("findTargetSlot", () => {
  const players = [
    { tag: "pook", connectCode: "POOK#392" },
    { tag: "rival", connectCode: "RIVAL#1" },
  ];

  it("matches tag, full connect code, and bare code prefix", () => {
    expect(findTargetSlot(players, "pook")).toBe(0);
    expect(findTargetSlot(players, "POOK#392")).toBe(0);
    expect(findTargetSlot(players, "pOoK")).toBe(0);
    expect(findTargetSlot(players, "POOK")).toBe(0);
    expect(findTargetSlot(players, "RIVAL#1")).toBe(1);
  });

  it("throws a typed error when the target is absent", () => {
    expect(() => findTargetSlot(players, "nobody")).toThrow(HitReviewTargetError);
    expect(() => findTargetSlot(players, "nobody")).toThrow(/not found/i);
  });
});

describe("extractHitReview", () => {
  it("keeps hits where the target is the victim and ignores hits they landed", () => {
    const taken = makeConversion(
      [
        { frame: 100, moveId: 14, damage: 10 },
        { frame: 130, moveId: 13, damage: 5 },
      ],
      { startPercent: 20, endPercent: 35 },
    );
    const landed = makeConversion([{ frame: 200, moveId: 11, damage: 20 }], {
      attackerSlot: 0,
      startPercent: 0,
      endPercent: 20,
    });
    const later = makeConversion([{ frame: 400, moveId: 15, damage: 20 }], { startPercent: 40, endPercent: 60 });

    const sequences = extractHitReview(makeGame([taken, landed, later], []), "POOK#392", "/replays/game.slp");

    expect(sequences).toHaveLength(2);
    expect(sequences[0]!.hits.map((hit) => hit.frame)).toEqual([100, 130]);
    expect(sequences[0]!.damage).toBe(15);
    expect(sequences[0]!.moveCount).toBe(2);
    expect(sequences[0]!.startPercent).toBe(20);
    expect(sequences[0]!.endPercent).toBe(35);
    expect(sequences[0]!.clipStartFrame).toBe(10);
    expect(sequences[0]!.clipEndFrame).toBe(220);
    expect(sequences[1]!.hits.map((hit) => hit.frame)).toEqual([400]);
    expect(sequences[1]!.damage).toBe(20);
  });

  it("splits hits that are more than 45 frames apart", () => {
    const conversion = makeConversion([
      { frame: 100, moveId: 14, damage: 5 },
      { frame: 140, moveId: 13, damage: 5 },
      { frame: 200, moveId: 15, damage: 5 },
    ]);

    const sequences = extractHitReview(makeGame([conversion], []), "pook", "/replays/game.slp");

    expect(sequences).toHaveLength(2);
    expect(sequences[0]!.hits.map((hit) => hit.frame)).toEqual([100, 140]);
    expect(sequences[1]!.hits.map((hit) => hit.frame)).toEqual([200]);
  });

  it("does not merge hits across a stock death", () => {
    const conversion = makeConversion([
      { frame: 100, moveId: 14, damage: 5 },
      { frame: 140, moveId: 13, damage: 5 },
    ]);
    const stock = makeStock({
      stockNumber: 1,
      endFrame: 120,
      deathPercent: 10,
      killerMoveId: 14,
      finalHitFrame: 100,
    });

    const sequences = extractHitReview(makeGame([conversion], [stock]), "pook", "/replays/game.slp");

    expect(sequences).toHaveLength(2);
    expect(sequences[0]!.death?.stockNumber).toBe(1);
    expect(sequences[1]!.death).toBeNull();
  });

  it("associates a killing conversion and exposes only measured DI", () => {
    const conversion = makeConversion([{ frame: 400, moveId: 54, damage: 10 }], {
      didKill: true,
      startPercent: 140,
      endPercent: 150,
      endFrame: 500,
    });
    const stock = makeStock({
      stockNumber: 2,
      endFrame: 500,
      deathPercent: 150,
      killerMoveId: 54,
      verdict: "WRONG_DI",
      diScore: 0.1,
      deathDirection: "left",
    });

    const sequence = onlySequence(
      extractHitReview(makeGame([conversion], [stock], 600), "POOK#392", "/replays/game.slp"),
    );

    expect(sequence.didKill).toBe(true);
    expect(sequence.death).toMatchObject({
      stockNumber: 2,
      deathPercent: 150,
      killerMoveName: "bthrow",
      deathDirection: "left",
      verdict: "WRONG_DI",
      diScore: 0.1,
    });
    expect(sequence.clipStartFrame).toBe(310);
    expect(sequence.clipEndFrame).toBe(550);

    const caption = formatHitReviewCaption(sequence);
    expect(caption).toContain("Stock lost");
    expect(caption).toContain("bthrow");
    expect(caption).toContain("DI: wrong DI (0.10)");
  });

  it("does not claim DI when the death has no measured diScore", () => {
    const conversion = makeConversion([{ frame: 400, moveId: 17, damage: 12 }], {
      didKill: true,
      startPercent: 80,
      endPercent: 92,
      endFrame: 500,
    });
    const stock = makeStock({
      stockNumber: 1,
      endFrame: 500,
      deathPercent: 92,
      killerMoveId: 17,
      verdict: "FAILED_RECOVERY",
      diScore: null,
    });

    const sequence = onlySequence(extractHitReview(makeGame([conversion], [stock], 600), "pook", "/replays/game.slp"));
    const caption = formatHitReviewCaption(sequence);

    expect(caption).toContain("DI: not measured for this hit");
    expect(caption).not.toContain("FAILED_RECOVERY");
    expect(caption).not.toContain("DI: failed");
  });

  it("falls back to the stock's killing move when conversion end frames differ", () => {
    const conversion = makeConversion([{ frame: 400, moveId: 54, damage: 10 }], {
      didKill: true,
      startPercent: 100,
      endPercent: 110,
      endFrame: 500,
    });
    const stock = makeStock({
      endFrame: 515,
      deathPercent: 110,
      killerMoveId: 54,
    });

    const sequence = onlySequence(extractHitReview(makeGame([conversion], [stock], 600), "pook", "/replays/game.slp"));
    expect(sequence.didKill).toBe(true);
    expect(sequence.death?.stockNumber).toBe(1);
  });

  it("clamps a clip to the end of the replay", () => {
    const conversion = makeConversion([{ frame: 1050, moveId: 14, damage: 8 }], {
      didKill: true,
      startPercent: 90,
      endPercent: 98,
      endFrame: 1060,
    });
    const stock = makeStock({
      endFrame: 1060,
      deathPercent: 98,
      killerMoveId: 14,
      finalHitFrame: 1050,
    });
    // 20 seconds of gameplay: Slippi's first playable frame is -39, so the
    // last frame is -39 + 1200 = 1161.
    const sequence = onlySequence(extractHitReview(makeGame([conversion], [stock], 20), "pook", "/replays/game.slp"));

    expect(sequence.clipStartFrame).toBe(960);
    expect(sequence.clipEndFrame).toBe(1161);
  });

  it("emits an unattributed-death clip when a stock has no associated hit", () => {
    const stock = makeStock({
      stockNumber: 3,
      startFrame: 700,
      endFrame: 1000,
      startPercent: 0,
      deathPercent: 0,
      killerMoveId: null,
      verdict: "SD",
      diScore: null,
      finalHitFrame: null,
    });

    const sequence = onlySequence(extractHitReview(makeGame([], [stock], 300), "pook", "/replays/game.slp"));

    expect(sequence.kind).toBe("unattributed-death");
    expect(sequence.didKill).toBe(true);
    expect(sequence.moveCount).toBe(0);
    expect(sequence.death?.verdict).toBe("SD");
    expect(sequence.clipStartFrame).toBe(820);
    expect(sequence.clipEndFrame).toBe(1030);
    expect(formatHitReviewCaption(sequence)).toContain("no hit attributed");
  });
});

describe("selectHitSequences", () => {
  function sequence(overrides: Partial<HitReviewSequence>): HitReviewSequence {
    return {
      kind: "hits",
      replayPath: "/replays/game.slp",
      gameNumber: 1,
      startAt: "2026-11-15T10:00:00.000Z",
      stage: "Battlefield",
      target: { slot: 0, tag: "pook", connectCode: "POOK#392", character: "Fox" },
      opponent: { slot: 1, tag: "rival", connectCode: "RIVAL#1", character: "Ness" },
      clipStartFrame: 0,
      clipEndFrame: 200,
      firstHitFrame: 100,
      lastHitFrame: 100,
      timestamp: "0:03",
      startPercent: 0,
      endPercent: 10,
      damage: 10,
      moveCount: 1,
      hits: [],
      openingTypes: ["neutral-win"],
      didKill: false,
      death: null,
      score: 14,
      ...overrides,
    };
  }

  it("ranks a death above a higher-damage nonlethal sequence", () => {
    const nonlethal = sequence({ damage: 70, score: 74 });
    const death = sequence({ firstHitFrame: 500, damage: 20, didKill: true, score: 120 });

    const selected = selectHitSequences([nonlethal, death], { limit: 1 });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.didKill).toBe(true);
  });

  it("applies minDamage and deathsOnly filters", () => {
    const small = sequence({ damage: 5 });
    const big = sequence({ damage: 40, firstHitFrame: 300 });
    const death = sequence({ damage: 10, didKill: true, firstHitFrame: 600 });

    expect(selectHitSequences([small, big, death], { minDamage: 10 }).map((s) => s.damage)).toEqual([40, 10]);
    expect(selectHitSequences([small, big, death], { deathsOnly: true }).map((s) => s.damage)).toEqual([10]);
  });

  it("uses limit 0 to mean no limit", () => {
    const sequences = [sequence({ firstHitFrame: 100 }), sequence({ firstHitFrame: 200 })];
    expect(selectHitSequences(sequences, { limit: 0 })).toHaveLength(2);
  });
});
