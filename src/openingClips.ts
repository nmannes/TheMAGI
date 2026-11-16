// Selecting and describing a clip for the opening ledger.
//
// The openings CLI uses this module to turn a chosen rule bucket or shape
// cluster into concrete clip examples. Buckets are authoritative; clusters are
// exploratory and are selected only by their display id for this query. The
// clip itself shows the opening hit with lead-in and follow-through, matching
// the chronological hit-review "opening hit taken" event.

import { Frames } from "@slippi/slippi-js/node";

import { FPS, frameToTimestamp } from "./pipeline/helpers.js";
import type { OpeningExample } from "./pipeline/openingClusters.js";
import type { OpeningsAgainstResult } from "./openingsAgainst.js";

/** Five seconds of lead-in before the opening hit, like chronological hit review. */
export const OPENING_CLIP_PRE_ROLL_FRAMES = 5 * FPS;
/** Two seconds after the opening hit, enough to show the immediate response. */
export const OPENING_CLIP_POST_ROLL_FRAMES = 2 * FPS;
/** Hard cap shared with hit review, so a malformed duration cannot explode a clip. */
export const OPENING_CLIP_MAX_FRAMES = 20 * FPS;

export interface OpeningClipSelectionOptions {
  /** 1-based position in the printed rule-bucket list. */
  bucket?: number | null;
  /** Shape-cluster display id (1-based, recomputed per query). */
  cluster?: number | null;
  /** Maximum examples to clip (default 1). */
  limit?: number;
}

export interface OpeningClipSelection {
  source: "bucket" | "cluster";
  /** Bucket position (1-based) or cluster id. */
  id: number;
  /** situation · family · exact move, for the caption. */
  title: string;
  /** Sample size / kill count context line for the caption. */
  context: string;
  examples: OpeningExample[];
}

export interface OpeningClipGame {
  playerTag: string;
  playerCharacter: string;
  opponentTag: string;
  opponentCharacter: string;
  stage: string;
}

export interface OpeningClipBounds {
  startFrame: number;
  endFrame: number;
}

export class OpeningClipSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpeningClipSelectionError";
  }
}

/**
 * Pick the examples to render. Without an explicit selector the most frequent
 * rule bucket is used, because that is the "openings I am most commonly hit
 * with" question. Examples are already newest-first from the aggregator.
 */
export function selectOpeningClipExamples(
  result: OpeningsAgainstResult,
  options: OpeningClipSelectionOptions = {},
): OpeningClipSelection {
  if (options.bucket != null && options.cluster != null) {
    throw new OpeningClipSelectionError("Choose either --bucket or --cluster, not both.");
  }
  const limit = Math.max(1, Math.floor(options.limit ?? 1));

  if (options.cluster != null) {
    if (result.clusters.status === "insufficient-sample") {
      throw new OpeningClipSelectionError(
        result.clusters.reason === "n-below-40"
          ? `Shape clusters need ${result.clusters.required} openings in this scope; ${result.clusters.n} so far. Use --bucket instead.`
          : `No shape cluster was valid at k 2–6 with minimum cluster size ${result.clusters.minClusterSize}. Use --bucket instead.`,
      );
    }
    const cluster = result.clusters.clusters.find((candidate) => candidate.id === options.cluster);
    if (!cluster) {
      const ids = result.clusters.clusters.map((candidate) => candidate.id).join(", ");
      throw new OpeningClipSelectionError(`No shape cluster #${options.cluster}. Valid ids: ${ids}.`);
    }
    const examples = clipExamples(cluster.examples, limit);
    if (examples.length === 0) {
      throw new OpeningClipSelectionError(
        `Shape cluster #${cluster.id} has no navigable examples. Choose another source.`,
      );
    }
    return {
      source: "cluster",
      id: cluster.id,
      title: `${cluster.dominantSituation} · ${cluster.dominantFamily} · ${cluster.dominantOpenerLabel}`,
      context:
        `shape cluster #${cluster.id} ${cluster.label} · ${cluster.size} openings (${Math.round(cluster.share * 100)}%)` +
        ` · ${cluster.distinctGames} game${cluster.distinctGames === 1 ? "" : "s"}`,
      examples,
    };
  }

  const index = options.bucket ?? 1;
  const bucket = result.buckets[index - 1];
  if (!bucket) {
    throw new OpeningClipSelectionError(
      result.buckets.length === 0
        ? "No rule buckets in this scope; there are no openings to clip."
        : `No rule bucket #${index}. Valid positions: 1–${result.buckets.length}.`,
    );
  }
  const examples = clipExamples(bucket.examples, limit);
  if (examples.length === 0) {
    throw new OpeningClipSelectionError(`Rule bucket #${index} has no navigable examples. Choose another source.`);
  }
  return {
    source: "bucket",
    id: index,
    title: `${bucket.situation} · ${bucket.openerFamily} · ${bucket.openerLabel}`,
    context:
      `rule bucket #${index} · ${bucket.count} opening${bucket.count === 1 ? "" : "s"}` +
      ` (${Math.round(bucket.share * 100)}% of this scope) · ${bucket.kills} kill${bucket.kills === 1 ? "" : "s"}`,
    examples,
  };
}

/**
 * Frame range for the opening-hit clip. Anchored on the conversion's first
 * stun/grab frame (opening_events.start_frame), with the same 5s/2s rolls as
 * the chronological hit-review event. Capped at the replay's last playable
 * frame so the renderer never waits for a frame that does not exist.
 */
export function openingClipBounds(firstHitFrame: number, durationSeconds: number): OpeningClipBounds {
  const hitFrame = Math.max(0, Math.round(firstHitFrame));
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const lastFrame = Frames.FIRST_PLAYABLE + Math.floor(duration * FPS);
  const endFrame = Math.max(hitFrame + 1, Math.min(hitFrame + OPENING_CLIP_POST_ROLL_FRAMES, lastFrame));
  let startFrame = Math.max(0, hitFrame - OPENING_CLIP_PRE_ROLL_FRAMES);
  if (endFrame - startFrame > OPENING_CLIP_MAX_FRAMES) {
    startFrame = Math.max(0, endFrame - OPENING_CLIP_MAX_FRAMES);
  }
  return { startFrame, endFrame };
}

/**
 * Plain-text Telegram caption. The example carries the measured fields; the
 * selection contributes only its sample context. No technique is inferred
 * from a bucket or cluster label.
 */
export function formatOpeningClipCaption(
  selection: OpeningClipSelection,
  example: OpeningExample,
  game: OpeningClipGame,
): string {
  const lines = [
    `${example.didKill ? "💀" : "🟥"} Opening against you — ${example.situation} · ${example.openerFamily} · ${example.openerLabel}`,
    `${game.playerTag || "You"} (${game.playerCharacter}) vs ${game.opponentTag || "Opponent"} (${game.opponentCharacter}) · ${game.stage}`,
    `${frameToTimestamp(example.startFrame)} · ${formatPercent(example.victimPercent)} before the hit · ` +
      `${formatPercent(example.damage)} over the full conversion${example.didKill ? " · took the stock" : ""}`,
    selection.context,
  ];
  const caption = lines.join("\n");
  return caption.length <= 1024 ? caption : `${caption.slice(0, 1023)}…`;
}

function clipExamples(examples: OpeningExample[], limit: number): OpeningExample[] {
  const seen = new Set<string>();
  const selected: OpeningExample[] = [];
  for (const example of examples) {
    if (example.gameId == null) continue;
    const key = `${example.gameId}:${example.startFrame}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(example);
    if (selected.length >= limit) break;
  }
  return selected;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}
