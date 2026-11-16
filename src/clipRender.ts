// Shared clip rendering helpers for the hit-review and openings CLIs.
//
// Both commands render a frame range of a replay through scripts/render-clip.sh
// and write MP4s with the same managed filename pattern, so the retention pass
// in src/outputRetention.ts can prune old clips from either producer.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Labels understood by the hit-review retention pattern. */
export type ClipLabel = "hit" | "death" | "opening" | "conversion";

export interface ClipRenderRequest {
  replayPath: string;
  /** First Slippi frame in the clip (inclusive), passed to render-clip.sh. */
  startFrame: number;
  /** Last Slippi frame in the clip, passed to render-clip.sh. */
  endFrame: number;
  outPath: string;
  /** 480p/720p/1080p/1440p/2160p or a raw EFBScale integer. */
  resolution: string;
  backend?: string | null;
  noXvfb?: boolean;
  verbose?: boolean;
}

export interface ClipFileNameParts {
  replayPath: string;
  label: ClipLabel;
  firstHitFrame: number;
  clipStartFrame: number;
  clipEndFrame: number;
}

/** Locate scripts/render-clip.sh from the source tree or the packaged layout. */
export function findRenderClipScript(): string {
  const candidates = [
    path.resolve(__dirname, "..", "scripts", "render-clip.sh"),
    path.resolve(__dirname, "..", "..", "scripts", "render-clip.sh"),
    path.resolve(process.cwd(), "scripts", "render-clip.sh"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

export function buildRenderClipArgs(scriptPath: string, request: ClipRenderRequest): string[] {
  const args = [
    scriptPath,
    "--replay",
    request.replayPath,
    "--start",
    String(request.startFrame),
    "--end",
    String(request.endFrame),
    "--out",
    request.outPath,
    "--resolution",
    request.resolution,
  ];
  if (request.backend) args.push("--backend", request.backend);
  if (request.noXvfb) args.push("--no-xvfb");
  return args;
}

/** Render one clip with the project's headless Slippi playback script. */
export function renderClipFile(request: ClipRenderRequest): void {
  const result = spawnSync("bash", buildRenderClipArgs(findRenderClipScript(), request), {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`render-clip.sh exited ${result.status ?? "by signal"}\n${tail(output, 4000)}`);
  }
  if (request.verbose && result.stdout.trim()) console.error(result.stdout.trim());
}

/**
 * Filename the retention pass recognizes:
 * `<stem>-<hash>-<label>-<firstHit>-<clipStart>-<clipEnd>.mp4`.
 */
export function clipFileName(parts: ClipFileNameParts): string {
  const stem = path
    .basename(parts.replayPath, path.extname(parts.replayPath))
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 60);
  const hash = createHash("sha1").update(parts.replayPath).digest("hex").slice(0, 8);
  return `${stem}-${hash}-${parts.label}-${parts.firstHitFrame}-${parts.clipStartFrame}-${parts.clipEndFrame}.mp4`;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}
