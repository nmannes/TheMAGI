import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

// getComboEndings: target-perspective isolation, game-scope filters, coverage,
// detector-version gating, and the combo-ending aggregation. better-sqlite3 is
// Electron-ABI (see CLAUDE.md), so this suite runs the real SQL through Node's
// built-in sqlite, same as openingsAgainstDb.test.ts.

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const home = mkdtempSync(join(actual.tmpdir(), "magi-combo-endings-"));
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
  getComboEndings,
  getPatternData,
  setGameEventsVersion,
  insertComboEndingEvents,
  type InsertGameParams,
} from "../src/db";
import { persistFrameEvents } from "../src/importer";
import { FRAME_EVENTS_VERSION } from "../src/pipeline/frameEvents";
import type { ComboEndingEvent, GameFrameEvents } from "../src/pipeline/frameEvents";

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  getDb().exec("DELETE FROM combo_ending_events; DELETE FROM games;");
});

let gameCounter = 0;

function seedGame(overrides: Partial<InsertGameParams> = {}): number {
  gameCounter++;
  const params: InsertGameParams = {
    sessionId: null,
    replayPath: `C:/replays/combo-endings-${gameCounter}.slp`,
    replayHash: `combo-endings-hash-${gameCounter}`,
    playedAt: `2026-07-02 12:00:0${gameCounter % 10}`,
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

function events(comboEndings: ComboEndingEvent[]): GameFrameEvents {
  return {
    conversions: [],
    stocks: [],
    habits: [],
    throwDI: [],
    recoverySpans: [],
    shieldBlocks: [],
    whiffs: [],
    openings: [],
    comboEndings,
    attacks: [[], []],
    neutralSegments: [],
  };
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

describe("combo-ending schema", () => {
  it("creates the v19 table and its four indexes", () => {
    const names = (
      getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'combo_ending_events'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(names).toEqual(["combo_ending_events"]);

    const indexes = (
      getDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'combo_ending_events' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual([
      "idx_combo_ending_events_decision",
      "idx_combo_ending_events_ender",
      "idx_combo_ending_events_game",
      "idx_combo_ending_events_game_attacker",
    ]);
  });
});

describe("insertComboEndingEvents", () => {
  it("round-trips nullable booleans and null frames", () => {
    const gameId = seedGame();
    insertComboEndingEvents(gameId, [
      {
        attackerIsPlayer: true,
        conversionStartFrame: 100,
        lastHitFrame: 120,
        conversionEndFrame: null,
        openerMoveId: null,
        enderMoveId: 13,
        enderLabel: "nair",
        enderFamily: "aerial",
        openingType: "neutral-win",
        moveCount: 1,
        damage: 12,
        startPercent: 0,
        endPercent: 12,
        didKill: false,
        victimEndState: "unknown",
        victimEndX: null,
        victimEndY: null,
        victimEndPercent: null,
        attackerFirstActionableFrame: null,
        framesFromLastHitToActionable: null,
        postHitDecision: "none",
        postHitMoveId: null,
        postHitMoveLabel: null,
        postHitStartFrame: null,
        postHitConnected: null,
        postHitOnShield: null,
        extended: false,
        whiffed: false,
        punished: false,
        punishDelay: null,
        punishOpenerMoveId: null,
        punishDamage: 0,
        edgeguardLinked: false,
        victimDeathPercent: null,
        deathFrame: null,
      },
    ]);

    const row = getDb()
      .prepare("SELECT post_hit_connected, post_hit_on_shield, conversion_end_frame FROM combo_ending_events")
      .get() as { post_hit_connected: number | null; post_hit_on_shield: number | null; conversion_end_frame: number | null };
    expect(row).toEqual({ post_hit_connected: null, post_hit_on_shield: null, conversion_end_frame: null });
  });
});

describe("persistFrameEvents combo-ending mapping", () => {
  it("stores both slots and resolves attacker_is_player against the target", () => {
    const gameId = seedGame();
    persistFrameEvents(
      gameId,
      events([
        ending({ attackerSlot: 0, enderLabel: "nair" }),
        ending({ attackerSlot: 1, enderLabel: "fair", lastHitFrame: 300 }),
      ]),
      0,
    );

    const rows = getDb()
      .prepare("SELECT attacker_is_player, ender_label FROM combo_ending_events WHERE game_id = ? ORDER BY last_hit_frame")
      .all(gameId) as { attacker_is_player: number; ender_label: string }[];
    expect(rows).toEqual([
      { attacker_is_player: 1, ender_label: "nair" },
      { attacker_is_player: 0, ender_label: "fair" },
    ]);

    const result = getComboEndings();
    expect(result.summary.total).toBe(1);
    expect(result.summary.enders[0]).toMatchObject({ label: "nair", count: 1, family: "aerial" });
  });

  it("NEGATIVE: a game persisted from the opponent's side never leaks into the player's ledger", () => {
    const gameId = seedGame({ playerCharacter: "Marth", opponentCharacter: "Fox" });
    persistFrameEvents(
      gameId,
      events([
        ending({ attackerSlot: 0, enderLabel: "slot-zero-own" }),
        ending({ attackerSlot: 1, enderLabel: "slot-one-own", lastHitFrame: 300 }),
      ]),
      1,
    );

    const result = getComboEndings();
    expect(result.summary.total).toBe(1);
    expect(result.summary.enders.map((row) => row.label)).toEqual(["slot-one-own"]);
  });
});

describe("getComboEndings", () => {
  it("aggregates enders, end states, decisions, outcomes and cost", () => {
    const gameId = seedGame();
    persistFrameEvents(
      gameId,
      events([
        ending({ enderLabel: "nair", didKill: false, endPercent: 45 }),
        ending({
          enderLabel: "nair",
          lastHitFrame: 220,
          postHitDecision: "attack",
          postHitMoveLabel: "fair",
          postHitConnected: true,
          whiffed: false,
          extended: true,
        }),
        ending({
          enderLabel: "bair",
          lastHitFrame: 320,
          postHitDecision: "defend",
          postHitMoveLabel: "shield",
          postHitConnected: null,
          postHitOnShield: null,
          whiffed: false,
          endPercent: 120,
          didKill: false,
        }),
        ending({
          enderLabel: "up smash",
          enderFamily: "grounded",
          lastHitFrame: 420,
          didKill: true,
          victimEndState: "dead",
          endPercent: 135,
          postHitDecision: "reposition",
          postHitMoveLabel: "dash",
          postHitConnected: null,
          postHitOnShield: null,
          whiffed: false,
        }),
        ending({
          enderLabel: "fair",
          lastHitFrame: 520,
          postHitDecision: "attack",
          postHitMoveLabel: "fair",
          postHitConnected: false,
          whiffed: true,
          punished: true,
          punishDelay: 4,
          punishOpenerMoveId: 8,
          punishDamage: 19,
        }),
      ]),
      0,
    );

    const { summary } = getComboEndings();
    expect(summary.total).toBe(5);
    expect(summary.kills).toBe(1);
    expect(summary.killRate).toBeCloseTo(0.2);
    expect(summary.squandered).toBe(1);
    expect(summary.enders.map((row) => row.label)).toEqual(["nair", "bair", "fair", "up smash"]);
    expect(summary.enders[0]).toMatchObject({
      label: "nair",
      family: "aerial",
      count: 2,
      kills: 0,
      avgDamage: 27,
      lowSample: true,
    });
    expect(summary.enders[0]!.endStates).toEqual([
      { state: "onstage", count: 2, share: 1 },
    ]);
    expect(summary.victimEndStates.map((row) => row.state).sort()).toEqual(["dead", "onstage"]);
    expect(summary.decisions.map((row) => row.decision)).toEqual(["attack", "reposition", "defend"]);
    const attack = summary.decisions.find((row) => row.decision === "attack")!;
    expect(attack).toMatchObject({ count: 3, whiffed: 2, extended: 1, punished: 1 });
    expect(summary.outcomes.map((row) => row.key)).toEqual([
      "killed",
      "extended",
      "whiffed",
      "punished",
      "reset",
      "edgeguard-linked",
    ]);
    expect(summary.outcomes).toContainEqual({ key: "punished", count: 1, share: 0.2 });
    expect(summary.cost).toMatchObject({
      punished: 1,
      punishedShare: 0.2,
      avgPunishDamagePerEnding: 3.8,
      avgPunishDamageWhenPunished: 19,
      avgPunishDelay: 4,
    });
    expect(summary.cost.topPunishOpeners).toEqual([{ moveId: 8, label: "utilt", count: 1, share: 1 }]);
    expect(summary.squanderedEndings.byEnder.map((row) => row.label)).toEqual(["bair"]);
    expect(summary.examples[0]!.lastHitFrame).toBe(520);
  });

  it("filters by player character, opponent character, stage and opponent key", () => {
    const foxMarthBf = seedGame();
    persistFrameEvents(foxMarthBf, events([ending({ enderLabel: "nair" })]), 0);

    const falcoFoxYoshi = seedGame({
      replayPath: "C:/replays/combo-endings-yoshi.slp",
      replayHash: "combo-endings-hash-yoshi",
      playerCharacter: "Falco",
      opponentCharacter: "Fox",
      stage: "Yoshi's Story",
      opponentTag: "RIVAL",
      opponentConnectCode: "RIV#789",
    });
    persistFrameEvents(falcoFoxYoshi, events([ending({ enderLabel: "dair" })]), 0);

    const foxMarthFd = seedGame({
      replayPath: "C:/replays/combo-endings-fd.slp",
      replayHash: "combo-endings-hash-fd",
      stage: "Final Destination",
    });
    persistFrameEvents(foxMarthFd, events([ending({ enderLabel: "bair" })]), 0);

    expect(getComboEndings({ character: "Fox" }).summary.total).toBe(2);
    expect(getComboEndings({ character: "Falco" }).summary.total).toBe(1);
    expect(getComboEndings({ opponentCharacter: "Marth" }).summary.total).toBe(2);
    expect(getComboEndings({ stage: "Yoshi's Story" }).summary.total).toBe(1);
    expect(getComboEndings({ stage: "Battlefield" }).summary.total).toBe(1);
    expect(getComboEndings({ opponentKey: "RIV#789" }).summary.total).toBe(1);
    expect(getComboEndings({ opponentKey: "VILLAIN" }).summary.total).toBe(2);
    expect(getComboEndings({ character: "Peach" }).coverage.gamesInScope).toBe(0);
    expect(getComboEndings({ character: "Peach" }).summary.total).toBe(0);
  });

  it("reports coverage and excludes games parsed by an older detector", () => {
    const currentA = seedGame();
    persistFrameEvents(currentA, events([ending({ enderLabel: "current-a" })]), 0);
    const currentB = seedGame({
      replayPath: "C:/replays/combo-endings-current-b.slp",
      replayHash: "combo-endings-hash-current-b",
    });
    persistFrameEvents(currentB, events([ending({ enderLabel: "current-b" })]), 0);

    const stale = seedGame({
      replayPath: "C:/replays/combo-endings-stale.slp",
      replayHash: "combo-endings-hash-stale",
    });
    persistFrameEvents(stale, events([ending({ enderLabel: "stale-row" })]), 0);
    setGameEventsVersion(stale, FRAME_EVENTS_VERSION - 1);

    const result = getComboEndings();
    expect(result.coverage).toEqual({ gamesInScope: 3, gamesWithEndings: 2, gamesParsedCurrent: 2 });
    expect(result.summary.total).toBe(2);
    expect(result.summary.enders.map((row) => row.label).sort()).toEqual(["current-a", "current-b"]);
  });

  it("limits to the most recent scoped games and caps the limit", () => {
    const oldest = seedGame({
      replayPath: "C:/replays/combo-endings-oldest.slp",
      replayHash: "combo-endings-hash-oldest",
      playedAt: "2026-07-02 10:00:00",
    });
    persistFrameEvents(oldest, events([ending({ enderLabel: "oldest" })]), 0);
    const middle = seedGame({
      replayPath: "C:/replays/combo-endings-middle.slp",
      replayHash: "combo-endings-hash-middle",
      playedAt: "2026-07-02 11:00:00",
    });
    persistFrameEvents(middle, events([ending({ enderLabel: "middle" })]), 0);
    const newest = seedGame({
      replayPath: "C:/replays/combo-endings-newest.slp",
      replayHash: "combo-endings-hash-newest",
      playedAt: "2026-07-02 12:00:00",
    });
    persistFrameEvents(newest, events([ending({ enderLabel: "newest" })]), 0);

    const result = getComboEndings({ limit: 2 });
    expect(result.coverage.gamesInScope).toBe(2);
    expect(result.summary.enders.map((row) => row.label).sort()).toEqual(["middle", "newest"]);

    expect(getComboEndings({ limit: 100000 }).coverage.gamesInScope).toBe(3);
  });

  it("returns filter options from the full database", () => {
    const first = seedGame();
    persistFrameEvents(first, events([ending()]), 0);
    const second = seedGame({
      replayPath: "C:/replays/combo-endings-options.slp",
      replayHash: "combo-endings-hash-options",
      playerCharacter: "Falco",
      opponentCharacter: "Fox",
      stage: "Yoshi's Story",
    });
    persistFrameEvents(second, events([ending()]), 0);

    const result = getComboEndings();
    expect(result.options.characters).toEqual(["Falco", "Fox"]);
    expect(result.options.opponentCharacters).toEqual(["Fox", "Marth"]);
    expect(result.options.stages).toEqual(["Battlefield", "Yoshi's Story"]);
  });
});

describe("getPatternData combo-ending history", () => {
  it("aggregates only the player's own endings from current-version games", () => {
    const current = seedGame();
    persistFrameEvents(
      current,
      events([
        ending({ enderLabel: "nair", didKill: false }),
        ending({ enderLabel: "nair", lastHitFrame: 220, didKill: true, victimEndState: "dead" }),
        ending({ enderLabel: "bair", lastHitFrame: 320, endPercent: 120, didKill: false }),
        ending({
          attackerSlot: 1,
          enderLabel: "opponent-ender",
          lastHitFrame: 420,
        }),
      ]),
      0,
    );
    seedStockDeath(current);

    const stale = seedGame({
      replayPath: "C:/replays/combo-endings-pattern-stale.slp",
      replayHash: "combo-endings-hash-pattern-stale",
    });
    persistFrameEvents(stale, events([ending({ enderLabel: "stale-ender" })]), 0);
    setGameEventsVersion(stale, FRAME_EVENTS_VERSION - 1);
    seedStockDeath(stale);

    const data = getPatternData({ label: "all games" })!;
    expect(data.games).toBe(2);
    expect(data.currentGames).toBe(1);
    expect(data.comboEndings).toEqual({
      total: 3,
      kills: 1,
      squandered: 1,
      extended: 0,
      whiffed: 3,
      punished: 0,
      edgeguardLinked: 0,
      enders: [
        { label: "nair", family: "aerial", count: 2, kills: 1 },
        { label: "bair", family: "aerial", count: 1, kills: 0 },
      ],
      topPunishOpeners: [],
    });
  });

  it("NEGATIVE: a stale game's endings never leak into pattern history", () => {
    const stale = seedGame();
    persistFrameEvents(stale, events([ending({ enderLabel: "stale-ender" })]), 0);
    setGameEventsVersion(stale, FRAME_EVENTS_VERSION - 1);
    seedStockDeath(stale);

    const data = getPatternData({ label: "all games" })!;
    expect(data.comboEndings).toEqual({
      total: 0,
      kills: 0,
      squandered: 0,
      extended: 0,
      whiffed: 0,
      punished: 0,
      edgeguardLinked: 0,
      enders: [],
      topPunishOpeners: [],
    });
  });
});
