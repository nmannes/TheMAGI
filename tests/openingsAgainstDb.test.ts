import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

// getOpeningsAgainst: perspective normalization, game-scope filters, coverage
// and detector-version gating. better-sqlite3 is Electron-ABI (see CLAUDE.md),
// so this suite runs the real SQL through Node's built-in sqlite, same as
// characterEventProfile.test.ts / openingEventsDb.test.ts.

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const home = mkdtempSync(join(actual.tmpdir(), "magi-openings-against-"));
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
  getGameClipInfo,
  getOpeningsAgainst,
  getPatternData,
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
  // Isolate each test. Delete event rows first so reused game ids can never
  // inherit a previous test's openings.
  getDb().exec("DELETE FROM opening_events; DELETE FROM games;");
});

let gameCounter = 0;

function seedGame(overrides: Partial<InsertGameParams> = {}): number {
  gameCounter++;
  const params: InsertGameParams = {
    sessionId: null,
    replayPath: `C:/replays/openings-against-${gameCounter}.slp`,
    replayHash: `openings-against-hash-${gameCounter}`,
    playedAt: `2026-07-01 12:00:0${gameCounter % 10}`,
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
    ...overrides,
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
    didKill: false,
    stockNumber: null,
    deathFrame: null,
    deathVerdict: null,
    ...overrides,
  };
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

function persist(gameId: number, openings: OpeningEvent[], playerIdx: 0 | 1 = 0): void {
  persistFrameEvents(gameId, events(openings), playerIdx);
}

/** getPatternData scopes to games that have at least one stock_deaths row. */
function seedStockDeath(gameId: number): void {
  getDb()
    .prepare(
      `INSERT INTO stock_deaths (game_id, victim_is_player, stock_number, start_frame, start_percent, died)
       VALUES (?, 1, 1, 60, 0, 1)`,
    )
    .run(gameId);
}

describe("getOpeningsAgainst", () => {
  it("returns only target-victim rows for both settings orders", () => {
    const gameA = seedGame();
    persist(gameA, [
      opening({ openerLabel: "dsmash" }),
      opening({ victimSlot: 1, attackerSlot: 0, startFrame: 300, openerLabel: "opponent-was-hit" }),
    ]);

    const gameB = seedGame({
      replayPath: "C:/replays/openings-against-b.slp",
      replayHash: "openings-against-hash-b",
      playerCharacter: "Marth",
      opponentCharacter: "Fox",
    });
    persist(
      gameB,
      [
        opening({ victimSlot: 0, attackerSlot: 1, openerLabel: "slot-zero-hit" }),
        opening({
          victimSlot: 1,
          attackerSlot: 0,
          startFrame: 300,
          openerLabel: "fthrow",
          grab: true,
          openerFamily: "grab",
        }),
      ],
      1,
    );

    const result = getOpeningsAgainst();
    expect(result.coverage.gamesInScope).toBe(2);
    expect(result.coverage.gamesParsedCurrent).toBe(2);
    expect(result.coverage.gamesWithOpenings).toBe(2);
    expect(result.baseline.total).toBe(2);
    expect(result.buckets.map((b) => b.openerLabel).sort()).toEqual(["dsmash", "fthrow"]);
    expect(result.buckets.find((b) => b.openerLabel === "fthrow")!.openerFamily).toBe("grab");
  });

  it("filters by player character, opponent character, stage and opponent key", () => {
    const foxMarthBf = seedGame();
    persist(foxMarthBf, [opening({ openerLabel: "dsmash" })]);

    const falcoFoxYoshi = seedGame({
      replayPath: "C:/replays/openings-against-yoshi.slp",
      replayHash: "openings-against-hash-yoshi",
      playerCharacter: "Falco",
      opponentCharacter: "Fox",
      stage: "Yoshi's Story",
      opponentTag: "RIVAL",
      opponentConnectCode: "RIV#789",
    });
    persist(falcoFoxYoshi, [opening({ openerLabel: "nair", openerFamily: "aerial", openerMoveId: 13 })]);

    const foxMarthFd = seedGame({
      replayPath: "C:/replays/openings-against-fd.slp",
      replayHash: "openings-against-hash-fd",
      stage: "Final Destination",
    });
    persist(foxMarthFd, [opening({ openerLabel: "ftilt" })]);

    expect(getOpeningsAgainst({ character: "Fox" }).baseline.total).toBe(2);
    expect(getOpeningsAgainst({ character: "Falco" }).baseline.total).toBe(1);
    expect(getOpeningsAgainst({ opponentCharacter: "Marth" }).baseline.total).toBe(2);
    expect(getOpeningsAgainst({ stage: "Yoshi's Story" }).baseline.total).toBe(1);
    expect(getOpeningsAgainst({ stage: "Battlefield" }).baseline.total).toBe(1);
    expect(getOpeningsAgainst({ opponentKey: "RIV#789" }).baseline.total).toBe(1);
    expect(getOpeningsAgainst({ opponentKey: "VILLAIN" }).baseline.total).toBe(2);
    expect(
      getOpeningsAgainst({ character: "Falco", opponentCharacter: "Fox", stage: "Yoshi's Story" }).baseline.total,
    ).toBe(1);
    expect(getOpeningsAgainst({ character: "Peach" }).coverage.gamesInScope).toBe(0);
    expect(getOpeningsAgainst({ character: "Peach" }).clusters.status).toBe("insufficient-sample");
  });

  it("reports coverage and excludes games parsed by an older detector", () => {
    const currentA = seedGame();
    persist(currentA, [opening({ openerLabel: "current-a" })]);
    const currentB = seedGame({
      replayPath: "C:/replays/openings-against-current-b.slp",
      replayHash: "openings-against-hash-current-b",
    });
    persist(currentB, [opening({ openerLabel: "current-b" })]);

    const stale = seedGame({
      replayPath: "C:/replays/openings-against-stale.slp",
      replayHash: "openings-against-hash-stale",
    });
    persist(stale, [opening({ openerLabel: "stale-row" })]);
    setGameEventsVersion(stale, FRAME_EVENTS_VERSION - 1);

    const result = getOpeningsAgainst();
    expect(result.coverage).toEqual({ gamesInScope: 3, gamesWithOpenings: 2, gamesParsedCurrent: 2 });
    expect(result.baseline.total).toBe(2);
    expect(result.buckets.map((b) => b.openerLabel).sort()).toEqual(["current-a", "current-b"]);
  });

  it("limits to the most recent scoped games", () => {
    const oldest = seedGame({
      replayPath: "C:/replays/openings-against-oldest.slp",
      replayHash: "openings-against-hash-oldest",
      playedAt: "2026-07-01 10:00:00",
    });
    persist(oldest, [opening({ openerLabel: "oldest" })]);
    const middle = seedGame({
      replayPath: "C:/replays/openings-against-middle.slp",
      replayHash: "openings-against-hash-middle",
      playedAt: "2026-07-01 11:00:00",
    });
    persist(middle, [opening({ openerLabel: "middle" })]);
    const newest = seedGame({
      replayPath: "C:/replays/openings-against-newest.slp",
      replayHash: "openings-against-hash-newest",
      playedAt: "2026-07-01 12:00:00",
    });
    persist(newest, [opening({ openerLabel: "newest" })]);

    const result = getOpeningsAgainst({ limit: 2 });
    expect(result.coverage.gamesInScope).toBe(2);
    expect(result.baseline.total).toBe(2);
    expect(result.buckets.map((b) => b.openerLabel).sort()).toEqual(["middle", "newest"]);

    const capped = getOpeningsAgainst({ limit: 100000 });
    expect(capped.coverage.gamesInScope).toBe(3);
  });

  it("returns filter options from the full database", () => {
    seedGame();
    seedGame({
      replayPath: "C:/replays/openings-against-options.slp",
      replayHash: "openings-against-hash-options",
      playerCharacter: "Falco",
      opponentCharacter: "Fox",
      stage: "Yoshi's Story",
      opponentTag: "RIVAL",
      opponentConnectCode: "RIV#789",
    });
    seedGame({
      replayPath: "C:/replays/openings-against-options-fd.slp",
      replayHash: "openings-against-hash-options-fd",
      stage: "Final Destination",
    });

    const result = getOpeningsAgainst();
    expect(result.options.characters).toEqual(["Falco", "Fox"]);
    expect(result.options.opponentCharacters).toEqual(["Fox", "Marth"]);
    expect(result.options.stages).toEqual(["Battlefield", "Final Destination", "Yoshi's Story"]);
  });

  it("clusters DB rows with stage ids and keeps raw rows out of later scopes when no games match", () => {
    const gameId = seedGame({
      replayPath: "C:/replays/openings-against-cluster.slp",
      replayHash: "openings-against-hash-cluster",
    });
    const many = Array.from({ length: 42 }, (_, i) =>
      opening({
        startFrame: 100 + i * 3,
        openerLabel: i % 2 === 0 ? "dash attack" : "grab (bthrow)",
        openerFamily: i % 2 === 0 ? "grounded" : "grab",
        grab: i % 2 !== 0,
        openerMoveId: i % 2 === 0 ? 6 : 54,
        situation: i % 2 === 0 ? "commitment" : "shield",
        victimPercent: i % 2 === 0 ? 25 + (i % 5) : 110 + (i % 5),
        relativeX: i % 2 === 0 ? 5 : 40,
        distance: i % 2 === 0 ? 20 : 80,
        victimX: i % 2 === 0 ? -40 : 55,
      }),
    );
    persist(gameId, many);

    const result = getOpeningsAgainst({ stage: "Battlefield" });
    expect(result.coverage.gamesWithOpenings).toBe(1);
    expect(result.baseline.total).toBe(42);
    expect(result.clusters.status).toBe("ok");
    if (result.clusters.status === "ok") {
      expect(result.clusters.clusters.reduce((sum, c) => sum + c.size, 0)).toBe(42);
    }
    expect(result.examples).toHaveLength(10);
    expect(result.examples[0]!.timestamp).toMatch(/^\d+:\d{2}$/);

    const otherStage = getOpeningsAgainst({ stage: "Dream Land" });
    expect(otherStage.coverage.gamesInScope).toBe(0);
    expect(otherStage.baseline.total).toBe(0);
  });
});

describe("getGameClipInfo", () => {
  it("returns replay and player metadata for the selected games, ignoring unknown ids", () => {
    const first = seedGame({
      replayPath: "C:/replays/openings-clip-first.slp",
      replayHash: "openings-against-hash-clip-first",
    });
    const second = seedGame({
      replayPath: "C:/replays/openings-clip-second.slp",
      replayHash: "openings-against-hash-clip-second",
      playerCharacter: "Marth",
      opponentCharacter: "Fox",
      opponentTag: "RIVAL",
      opponentConnectCode: "RIV#789",
      stage: "Yoshi's Story",
    });

    const info = getGameClipInfo([second, first, first, 9999]);
    expect(info).toHaveLength(2);
    const byId = new Map(info.map((row) => [row.id, row]));
    expect(byId.get(first)).toMatchObject({
      replayPath: "C:/replays/openings-clip-first.slp",
      playerTag: "HERO",
      playerCharacter: "Fox",
      opponentTag: "VILLAIN",
      opponentCharacter: "Marth",
      stage: "Battlefield",
      durationSeconds: 180,
    });
    expect(byId.get(second)).toMatchObject({
      replayPath: "C:/replays/openings-clip-second.slp",
      playerCharacter: "Marth",
      opponentCharacter: "Fox",
      opponentTag: "RIVAL",
      stage: "Yoshi's Story",
    });
  });

  it("NEGATIVE: an empty id list returns no rows without querying", () => {
    expect(getGameClipInfo([])).toEqual([]);
    expect(getGameClipInfo([0, -3, 1.5])).toEqual([]);
  });
});

describe("getPatternData opening history", () => {
  it("aggregates openings against the player from current-version games only", () => {
    const current = seedGame();
    persist(current, [
      opening({ didKill: true, situation: "commitment", openerFamily: "aerial", openerLabel: "dair" }),
      opening({
        didKill: false,
        situation: "commitment",
        openerFamily: "aerial",
        openerLabel: "dair",
        startFrame: 200,
      }),
      opening({
        didKill: false,
        situation: "shield",
        openerFamily: "grab",
        openerLabel: "grab (bthrow)",
        grab: true,
      }),
      // The opponent being opened is not one of the player's openings against.
      opening({
        victimSlot: 1,
        attackerSlot: 0,
        situation: "landing",
        openerFamily: "grounded",
        openerLabel: "dsmash",
        startFrame: 400,
      }),
    ]);
    seedStockDeath(current);

    const stale = seedGame({
      replayPath: "C:/replays/openings-against-pattern-stale.slp",
      replayHash: "openings-against-hash-pattern-stale",
    });
    persist(stale, [
      opening({ didKill: true, situation: "neutral-grounded", openerFamily: "grounded", openerLabel: "upsmash" }),
    ]);
    setGameEventsVersion(stale, FRAME_EVENTS_VERSION - 1);
    seedStockDeath(stale);

    const data = getPatternData({ label: "all games" })!;
    expect(data.games).toBe(2);
    expect(data.currentGames).toBe(1);
    expect(data.openingsAgainst).toEqual({
      total: 3,
      games: 1,
      kills: 1,
      buckets: [
        { situation: "commitment", family: "aerial", label: "dair", count: 2, kills: 1 },
        { situation: "shield", family: "grab", label: "grab (bthrow)", count: 1, kills: 0 },
      ],
    });
  });

  it("NEGATIVE: a stale game's openings never leak into pattern history", () => {
    const stale = seedGame();
    persist(stale, [
      opening({ didKill: true, situation: "neutral-grounded", openerFamily: "grounded", openerLabel: "upsmash" }),
    ]);
    setGameEventsVersion(stale, FRAME_EVENTS_VERSION - 1);
    seedStockDeath(stale);

    const data = getPatternData({ label: "all games" })!;
    expect(data.games).toBe(1);
    expect(data.openingsAgainst).toEqual({ total: 0, games: 0, kills: 0, buckets: [] });
  });
});
