import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoGenRequest } from "@vvugc/mcp-video-gen";
import { resolveVideoVendorChain, generateClipWithFallback, recordVideoGenAttempt, type VideoVendorId } from "./conductor.js";
import { CostLedger } from "@vvugc/shared-cost";

// Mock the video-gen adapter factory so we can control which vendors succeed/fail
// without hitting any real API. In dryRun the real factory always returns a mock
// adapter that never fails, so we override it here to model failures.
const successSet = new Set<VideoVendorId>(["gemini", "replicate", "kling", "runway", "pika", "higgsfield", "alibaba"]);
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

  it("puts alibaba first and appends the sensible default chain when none configured", () => {
    expect(resolveVideoVendorChain("alibaba")).toEqual(["alibaba", "gemini", "replicate"]);
  });

  it("uses explicit fallbacks after an alibaba primary, in order", () => {
    expect(resolveVideoVendorChain("alibaba", ["kling", "gemini", "replicate"])).toEqual([
      "alibaba",
      "kling",
      "gemini",
      "replicate"
    ]);
  });

  it("deduplicates a chain that repeats alibaba / gemini", () => {
    expect(resolveVideoVendorChain("alibaba", ["gemini", "alibaba", "gemini"])).toEqual(["alibaba", "gemini"]);
  });
});

describe("generateClipWithFallback", () => {
  beforeEach(() => {
    // Default: every vendor healthy.
    ["higgsfield", "gemini", "replicate", "kling", "runway", "pika", "alibaba"].forEach((v) =>
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

  it("accounts every fallback attempt once, including a failed peer clip", async () => {
    successSet.delete("higgsfield");
    successSet.delete("runway");
    successSet.delete("pika");
    const ledger = new CostLedger();
    const trackAttempts = (vendor: VideoVendorId, failed?: string) => recordVideoGenAttempt(ledger, vendor, false, failed);
    const request = (scriptSegmentIndex: number): VideoGenRequest => ({
      scriptSegmentIndex, prompt: "p", durationSec: 5, aspectRatio: "9:16"
    });

    const results = await Promise.allSettled([
      generateClipWithFallback(["higgsfield", "gemini"], request(0), { outDir: "out", dryRun: false }, trackAttempts),
      generateClipWithFallback(["runway", "pika"], request(1), { outDir: "out", dryRun: false }, trackAttempts)
    ]);

    expect(results[0]?.status).toBe("fulfilled"); // primary fails, fallback succeeds
    expect(results[1]?.status).toBe("rejected"); // peer exhausts its own chain
    expect(Object.fromEntries(ledger.getEvents().map(({ vendor, quantity }) => [vendor, quantity]))).toEqual({
      higgsfield: 1, gemini: 1, runway: 1, pika: 1
    });
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

  it("uses alibaba as the primary when it succeeds, stamping the actual vendor", async () => {
    const clip = await generateClipWithFallback(
      ["alibaba", "gemini", "replicate"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    );
    expect(clip.vendor).toBe("alibaba");
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("falls back from a failed alibaba primary to gemini, tracing alibaba's failure", async () => {
    successSet.delete("alibaba");
    const attempts: string[] = [];
    const clip = await generateClipWithFallback(
      ["alibaba", "gemini", "replicate"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true },
      (v, failed) => attempts.push(failed ? `${v}:${failed}` : v)
    );
    expect(clip.vendor).toBe("gemini");
    expect(attempts.some((a) => a.startsWith("alibaba:") && a.includes("down"))).toBe(true);
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("reaches alibaba as a later fallback when an earlier vendor is down", async () => {
    successSet.delete("kling");
    const clip = await generateClipWithFallback(
      ["kling", "alibaba", "gemini"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    );
    expect(clip.vendor).toBe("alibaba");
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("aggregates every failure (alibaba included) when the whole chain is down", async () => {
    successSet.clear();
    const err = await generateClipWithFallback(
      ["alibaba", "gemini"],
      { scriptSegmentIndex: 0, prompt: "p", durationSec: 5, aspectRatio: "9:16" },
      { outDir: "out", dryRun: true }
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/all 2 video vendor\(s\) failed/);
    expect(String(err)).toMatch(/alibaba/);
    expect(gen).toHaveBeenCalledTimes(2);
  });
});
