import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

// Persistence for the opening ledger: both settings-order slots are stored in
// one row set and `victim_is_player` is resolved against the target player at
// persist time. better-sqlite3 is Electron-ABI (see CLAUDE.md), so this suite
// runs the real SQL through Node's built-in sqlite, same as
// characterEventProfile.test.ts.

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const home = mkdtempSync(join(actual.tmpdir(), "magi-opening-events-"));
  const homedir = () => home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("better-sqlite3", async () => {
  const { DatabaseSync } = await import("node:sqlite");

  class Database {
    private db: InstanceType<typeof DatabaseSync>;

    constructor(dbPath: string) {
      this.db = new DatabaseSync(dbPath);
    }

    pragma(source: string): unknown {
      return this.db.prepare(`PRAGMA ${source}`).all();
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare(sql: string) {
      return this.db.prepare(sql);
    }

    transaction<T extends (...args: unknown[]) => unknown>(fn: T) {
      return (...args: Parameters<T>): ReturnType<T> => {
        this.db.exec("BEGIN");
        try {
          const result = fn(...args) as ReturnType<T>;
          this.db.exec("COMMIT");
          return result;
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      };
    }

    close(): void {
      this.db.close();
    }
  }

  return { default: Database };
});

import {
  getDb,
  closeDb,
  insertGame,
  deleteFrameEventRows,
  getBackfillCandidates,
  getLibraryGames,
  insertGameStats,
  setGameEventsVersion,
  type InsertGameParams,
} from "../src/db";
import { persistFrameEvents } from "../src/importer";
import { FRAME_EVENTS_VERSION } from "../src/pipeline/frameEvents";
import type { GameFrameEvents, OpeningEvent } from "../src/pipeline/frameEvents";

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  // Isolate each test and prevent reused game ids from inheriting old rows.
  getDb().exec("DELETE FROM opening_events; DELETE FROM game_stats; DELETE FROM games;");
});

let gameCounter = 0;

function seedGame(): number {
  gameCounter++;
  const params: InsertGameParams = {
    sessionId: null,
    replayPath: `C:/replays/opening-${gameCounter}.slp`,
    replayHash: `opening-hash-${gameCounter}`,
    playedAt: "2026-07-01 12:00:00",
    stage: "Battlefield",
    durationSeconds: 180,
    playerCharacter: "Fox",
    opponentCharacter: "Marth",
    playerTag: "HERO",
    playerConnectCode: "HERO#123",
    opponentTag: "VILLAIN",
    opponentConnectCode: "VILN#456",
    result: "loss",
    endMethod: "stocks",
    playerFinalStocks: 0,
    playerFinalPercent: 120,
    opponentFinalStocks: 2,
    opponentFinalPercent: 60,
    gameNumber: 1,
  };
  return insertGame(params);
}

function opening(overrides: Partial<OpeningEvent> = {}): OpeningEvent {
  return {
    victimSlot: 0,
    attackerSlot: 1,
    startFrame: 100,
    endFrame: 130,
    openerMoveId: 12,
    openerLabel: "dsmash",
    openerFamily: "grounded",
    grab: false,
    openingType: "neutral-win",
    traded: false,
    situation: "landing",
    victimState: 72,
    attackerState: 20,
    victimPercent: 35,
    attackerPercent: 12,
    victimX: 10,
    victimY: 0,
    attackerX: 25,
    attackerY: 0,
    relativeX: 15,
    relativeY: 0,
    distance: 15,
    cornered: false,
    onPlatform: false,
    damage: 22,
    moveCount: 3,
    didKill: true,
    stockNumber: 2,
    deathFrame: 160,
    deathVerdict: "GOOD_DI",
    ...overrides,
  };
}

/** Minimal game_stats row so Library queries (which JOIN game_stats) can see a game. */
function seedStats(gameId: number): void {
  insertGameStats({
    gameId,
    neutralWins: 0,
    neutralLosses: 0,
    neutralWinRate: 0,
    counterHits: 0,
    openingsPerKill: 0,
    totalOpenings: 0,
    totalConversions: 0,
    conversionRate: 0,
    avgDamagePerOpening: 0,
    killConversions: 0,
    lCancelRate: 0,
    wavedashCount: 0,
    dashDanceFrames: 0,
    avgStagePositionX: 0,
    timeOnPlatform: 0,
    timeInAir: 0,
    timeAtLedge: 0,
    totalDamageTaken: 0,
    totalDamageDealt: 0,
    avgDeathPercent: 0,
    recoveryAttempts: 0,
    recoverySuccessRate: 0,
    ledgeEntropy: 0,
    knockdownEntropy: 0,
    shieldPressureEntropy: 0,
    powerShieldCount: 0,
    edgeguardAttempts: 0,
    edgeguardSuccessRate: 0,
    shieldPressureSequences: 0,
    shieldPressureAvgDamage: 0,
    shieldBreaks: 0,
    shieldPokeRate: 0,
    diSurvivalScore: 0.5,
    diComboScore: 0.5,
    diAvgComboLengthReceived: 0,
    diAvgComboLengthDealt: 0,
  });
}

function events(openings: OpeningEvent[]): GameFrameEvents {
  return {
    conversions: [],
    stocks: [],
    habits: [],
    throwDI: [],
    recoverySpans: [],
    shieldBlocks: [],
    whiffs: [],
    openings,
    attacks: [[], []],
    neutralSegments: [],
  };
}

interface StoredOpening {
  victim_is_player: number;
  opener_label: string;
  situation: string;
  relative_x: number;
  grab: number;
  traded: number;
  stock_number: number | null;
  death_verdict: string | null;
}

function stored(gameId: number): StoredOpening[] {
  return getDb()
    .prepare(
      `SELECT victim_is_player, opener_label, situation, relative_x, grab, traded, stock_number, death_verdict
       FROM opening_events WHERE game_id = ? ORDER BY victim_is_player DESC`,
    )
    .all(gameId) as StoredOpening[];
}

describe("opening ledger persistence", () => {
  it("stores both slots and resolves victim_is_player against the target", () => {
    const gameId = seedGame();
    persistFrameEvents(gameId, events([opening(), opening({ victimSlot: 1, attackerSlot: 0, startFrame: 300 })]), 0);

    const rows = stored(gameId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      victim_is_player: 1,
      opener_label: "dsmash",
      situation: "landing",
      relative_x: 15,
      stock_number: 2,
      death_verdict: "GOOD_DI",
    });
    expect(rows[1]!.victim_is_player).toBe(0);
  });

  it("flips the perspective when the target is the second settings slot", () => {
    const gameId = seedGame();
    persistFrameEvents(
      gameId,
      events([
        opening({ victimSlot: 0, attackerSlot: 1 }),
        opening({ victimSlot: 1, attackerSlot: 0, openerLabel: "grab (bthrow)", grab: true, openerFamily: "grab" }),
      ]),
      1,
    );

    const rows = stored(gameId);
    expect(rows).toHaveLength(2);
    const opponentRow = rows.find((r) => r.victim_is_player === 0)!;
    const targetRow = rows.find((r) => r.victim_is_player === 1)!;
    expect(opponentRow.grab).toBe(0);
    expect(opponentRow.opener_label).toBe("dsmash");
    expect(targetRow).toMatchObject({ opener_label: "grab (bthrow)", grab: 1 });
  });

  it("persists trade flags and null stock links", () => {
    const gameId = seedGame();
    persistFrameEvents(
      gameId,
      events([opening({ traded: true, didKill: false, stockNumber: null, deathFrame: null, deathVerdict: null })]),
      0,
    );
    const [row] = stored(gameId);
    expect(row).toMatchObject({ traded: 1, stock_number: null, death_verdict: null });
  });

  it("deleteFrameEventRows removes opening rows for a re-parse", () => {
    const gameId = seedGame();
    persistFrameEvents(gameId, events([opening()]), 0);
    expect(stored(gameId)).toHaveLength(1);

    deleteFrameEventRows(gameId);
    expect(stored(gameId)).toHaveLength(0);

    // The games row itself is preserved for the backfill to re-parse.
    const game = getDb().prepare("SELECT id FROM games WHERE id = ?").get(gameId) as { id: number };
    expect(game.id).toBe(gameId);
  });

  it("a plain backfill picks up games stamped with an older detector version", () => {
    expect(FRAME_EVENTS_VERSION).toBe(4);

    const stale = seedGame();
    const current = seedGame();

    setGameEventsVersion(stale, 3);
    setGameEventsVersion(current, FRAME_EVENTS_VERSION);

    const ids = getBackfillCandidates(false).map((c) => c.id);
    expect(ids).toContain(stale);
    expect(ids).not.toContain(current);
  });

  it("Library filters games through the opening_events EXISTS bucket key", () => {
    const landing = seedGame();
    persistFrameEvents(
      landing,
      events([opening({ situation: "landing", openerFamily: "grounded", openerLabel: "dsmash" })]),
      0,
    );
    seedStats(landing);

    const shield = seedGame();
    persistFrameEvents(
      shield,
      events([
        opening({
          situation: "shield",
          openerFamily: "grab",
          openerLabel: "grab (bthrow)",
          grab: true,
          openerMoveId: 54,
        }),
      ]),
      0,
    );
    seedStats(shield);

    const grounded = getLibraryGames({ opening: "landing::grounded" });
    expect(grounded.total).toBe(1);
    expect(grounded.games.map((g) => g.id)).toEqual([landing]);
    expect(grounded.openingFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "landing::grounded", situation: "landing", family: "grounded", count: 1 }),
        expect.objectContaining({ value: "shield::grab", situation: "shield", family: "grab", count: 1 }),
      ]),
    );

    expect(getLibraryGames({ opening: "shield::grab" }).games.map((g) => g.id)).toEqual([shield]);
    expect(getLibraryGames({ opening: "commitment::aerial" }).total).toBe(0);
    // A malformed key narrows to nothing instead of silently widening.
    expect(getLibraryGames({ opening: "malformed" }).total).toBe(0);
  });

  it("the schema shipped the opening indexes", () => {
    const indexes = (
      getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'opening_events'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["idx_opening_events_game", "idx_opening_events_game_victim", "idx_opening_events_lookup"]),
    );
  });
});
