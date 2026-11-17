// Shared contract for the "How I End My Combos" query.
// Single source of truth across main (src/db.ts, src/main/handlers/stats.ts)
// and renderer (src/renderer/global.d.ts, src/renderer/hooks/queries.ts,
// src/renderer/pages/characters/ComboEnders.tsx,
// src/renderer/pages/performance/ComboEndings.tsx).
//
// The unit is one own conversion (attacker_is_player = 1). Rows come from the
// v19 combo_ending_events table joined to games for the scope filters; all
// aggregation happens in TypeScript from the raw rows. Type-only imports keep
// the replay-parsing stack out of the Vite bundle.

import type { ComboEndingSummary } from "./pipeline/comboEndings.js";

export interface ComboEndingsFilters {
  /** The player's character (games.player_character). */
  character?: string;
  /** The opponent's character (games.opponent_character). */
  opponentCharacter?: string;
  /** Stage display name (games.stage). */
  stage?: string;
  /** Opponent connect code or tag (same key as getAggregateStats). */
  opponentKey?: string;
  /** Most recent scoped games to read (default 200, max 1000). */
  limit?: number;
}

export interface ComboEndingsCoverage {
  /** Scoped games after filters and limit. */
  gamesInScope: number;
  /** Scoped games that contributed at least one combo-ending row. */
  gamesWithEndings: number;
  /** Scoped games parsed by the current detector version. */
  gamesParsedCurrent: number;
}

export interface ComboEndingsFilterOptions {
  characters: string[];
  opponentCharacters: string[];
  stages: string[];
}

export interface ComboEndingsResult {
  coverage: ComboEndingsCoverage;
  summary: ComboEndingSummary;
  /** Distinct values available in the full DB, for filter selects. */
  options: ComboEndingsFilterOptions;
}

export const COMBO_ENDINGS_DEFAULT_LIMIT = 200;
export const COMBO_ENDINGS_MAX_LIMIT = 1000;
