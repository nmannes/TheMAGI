#!/usr/bin/env node
/**
 * Hit review pipeline: find the moments the configured player got hit, render
 * the best/most costly ones to MP4, and optionally send them to Telegram.
 *
 * Usage:
 *   npx tsx src/hit-review-cli.ts --dir ~/Slippi --target POOK#392 --json
 *   npx tsx src/hit-review-cli.ts --dir ~/Slippi --limit 5 --render --telegram
 *   npx tsx src/hit-review-cli.ts --telegram-check
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveReplayFolder, resolveTarget } from "./config.js";
import {
  extractHitReview,
  formatHitReviewCaption,
  HitReviewTargetError,
  selectHitSequences,
  type HitReviewSequence,
} from "./hitReview.js";
import { DEFAULT_MAX_OUT_SIZE, enforceOutputLimit, parseByteSize, type RetentionResult } from "./outputRetention.js";
import { processGame } from "./pipeline/index.js";
import {
  discoverTelegramChats,
  getTelegramMe,
  sendTelegramVideo,
  telegramConfigFromEnv,
  type TelegramConfig,
} from "./telegram.js";

interface CliArgs {
  paths: string[];
  dirs: string[];
  replays: string[];
  target: string | null;
  limit: number;
  minDamage: number | null;
  deathsOnly: boolean;
  json: boolean;
  render: boolean;
  outDir: string | null;
  telegram: boolean;
  telegramCheck: boolean;
  telegramChat: string | null;
  statePath: string;
  noState: boolean;
  force: boolean;
  all: boolean;
  sinceHours: number;
  resolution: string;
  maxOutBytes: number;
  backend: string | null;
  noXvfb: boolean;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

interface Candidate {
  path: string;
  explicit: boolean;
  size: number;
  mtimeMs: number;
}

interface AnalyzedGame {
  candidate: Candidate;
  sequences: HitReviewSequence[];
}

interface ReplayState {
  size: number;
  mtimeMs: number;
  processedAt: string;
  sequences: number;
}

interface HitReviewState {
  version: 1;
  replays: Record<string, ReplayState>;
  delivered: Record<string, string>;
}

interface ClipOutput {
  path: string;
  sequence: HitReviewSequence;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_SINCE_HOURS = 48;
const DELIVERED_RETENTION_DAYS = 60;
const TELEGRAM_SEND_INTERVAL_MS = 1200;

const USAGE = `Usage: npx tsx src/hit-review-cli.ts [paths...] [options]

Finds the moments the target player got hit, groups nearby hits, and can render
each sequence to MP4 and send it to Telegram.

Replay input:
  --dir PATH            Scan a folder recursively for .slp files (repeatable)
  --replay PATH         Add a replay (repeatable)
  positional paths      Files or folders; folders are scanned

Selection:
  --target TAG|CODE     Player to review (default: MAGI config or MAGI_TARGET)
  --limit N             Clips to render/send, ranked by cost (default: ${DEFAULT_LIMIT}; 0 = all)
  --min-damage N        Ignore sequences below this damage
  --deaths-only         Only sequences that took a stock

Output:
  --json                Print the selected sequences as JSON (progress goes to stderr)
  --render              Render each selected sequence with scripts/render-clip.sh
  --out-dir PATH        Clip directory (default: ~/.magi-melee/hit-review)
  --max-out-size SIZE   Delete oldest produced clips above this cap, e.g. 500MB/1GB
                        (default: ${DEFAULT_MAX_OUT_SIZE}; 0 disables pruning)
  --resolution RES      480p/720p/1080p/2160p or raw EFBScale (default: 720p)
  --backend NAME        Dolphin video backend (default: script default)
  --no-xvfb             Do not start a private virtual display
  --dry-run             Show what would be rendered/sent, but do nothing

Telegram:
  --telegram            Send rendered clips (implies --render)
  --telegram-chat ID    Override TELEGRAM_CHAT_ID
  --telegram-check      Print the bot identity and recently seen chat ids, then exit

State:
  --state PATH          State file (default: ~/.magi-melee/hit-review-state.json)
  --since-hours N       On a fresh state, only scan files newer than N hours (default: ${DEFAULT_SINCE_HOURS}; 0 = all)
  --all                 Process every discovered replay, regardless of state/age
  --force               Reprocess replays and resend clips already marked delivered
  --no-state            Do not read or write state (will reprocess on every run)
  --verbose             Print per-replay detail

Environment:
  MAGI_TARGET, CLIPPI_TARGET           Target tag/connect code
  TELEGRAM_BOT_TOKEN                    Bot token from @BotFather
  TELEGRAM_CHAT_ID                      Destination chat id or @channelusername
  SLIPPI_PLAYBACK, MELEE_ISO           Paths used by scripts/render-clip.sh
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    paths: [],
    dirs: [],
    replays: [],
    target: null,
    limit: DEFAULT_LIMIT,
    minDamage: null,
    deathsOnly: false,
    json: false,
    render: false,
    outDir: null,
    telegram: false,
    telegramCheck: false,
    telegramChat: null,
    statePath: path.join(os.homedir(), ".magi-melee", "hit-review-state.json"),
    noState: false,
    force: false,
    all: false,
    sinceHours: DEFAULT_SINCE_HOURS,
    resolution: process.env.CLIPPI_RESOLUTION?.trim() || "720p",
    maxOutBytes: parseByteSize(DEFAULT_MAX_OUT_SIZE),
    backend: null,
    noXvfb: false,
    dryRun: false,
    verbose: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const raw = argv[i]!;
    if (raw === "-h" || raw === "--help") {
      args.help = true;
      i++;
      continue;
    }
    if (!raw.startsWith("--")) {
      args.paths.push(raw);
      i++;
      continue;
    }

    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : raw.slice(equalsIndex + 1);
    const takeValue = (): string => {
      if (inlineValue !== null) {
        i++;
        return inlineValue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
      i += 2;
      return next;
    };

    switch (name) {
      case "--dir":
        args.dirs.push(takeValue());
        break;
      case "--replay":
        args.replays.push(takeValue());
        break;
      case "--target":
        args.target = takeValue();
        break;
      case "--limit":
        args.limit = parseInteger(name, takeValue(), 0);
        break;
      case "--min-damage":
        args.minDamage = parseNumber(name, takeValue(), 0);
        break;
      case "--deaths-only":
        args.deathsOnly = true;
        i++;
        break;
      case "--json":
        args.json = true;
        i++;
        break;
      case "--render":
        args.render = true;
        i++;
        break;
      case "--out-dir":
        args.outDir = takeValue();
        break;
      case "--telegram":
        args.telegram = true;
        i++;
        break;
      case "--telegram-chat":
        args.telegramChat = takeValue();
        break;
      case "--telegram-check":
        args.telegramCheck = true;
        i++;
        break;
      case "--state":
        args.statePath = path.resolve(expandHome(takeValue()));
        break;
      case "--since-hours":
        args.sinceHours = parseNumber(name, takeValue(), 0);
        break;
      case "--all":
        args.all = true;
        i++;
        break;
      case "--force":
        args.force = true;
        i++;
        break;
      case "--no-state":
        args.noState = true;
        i++;
        break;
      case "--resolution":
        args.resolution = takeValue();
        break;
      case "--max-out-size":
        args.maxOutBytes = parseByteSize(takeValue());
        break;
      case "--backend":
        args.backend = takeValue();
        break;
      case "--no-xvfb":
        args.noXvfb = true;
        i++;
        break;
      case "--dry-run":
        args.dryRun = true;
        i++;
        break;
      case "--verbose":
        args.verbose = true;
        i++;
        break;
      default:
        throw new Error(`Unknown option: ${name}\n\n${USAGE}`);
    }
  }

  if (args.telegram) args.render = true;
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.telegramCheck) {
    await runTelegramCheck(args);
    return;
  }

  const target = resolveTarget(args.target ?? envTarget());
  if (!target) {
    throw new Error(
      "No target player. Pass --target POOK#392, set MAGI_TARGET, or set connectCode/targetPlayer in ~/.magi-melee/config.json.",
    );
  }

  if (args.paths.length === 0 && args.dirs.length === 0 && args.replays.length === 0) {
    const configuredFolder = resolveReplayFolder(null);
    if (!configuredFolder) {
      throw new Error(
        "No replay input. Pass --dir ~/Slippi (or a replay path), or set replayFolder in ~/.magi-melee/config.json.",
      );
    }
    args.dirs.push(configuredFolder);
  }

  const state = args.noState ? emptyState() : loadState(args.statePath);
  const candidates = collectCandidates(args);

  const toProcess: Candidate[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (shouldProcess(candidate, state, args)) toProcess.push(candidate);
    else skipped++;
  }

  log(
    `${candidates.length} replay(s) found; ${toProcess.length} to analyze, ${skipped} skipped` +
      `${args.noState ? " (state disabled)" : ""}.`,
  );

  let telegramConfig: TelegramConfig | null = null;
  if (args.telegram && !args.dryRun) {
    telegramConfig = telegramConfigFromEnv({ chatId: args.telegramChat });
  }

  const renderScript = findRenderScript();
  if ((args.render || args.telegram) && !args.dryRun && !fs.existsSync(renderScript)) {
    throw new Error(`Render script not found: ${renderScript}`);
  }

  const analyzed: AnalyzedGame[] = [];
  const errors: string[] = [];
  let targetErrors = 0;

  for (const candidate of toProcess) {
    try {
      const result = processGame(candidate.path, analyzed.length + 1);
      const sequences = extractHitReview(result, target, candidate.path);
      analyzed.push({ candidate, sequences });
      log(`  ${path.basename(candidate.path)}: ${sequences.length} hit sequence(s)`);
    } catch (err) {
      if (err instanceof HitReviewTargetError) targetErrors++;
      const message = errorMessage(err);
      errors.push(`${path.basename(candidate.path)}: ${message}`);
      log(`  skipped ${path.basename(candidate.path)}: ${message}`);
    }
  }

  if (analyzed.length === 0) {
    if (targetErrors > 0) {
      throw new HitReviewTargetError(
        `Target player "${target}" was not found in any replay (${targetErrors} target error(s)). Check the tag/connect code.`,
      );
    }
    if (errors.length > 0) throw new Error(`No replay could be analyzed. First error: ${errors[0]}`);
    log("No new replays to analyze.");
  }

  const allSequences = analyzed.flatMap((game) => game.sequences);
  const selectionOptions: { limit: number; minDamage?: number; deathsOnly?: boolean } = { limit: args.limit };
  if (args.minDamage !== null) selectionOptions.minDamage = args.minDamage;
  if (args.deathsOnly) selectionOptions.deathsOnly = true;
  const selected = selectHitSequences(allSequences, selectionOptions);

  log(`Found ${allSequences.length} hit sequence(s) in ${analyzed.length} game(s); selected ${selected.length}.`);

  const outDir = path.resolve(expandHome(args.outDir ?? path.join(os.homedir(), ".magi-melee", "hit-review")));
  const clips: ClipOutput[] = [];
  let renderFailures = 0;
  let sendFailures = 0;
  let sent = 0;
  let rendered = 0;
  let retention: RetentionResult | null = null;

  const runsPipeline = args.render || args.telegram;
  if (runsPipeline) {
    const analyzedByPath = new Map(analyzed.map((game) => [game.candidate.path, game]));
    const selectedByPath = new Map<string, HitReviewSequence[]>();
    for (const sequence of selected) {
      const list = selectedByPath.get(sequence.replayPath);
      if (list) list.push(sequence);
      else selectedByPath.set(sequence.replayPath, [sequence]);
    }

    // A replay with no selected clip still finished analysis; mark it so the
    // next run does not reparse it for nothing.
    if (!args.dryRun && !args.noState) {
      let dirty = false;
      for (const game of analyzed) {
        if (selectedByPath.has(game.candidate.path)) continue;
        markProcessed(state, game.candidate, game.sequences.length);
        dirty = true;
      }
      if (dirty) persistState(args, state);
    }

    const groups = [...selectedByPath.entries()]
      .map(([replayPath, sequences]) => ({
        game: analyzedByPath.get(replayPath),
        sequences: [...sequences].sort((a, b) => a.firstHitFrame - b.firstHitFrame),
      }))
      .filter((group): group is { game: AnalyzedGame; sequences: HitReviewSequence[] } => group.game !== undefined)
      .sort(
        (a, b) =>
          compareSequenceMoment(a.sequences[0], b.sequences[0]) ||
          a.game.candidate.path.localeCompare(b.game.candidate.path),
      );

    log(`Output directory: ${outDir}`);
    if (args.telegram) log(`Telegram destination: chat ${telegramConfig?.chatId ?? "(dry run)"}`);

    for (const group of groups) {
      let groupOk = true;

      for (const sequence of group.sequences) {
        const clipPath = path.join(outDir, clipFileName(sequence));

        if (args.dryRun) {
          log(
            `[dry-run] would render ${path.basename(sequence.replayPath)} frames ${sequence.clipStartFrame}-${sequence.clipEndFrame} -> ${clipPath}`,
          );
          clips.push({ path: clipPath, sequence });
          continue;
        }

        try {
          fs.mkdirSync(outDir, { recursive: true });
          renderClip(sequence, clipPath, args, renderScript);
          writeClipMetadata(clipPath, sequence);
          rendered++;
          clips.push({ path: clipPath, sequence });
          log(`  rendered ${path.basename(clipPath)}`);
        } catch (err) {
          groupOk = false;
          renderFailures++;
          log(
            `  render failed for ${path.basename(sequence.replayPath)} frames ${sequence.clipStartFrame}-${sequence.clipEndFrame}: ${errorMessage(err)}`,
          );
          continue;
        }

        if (args.telegram && telegramConfig) {
          const key = deliveredKey(sequence);
          if (!args.force && state.delivered[key]) {
            log("  already delivered; skipping Telegram");
          } else {
            try {
              await sendTelegramVideo(telegramConfig, clipPath, formatHitReviewCaption(sequence));
              sent++;
              state.delivered[key] = new Date().toISOString();
              if (!args.noState) persistState(args, state);
            } catch (err) {
              groupOk = false;
              sendFailures++;
              log(`  Telegram send failed: ${errorMessage(err)}`);
            }
            await sleep(TELEGRAM_SEND_INTERVAL_MS);
          }
        }
      }

      if (groupOk && !args.dryRun && !args.noState) {
        markProcessed(state, group.game.candidate, group.game.sequences.length);
        persistState(args, state);
      }
    }
  } else if (!args.json) {
    log("Pass --render to produce MP4s or --telegram to render and send them.");
  }

  if (runsPipeline && !args.dryRun && args.maxOutBytes > 0) {
    retention = enforceOutputLimit(outDir, args.maxOutBytes, { onError: log });
    if (retention.removed > 0) {
      log(
        `Pruned ${retention.removed} old clip/sidecar file(s), freed ${formatBytes(retention.freedBytes)}; ` +
          `${formatBytes(retention.remainingBytes)} remains (limit ${formatBytes(args.maxOutBytes)}).`,
      );
    } else if (retention.remainingBytes > args.maxOutBytes) {
      log(
        `Warning: ${formatBytes(retention.remainingBytes)} of clips remain, above the ` +
          `${formatBytes(args.maxOutBytes)} limit; prune manually if deletion was blocked.`,
      );
    }
  }

  const payload = {
    target,
    filesScanned: candidates.length,
    filesAnalyzed: analyzed.length,
    filesSkipped: skipped,
    sequencesFound: allSequences.length,
    sequencesSelected: selected,
    clips,
    outputLimitBytes: args.maxOutBytes,
    outputBytes: retention?.remainingBytes ?? null,
    errors,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    log(
      `Done: ${rendered} rendered, ${sent} sent, ${renderFailures} render failure(s), ${sendFailures} send failure(s).`,
    );
  }

  if (renderFailures > 0 || sendFailures > 0) process.exitCode = 1;
}

async function runTelegramCheck(args: CliArgs): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and export the token.");
  }
  const apiBase = process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org";
  const me = await getTelegramMe(token, apiBase);
  process.stdout.write(`Bot: @${me.username ?? me.first_name ?? me.id}\n`);
  const configuredChat = args.telegramChat ?? process.env.TELEGRAM_CHAT_ID?.trim();
  if (configuredChat) process.stdout.write(`TELEGRAM_CHAT_ID: ${configuredChat}\n`);

  const chats = await discoverTelegramChats(token, apiBase);
  if (chats.length === 0) {
    process.stdout.write(
      "No chats seen yet. Send /start (or any message) to the bot, then run this again. " +
        "Group chats only appear after the bot has been added and someone posts.\n",
    );
    return;
  }
  for (const chat of chats) {
    process.stdout.write(`chat_id=${chat.id} type=${chat.type} title=${chat.title}\n`);
  }
}

function collectCandidates(args: CliArgs): Candidate[] {
  const explicitFiles = new Set<string>();
  const dirs = args.dirs.map((dir) => path.resolve(expandHome(dir)));

  for (const replay of args.replays) {
    explicitFiles.add(canonicalFile(path.resolve(expandHome(replay))));
  }
  for (const positional of args.paths) {
    const resolved = path.resolve(expandHome(positional));
    if (!fs.existsSync(resolved)) throw new Error(`Path not found: ${positional}`);
    if (fs.statSync(resolved).isDirectory()) dirs.push(resolved);
    else explicitFiles.add(canonicalFile(resolved));
  }

  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Replay folder not found: ${dir}`);
    }
  }

  const files = new Set(explicitFiles);
  for (const dir of dirs) {
    for (const file of walkSlp(dir)) files.add(canonicalFile(file));
  }
  if (files.size === 0) {
    throw new Error("No .slp files found. Pass --dir ~/Slippi or a replay path.");
  }

  const candidates: Candidate[] = [];
  for (const file of files) {
    const stat = fs.statSync(file);
    candidates.push({
      path: file,
      explicit: explicitFiles.has(file),
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    });
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return candidates;
}

function walkSlp(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkSlp(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".slp")) files.push(full);
  }
  return files;
}

function canonicalFile(file: string): string {
  if (!fs.existsSync(file)) throw new Error(`Replay not found: ${file}`);
  if (!fs.statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
  return fs.realpathSync(file);
}

function shouldProcess(candidate: Candidate, state: HitReviewState, args: CliArgs): boolean {
  if (candidate.explicit) return true;
  if (args.force || args.all) return true;
  const recorded = state.replays[candidate.path];
  if (recorded) {
    return recorded.size !== candidate.size || recorded.mtimeMs !== candidate.mtimeMs;
  }
  if (!args.noState && Object.keys(state.replays).length === 0 && args.sinceHours > 0) {
    return Date.now() - candidate.mtimeMs <= args.sinceHours * 3_600_000;
  }
  return true;
}

function markProcessed(state: HitReviewState, candidate: Candidate, sequences: number): void {
  state.replays[candidate.path] = {
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    processedAt: new Date().toISOString(),
    sequences,
  };
}

function renderClip(sequence: HitReviewSequence, outPath: string, args: CliArgs, renderScript: string): void {
  const commandArgs = [
    renderScript,
    "--replay",
    sequence.replayPath,
    "--start",
    String(sequence.clipStartFrame),
    "--end",
    String(sequence.clipEndFrame),
    "--out",
    outPath,
    "--resolution",
    args.resolution,
  ];
  if (args.backend) commandArgs.push("--backend", args.backend);
  if (args.noXvfb) commandArgs.push("--no-xvfb");

  const result = spawnSync("bash", commandArgs, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`render-clip.sh exited ${result.status ?? "by signal"}\n${tail(output, 4000)}`);
  }
  if (args.verbose && result.stdout.trim()) log(result.stdout.trim());
}

function writeClipMetadata(clipPath: string, sequence: HitReviewSequence): void {
  const metadataPath = clipPath.replace(/\.mp4$/i, ".json");
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({ ...sequence, renderedPath: clipPath, renderedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function findRenderScript(): string {
  const candidates = [
    path.resolve(__dirname, "..", "scripts", "render-clip.sh"),
    path.resolve(__dirname, "..", "..", "scripts", "render-clip.sh"),
    path.resolve(process.cwd(), "scripts", "render-clip.sh"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function clipFileName(sequence: HitReviewSequence): string {
  const stem = path
    .basename(sequence.replayPath, path.extname(sequence.replayPath))
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 60);
  const hash = createHash("sha1").update(sequence.replayPath).digest("hex").slice(0, 8);
  const label = sequence.didKill ? "death" : "hit";
  return `${stem}-${hash}-${label}-${sequence.firstHitFrame}-${sequence.clipStartFrame}-${sequence.clipEndFrame}.mp4`;
}

function deliveredKey(sequence: HitReviewSequence): string {
  return `${sequence.replayPath}|${sequence.target.slot}|${sequence.kind}|${sequence.firstHitFrame}|${sequence.lastHitFrame}`;
}

function compareSequenceMoment(a: HitReviewSequence | undefined, b: HitReviewSequence | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return (a.startAt ?? "").localeCompare(b.startAt ?? "") || a.firstHitFrame - b.firstHitFrame;
}

function loadState(file: string): HitReviewState {
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HitReviewState>;
    return {
      version: 1,
      replays: parsed.replays && typeof parsed.replays === "object" ? parsed.replays : {},
      delivered: parsed.delivered && typeof parsed.delivered === "object" ? parsed.delivered : {},
    };
  } catch (err) {
    log(`Warning: could not read state file ${file} (${errorMessage(err)}); starting fresh.`);
    return emptyState();
  }
}

function emptyState(): HitReviewState {
  return { version: 1, replays: {}, delivered: {} };
}

function persistState(args: CliArgs, state: HitReviewState): void {
  if (args.noState) return;
  pruneDelivered(state);
  fs.mkdirSync(path.dirname(args.statePath), { recursive: true });
  const temporary = `${args.statePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, args.statePath);
}

function pruneDelivered(state: HitReviewState): void {
  const cutoff = Date.now() - DELIVERED_RETENTION_DAYS * 24 * 3600_000;
  for (const [key, timestamp] of Object.entries(state.delivered)) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || parsed < cutoff) delete state.delivered[key];
  }
}

function envTarget(): string | null {
  return process.env.MAGI_TARGET?.trim() || process.env.CLIPPI_TARGET?.trim() || null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseInteger(name: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer >= ${min}`);
  return parsed;
}

function parseNumber(name: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} must be a number >= ${min}`);
  return parsed;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(message: string): void {
  console.error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(`Error: ${errorMessage(err)}`);
  process.exit(1);
});
