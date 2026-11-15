import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { enforceOutputLimit, isManagedOutputFile, parseByteSize } from "../src/outputRetention";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clippi-retention-"));
  tempDirectories.push(directory);
  return directory;
}

function writeFile(directory: string, name: string, size: number, mtimeSeconds: number): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, "x".repeat(size));
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

describe("parseByteSize", () => {
  it("accepts bytes and binary suffixes", () => {
    expect(parseByteSize("1024")).toBe(1024);
    expect(parseByteSize("1KB")).toBe(1024);
    expect(parseByteSize("1.5MB")).toBe(1.5 * 1024 ** 2);
    expect(parseByteSize("1GB")).toBe(1024 ** 3);
    expect(parseByteSize("0")).toBe(0);
  });

  it("rejects unknown units", () => {
    expect(() => parseByteSize("1XB")).toThrow(/Invalid size/);
    expect(() => parseByteSize("")).toThrow(/Invalid size/);
  });
});

describe("isManagedOutputFile", () => {
  it("matches only the clip/sidecar names this tool creates", () => {
    expect(isManagedOutputFile("Game_20260101T000000-abcdef12-hit-100-10-190.mp4")).toBe(true);
    expect(isManagedOutputFile("Game_20260101T000000-abcdef12-death-400-310-550.mp4")).toBe(true);
    expect(isManagedOutputFile("Game_20260101T000000-abcdef12-hit-100-10-190.json")).toBe(true);

    expect(isManagedOutputFile("keep.txt")).toBe(false);
    expect(isManagedOutputFile("notes.json")).toBe(false);
    expect(isManagedOutputFile("Game_20260101T000000-abcdef12-hit-100-10-190.png")).toBe(false);
    expect(isManagedOutputFile("random.mp4")).toBe(false);
  });
});

describe("enforceOutputLimit", () => {
  it("deletes the oldest clip and its sidecar until under the cap", () => {
    const directory = tempDirectory();
    const firstClip = writeFile(directory, "Game-aaaa-hit-100-10-190.mp4", 100, 1000);
    const firstSidecar = writeFile(directory, "Game-aaaa-hit-100-10-190.json", 20, 1000);
    const secondClip = writeFile(directory, "Game-bbbb-hit-200-110-290.mp4", 100, 2000);
    writeFile(directory, "Game-cccc-death-300-210-450.mp4", 100, 3000);
    const keep = writeFile(directory, "keep.txt", 10_000, 500);

    const result = enforceOutputLimit(directory, 250);

    expect(result).toEqual({ remainingBytes: 200, removed: 2, freedBytes: 120 });
    expect(fs.existsSync(firstClip)).toBe(false);
    expect(fs.existsSync(firstSidecar)).toBe(false);
    expect(fs.existsSync(secondClip)).toBe(true);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.readFileSync(keep, "utf8")).toHaveLength(10_000);
  });

  it("counts only managed files, so unrelated files do not trigger deletion", () => {
    const directory = tempDirectory();
    const clip = writeFile(directory, "Game-aaaa-hit-100-10-190.mp4", 100, 1000);
    writeFile(directory, "archive.bin", 50_000, 500);

    const result = enforceOutputLimit(directory, 500);

    expect(result).toEqual({ remainingBytes: 100, removed: 0, freedBytes: 0 });
    expect(fs.existsSync(clip)).toBe(true);
  });

  it("disabled max does not delete anything", () => {
    const directory = tempDirectory();
    const clip = writeFile(directory, "Game-aaaa-hit-100-10-190.mp4", 100, 1000);

    const result = enforceOutputLimit(directory, 0);

    expect(result.remainingBytes).toBe(100);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(clip)).toBe(true);
  });

  it("returns zeros for a missing directory", () => {
    expect(enforceOutputLimit(path.join(tempDirectory(), "missing"), 100)).toEqual({
      remainingBytes: 0,
      removed: 0,
      freedBytes: 0,
    });
  });
});
