// Shared contract for the "Openings Against Me" query.
// Single source of truth across main (src/db.ts, src/main/handlers/stats.ts)
// and renderer (src/renderer/global.d.ts, src/renderer/hooks/queries.ts,
// src/renderer/pages/performance/OpeningsAgainst.tsx).
//
// The unit is the first hit in neutral of an opponent conversion where the
// target player is the victim. Aggregates come from the v18 opening_events
// table (victim_is_player = 1) joined to games for the scope filters; the
// opponent's full conversion move list is joined from conversions.moves_json
// for the conversion-sequence clusters. Rule buckets are authoritative and stable;
// clusters are exploratory and are recomputed per query, never persisted and
// never used as filters.

import type {
  OpeningBaseline,
  OpeningBucket,
  OpeningExample,
  OpeningSequenceClusterResult,
} from "./pipeline/openingClusters.js";

export interface OpeningsAgainstFilters {
  /** The player's character (games.player_character). */
  character?: string;
  /** The opponent's character (games.opponent_character). */
  opponentCharacter?: string;
  /** Stage display name (games.stage). */
  stage?: string;
  /** Opponent connect code or tag (same key as getAggregateStats). */
  opponentKey?: string;
  /**
   * Narrow openings to one pre-hit victim-percent band. Accepts an
   * OPENING_PERCENT_BANDS key ("0-30", "30-60", "60-90", "90-120", "120+")
   * or its display label. Bands are descriptive, not combo-validity cutoffs.
   */
  percentBand?: string;
  /** Most recent scoped games to read (default 200, max 1000). */
  limit?: number;
}

export interface OpeningsAgainstCoverage {
  /** Scoped games after filters and limit. */
  gamesInScope: number;
  /** Scoped games that contributed at least one opening row. */
  gamesWithOpenings: number;
  /** Scoped games parsed by the current detector version (opening ledger available). */
  gamesParsedCurrent: number;
}

export interface OpeningsAgainstFilterOptions {
  characters: string[];
  opponentCharacters: string[];
  stages: string[];
}

export interface OpeningsAgainstResult {
  coverage: OpeningsAgainstCoverage;
  /** Whole-scope totals and situation/family/percent distributions. */
  baseline: OpeningBaseline;
  /** situation × opener family × exact move, sorted by count. */
  buckets: OpeningBucket[];
  /** Opponent conversion-sequence clusters per opponent character, or an explicit insufficient-sample result. */
  clusters: OpeningSequenceClusterResult;
  /** The most recent openings across the scope (game id, frame, timestamp). */
  examples: OpeningExample[];
  /** Distinct values available in the full DB, for filter selects. */
  options: OpeningsAgainstFilterOptions;
}

export const OPENINGS_AGAINST_DEFAULT_LIMIT = 200;
export const OPENINGS_AGAINST_MAX_LIMIT = 1000;
