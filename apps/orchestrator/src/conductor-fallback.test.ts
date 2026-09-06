import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoGenRequest } from "@vvugc/mcp-video-gen";
import { resolveVideoVendorChain, generateClipWithFallback, type VideoVendorId } from "./conductor.js";

// Mock the video-gen adapter factory so we can control which vendors succeed/fail
// without hitting any real API. In dryRun the real factory always returns a mock
// adapter that never fails, so we override it here to model failures.
const successSet = new Set<VideoVendorId>(["gemini", "replicate", "kling", "runway", "pika", "higgsfield", "nvidia"]);
const gen = vi.fn((vendor: VideoVendorId, _opts: unknown, request: VideoGenRequest) => {
  if (!successSet.has(vendor)) throw new Error(`${vendor} down`);
  return Promise.resolve({
    id: `clip-${vendor}`,
    scriptSegmentIndex: request.scriptSegmentIndex,
    vendor,
    filePath: `/out/${vendor}.mp4`,
    durationSec: request.durationSec
  });
});
vi.mock("@vvugc/mcp-video-gen", async () => {
  const actual = await vi.importActual<typeof import("@vvugc/mcp-video-gen")>("@vvugc/mcp-video-gen");
  return {
    ...actual,
    getVideoGenAdapter: (vendor: VideoVendorId, opts: { outDir: string; dryRun: boolean; callMcpTool?: unknown }) =>
      ({ vendor, generate: (req: VideoGenRequest) => gen(vendor, opts, req) })
  };
});

describe("resolveVideoVendorChain", () => {
  it("puts the primary first and falls back to the sensible default chain when none configured", () => {
    expect(resolveVideoVendorChain("higgsfield")).toEqual(["higgsfield", "gemini", "replicate"]);
  });

  it("uses explicit fallbacks when provided, in order", () => {
    expect(resolveVideoVendorChain("higgsfield", ["replicate", "gemini"])).toEqual([
      "higgsfield",
      "replicate",
      "gemini"
    ]);
  });

  it("deduplicates the chain (never tries the same vendor twice)", () => {
    expect(resolveVideoVendorChain("kling", ["gemini", "kling", "gemini"])).toEqual(["kling", "gemini"]);
  });

  it("puts nvidia first and appends the sensible default chain when none configured", () => {
    expect(resolveVideoVendorChain("nvidia")).toEqual(["nvidia", "gemini", "replicate"]);
  });

  it("uses explicit fallbacks after an nvidia primary, in order", () => {
    expect(resolveVideoVendorChain("nvidia", ["kling", "gemini", "replicate"])).toEqual([
      "nvidia",
      "kling",
      "gemini",
      "replicate"
    ]);
  });

  it("deduplicates a chain that repeats nvidia / gemini", () => {
    expect(resolveVideoVendorChain("nvidia", ["gemini", "nvidia", "gemini"])).toEqual(["nvidia", "gemini"]);
  });
});

describe("generateClipWithFallback", () => {
  beforeEach(() => {
    // Default: every vendor healthy.
    ["higgsfield", "gemini", "replicate", "kling", "runway", "pika", "nvidia"].forEach((v) =>
      successSet.add(v as VideoVendorId)
    );
    gen.mockClear();
  });

  it("uses the primary vendor when it succeeds", async () => {
    const clip = await generateClipWithFallback(
      ["higgsfield", "gemini", "replicate"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    );
    expect(clip.vendor).toBe("higgsfield");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next vendor when the primary fails, stamping the actual vendor", async () => {
    successSet.delete("higgsfield");
    const attempts: string[] = [];
    const clip = await generateClipWithFallback(
      ["higgsfield", "gemini", "replicate"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true },
      (v, failed) => attempts.push(failed ? `${v}:${failed}` : v)
    );
    expect(clip.vendor).toBe("gemini");
    // onAttempt fires at attempt-start (vendor) and again on failure (vendor:error).
    expect(attempts.some((a) => a.startsWith("higgsfield:") && a.includes("down"))).toBe(true);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("throws only when every vendor in the chain has failed", async () => {
    successSet.clear();
    await expect(
      generateClipWithFallback(
        ["higgsfield", "gemini"],
        { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
        { outDir: "out", dryRun: true }
      )
    ).rejects.toThrow(/all 2 video vendor\(s\) failed/);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("uses nvidia as the primary when it succeeds, stamping the actual vendor", async () => {
    const clip = await generateClipWithFallback(
      ["nvidia", "gemini", "replicate"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    );
    expect(clip.vendor).toBe("nvidia");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("falls back from a failed nvidia primary to gemini, tracing nvidia's failure", async () => {
    successSet.delete("nvidia");
    const attempts: string[] = [];
    const clip = await generateClipWithFallback(
      ["nvidia", "gemini", "replicate"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true },
      (v, failed) => attempts.push(failed ? `${v}:${failed}` : v)
    );
    expect(clip.vendor).toBe("gemini");
    expect(attempts.some((a) => a.startsWith("nvidia:") && a.includes("down"))).toBe(true);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("reaches nvidia as a later fallback when an earlier vendor is down", async () => {
    successSet.delete("kling");
    const clip = await generateClipWithFallback(
      ["kling", "nvidia", "gemini"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    );
    expect(clip.vendor).toBe("nvidia");
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("aggregates every failure (nvidia included) when the whole chain is down", async () => {
    successSet.clear();
    const err = await generateClipWithFallback(
      ["nvidia", "gemini"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/all 2 video vendor\(s\) failed/);
    expect(String(err)).toMatch(/nvidia/);
    expect(gen).toHaveBeenCalledTimes(2);
  });
});
