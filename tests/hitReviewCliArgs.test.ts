import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/hitReviewCliArgs";

describe("hit-review CLI arguments", () => {
  it("defaults to chronological review", () => {
    expect(parseArgs(["--dir", "/replays"]).chronological).toBe(true);
  });

  it("still accepts --chronological for compatibility", () => {
    expect(parseArgs(["--chronological"]).chronological).toBe(true);
  });

  it("selects the legacy cost-ranked mode with --legacy-ranked", () => {
    expect(parseArgs(["--legacy-ranked"]).chronological).toBe(false);
  });

  it("allows legacy-only options in the legacy mode", () => {
    const args = parseArgs(["--legacy-ranked", "--all", "--no-state", "--since-hours", "12"]);
    expect(args.chronological).toBe(false);
    expect(args.all).toBe(true);
    expect(args.noState).toBe(true);
    expect(args.sinceHours).toBe(12);
  });

  it("rejects legacy-only options without --legacy-ranked", () => {
    expect(() => parseArgs(["--all"])).toThrow(/--legacy-ranked/);
    expect(() => parseArgs(["--no-state"])).toThrow(/--legacy-ranked/);
    expect(() => parseArgs(["--state", "/tmp/state.json"])).toThrow(/--legacy-ranked/);
    expect(() => parseArgs(["--since-hours", "12"])).toThrow(/--legacy-ranked/);
    expect(() => parseArgs(["--chronological", "--all"])).toThrow(/--legacy-ranked/);
  });

  it("rejects combining the two mode flags", () => {
    expect(() => parseArgs(["--chronological", "--legacy-ranked"])).toThrow(/cannot be combined/);
    expect(() => parseArgs(["--legacy-ranked", "--chronological"])).toThrow(/cannot be combined/);
  });
});
