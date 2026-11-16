// Standalone CLI for the opening ledger — the first hit in neutral of each
// opponent conversion where the target player was the victim.
//
// Usage:
//   npm run openings -- [--target <tag>] [--character <char>] [--opponent <char>]
//                       [--stage <stage>] [--opponent-key <tag|code>]
//                       [--limit <n>] [--k <2-6>] [--no-clusters] [--json]
//                       [--render | --send] [--bucket <n> | --cluster <n>]
//                       [--clips <n>] [--resolution <r>] [--out <dir>]
//
// Reads the v18 opening_events table, so the games must have been imported (or
// backfilled) with the current detector version. Rows are resolved against the
// configured target player at import time; --target verifies that configured
// target rather than re-perspectiving stored rows.
//
// --render/--send turn the selected rule bucket (default: the most frequent)
// or shape cluster into headless Slippi clips. Clips show the opening hit with
// 5s lead-in and 2s follow-through, matching the chronological hit-review
// event. --send delivers through Telegram using TELEGRAM_BOT_TOKEN/CHAT_ID.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EVENT_SAMPLE_GUARDS } from "./characterEventProfile";
import { clipFileName, findRenderClipScript, renderClipFile } from "./clipRender";
import { loadConfig } from "./config";
import { closeDb, getGameClipInfo, getOpeningsAgainst, type GameClipInfo } from "./db";
import { formatOpeningClipCaption, openingClipBounds, selectOpeningClipExamples } from "./openingClips";
import {
  OPENINGS_AGAINST_DEFAULT_LIMIT,
  OPENINGS_AGAINST_MAX_LIMIT,
  type OpeningsAgainstFilters,
  type OpeningsAgainstResult,
} from "./openingsAgainst";
import { sendTelegramVideo, telegramConfigFromEnv, type TelegramConfig } from "./telegram";

interface ClipOptions {
  render: boolean;
  send: boolean;
  /** Examples to clip (default 1). */
  clips: number;
  /** 1-based position in the printed rule-bucket list. */
  bucket: number | null;
  /** Shape-cluster display id. */
  cluster: number | null;
  resolution: string;
  outDir: string | null;
  backend: string | null;
  noXvfb: boolean;
  verbose: boolean;
}

interface CliOptions {
  target: string | null;
  filters: OpeningsAgainstFilters;
  noClusters: boolean;
  json: boolean;
  clip: ClipOptions;
}

const USAGE = `Usage:
  npm run openings -- [--target <tag>] [--character <char>] [--opponent <char>]
                      [--stage <stage>] [--opponent-key <tag|code>]
                      [--limit <n>] [--k <2-6>] [--no-clusters] [--json]
                      [--render | --send] [--bucket <n> | --cluster <n>]
                      [--clips <n>] [--resolution <r>] [--out <dir>]

  --target        Verify the configured target player (rows are resolved at import)
  --character     Only games where you played this character
  --opponent      Only games against this opponent character
  --stage         Only games on this stage
  --opponent-key  Only games against this opponent tag or connect code
  --limit         Most recent scoped games (default ${OPENINGS_AGAINST_DEFAULT_LIMIT}, max ${OPENINGS_AGAINST_MAX_LIMIT})
  --k             Force the number of shape clusters (2-6) instead of silhouette selection
  --no-clusters   Skip the descriptive shape-cluster section
  --json          Print the raw result as JSON
  --render        Render clip(s) for a selected bucket/cluster (default: most frequent bucket)
  --send          Render and send the clip(s) to Telegram (requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
  --bucket        Rule bucket to clip, by its 1-based position in this output
  --cluster       Shape cluster to clip, by its displayed id (requires a valid cluster)
  --clips         Maximum examples to render/send (default 1)
  --resolution    480p/720p/1080p/1440p/2160p or a raw EFBScale (default: 720p)
  --out           Clip output directory (default ~/.magi-melee/hit-review)
  --backend       Dolphin video backend (default: script default)
  --no-xvfb       Use the current DISPLAY instead of starting Xvfb`;

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
  const filters: OpeningsAgainstFilters = {};
  let target: string | null = null;
  let noClusters = false;
  let json = false;
  let clipsSpecified = false;
  const clip: ClipOptions = {
    render: false,
    send: false,
    clips: 1,
    bucket: null,
    cluster: null,
    resolution: process.env.CLIPPI_RESOLUTION?.trim() || "720p",
    outDir: null,
    backend: null,
    noXvfb: false,
    verbose: false,
  };

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
      case "--k": {
        const k = parseInteger(next(), "--k");
        if (k < 2 || k > 6) fail("--k must be between 2 and 6.");
        filters.clusterK = k;
        break;
      }
      case "--no-clusters":
        noClusters = true;
        break;
      case "--json":
        json = true;
        break;
      case "--render":
        clip.render = true;
        break;
      case "--send":
        clip.render = true;
        clip.send = true;
        break;
      case "--bucket": {
        const bucket = parseInteger(next(), "--bucket");
        if (bucket < 1) fail("--bucket must be at least 1.");
        clip.bucket = bucket;
        clipsSpecified = true;
        break;
      }
      case "--cluster": {
        const cluster = parseInteger(next(), "--cluster");
        if (cluster < 1) fail("--cluster must be at least 1.");
        clip.cluster = cluster;
        clipsSpecified = true;
        break;
      }
      case "--clips": {
        const count = parseInteger(next(), "--clips");
        if (count < 1) fail("--clips must be at least 1.");
        clip.clips = count;
        clipsSpecified = true;
        break;
      }
      case "--resolution":
        clip.resolution = next();
        break;
      case "--out":
        clip.outDir = next();
        break;
      case "--backend":
        clip.backend = next();
        break;
      case "--no-xvfb":
        clip.noXvfb = true;
        break;
      case "--verbose":
        clip.verbose = true;
        break;
      default:
        fail(`Unknown argument "${arg}".`);
    }
  }

  if (clip.bucket != null && clip.cluster != null) fail("Choose either --bucket or --cluster, not both.");
  if (clipsSpecified && !clip.render) fail("--bucket/--cluster/--clips require --render or --send.");

  return { target, filters, noClusters, json, clip };
}

const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

function scopeText(filters: OpeningsAgainstFilters): string {
  const parts: string[] = [`last ${filters.limit ?? OPENINGS_AGAINST_DEFAULT_LIMIT} games`];
  if (filters.character) parts.push(`your ${filters.character}`);
  if (filters.opponentCharacter) parts.push(`vs ${filters.opponentCharacter}`);
  if (filters.stage) parts.push(`on ${filters.stage}`);
  if (filters.opponentKey) parts.push(`vs opponent ${filters.opponentKey}`);
  return parts.join(" · ");
}

function printRun(result: OpeningsAgainstResult, options: CliOptions, target: string | null): void {
  const { coverage, baseline } = result;
  console.log("=== Openings against you ===");
  console.log(
    "First hit in neutral of each opponent conversion where you were the victim. Grabs count at the grab frame, not the throw; follow-up combo hits, ledge/offstage hits and SDs are excluded.",
  );
  console.log(`Target: ${target ?? "(not configured — stored rows used as-is)"}`);
  console.log(`Scope: ${scopeText(options.filters)}`);
  console.log(
    `Coverage: ${coverage.gamesInScope} games in scope · ${coverage.gamesWithOpenings} with openings · ${coverage.gamesParsedCurrent} parsed with the current detector`,
  );
  const missing = Math.max(0, coverage.gamesInScope - coverage.gamesParsedCurrent);
  if (missing > 0) {
    console.log(
      `WARNING: ${missing} scoped game${missing === 1 ? "" : "s"} predate the opening ledger. Run: npm run backfill`,
    );
  }

  if (coverage.gamesInScope === 0) {
    console.log("\nNo games match these filters.");
    return;
  }
  if (baseline.total === 0) {
    console.log("\nNo neutral openings recorded for these games.");
    if (missing > 0) console.log("Older replays need a backfill first.");
    return;
  }

  console.log(
    `\nOpenings: ${baseline.total} · kills ${baseline.kills} (${pct(baseline.killRate)}) · avg damage ${baseline.avgDamage.toFixed(1)} · avg victim percent ${baseline.avgPercent.toFixed(0)}%`,
  );
  console.log(`By situation: ${baseline.situations.map((s) => `${s.key} ${s.count} (${pct(s.share)})`).join(", ")}`);
  console.log(`By opener family: ${baseline.families.map((f) => `${f.key} ${f.count} (${pct(f.share)})`).join(", ")}`);

  console.log("\n--- Rule buckets (situation · family · move) ---");
  for (const bucket of result.buckets) {
    const lowN = bucket.count < EVENT_SAMPLE_GUARDS.openingsBucketMin ? "  [low n]" : "";
    console.log(
      `  ${bucket.situation} · ${bucket.openerFamily} · ${bucket.openerLabel} — ${bucket.count} (${pct(bucket.share)} of openings) · ${bucket.kills} kill${bucket.kills === 1 ? "" : "s"} (${pct(bucket.killRate)}) · avg ${bucket.avgDamage.toFixed(1)} damage · ${bucket.distinctGames} game${bucket.distinctGames === 1 ? "" : "s"}${lowN}`,
    );
  }
  if (baseline.total < EVENT_SAMPLE_GUARDS.openingsTotalMin) {
    console.log(
      `  Low total (${baseline.total} < ${EVENT_SAMPLE_GUARDS.openingsTotalMin}): descriptive only — collect more games before calling any of these a habit.`,
    );
  }

  if (!options.noClusters) {
    console.log("\n--- Shape clusters (descriptive; recomputed per query, never persisted) ---");
    if (result.clusters.status === "insufficient-sample") {
      console.log(
        result.clusters.reason === "n-below-40"
          ? `  Insufficient sample: ${result.clusters.n} openings; clusters need ${result.clusters.required}.`
          : `  No valid partition at k 2-6 with minimum cluster size ${result.clusters.minClusterSize}.`,
      );
    } else {
      for (const cluster of result.clusters.clusters) {
        console.log(
          `  #${cluster.id} ${cluster.label} — ${cluster.size} (${pct(cluster.share)}) · mostly ${cluster.dominantSituation} · ${cluster.dominantFamily} · ${cluster.dominantOpenerLabel} · kill ${pct(cluster.killRate)} · avg ${cluster.avgDamage.toFixed(1)} damage · ${cluster.distinctGames} games`,
        );
      }
      if (result.clusters.weakSeparation) {
        console.log(
          `  Weak separation (silhouette ${result.clusters.silhouette.toFixed(2)}): a rough map of where openings happen, not separate habits.`,
        );
      }
    }
  }

  if (result.examples.length > 0) {
    console.log("\n--- Most recent examples ---");
    for (const example of result.examples) {
      console.log(
        `  [${example.timestamp}] game ${example.gameId ?? "?"} · ${example.situation} · ${example.openerFamily} · ${example.openerLabel} at ${example.victimPercent}% · ${example.damage.toFixed(1)} damage${example.didKill ? " · kill" : ""}`,
      );
    }
  }
}

interface OpeningClipOutput {
  source: "bucket" | "cluster";
  title: string;
  gameId: number;
  openingFrame: number;
  clipStartFrame: number;
  clipEndFrame: number;
  path: string;
  telegram: "sent" | "not-requested" | "failed";
  error: string | null;
}

async function renderOpeningClips(
  result: OpeningsAgainstResult,
  options: ClipOptions,
  quiet: boolean,
): Promise<OpeningClipOutput[]> {
  const selection = selectOpeningClipExamples(result, {
    bucket: options.bucket,
    cluster: options.cluster,
    limit: options.clips,
  });
  const gameIds = selection.examples.map((example) => example.gameId!);
  const games = new Map<number, GameClipInfo>(getGameClipInfo(gameIds).map((game) => [game.id, game]));
  const missing = selection.examples.filter((example) => !games.has(example.gameId!));
  if (missing.length > 0) {
    throw new Error(
      `Could not find the game row for ${missing.length} selected example(s); re-import or choose another bucket.`,
    );
  }

  const telegram: TelegramConfig | null = options.send ? telegramConfigFromEnv() : null;
  const renderScript = findRenderClipScript();
  if (!fs.existsSync(renderScript)) throw new Error(`Render script not found: ${renderScript}`);
  const outDir = path.resolve(expandHome(options.outDir ?? path.join(os.homedir(), ".magi-melee", "hit-review")));
  fs.mkdirSync(outDir, { recursive: true });

  if (!quiet) {
    console.log("\n=== Clip selection ===");
    console.log(`Selected ${selection.source} ${selection.id}: ${selection.title}`);
    console.log(selection.context);
  }

  const outputs: OpeningClipOutput[] = [];
  for (const example of selection.examples) {
    const game = games.get(example.gameId!);
    if (!game) continue;
    const bounds = openingClipBounds(example.startFrame, game.durationSeconds);
    const clipPath = path.join(
      outDir,
      clipFileName({
        replayPath: game.replayPath,
        label: "opening",
        firstHitFrame: example.startFrame,
        clipStartFrame: bounds.startFrame,
        clipEndFrame: bounds.endFrame,
      }),
    );
    const output: OpeningClipOutput = {
      source: selection.source,
      title: selection.title,
      gameId: game.id,
      openingFrame: example.startFrame,
      clipStartFrame: bounds.startFrame,
      clipEndFrame: bounds.endFrame,
      path: clipPath,
      telegram: "not-requested",
      error: null,
    };

    try {
      renderClipFile({
        replayPath: game.replayPath,
        startFrame: bounds.startFrame,
        endFrame: bounds.endFrame,
        outPath: clipPath,
        resolution: options.resolution,
        backend: options.backend,
        noXvfb: options.noXvfb,
        verbose: options.verbose,
      });
    } catch (err) {
      output.error = errorMessage(err);
      outputs.push(output);
      if (!quiet) console.log(`  render failed (game ${game.id}, frame ${example.startFrame}): ${output.error}`);
      continue;
    }

    if (telegram) {
      try {
        await sendTelegramVideo(telegram, clipPath, formatOpeningClipCaption(selection, example, game));
        output.telegram = "sent";
      } catch (err) {
        output.telegram = "failed";
        output.error = errorMessage(err);
      }
    }

    outputs.push(output);
    if (!quiet) {
      const status =
        output.error !== null
          ? `send failed: ${output.error}`
          : output.telegram === "sent"
            ? "sent to Telegram"
            : "rendered";
      console.log(`  ${status} — ${clipPath}`);
    }
  }

  return outputs;
}

function printClips(clips: readonly OpeningClipOutput[]): void {
  if (clips.length === 0) return;
  console.log("\n--- Clips ---");
  for (const clip of clips) {
    const status =
      clip.error !== null ? `ERROR: ${clip.error}` : clip.telegram === "sent" ? "sent to Telegram" : "rendered";
    console.log(`  ${clip.path} — ${status}`);
  }
}

function expandHome(file: string): string {
  if (file === "~") return os.homedir();
  if (file.startsWith("~/") || file.startsWith("~\\")) return path.join(os.homedir(), file.slice(2));
  return file;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const configTarget = loadConfig().targetPlayer ?? null;
  if (options.target && configTarget && options.target.toLowerCase() !== configTarget.toLowerCase()) {
    console.error(
      `Opening rows are stored against the configured target (${configTarget}). --target ${options.target} cannot re-perspective them.\n` +
        "Change the target player and re-import, or omit --target.",
    );
    process.exit(1);
  }
  const target = configTarget ?? options.target;

  try {
    const result = getOpeningsAgainst(options.filters);
    const clips = options.clip.render ? await renderOpeningClips(result, options.clip, options.json) : null;
    if (options.json) {
      console.log(
        JSON.stringify({ target, filters: options.filters, ...result, ...(clips ? { clips } : {}) }, null, 2),
      );
    } else {
      printRun(result, options, target);
      if (clips) printClips(clips);
    }
    if (clips?.some((clip) => clip.error !== null)) process.exitCode = 1;
  } finally {
    closeDb();
  }
}

// Only run when executed directly, not when imported (same pattern as stats.ts).
if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${errorMessage(err)}`);
    process.exit(1);
  });
}
