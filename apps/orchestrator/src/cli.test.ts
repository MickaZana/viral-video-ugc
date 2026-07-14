import { describe, expect, it } from "vitest";
import { parseRunOptions } from "./cli.js";

function baseOptions(overrides: Partial<Parameters<typeof parseRunOptions>[0]> = {}) {
  return {
    niche: "fitness",
    platforms: ["tiktok", "youtube_shorts"] as Array<"tiktok" | "youtube_shorts" | "instagram_reels" | "facebook">,
    brandVoice: "neutral, energetic, concise",
    duration: 25,
    maxCandidates: 5,
    videoVendor: "higgsfield",
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
