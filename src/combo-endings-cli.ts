// Standalone CLI for the combo-ending ledger — how your own conversions end:
// the exact final move, the measured victim end state, and what you did after
// your first actionable frame.
//
// Usage:
//   npm run combo-endings -- [--target <tag>] [--character <char>] [--opponent <char>]
//                            [--stage <stage>] [--opponent-key <tag|code>]
//                            [--limit <n>] [--bands] [--json]
//
// Reads the v19 combo_ending_events table, so the games must have been imported
// (or backfilled) with the current detector version. Rows are resolved against
// the configured target player at import time; --target verifies that configured
// target rather than re-perspectiving stored rows.
//
// The unit is one own conversion, anchored on its final connected hit — NOT a
// verified true combo and NOT conversion.endFrame. Labels state measured moves
// and outcomes; they never assert intent or a dropped combo.

import { EVENT_SAMPLE_GUARDS } from "./characterEventProfile";
import {
  COMBO_ENDINGS_DEFAULT_LIMIT,
  COMBO_ENDINGS_MAX_LIMIT,
  type ComboEndingsFilters,
  type ComboEndingsResult,
} from "./comboEndings";
import { loadConfig } from "./config";
import { closeDb, getComboEndings } from "./db";
import type { ComboDecisionRow, ComboEndingSummary, ComboEnderRow, ComboOutcomeRow } from "./pipeline/comboEndings";

interface CliOptions {
  target: string | null;
  filters: ComboEndingsFilters;
  showBands: boolean;
  json: boolean;
}

const USAGE = `Usage:
  npm run combo-endings -- [--target <tag>] [--character <char>] [--opponent <char>]
                            [--stage <stage>] [--opponent-key <tag|code>]
                            [--limit <n>] [--bands] [--json]

  --target        Verify the configured target player (rows are resolved at import)
  --character     Only games where you played this character
  --opponent      Only games against this opponent character
  --stage         Only games on this stage
  --opponent-key  Only games against this opponent tag or connect code
  --limit         Most recent scoped games (default ${COMBO_ENDINGS_DEFAULT_LIMIT}, max ${COMBO_ENDINGS_MAX_LIMIT})
  --bands         Print each ender's end-percent band distribution
  --json          Print the raw result as JSON`;

function fail(message: string): never {
  console.error(message);
  console.error(`\n${USAGE}`);
  process.exit(1);
}

function parseInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) fail(`${flag} expects an integer, got "${raw}".`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const filters: ComboEndingsFilters = {};
  let target: string | null = null;
  let showBands = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      if (i + 1 >= args.length) fail(`${arg} expects a value.`);
      return args[++i]!;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    switch (arg) {
      case "--target":
        target = next();
        break;
      case "--character":
        filters.character = next();
        break;
      case "--opponent":
        filters.opponentCharacter = next();
        break;
      case "--stage":
        filters.stage = next();
        break;
      case "--opponent-key":
        filters.opponentKey = next();
        break;
      case "--limit": {
        const limit = parseInteger(next(), "--limit");
        if (limit < 1) fail("--limit must be at least 1.");
        filters.limit = limit;
        break;
      }
      case "--bands":
        showBands = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        fail(`Unknown argument "${arg}".`);
    }
  }

  return { target, filters, showBands, json };
}

const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

function scopeText(filters: ComboEndingsFilters): string {
  const parts: string[] = [`last ${filters.limit ?? COMBO_ENDINGS_DEFAULT_LIMIT} games`];
  if (filters.character) parts.push(`your ${filters.character}`);
  if (filters.opponentCharacter) parts.push(`vs ${filters.opponentCharacter}`);
  if (filters.stage) parts.push(`on ${filters.stage}`);
  if (filters.opponentKey) parts.push(`vs opponent ${filters.opponentKey}`);
  return parts.join(" · ");
}

function killText(row: { count: number; kills: number; killRate: number }): string {
  return `${row.kills} kill${row.kills === 1 ? "" : "s"} (${pct(row.killRate)})`;
}

function outcomeText(outcomes: readonly ComboOutcomeRow[]): string {
  return outcomes.map((row) => `${row.key} ${row.count} (${pct(row.share)})`).join(", ");
}

function printEnder(row: ComboEnderRow, options: CliOptions): void {
  const lowN = row.lowSample ? `  [low n: < ${EVENT_SAMPLE_GUARDS.comboEnderMin}]` : "";
  console.log(
    `  ${row.label} (${row.family}) — ${row.count} (${pct(row.share)} of endings) · ${killText(row)} · avg ${row.avgDamage.toFixed(1)} damage · ${row.avgMoveCount.toFixed(1)} moves · end % ${Math.round(row.endPercentP25)}–${Math.round(row.endPercentP75)} (median ${Math.round(row.endPercentMedian)})${lowN}`,
  );
  if (options.showBands) {
    console.log(
      `      end % bands: ${row.endPercentBands
        .map((band) => `${band.label} ${band.count}${band.kills > 0 ? ` (${band.kills}K)` : ""}`)
        .join(" · ")}`,
    );
  }
  console.log(`      victim end states: ${row.endStates.map((s) => `${s.state} ${s.count}`).join(", ")}`);
}

function printDecision(row: ComboDecisionRow): void {
  const lowN = row.lowSample ? `  [low n: < ${EVENT_SAMPLE_GUARDS.comboDecisionMin}]` : "";
  const delay = row.avgPunishDelay == null ? "" : ` · punished after ${Math.round(row.avgPunishDelay)}f average`;
  console.log(
    `  ${row.decision} — ${row.count} (${pct(row.share)} of endings) · killed ${row.killed} · extended ${row.extended} · whiffed ${row.whiffed} · punished ${row.punished} · reset ${row.reset} · edgeguard-linked ${row.edgeguardLinked}${delay}${lowN}`,
  );
}

function printRun(result: ComboEndingsResult, options: CliOptions, target: string | null): void {
  const { coverage, summary } = result;
  console.log("=== How your combos end ===");
  console.log(
    "Each row is one of YOUR conversions, anchored on the final connected hit (not a verified true combo; the recorded conversion can include resets and tech chases). The ender is the exact final move; post-hit decisions are measured from your first actionable frame.",
  );
  console.log(`Target: ${target ?? "(not configured — stored rows used as-is)"}`);
  console.log(`Scope: ${scopeText(options.filters)}`);
  console.log(
    `Coverage: ${coverage.gamesInScope} games in scope · ${coverage.gamesWithEndings} with endings · ${coverage.gamesParsedCurrent} parsed with the current detector`,
  );
  const missing = Math.max(0, coverage.gamesInScope - coverage.gamesParsedCurrent);
  if (missing > 0) {
    console.log(
      `WARNING: ${missing} scoped game${missing === 1 ? "" : "s"} predate the combo-ending ledger. Run: npm run backfill`,
    );
  }

  if (coverage.gamesInScope === 0) {
    console.log("\nNo games match these filters.");
    return;
  }
  if (summary.total === 0) {
    console.log("\nNo combo endings recorded for these games.");
    if (missing > 0) console.log("Older replays need a backfill first.");
    return;
  }

  printSummary(summary, options);
}

function printSummary(summary: ComboEndingSummary, options: CliOptions): void {
  console.log(
    `\nEndings: ${summary.total} · ${summary.kills} kill${summary.kills === 1 ? "" : "s"} (${pct(summary.killRate)}) · avg ${summary.avgDamage.toFixed(1)} damage · ${summary.avgMoveCount.toFixed(1)} moves · end % ${Math.round(summary.endPercentP25)}–${Math.round(summary.endPercentP75)} (median ${Math.round(summary.endPercentMedian)})`,
  );
  console.log(
    `Victim end states: ${summary.victimEndStates.map((s) => `${s.state} ${s.count} (${pct(s.share)})`).join(", ")}`,
  );
  console.log(`Outcomes (flags, not a partition): ${outcomeText(summary.outcomes)}`);

  console.log("\n--- Enders (exact final move) ---");
  if (summary.enders.length === 0) {
    console.log("  No ender rows recorded.");
  }
  for (const row of summary.enders) printEnder(row, options);
  if (summary.total < EVENT_SAMPLE_GUARDS.comboEnderMin) {
    console.log(
      `  Low total (${summary.total} < ${EVENT_SAMPLE_GUARDS.comboEnderMin}): descriptive only — collect more endings before calling any of these a habit.`,
    );
  }

  console.log("\n--- Post-hit decisions (after your first actionable frame) ---");
  if (summary.decisions.length === 0) {
    console.log("  No post-hit decisions recorded.");
  }
  for (const row of summary.decisions) printDecision(row);

  const { cost } = summary;
  console.log("\n--- Cost after the hit ---");
  console.log(
    `  Punished: ${cost.punished} of ${summary.total} endings (${pct(cost.punishedShare)}) · avg ${cost.avgPunishDamagePerEnding.toFixed(1)} damage taken per ending · ${cost.avgPunishDamageWhenPunished.toFixed(1)} when punished · reaction ${cost.avgPunishDelay == null ? "n/a" : `${Math.round(cost.avgPunishDelay)}f`}`,
  );
  if (cost.topPunishOpeners.length > 0) {
    console.log(
      `  Punished most often by: ${cost.topPunishOpeners
        .map((row) => `${row.label} ${row.count} (${pct(row.share)})`)
        .join(", ")}`,
    );
  }

  const squandered = summary.squanderedEndings;
  console.log("\n--- Endings at ≥100% without the stock ---");
  console.log(
    `  ${squandered.total} of ${summary.total} endings (${pct(squandered.share)}) ended at 100% or more without a kill. This is a fact about the recorded ending — never a "missed kill" or "dropped combo" claim.`,
  );
  if (squandered.byEnder.length > 0) {
    for (const row of squandered.byEnder) {
      console.log(
        `  ${row.label} (${row.family}) — ${row.count} · end states: ${row.endStates.map((s) => `${s.state} ${s.count}`).join(", ")}`,
      );
    }
  }

  if (summary.examples.length > 0) {
    console.log("\n--- Most recent endings ---");
    for (const example of summary.examples) {
      const flags = [
        example.didKill ? "kill" : null,
        example.extended ? "extended" : null,
        example.whiffed ? "whiffed" : null,
        example.punished ? `punished${example.punishDelay == null ? "" : ` after ${example.punishDelay}f`}` : null,
        example.edgeguardLinked ? "edgeguard-linked" : null,
      ].filter((flag): flag is string => flag != null);
      const decision =
        example.postHitMoveLabel != null
          ? `${example.postHitDecision} (${example.postHitMoveLabel})`
          : example.postHitDecision;
      console.log(
        `  [${example.timestamp}] game ${example.gameId ?? "?"} · ${example.enderLabel} · ${example.startPercent}% → ${example.endPercent}% · ${example.damage.toFixed(1)} damage · victim ${example.victimEndState} · next ${decision}${flags.length > 0 ? ` · ${flags.join(" · ")}` : ""}`,
      );
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function main(): void {
  const options = parseArgs(process.argv);
  const configTarget = loadConfig().targetPlayer ?? null;
  if (options.target && configTarget && options.target.toLowerCase() !== configTarget.toLowerCase()) {
    console.error(
      `Combo-ending rows are stored against the configured target (${configTarget}). --target ${options.target} cannot re-perspective them.\n` +
        "Change the target player and re-import, or omit --target.",
    );
    process.exit(1);
  }
  const target = configTarget ?? options.target;

  try {
    const result = getComboEndings(options.filters);
    if (options.json) {
      console.log(JSON.stringify({ target, filters: options.filters, ...result }, null, 2));
    } else {
      printRun(result, options, target);
    }
  } finally {
    closeDb();
  }
}

// Only run when executed directly, not when imported (same pattern as stats.ts).
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${errorMessage(err)}`);
    process.exit(1);
  }
}
