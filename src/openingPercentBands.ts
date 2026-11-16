// Pre-hit victim-percent bands shared by the opening ledger, the DB scope
// filter, the CLI and the renderer.
//
// Kept dependency-free (no slippi-js / Node imports) so renderer imports of
// the band definitions do not pull the replay-parsing stack into the Vite
// bundle. Bands are half-open [min, max); the last band is unbounded. They
// are descriptive buckets, not thresholds at which a conversion becomes a
// true combo.

export const OPENING_PERCENT_BANDS = [
  { key: "0-30", label: "0–30%", min: 0, max: 30 },
  { key: "30-60", label: "30–60%", min: 30, max: 60 },
  { key: "60-90", label: "60–90%", min: 60, max: 90 },
  { key: "90-120", label: "90–120%", min: 90, max: 120 },
  { key: "120+", label: "120%+", min: 120, max: null },
] as const;

export type OpeningPercentBandKey = (typeof OPENING_PERCENT_BANDS)[number]["key"];

/** Measured counts for one band within a sample. */
export interface OpeningPercentBand {
  key: string;
  label: string;
  count: number;
  kills: number;
  killRate: number;
}

/** Resolve a band key (or its display label) for the scope filter. */
export function openingPercentBand(key: string): (typeof OPENING_PERCENT_BANDS)[number] | undefined {
  return OPENING_PERCENT_BANDS.find((band) => band.key === key || band.label === key);
}
