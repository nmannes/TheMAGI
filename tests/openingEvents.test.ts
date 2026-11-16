import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { SlippiGame } from "@slippi/slippi-js/node";
import type { FramesType } from "@slippi/slippi-js/node";
import { processGame } from "../src/pipeline/processGame";
import { extractOpeningEvents } from "../src/pipeline/openingEvents";
import type { ConversionRecord, OpeningEvent, StockRecord } from "../src/pipeline/frameEvents";
import { isOffstage, moveIdToName } from "../src/pipeline/helpers";

const TEST_REPLAYS_DIR = path.resolve(__dirname, "fixtures");
const SCENARIOS = ["neutral-grounded", "neutral-airborne", "shield", "shieldstun", "commitment", "landing"];
const FAMILIES = ["aerial", "grounded", "special", "projectile", "grab"];

type SyntheticPost = {
  actionStateId: number;
  positionX?: number;
  positionY?: number;
  percent?: number;
  facingDirection?: number;
  stocksRemaining?: number;
};

interface SyntheticItem {
  typeId: number;
  owner: number;
  state?: number;
}

/** Minimal FramesType stand-in for both players plus items. */
function syntheticFrames(
  length: number,
  postAt: (playerIndex: number, f: number) => SyntheticPost,
  itemsAt?: (f: number) => SyntheticItem[],
): FramesType {
  const frames: Record<number, unknown> = {};
  for (let f = 0; f < length; f++) {
    const items = itemsAt?.(f);
    frames[f] = {
      frame: f,
      players: {
        0: { pre: {}, post: { positionX: 0, positionY: 0, percent: 0, facingDirection: 1, ...postAt(0, f) } },
        1: { pre: {}, post: { positionX: 0, positionY: 0, percent: 0, facingDirection: -1, ...postAt(1, f) } },
      },
      ...(items ? { items } : {}),
    };
  }
  return frames as unknown as FramesType;
}

function conversion(overrides: Partial<ConversionRecord> & { startFrame: number; attackerSlot: 0 | 1 }): ConversionRecord {
  const moveId = overrides.openerMoveId ?? 14;
  return {
    startFrame: overrides.startFrame,
    attackerSlot: overrides.attackerSlot,
    endFrame: overrides.startFrame + 20,
    startPercent: 20,
    endPercent: 30,
    damage: 10,
    moveCount: 1,
    openerMoveId: moveId,
    lastMoveId: moveId,
    openingType: "neutral-win",
    didKill: false,
    moves: [{ frame: overrides.startFrame, moveId, damage: 10 }],
    ...overrides,
  };
}

function stock(overrides: Partial<StockRecord> & { victimSlot: 0 | 1; stockNumber: number; endFrame: number }): StockRecord {
  return {
    victimSlot: overrides.victimSlot,
    stockNumber: overrides.stockNumber,
    startFrame: 0,
    endFrame: overrides.endFrame,
    startPercent: 0,
    deathPercent: 40,
    killerMoveId: 14,
    deathDirection: "right",
    died: true,
    verdict: "GOOD_DI",
    diScore: 0.9,
    diStickX: 1,
    diStickY: 0,
    launchAngleDeg: 45,
    resourceFault: false,
    finalHitFrame: overrides.endFrame - 5,
    ...overrides,
  };
}

const STANDING = 14;
const GUARD = 179;
const NAIR = 65;
const FAIR_LANDING = 72;

function run(
  player0: (f: number) => SyntheticPost,
  player1: (f: number) => SyntheticPost,
  conversions: ConversionRecord[],
  stocks: StockRecord[] = [],
  itemsAt?: (f: number) => SyntheticItem[],
  stageId = 32,
): OpeningEvent[] {
  const frames = syntheticFrames(200, (idx, f) => (idx === 0 ? player0(f) : player1(f)), itemsAt);
  return extractOpeningEvents(conversions, stocks, frames, 199, stageId, 0, 1);
}

describe("openingEvents: positive classifications", () => {
  it("records a grounded neutral hit with pre-hit percent and position", () => {
    const events = run(
      () => ({ actionStateId: STANDING, positionX: -10, percent: 25, facingDirection: 1 }),
      () => ({ actionStateId: STANDING, positionX: 20, percent: 60 }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 6 })],
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.victimSlot).toBe(0);
    expect(e.attackerSlot).toBe(1);
    expect(e.startFrame).toBe(100);
    expect(e.situation).toBe("neutral-grounded");
    expect(e.openerFamily).toBe("grounded");
    expect(e.openerLabel).toBe("dash attack");
    expect(e.victimState).toBe(STANDING);
    expect(e.victimPercent).toBe(25);
    expect(e.attackerPercent).toBe(60);
    expect(e.relativeX).toBe(30); // (20 - -10) * facing 1
    expect(e.distance).toBe(30);
    expect(e.grab).toBe(false);
  });

  it("labels a shield grab at the grab frame and shows the throw as detail", () => {
    const events = run(
      () => ({ actionStateId: GUARD, positionX: 0, percent: 30 }),
      () => ({ actionStateId: STANDING, positionX: 10 }),
      [
        conversion({
          startFrame: 100,
          attackerSlot: 1,
          openerMoveId: 54, // bthrow
          // The first damaging move happens later; the event frame stays the grab frame.
          moves: [{ frame: 130, moveId: 54, damage: 8 }],
        }),
      ],
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.startFrame).toBe(100);
    expect(e.situation).toBe("shield");
    expect(e.grab).toBe(true);
    expect(e.openerFamily).toBe("grab");
    expect(e.openerMoveId).toBe(54);
    expect(e.openerLabel).toBe("grab (bthrow)");
  });

  it("labels an own aerial as a commitment", () => {
    const events = run(
      () => ({ actionStateId: NAIR }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 14 })],
    );
    expect(events[0]!.situation).toBe("commitment");
    expect(events[0]!.openerFamily).toBe("aerial");
    expect(events[0]!.openerLabel).toBe("fair");
  });

  it("labels landing lag", () => {
    const events = run(
      () => ({ actionStateId: FAIR_LANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 12 })],
    );
    expect(events[0]!.situation).toBe("landing");
    expect(events[0]!.openerFamily).toBe("grounded");
    expect(events[0]!.openerLabel).toBe("dsmash");
  });

  it("labels shieldstun separately from an idle shield", () => {
    const events = run(
      () => ({ actionStateId: 181 }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 13 })],
    );
    expect(events[0]!.situation).toBe("shieldstun");
  });

  it("claims projectile only with an unattributed move plus an attacker-owned item", () => {
    const withItem = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 1 })],
      [],
      (f) => (f === 99 ? [{ typeId: 55, owner: 1 }] : []),
    );
    expect(withItem[0]!.openerFamily).toBe("projectile");
    expect(withItem[0]!.openerLabel).toBe("projectile");

    // A normal aerial with a stray item on screen stays a normal aerial.
    const withAerial = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 14 })],
      [],
      () => [{ typeId: 55, owner: 1 }],
    );
    expect(withAerial[0]!.openerFamily).toBe("aerial");
    expect(withAerial[0]!.openerLabel).toBe("fair");

    // A special move id is not relabeled from item presence alone.
    const withSpecial = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 19 })],
      [],
      () => [{ typeId: 55, owner: 1 }],
    );
    expect(withSpecial[0]!.openerFamily).toBe("special");
    expect(withSpecial[0]!.openerLabel).toBe(moveIdToName[19]);

    // No item evidence: the unattributed move stays special, not projectile.
    const noItem = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 1 })],
    );
    expect(noItem[0]!.openerFamily).toBe("special");
  });
});

describe("openingEvents: neutral gate negatives", () => {
  const cases: Array<[string, number]> = [
    ["hitstun", 75],
    ["tumbling", 38],
    ["knockdown", 183],
    ["tech", 199],
    ["captured", 223],
    ["thrown", 241],
    ["ledge hang", 253],
    ["dead", 4],
    ["respawn", 12],
    ["command grabbed", 266],
  ];
  for (const [name, state] of cases) {
    it(`excludes a conversion that starts in ${name}`, () => {
      const events = run(
        () => ({ actionStateId: state }),
        () => ({ actionStateId: STANDING }),
        [conversion({ startFrame: 100, attackerSlot: 1 })],
      );
      expect(events).toHaveLength(0);
    });
  }

  it("excludes an onstage-state victim who is actually offstage", () => {
    const events = run(
      () => ({ actionStateId: STANDING, positionX: 90, positionY: 0 }), // FD ledge is 85.57
      () => ({ actionStateId: STANDING, positionX: 80 }),
      [conversion({ startFrame: 100, attackerSlot: 1 })],
    );
    expect(events).toHaveLength(0);
  });

  it("produces nothing for an SD (no conversion exists to read)", () => {
    expect(run(() => ({ actionStateId: STANDING }), () => ({ actionStateId: STANDING }), [])).toEqual([]);
  });
});

describe("openingEvents: trades, position math and stock linkage", () => {
  it("flags both conversions of a same-frame trade", () => {
    const events = run(
      () => ({ actionStateId: STANDING, positionX: -5 }),
      () => ({ actionStateId: STANDING, positionX: 5 }),
      [conversion({ startFrame: 100, attackerSlot: 0, openerMoveId: 13 }), conversion({ startFrame: 100, attackerSlot: 1, openerMoveId: 15 })],
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.traded)).toBe(true);
    expect(events.map((e) => e.victimSlot).sort()).toEqual([0, 1]);
  });

  it("does not flag conversions that start on different frames", () => {
    const events = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1 }), conversion({ startFrame: 140, attackerSlot: 0 })],
    );
    expect(events.every((e) => !e.traded)).toBe(true);
  });

  it("uses the victim-facing frame for relative X and the habit corner rule", () => {
    const cornered = run(
      () => ({ actionStateId: STANDING, positionX: 80, positionY: 0, facingDirection: -1 }), // FD, facing left
      () => ({ actionStateId: STANDING, positionX: 70, positionY: 5 }),
      [conversion({ startFrame: 100, attackerSlot: 1 })],
    )[0]!;
    expect(cornered.cornered).toBe(true);
    expect(cornered.relativeX).toBe(10); // (70 - 80) * -1
    expect(cornered.relativeY).toBe(5);
    expect(cornered.distance).toBe(11.18);

    const center = run(
      () => ({ actionStateId: STANDING, positionX: 40, positionY: 0 }),
      () => ({ actionStateId: STANDING, positionX: 20, positionY: 0 }),
      [conversion({ startFrame: 100, attackerSlot: 1 })],
    )[0]!;
    expect(center.cornered).toBe(false);
  });

  it("flags a victim standing on a platform by stage height", () => {
    const events = run(
      () => ({ actionStateId: STANDING, positionX: 0, positionY: 30 }),
      () => ({ actionStateId: STANDING, positionX: 10, positionY: 30 }),
      [conversion({ startFrame: 100, attackerSlot: 1 })],
      [],
      undefined,
      31, // Battlefield: platform threshold 27
    );
    expect(events[0]!.onPlatform).toBe(true);
  });

  it("links a killing opening to the victim's stock record", () => {
    const events = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1, endFrame: 150, didKill: true })],
      [stock({ victimSlot: 0, stockNumber: 2, endFrame: 150 })],
    );
    expect(events[0]!).toMatchObject({ stockNumber: 2, deathFrame: 150, deathVerdict: "GOOD_DI" });
  });

  it("leaves stock fields null when the conversion did not kill", () => {
    const events = run(
      () => ({ actionStateId: STANDING }),
      () => ({ actionStateId: STANDING }),
      [conversion({ startFrame: 100, attackerSlot: 1 })],
      [stock({ victimSlot: 0, stockNumber: 2, endFrame: 150 })],
    );
    expect(events[0]!).toMatchObject({ stockNumber: null, deathFrame: null, deathVerdict: null });
  });
});

describe("openingEvents: fixture invariants", () => {
  const files = fs
    .readdirSync(TEST_REPLAYS_DIR)
    .filter((f) => f.endsWith(".slp"))
    .map((f) => path.join(TEST_REPLAYS_DIR, f));

  it("produces well-formed, sorted records on every fixture", () => {
    for (const file of files) {
      const result = processGame(file, 1);
      const openings = result.frameEvents.openings;
      expect(openings.length, path.basename(file)).toBeGreaterThan(0);

      const game = new SlippiGame(file);
      const frames = game.getFrames();
      const settings = game.getSettings()!;
      const stageId = settings.stageId!;
      const slots = settings.players.filter((p) => p.type !== 3);
      const indexBySlot: [number, number] = [slots[0]!.playerIndex, slots[1]!.playerIndex];
      for (let i = 0; i < openings.length; i++) {
        const e = openings[i]!;
        expect([0, 1]).toContain(e.victimSlot);
        expect(e.attackerSlot).toBe(e.victimSlot === 0 ? 1 : 0);
        expect(SCENARIOS).toContain(e.situation);
        expect(FAMILIES).toContain(e.openerFamily);
        expect(typeof e.openerLabel).toBe("string");
        expect(e.openerMoveId).not.toBeNull();
        if (e.grab) expect(e.openerFamily).toBe("grab");
        if (i > 0) expect(e.startFrame).toBeGreaterThanOrEqual(openings[i - 1]!.startFrame);
        if (e.stockNumber != null) expect(e.deathFrame).not.toBeNull();

        // Pre-hit evidence matches the replay and the victim was onstage.
        const pre = frames[e.startFrame - 1]!;
        const victim = pre.players[indexBySlot[e.victimSlot]]!.post!;
        const attacker = pre.players[indexBySlot[e.attackerSlot]]!.post!;
        expect(e.victimX).toBeCloseTo(victim.positionX ?? 0, 2);
        expect(e.victimY).toBeCloseTo(victim.positionY ?? 0, 2);
        expect(e.attackerX).toBeCloseTo(attacker.positionX ?? 0, 2);
        expect(isOffstage(e.victimX, e.victimY, stageId)).toBe(false);
        expect(e.relativeX).toBeCloseTo(
          ((attacker.positionX ?? 0) - (victim.positionX ?? 0)) * (victim.facingDirection ?? 1),
          2,
        );
      }
    }
  });
});
