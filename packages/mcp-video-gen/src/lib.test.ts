import { existsSync, readdirSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawClip } from "@vvugc/shared-schema";
import { getVideoGenAdapter } from "./lib.js";
import type { VideoGenRequest } from "./adapters/VideoGenAdapter.js";

const outDir = `${process.cwd()}/.test-out-lib`;

const REQ: VideoGenRequest = {
  scriptSegmentIndex: 0,
  prompt: "x",
  durationSec: 5,
  aspectRatio: "9:16"
};

// The full real vendor union from RawClip["vendor"] (packages/shared-schema).
const REAL_VENDORS: RawClip["vendor"][] = [
  "higgsfield",
  "kling",
  "runway",
  "pika",
  "gemini",
  "replicate",
  "seedance",
  "grok_video",
  "wan",
  "nvidia"
];

afterEach(() => {
  vi.unstubAllGlobals();
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

describe("getVideoGenAdapter — NVIDIA wiring", () => {
  it("returns the real NVIDIA adapter (vendor 'nvidia') when dryRun is false", () => {
    const adapter = getVideoGenAdapter("nvidia", { outDir, dryRun: false });
    expect(adapter.vendor).toBe("nvidia");
  });

  it("returns the mock adapter for nvidia when dryRun is true — no network call, mock-nvidia file name", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("fetch must not be called for a dry-run adapter");
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = getVideoGenAdapter("nvidia", { outDir, dryRun: true });
    expect(adapter.vendor).toBe("nvidia");

    const clip = await adapter.generate({ ...REQ });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clip.vendor).toBe("nvidia");
    expect(clip.filePath).toContain("mock-nvidia");
    expect(existsSync(clip.filePath)).toBe(true);
    // The written file's own name carries createMockAdapter's `mock-<vendor>` marker.
    const written = readdirSync(outDir);
    expect(written.some((f) => f.includes("mock-nvidia"))).toBe(true);
  });
});

describe("getVideoGenAdapter — regression guard over the real vendor union", () => {
  it("every real vendor with dryRun:true returns an adapter whose .vendor matches, without throwing", () => {
    for (const vendor of REAL_VENDORS) {
      const adapter = getVideoGenAdapter(vendor, { outDir, dryRun: true });
      expect(adapter.vendor).toBe(vendor);
    }
  });

  it("higgsfield with dryRun:true returns the mock without needing a callMcpTool callback", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("fetch must not be called for a dry-run adapter");
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = getVideoGenAdapter("higgsfield", { outDir, dryRun: true });
    expect(adapter.vendor).toBe("higgsfield");

    const clip = await adapter.generate({ ...REQ });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clip.filePath).toContain("mock-higgsfield");
  });
});
