#!/usr/bin/env node
/**
 * Hit review pipeline: walk replay history chronologically, render the next
 * opening hits taken or landed conversions to MP4, and optionally send them to
 * Telegram.
 *
 * Usage:
 *   npx tsx src/hit-review-cli.ts --dir ~/Slippi --target POOK#392 --json
 *   npx tsx src/hit-review-cli.ts --dir ~/Slippi --limit 2 --render --telegram
 *   npx tsx src/hit-review-cli.ts --telegram-check
 *
 * Chronological review is the default. The earlier cost-ranked selection is
 * still available behind --legacy-ranked.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SlippiGame } from "@slippi/slippi-js/node";

import { clipFileName, findRenderClipScript, renderClipFile } from "./clipRender.js";
import { resolveReplayFolder, resolveTarget } from "./config.js";
import { expandHome, parseArgs, USAGE, type CliArgs } from "./hitReviewCliArgs.js";
import {
  extractHitReview,
  extractReviewEvents,
  formatHitReviewCaption,
  HitReviewTargetError,
  isReviewEventAfterPoint,
  reviewEventAtMs,
  reviewEventKey,
  reviewReplayLastEventAtMs,
  reviewReplayStartsAtMs,
  selectHitSequences,
  type HitReviewCursorPoint,
  type HitReviewSequence,
} from "./hitReview.js";
import { enforceOutputLimit, type RetentionResult } from "./outputRetention.js";
import { processGame } from "./pipeline/index.js";
import {
  discoverTelegramChats,
  getTelegramMe,
  sendTelegramVideo,
  telegramConfigFromEnv,
  type TelegramConfig,
} from "./telegram.js";

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

interface ReviewCacheEntry {
  size: number;
  mtimeMs: number;
  events: HitReviewSequence[];
}

interface ReviewCursor {
  version: 1;
  cacheVersion: number;
  target: string;
  lastClipAt: string | null;
  lastClipKey: string | null;
  lastClip: {
    kind: string;
    replayPath: string;
    firstHitFrame: number;
    lastHitFrame: number;
  } | null;
  updatedAt: string;
  cache: Record<string, ReviewCacheEntry>;
}

interface ClipOutput {
  path: string;
  sequence: HitReviewSequence;
}

const REVIEW_CACHE_VERSION = 1;
const DELIVERED_RETENTION_DAYS = 60;
const TELEGRAM_SEND_INTERVAL_MS = 1200;

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

  if (args.chronological) {
    await runChronological(args, target);
    return;
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

  const renderScript = findRenderClipScript();
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
        const clipPath = path.join(outDir, reviewClipFileName(sequence));

        if (args.dryRun) {
          log(
            `[dry-run] would render ${path.basename(sequence.replayPath)} frames ${sequence.clipStartFrame}-${sequence.clipEndFrame} -> ${clipPath}`,
          );
          clips.push({ path: clipPath, sequence });
          continue;
        }

        try {
          fs.mkdirSync(outDir, { recursive: true });
          renderClip(sequence, clipPath, args);
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

interface ReplayBounds {
  /** Start instant used for chronological ordering (file mtime fallback). */
  startAtMs: number;
  /** Latest possible event instant, or null when the replay cannot be bounded. */
  lastEventAtMs: number | null;
}

/**
 * Read only what is needed to order a replay and decide whether the cursor has
 * already passed it. Cached games supply both bounds from their stored events;
 * other games get them from Slippi metadata without a full parse.
 */
function replayBounds(candidate: Candidate, cached: ReviewCacheEntry | undefined): ReplayBounds {
  if (cached && cached.size === candidate.size && cached.mtimeMs === candidate.mtimeMs && cached.events.length > 0) {
    const startAtMs = reviewReplayStartsAtMs(cached.events[0]!.startAt, candidate.mtimeMs);
    const lastEventAtMs = cached.events.reduce(
      (latest, event) => Math.max(latest, reviewEventAtMs(event, candidate.mtimeMs)),
      Number.NEGATIVE_INFINITY,
    );
    return { startAtMs, lastEventAtMs };
  }

  try {
    const metadata = new SlippiGame(candidate.path).getMetadata();
    const startAt = metadata?.startAt ?? null;
    const lastFrame = typeof metadata?.lastFrame === "number" ? metadata.lastFrame : null;
    return {
      startAtMs: reviewReplayStartsAtMs(startAt, candidate.mtimeMs),
      lastEventAtMs: reviewReplayLastEventAtMs(startAt, lastFrame),
    };
  } catch {
    // Unreadable replays still go through processGame, which reports the real
    // error. Order them by file time and never skip them.
    return { startAtMs: candidate.mtimeMs, lastEventAtMs: null };
  }
}

async function runChronological(args: CliArgs, target: string): Promise<void> {
  let cursor = loadReviewCursor(args.cursorPath, target);
  if (args.resetCursor) {
    if (cursor.lastClipAt) log(`Ignoring saved cursor at ${cursor.lastClipAt}.`);
    cursor.lastClipAt = null;
    cursor.lastClipKey = null;
    cursor.lastClip = null;
  }
  const cursorPoint = reviewCursorPoint(cursor);
  log(
    cursorPoint
      ? `Chronological cursor: ${new Date(cursorPoint.atMs).toISOString()} (${cursorPoint.key})`
      : "Chronological cursor: starting at the oldest event.",
  );

  const candidates = collectCandidates(args);
  const boundsByPath = new Map<string, ReplayBounds>();
  for (const candidate of candidates) {
    boundsByPath.set(candidate.path, replayBounds(candidate, cursor.cache[candidate.path]));
  }
  // Parse in start-time order and stop once the next unparsed replay starts
  // after the last event already selected. A daily run therefore parses only
  // the handful of replays around the cursor, not the whole library.
  const ordered = [...candidates].sort(
    (a, b) => boundsByPath.get(a.path)!.startAtMs - boundsByPath.get(b.path)!.startAtMs || a.path.localeCompare(b.path),
  );

  const games: AnalyzedGame[] = [];
  const allEvents: HitReviewSequence[] = [];
  const errors: string[] = [];
  let targetErrors = 0;
  let cachedFiles = 0;
  let parsedFiles = 0;
  let beforeCursorFiles = 0;

  const mtimeByPath = new Map(candidates.map((candidate) => [candidate.path, candidate.mtimeMs]));
  const eventMoment = (sequence: HitReviewSequence): number =>
    reviewEventAtMs(sequence, mtimeByPath.get(sequence.replayPath) ?? 0);
  const isAfterCursor = (sequence: HitReviewSequence): boolean =>
    args.force ||
    cursorPoint === null ||
    isReviewEventAfterPoint(sequence, cursorPoint, mtimeByPath.get(sequence.replayPath) ?? 0);
  const passesFilters = (sequence: HitReviewSequence): boolean => {
    if (args.deathsOnly && !sequence.didKill) return false;
    if (args.minDamage !== null) {
      const damage = sequence.conversion?.damage ?? sequence.damage;
      if (damage < args.minDamage) return false;
    }
    return true;
  };

  for (let index = 0; index < ordered.length; index++) {
    const candidate = ordered[index]!;
    const bounds = boundsByPath.get(candidate.path)!;

    // A replay whose last possible event is already behind the cursor cannot
    // contribute a selectable event, so it is never parsed.
    if (
      !args.force &&
      cursorPoint !== null &&
      bounds.lastEventAtMs !== null &&
      bounds.lastEventAtMs < cursorPoint.atMs
    ) {
      beforeCursorFiles++;
      continue;
    }

    const cached = cursor.cache[candidate.path];
    let sequences: HitReviewSequence[];
    if (cached && cached.size === candidate.size && cached.mtimeMs === candidate.mtimeMs) {
      sequences = cached.events;
      cachedFiles++;
      if (args.verbose) log(`  ${path.basename(candidate.path)}: ${cached.events.length} cached review event(s)`);
    } else {
      try {
        const result = processGame(candidate.path, games.length + 1);
        sequences = extractReviewEvents(result, target, candidate.path);
        cursor.cache[candidate.path] = {
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          events: sequences,
        };
        parsedFiles++;
        log(`  ${path.basename(candidate.path)}: ${sequences.length} review event(s)`);
      } catch (err) {
        if (err instanceof HitReviewTargetError) targetErrors++;
        const message = errorMessage(err);
        errors.push(`${path.basename(candidate.path)}: ${message}`);
        log(`  skipped ${path.basename(candidate.path)}: ${message}`);
        continue;
      }
    }

    games.push({ candidate, sequences });
    allEvents.push(...sequences);

    if (args.limit > 0) {
      const ready = allEvents.filter((sequence) => isAfterCursor(sequence) && passesFilters(sequence));
      if (ready.length >= args.limit) {
        ready.sort((a, b) => eventMoment(a) - eventMoment(b) || reviewEventKey(a).localeCompare(reviewEventKey(b)));
        const threshold = eventMoment(ready[args.limit - 1]!);
        const next = ordered[index + 1];
        const nextStart = next ? boundsByPath.get(next.path)!.startAtMs : Number.POSITIVE_INFINITY;
        // Strictly greater: an event at the next replay's start instant could
        // still win the same-millisecond key tie-break, so parse that replay.
        if (nextStart > threshold) break;
      }
    }
  }

  if (games.length === 0) {
    if (targetErrors > 0) {
      throw new HitReviewTargetError(
        `Target player "${target}" was not found in any replay (${targetErrors} target error(s)). Check the tag/connect code.`,
      );
    }
    if (errors.length > 0) throw new Error(`No replay could be analyzed. First error: ${errors[0]}`);
  }

  const deferredFiles = ordered.length - beforeCursorFiles - errors.length - games.length;
  log(
    `${candidates.length} replay(s) found; ${cachedFiles} cached, ${parsedFiles} parsed, ` +
      `${beforeCursorFiles} before the cursor, ${errors.length} skipped, ${deferredFiles} not needed.`,
  );

  let telegramConfig: TelegramConfig | null = null;
  if (args.telegram && !args.dryRun) {
    telegramConfig = telegramConfigFromEnv({ chatId: args.telegramChat });
  }

  const renderScript = findRenderClipScript();
  if ((args.render || args.telegram) && !args.dryRun && !fs.existsSync(renderScript)) {
    throw new Error(`Render script not found: ${renderScript}`);
  }

  const afterCursor = allEvents.filter(isAfterCursor);
  const filtered = afterCursor.filter(passesFilters);
  filtered.sort((a, b) => eventMoment(a) - eventMoment(b) || reviewEventKey(a).localeCompare(reviewEventKey(b)));
  const selected = args.limit > 0 ? filtered.slice(0, args.limit) : filtered;

  log(
    `Found ${allEvents.length} review event(s); ${afterCursor.length} after the cursor; selected ${selected.length}.`,
  );

  const outDir = path.resolve(expandHome(args.outDir ?? path.join(os.homedir(), ".magi-melee", "hit-review")));
  const clips: ClipOutput[] = [];
  let renderFailures = 0;
  let sendFailures = 0;
  let sent = 0;
  let rendered = 0;
  let retention: RetentionResult | null = null;

  const runsPipeline = args.render || args.telegram;
  if (!runsPipeline) {
    // A query-only run does not move the cursor, but keeping the parse cache
    // makes the next preview skip the replays it just parsed.
    if (!args.dryRun) persistReviewCursor(args.cursorPath, cursor);
    const payload = chronologicalPayload(
      args,
      target,
      candidates,
      games,
      cachedFiles,
      parsedFiles,
      beforeCursorFiles,
      deferredFiles,
      allEvents,
      afterCursor,
      selected,
      clips,
      cursor,
      retention,
      errors,
    );
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else log("Pass --render to produce MP4s or --telegram to render and send them.");
    return;
  }

  if (!args.dryRun) persistReviewCursor(args.cursorPath, cursor);

  log(`Output directory: ${outDir}`);
  if (args.telegram) log(`Telegram destination: chat ${telegramConfig?.chatId ?? "(dry run)"}`);

  for (const sequence of selected) {
    const clipPath = path.join(outDir, reviewClipFileName(sequence));

    if (args.dryRun) {
      log(
        `[dry-run] would render ${path.basename(sequence.replayPath)} frames ` +
          `${sequence.clipStartFrame}-${sequence.clipEndFrame} -> ${clipPath}`,
      );
      clips.push({ path: clipPath, sequence });
      continue;
    }

    try {
      fs.mkdirSync(outDir, { recursive: true });
      renderClip(sequence, clipPath, args);
      writeClipMetadata(clipPath, sequence);
      rendered++;
      clips.push({ path: clipPath, sequence });
      log(`  rendered ${path.basename(clipPath)}`);
    } catch (err) {
      renderFailures++;
      log(
        `  render failed for ${path.basename(sequence.replayPath)} frames ` +
          `${sequence.clipStartFrame}-${sequence.clipEndFrame}: ${errorMessage(err)}`,
      );
      break;
    }

    if (args.telegram && telegramConfig) {
      try {
        await sendTelegramVideo(telegramConfig, clipPath, formatHitReviewCaption(sequence));
        sent++;
      } catch (err) {
        sendFailures++;
        log(`  Telegram send failed: ${errorMessage(err)}`);
        break;
      }
      await sleep(TELEGRAM_SEND_INTERVAL_MS);
    }

    cursor = cursorAfterEvent(cursor, sequence, eventMoment(sequence));
    persistReviewCursor(args.cursorPath, cursor);
  }

  if (!args.dryRun && args.maxOutBytes > 0) {
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

  const payload = chronologicalPayload(
    args,
    target,
    candidates,
    games,
    cachedFiles,
    parsedFiles,
    beforeCursorFiles,
    deferredFiles,
    allEvents,
    afterCursor,
    selected,
    clips,
    cursor,
    retention,
    errors,
  );
  if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    log(
      `Done: ${rendered} rendered, ${sent} sent, ${renderFailures} render failure(s), ` +
        `${sendFailures} send failure(s).`,
    );
  }
  if (renderFailures > 0 || sendFailures > 0) process.exitCode = 1;
}

function chronologicalPayload(
  args: CliArgs,
  target: string,
  candidates: Candidate[],
  games: AnalyzedGame[],
  cachedFiles: number,
  parsedFiles: number,
  beforeCursorFiles: number,
  deferredFiles: number,
  allEvents: HitReviewSequence[],
  afterCursor: HitReviewSequence[],
  selected: HitReviewSequence[],
  clips: ClipOutput[],
  cursor: ReviewCursor,
  retention: RetentionResult | null,
  errors: string[],
): Record<string, unknown> {
  return {
    target,
    mode: "chronological",
    filesScanned: candidates.length,
    filesCached: cachedFiles,
    filesAnalyzed: parsedFiles,
    filesSkippedBeforeCursor: beforeCursorFiles,
    filesDeferred: deferredFiles,
    filesWithEvents: games.filter((game) => game.sequences.length > 0).length,
    eventsFound: allEvents.length,
    eventsAfterCursor: afterCursor.length,
    eventsSelected: selected,
    clips,
    cursor: {
      path: args.cursorPath,
      target: cursor.target,
      lastClipAt: cursor.lastClipAt,
      lastClipKey: cursor.lastClipKey,
      lastClip: cursor.lastClip,
      updatedAt: cursor.updatedAt,
    },
    outputLimitBytes: args.maxOutBytes,
    outputBytes: retention?.remainingBytes ?? null,
    errors,
  };
}

function loadReviewCursor(file: string, target: string): ReviewCursor {
  const empty = emptyReviewCursor(target);
  if (!fs.existsSync(file)) return empty;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReviewCursor> & {
      cache?: unknown;
    };
    if (parsed.target !== target) {
      log(`Cursor target changed from "${parsed.target ?? "unknown"}" to "${target}"; starting fresh.`);
      return empty;
    }
    if (
      typeof parsed.lastClipAt === "string" &&
      Number.isFinite(Date.parse(parsed.lastClipAt)) &&
      typeof parsed.lastClipKey === "string"
    ) {
      empty.lastClipAt = parsed.lastClipAt;
      empty.lastClipKey = parsed.lastClipKey;
    }
    if (
      parsed.lastClip &&
      typeof parsed.lastClip === "object" &&
      typeof parsed.lastClip.kind === "string" &&
      typeof parsed.lastClip.replayPath === "string" &&
      typeof parsed.lastClip.firstHitFrame === "number" &&
      typeof parsed.lastClip.lastHitFrame === "number"
    ) {
      empty.lastClip = parsed.lastClip;
    }
    if (typeof parsed.updatedAt === "string") empty.updatedAt = parsed.updatedAt;

    if (
      parsed.cacheVersion === REVIEW_CACHE_VERSION &&
      parsed.cache &&
      typeof parsed.cache === "object" &&
      !Array.isArray(parsed.cache)
    ) {
      for (const [replayPath, entry] of Object.entries(parsed.cache as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Partial<ReviewCacheEntry>;
        if (
          typeof candidate.size !== "number" ||
          typeof candidate.mtimeMs !== "number" ||
          !Array.isArray(candidate.events)
        ) {
          continue;
        }
        empty.cache[replayPath] = {
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          events: candidate.events as HitReviewSequence[],
        };
      }
    }
    return empty;
  } catch (err) {
    log(`Warning: could not read cursor file ${file} (${errorMessage(err)}); starting fresh.`);
    return empty;
  }
}

function emptyReviewCursor(target: string): ReviewCursor {
  return {
    version: 1,
    cacheVersion: REVIEW_CACHE_VERSION,
    target,
    lastClipAt: null,
    lastClipKey: null,
    lastClip: null,
    updatedAt: new Date(0).toISOString(),
    cache: {},
  };
}

function reviewCursorPoint(cursor: ReviewCursor): HitReviewCursorPoint | null {
  if (!cursor.lastClipAt || !cursor.lastClipKey) return null;
  const atMs = Date.parse(cursor.lastClipAt);
  if (!Number.isFinite(atMs)) return null;
  return { atMs, key: cursor.lastClipKey };
}

function cursorAfterEvent(cursor: ReviewCursor, sequence: HitReviewSequence, atMs: number): ReviewCursor {
  return {
    ...cursor,
    lastClipAt: new Date(Math.floor(atMs)).toISOString(),
    lastClipKey: reviewEventKey(sequence),
    lastClip: {
      kind: sequence.kind,
      replayPath: sequence.replayPath,
      firstHitFrame: sequence.firstHitFrame,
      lastHitFrame: sequence.lastHitFrame,
    },
    updatedAt: new Date().toISOString(),
  };
}

function persistReviewCursor(file: string, cursor: ReviewCursor): void {
  cursor.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`);
  fs.renameSync(temporary, file);
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

function renderClip(sequence: HitReviewSequence, outPath: string, args: CliArgs): void {
  renderClipFile({
    replayPath: sequence.replayPath,
    startFrame: sequence.clipStartFrame,
    endFrame: sequence.clipEndFrame,
    outPath,
    resolution: args.resolution,
    backend: args.backend,
    noXvfb: args.noXvfb,
    verbose: args.verbose,
  });
}

function writeClipMetadata(clipPath: string, sequence: HitReviewSequence): void {
  const metadataPath = clipPath.replace(/\.mp4$/i, ".json");
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({ ...sequence, renderedPath: clipPath, renderedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function reviewClipFileName(sequence: HitReviewSequence): string {
  return clipFileName({
    replayPath: sequence.replayPath,
    label:
      sequence.kind === "opening-hit-taken"
        ? "opening"
        : sequence.kind === "conversion-landed"
          ? "conversion"
          : sequence.didKill
            ? "death"
            : "hit",
    firstHitFrame: sequence.firstHitFrame,
    clipStartFrame: sequence.clipStartFrame,
    clipEndFrame: sequence.clipEndFrame,
  });
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
