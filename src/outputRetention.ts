import fs from "node:fs";
import path from "node:path";

/**
 * Size cap for rendered hit-review clips.
 *
 * Pruning only deletes files this tool created: `*.mp4` whose name matches the
 * hit-review clip pattern, and the matching `*.json` metadata sidecar. A user
 * pointing --out-dir at a folder with other files will not lose them.
 */

export const DEFAULT_MAX_OUT_SIZE = "1GB";

/** Matches `<stem>-<hash>-<hit|death>-<firstHit>-<clipStart>-<clipEnd>.mp4`. */
const MANAGED_CLIP_PATTERN = /-(?:hit|death)-\d+-\d+-\d+\.mp4$/i;

export interface RetentionResult {
  /** Managed bytes still present after pruning. */
  remainingBytes: number;
  removed: number;
  freedBytes: number;
}

interface ManagedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export function parseByteSize(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|k|m|g|t)?\s*$/i.exec(value);
  if (!match) {
    throw new Error(`Invalid size "${value}". Use bytes or a suffix like 500MB, 1GB, or 1.5GB.`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier =
    unit === "tb" || unit === "t"
      ? 1024 ** 4
      : unit === "gb" || unit === "g"
        ? 1024 ** 3
        : unit === "mb" || unit === "m"
          ? 1024 ** 2
          : unit === "kb" || unit === "k"
            ? 1024
            : 1;
  const bytes = Math.floor(amount * multiplier);
  if (!Number.isSafeInteger(bytes)) throw new Error(`Size "${value}" is too large`);
  return bytes;
}

export function isManagedOutputFile(filePath: string): boolean {
  const name = path.basename(filePath);
  if (MANAGED_CLIP_PATTERN.test(name)) return true;
  if (name.toLowerCase().endsWith(".json")) {
    return MANAGED_CLIP_PATTERN.test(`${name.slice(0, -5)}.mp4`);
  }
  return false;
}

/**
 * Delete managed clips/sidecars, oldest first, until their total is at or below
 * `maxBytes`. A max of 0 disables pruning. Unmanaged files are counted toward
 * nothing and are never deleted.
 */
export function enforceOutputLimit(
  directory: string,
  maxBytes: number,
  options: { onError?: (message: string) => void } = {},
): RetentionResult {
  if (!fs.existsSync(directory)) return { remainingBytes: 0, removed: 0, freedBytes: 0 };

  const units = groupManagedFiles(collectManagedFiles(directory, options.onError)).sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.key.localeCompare(b.key),
  );
  let remainingBytes = units.reduce((total, unit) => total + unit.size, 0);
  if (maxBytes <= 0 || remainingBytes <= maxBytes) {
    return { remainingBytes, removed: 0, freedBytes: 0 };
  }

  let removed = 0;
  let freedBytes = 0;
  for (const unit of units) {
    if (remainingBytes <= maxBytes) break;
    // Delete the MP4 and its JSON sidecar together so a pruned clip does not
    // leave orphaned metadata behind.
    for (const file of unit.files) {
      try {
        fs.unlinkSync(file.path);
        remainingBytes -= file.size;
        removed++;
        freedBytes += file.size;
      } catch (err) {
        options.onError?.(`Could not delete ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { remainingBytes, removed, freedBytes };
}

interface ManagedUnit {
  key: string;
  files: ManagedFile[];
  size: number;
  mtimeMs: number;
}

function groupManagedFiles(files: readonly ManagedFile[]): ManagedUnit[] {
  const units = new Map<string, ManagedUnit>();
  for (const file of files) {
    const key = file.path.replace(/\.(?:mp4|json)$/i, "");
    const existing = units.get(key);
    if (existing) {
      existing.files.push(file);
      existing.size += file.size;
      existing.mtimeMs = Math.min(existing.mtimeMs, file.mtimeMs);
    } else {
      units.set(key, { key, files: [file], size: file.size, mtimeMs: file.mtimeMs });
    }
  }
  return [...units.values()];
}

function collectManagedFiles(directory: string, onError?: (message: string) => void): ManagedFile[] {
  const files: ManagedFile[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      onError?.(`Could not read ${current}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isManagedOutputFile(full)) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (err) {
          onError?.(`Could not stat ${full}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };
  walk(directory);
  return files;
}
