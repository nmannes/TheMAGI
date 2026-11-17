import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { extractComboEndingEvents, POST_HIT_WINDOW_FRAMES, processGame } from "../src/pipeline";
import type {
  AttackInstance,
  ConversionRecord,
  RecoverySpan,
  StockRecord,
} from "../src/pipeline";
import type { FramesType } from "@slippi/slippi-js/node";

const TEST_REPLAYS_DIR = path.resolve(__dirname, "fixtures");
const BATTLEFIELD = 31;

// ── Synthetic-frame harness ──────────────────────────────────────────
//
// The detector only reads post-frame action states/positions/percent, so a
// sparse per-player timeline is enough to pin the final-hit anchor, the
// first-actionable boundary and each outcome flag.

const WAIT = 14;
const FAIR = 66; // aerial attack state; attackKindOf(66) === "aerial"
const DAMAGE_HI = 75;
const FALL = 29;
const JUMP_FORWARD = 25;

interface Post {
  actionStateId: number;
  positionX?: number;
  positionY?: number;
  percent?: number;
  isAirborne?: boolean;
}

function syntheticFrames(length: number, timelines: Record<number, (frame: number) => Post>): FramesType {
  const frames: Record<number, unknown> = {};
  for (let f = 0; f < length; f++) {
    const players: Record<number, unknown> = {};
    for (const [rawIndex, at] of Object.entries(timelines)) {
      const index = Number(rawIndex);
      players[index] = {
        pre: { positionX: 0, positionY: 0, percent: 0 },
        post: { positionX: 0, positionY: 0, percent: 0, isAirborne: false, ...at(f) },
      };
    }
    frames[f] = { frame: f, players };
  }
  return frames as unknown as FramesType;
}

function conversion(overrides: Partial<ConversionRecord> = {}): ConversionRecord {
  const moves = overrides.moves ?? [{ frame: 120, moveId: 14, damage: 12 }];
  const last = moves[moves.length - 1]!;
  return {
    attackerSlot: 0,
    startFrame: 90,
    endFrame: 210,
    startPercent: 10,
    endPercent: 22,
    damage: moves.reduce((sum, move) => sum + move.damage, 0),
    moveCount: moves.length,
    openerMoveId: moves[0]!.moveId,
    lastMoveId: last.moveId,
    openingType: "neutral-win",
    didKill: false,
    moves,
    ...overrides,
  };
}

function attack(overrides: Partial<AttackInstance> = {}): AttackInstance {
  return {
    playerSlot: 0,
    startFrame: 118,
    endFrame: 135,
    firstActionableFrame: 136,
    kind: "aerial",
    startStateId: FAIR,
    connected: true,
    onShield: false,
    ...overrides,
  };
}

function stock(overrides: Partial<StockRecord> = {}): StockRecord {
  return {
    victimSlot: 1,
    stockNumber: 1,
    startFrame: 0,
    endFrame: 141,
    startPercent: 0,
    deathPercent: 95,
    killerMoveId: 14,
    deathDirection: "left",
    died: true,
    verdict: "GOOD_DI",
    diScore: 0.9,
    diStickX: -0.7,
    diStickY: 0.7,
    launchAngleDeg: 40,
    resourceFault: false,
    finalHitFrame: 120,
    ...overrides,
  };
}

function span(overrides: Partial<RecoverySpan> = {}): RecoverySpan {
  return {
    playerSlot: 1,
    startFrame: 130,
    endFrame: 180,
    startX: 75,
    startY: 0,
    launchQuadrant: "right-high",
    djFrame: 150,
    djEarly: false,
    route: "mid",
    upbDelay: 20,
    airdodgeUsed: false,
    landing: "ledge",
    edgeguarderDepth: "onstage",
    edgeguarderInvincibleLedgeFrames: 0,
    contested: false,
    hitDuringRecovery: false,
    ...overrides,
  };
}

/** Victim in hitstun through 130, then free and standing onstage. */
function victimOnstage(f: number, overrides: Post = {}): Post {
  return { actionStateId: f <= 130 ? DAMAGE_HI : WAIT, positionX: 10, positionY: 0, percent: f === 120 ? 22 : 20, ...overrides };
}

/** Attacker still in the final-hit aerial through 135, actionable from 136. */
function attackerEndingFair(f: number, overrides: Post = {}): Post {
  return { actionStateId: f <= 135 ? FAIR : WAIT, positionX: 15, positionY: 0, ...overrides };
}

function run(
  conversions: ConversionRecord[],
  frames: FramesType,
  attacks: [AttackInstance[], AttackInstance[]] = [[attack()], []],
  stocks: StockRecord[] = [],
  spans: RecoverySpan[] = [],
  lastFrame = 400,
) {
  return extractComboEndingEvents(conversions, stocks, frames, lastFrame, BATTLEFIELD, 0, 1, attacks, spans);
}

describe("combo endings: anchor and ender", () => {
  it("anchors on the final connected hit, not conversion.endFrame", () => {
    // endFrame 210 is 45f after the victim regains control; the next own
    // conversion at 140 starts long before it. An endFrame anchor would miss it.
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run(
      [conversion({ endFrame: 210 }), conversion({ startFrame: 140, endFrame: 200, moves: [{ frame: 145, moveId: 13, damage: 8 }] })],
      frames,
    );

    expect(ending).toBeDefined();
    expect(ending!.lastHitFrame).toBe(120);
    expect(ending!.conversionEndFrame).toBe(210);
    expect(ending!.enderMoveId).toBe(14);
    expect(ending!.enderLabel).toBe("fair");
    expect(ending!.enderFamily).toBe("aerial");
    expect(ending!.extended).toBe(true);
  });

  it("labels grab enders by the exact throw/pummel move id", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run([conversion({ moves: [{ frame: 120, moveId: 54, damage: 10 }] })], frames);
    expect(ending!.enderMoveId).toBe(54);
    expect(ending!.enderLabel).toBe("bthrow");
    expect(ending!.enderFamily).toBe("grab");
  });
});

describe("combo endings: first actionable boundary", () => {
  it("NEGATIVE: the final hit's own endlag is not a post-hit decision", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run([conversion()], frames);

    expect(ending!.attackerFirstActionableFrame).toBe(136);
    expect(ending!.framesFromLastHitToActionable).toBe(16);
    expect(ending!.postHitDecision).toBe("none");
    expect(ending!.postHitStartFrame).toBeNull();
    expect(ending!.whiffed).toBe(false);
  });

  it("NEGATIVE: an opponent conversion during the attacker's endlag is not a punish", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run(
      [
        conversion(),
        conversion({
          attackerSlot: 1,
          startFrame: 130,
          endFrame: 170,
          moves: [{ frame: 132, moveId: 8, damage: 9 }],
        }),
      ],
      frames,
    );

    expect(ending!.attackerFirstActionableFrame).toBe(136);
    expect(ending!.punished).toBe(false);
    expect(ending!.punishDelay).toBeNull();
    expect(ending!.punishDamage).toBe(0);
  });

  it("falls back to a bounded scan when no attack instance contains the final hit", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run([conversion()], frames, [[], []]);
    expect(ending!.attackerFirstActionableFrame).toBe(136);
  });

  it("POSITIVE: a new own conversion after the actionable frame extends", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run(
      [
        conversion(),
        conversion({ startFrame: 140, endFrame: 200, moves: [{ frame: 145, moveId: 13, damage: 8 }] }),
      ],
      frames,
    );
    expect(ending!.extended).toBe(true);
  });

  it("NEGATIVE: an own conversion outside the 30f window does not extend", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run(
      [
        conversion(),
        conversion({ startFrame: 167, endFrame: 220, moves: [{ frame: 170, moveId: 13, damage: 8 }] }),
      ],
      frames,
    );
    expect(ending!.extended).toBe(false);
  });
});

describe("combo endings: post-hit decisions", () => {
  it("records an attack after the actionable frame and whether it connected", () => {
    const frames = syntheticFrames(400, {
      0: (f) => ({ actionStateId: f >= 140 && f <= 145 ? FAIR : WAIT, positionX: 15, positionY: 0 }),
      1: victimOnstage,
    });
    const [ending] = run(
      [conversion()],
      frames,
      [
        [
          attack(),
          attack({ startFrame: 140, endFrame: 145, firstActionableFrame: 146, connected: false }),
        ],
        [],
      ],
    );

    expect(ending!.postHitDecision).toBe("attack");
    expect(ending!.postHitMoveId).toBe(14); // fair
    expect(ending!.postHitMoveLabel).toBe("fair");
    expect(ending!.postHitStartFrame).toBe(140);
    expect(ending!.postHitConnected).toBe(false);
    expect(ending!.postHitOnShield).toBe(false);
    expect(ending!.whiffed).toBe(true);
  });

  it("does not count a shield hit as a connected true hit", () => {
    const frames = syntheticFrames(400, {
      0: (f) => ({ actionStateId: f >= 140 && f <= 145 ? FAIR : WAIT, positionX: 15, positionY: 0 }),
      1: victimOnstage,
    });
    const [ending] = run(
      [conversion()],
      frames,
      [[attack(), attack({ startFrame: 140, endFrame: 145, firstActionableFrame: 146, onShield: true })], []],
    );
    expect(ending!.postHitConnected).toBe(false);
    expect(ending!.postHitOnShield).toBe(true);
    expect(ending!.whiffed).toBe(false);
  });

  it("NEGATIVE: a special with no observed contact is unverified, not a whiff", () => {
    // A projectile special can hit after its action state ends. Missing hitlag
    // during the special therefore does not establish that it never connected.
    const SPECIAL = 341;
    const frames = syntheticFrames(400, {
      0: (f) => ({ actionStateId: f >= 140 && f <= 150 ? SPECIAL : WAIT, positionX: 15, positionY: 0 }),
      1: victimOnstage,
    });
    const [ending] = run(
      [conversion()],
      frames,
      [
        [
          attack(),
          attack({
            startFrame: 140,
            endFrame: 150,
            firstActionableFrame: 151,
            kind: "special",
            startStateId: SPECIAL,
            connected: false,
          }),
        ],
        [],
      ],
    );

    expect(ending!.postHitDecision).toBe("special");
    expect(ending!.postHitConnected).toBeNull();
    expect(ending!.postHitOnShield).toBeNull();
    expect(ending!.whiffed).toBe(false);
  });

  it("records direct special contact when hitlag establishes it", () => {
    const SPECIAL = 341;
    const frames = syntheticFrames(400, {
      0: (f) => ({ actionStateId: f >= 140 && f <= 150 ? SPECIAL : WAIT, positionX: 15, positionY: 0 }),
      1: victimOnstage,
    });
    const [ending] = run(
      [conversion()],
      frames,
      [
        [
          attack(),
          attack({
            startFrame: 140,
            endFrame: 150,
            firstActionableFrame: 151,
            kind: "special",
            startStateId: SPECIAL,
            connected: true,
          }),
        ],
        [],
      ],
    );

    expect(ending!.postHitDecision).toBe("special");
    expect(ending!.postHitConnected).toBe(true);
    expect(ending!.postHitOnShield).toBe(false);
    expect(ending!.whiffed).toBe(false);
  });

  it("records an opponent punish inside the window with delay, opener and damage", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run(
      [
        conversion(),
        conversion({
          attackerSlot: 1,
          startFrame: 145,
          endFrame: 190,
          moves: [
            { frame: 146, moveId: 8, damage: 12 },
            { frame: 175, moveId: 13, damage: 30 }, // outside the 136-166 window
          ],
        }),
      ],
      frames,
    );

    expect(ending!.punished).toBe(true);
    expect(ending!.punishDelay).toBe(9);
    expect(ending!.punishOpenerMoveId).toBe(8);
    expect(ending!.punishDamage).toBe(12);
  });

  it("NEGATIVE: an opponent hit after the window is not a punish", () => {
    const frames = syntheticFrames(400, { 0: attackerEndingFair, 1: victimOnstage });
    const [ending] = run(
      [
        conversion(),
        conversion({ attackerSlot: 1, startFrame: 167, endFrame: 200, moves: [{ frame: 168, moveId: 8, damage: 9 }] }),
      ],
      frames,
    );
    expect(ending!.punished).toBe(false);
  });

  it("classifies leaving the stage against an offstage victim as an edgeguard and links the recovery span", () => {
    const frames = syntheticFrames(400, {
      0: (f) => ({
        actionStateId: f <= 135 ? FAIR : f >= 140 ? JUMP_FORWARD : WAIT,
        positionX: f >= 140 ? 75 : 15,
        positionY: 0,
        isAirborne: f >= 140,
      }),
      1: (f) => ({ actionStateId: f <= 130 ? DAMAGE_HI : FALL, positionX: 75, positionY: 0, isAirborne: true }),
    });
    const [ending] = run([conversion()], frames, [[attack()], []], [], [span()]);

    expect(ending!.victimEndState).toBe("offstage");
    expect(ending!.postHitDecision).toBe("edgeguard");
    expect(ending!.postHitStartFrame).toBe(140);
    expect(ending!.edgeguardLinked).toBe(true);
  });

  it("NEGATIVE: an offstage victim with no overlapping recovery span is not edgeguard-linked", () => {
    const frames = syntheticFrames(400, {
      0: attackerEndingFair,
      1: (f) => ({ actionStateId: f <= 130 ? DAMAGE_HI : FALL, positionX: 75, positionY: 0, isAirborne: true }),
    });
    const [ending] = run([conversion()], frames, [[attack()], []], [], [span({ startFrame: 200, endFrame: 250 })]);

    expect(ending!.victimEndState).toBe("offstage");
    expect(ending!.edgeguardLinked).toBe(false);
  });
});

describe("combo endings: kills", () => {
  it("marks killed conversions dead and matches the stock death", () => {
    const frames = syntheticFrames(400, {
      0: attackerEndingFair,
      1: (f) => ({ actionStateId: f <= 130 ? DAMAGE_HI : WAIT, positionX: 85, positionY: 0, percent: 95 }),
    });
    const [ending] = run([conversion({ didKill: true, endFrame: 140, endPercent: 95 })], frames, [[attack()], []], [
      stock({ endFrame: 141 }),
    ]);

    expect(ending!.didKill).toBe(true);
    expect(ending!.victimEndState).toBe("dead");
    expect(ending!.deathFrame).toBe(141);
    expect(ending!.victimDeathPercent).toBe(95);
    expect(ending!.victimEndX).toBe(85);
  });

  it("NEGATIVE: a didKill conversion with no matching stock row falls back to the conversion's end frame and final-hit percent", () => {
    const frames = syntheticFrames(400, {
      0: attackerEndingFair,
      1: (f) => ({ actionStateId: f <= 130 ? DAMAGE_HI : WAIT, positionX: 85, positionY: 0, percent: 95 }),
    });
    const [ending] = run([conversion({ didKill: true, endFrame: 140, endPercent: 95 })], frames);

    expect(ending!.deathFrame).toBe(140);
    // No stock row: the end measurement still reports the final-hit percent.
    expect(ending!.victimDeathPercent).toBe(95);
  });
});

describe("combo endings: real replay invariants", () => {
  it("has well-formed endings that agree with their conversions", () => {
    const files = fs.readdirSync(TEST_REPLAYS_DIR).filter((file) => file.endsWith(".slp"));
    if (files.length === 0) throw new Error("No test replays found");
    const result = processGame(path.join(TEST_REPLAYS_DIR, files[0]!), 1);
    const events = result.frameEvents;
    const endings = events.comboEndings;

    expect(endings.length).toBeGreaterThan(0);
    const conversions = new Map(
      events.conversions
        .filter((c) => c.moves.length > 0)
        .map((c) => [`${c.attackerSlot}:${c.startFrame}`, c] as const),
    );

    const families = new Set(["aerial", "grounded", "special", "grab"]);
    const endStates = new Set(["dead", "offstage", "ledge", "knockdown", "airborne", "onstage", "unknown"]);
    const decisions = new Set(["attack", "special", "grab", "reposition", "defend", "edgeguard", "none"]);

    for (let i = 0; i < endings.length; i++) {
      const e = endings[i]!;
      const c = conversions.get(`${e.attackerSlot}:${e.conversionStartFrame}`);
      expect(c).toBeDefined();
      const finalMove = c!.moves[c!.moves.length - 1]!;
      expect(e.lastHitFrame).toBe(finalMove.frame);
      expect(e.enderMoveId).toBe(finalMove.moveId);
      expect(e.enderMoveId).toBe(c!.lastMoveId);
      expect(e.moveCount).toBe(c!.moveCount);
      expect(e.didKill).toBe(c!.didKill);
      expect(e.lastHitFrame).toBeGreaterThanOrEqual(e.conversionStartFrame);
      if (e.conversionEndFrame != null) {
        expect(e.lastHitFrame).toBeLessThanOrEqual(e.conversionEndFrame);
      }
      expect(families.has(e.enderFamily)).toBe(true);
      expect(endStates.has(e.victimEndState)).toBe(true);
      expect(decisions.has(e.postHitDecision)).toBe(true);
      if (e.didKill) expect(e.victimEndState).toBe("dead");

      if (e.attackerFirstActionableFrame != null) {
        expect(e.attackerFirstActionableFrame).toBeGreaterThanOrEqual(e.lastHitFrame);
        expect(e.framesFromLastHitToActionable).toBe(e.attackerFirstActionableFrame - e.lastHitFrame);
        if (e.postHitStartFrame != null) {
          expect(e.postHitStartFrame).toBeGreaterThanOrEqual(e.attackerFirstActionableFrame);
          expect(e.postHitStartFrame).toBeLessThanOrEqual(
            e.attackerFirstActionableFrame + POST_HIT_WINDOW_FRAMES,
          );
        }
      }
      if (e.punishDelay != null) {
        expect(e.punishDelay).toBeGreaterThanOrEqual(0);
        expect(e.punishDelay).toBeLessThanOrEqual(POST_HIT_WINDOW_FRAMES);
      }

      if (i > 0) {
        const prev = endings[i - 1]!;
        expect(e.lastHitFrame).toBeGreaterThanOrEqual(prev.lastHitFrame);
      }
    }
  });
});
