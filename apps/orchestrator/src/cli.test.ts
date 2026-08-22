import { describe, expect, it } from "vitest";
import type { RunResult } from "@vvugc/shared-schema";
import { determineExitCode, parseRunOptions } from "./cli.js";

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-1",
    niche: "fitness",
    candidatesFound: 3,
    reviewItemsCreated: 2,
    manifestPath: "/tmp/manifest.json",
    completedAt: new Date().toISOString(),
    ...overrides
  };
}

function baseOptions(overrides: Partial<Parameters<typeof parseRunOptions>[0]> = {}) {
  return {
    niche: "fitness",
    platforms: ["tiktok", "youtube_shorts"] as Array<"tiktok" | "youtube_shorts" | "instagram_reels" | "facebook">,
    brandVoice: "neutral, energetic, concise",
    locale: "en",
    duration: 25,
    maxCandidates: 5,
    videoVendor: "kling",
    dryRun: false,
    autoPost: false,
    ...overrides
  };
}

describe("parseRunOptions", () => {
  it("maps commander's parsed options onto a valid RunConfig with a generated runId", () => {
    const config = parseRunOptions(baseOptions());
    expect(config.runId).toBeTruthy();
    expect(config.niche).toBe("fitness");
    expect(config.platforms).toEqual(["tiktok", "youtube_shorts"]);
    expect(config.targetDurationSec).toBe(25);
    expect(config.maxCandidates).toBe(5);
    expect(config.createdAt).toBeTruthy();
  });

  it("generates a distinct runId on every call", () => {
    const a = parseRunOptions(baseOptions());
    const b = parseRunOptions(baseOptions());
    expect(a.runId).not.toBe(b.runId);
  });

  it("rejects an empty niche (mirrors what commander would pass through unchanged)", () => {
    expect(() => parseRunOptions(baseOptions({ niche: "" }))).toThrow();
  });

  it("rejects a duration outside the schema's 15-60s range", () => {
    expect(() => parseRunOptions(baseOptions({ duration: 5 }))).toThrow();
    expect(() => parseRunOptions(baseOptions({ duration: 90 }))).toThrow();
  });

  it("rejects a non-numeric duration (commander's Number() coercion producing NaN)", () => {
    expect(() => parseRunOptions(baseOptions({ duration: Number("not-a-number") }))).toThrow();
  });

  it("rejects an unknown videoVendor", () => {
    expect(() => parseRunOptions(baseOptions({ videoVendor: "sora" }))).toThrow();
  });

  it("passes through dryRun and autoPost flags", () => {
    const config = parseRunOptions(baseOptions({ dryRun: true, autoPost: true }));
    expect(config.dryRun).toBe(true);
    expect(config.autoPost).toBe(true);
  });
});

describe("determineExitCode", () => {
  it("returns 0 for a normal run with items created, regardless of the flag", () => {
    expect(determineExitCode(makeResult({ reviewItemsCreated: 5 }), true)).toBe(0);
    expect(determineExitCode(makeResult({ reviewItemsCreated: 5 }), false)).toBe(0);
  });

  it("returns 0 for a zero-item run when the flag is not set (default interactive-local behavior)", () => {
    expect(determineExitCode(makeResult({ reviewItemsCreated: 0 }), false)).toBe(0);
  });

  it("returns 1 for a zero-item run when --fail-on-zero-results is set — this is the silent-failure case scheduled runs need surfaced", () => {
    expect(determineExitCode(makeResult({ reviewItemsCreated: 0 }), true)).toBe(1);
  });
});
