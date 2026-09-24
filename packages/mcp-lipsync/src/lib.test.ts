/**
 * LipSync Studio — Atom D: Tests
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLipSyncAdapter, isLipSyncAvailable } from "./lib.js";

const testDirs: string[] = [];
afterEach(() => {
  while (testDirs.length) rmSync(testDirs.pop()!, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vvugc-lipsync-test-"));
  testDirs.push(dir);
  return dir;
}

describe("getLipSyncAdapter", () => {
  it("returns undefined when vendor is 'none'", () => {
    expect(getLipSyncAdapter("none", { dryRun: false })).toBeUndefined();
  });

  it("returns undefined when vendor is undefined", () => {
    expect(getLipSyncAdapter(undefined, { dryRun: false })).toBeUndefined();
  });

  it("returns mock adapter in dry-run mode regardless of vendor", () => {
    const adapter = getLipSyncAdapter("sync_labs", { dryRun: true });
    expect(adapter).toBeDefined();
    expect(adapter!.vendor).toBe("mock");
  });

  it("returns mock adapter for vendor 'mock'", () => {
    const adapter = getLipSyncAdapter("mock", { dryRun: false });
    expect(adapter).toBeDefined();
    expect(adapter!.vendor).toBe("mock");
  });
});

describe("mock adapter", () => {
  it("dry-run produces a placeholder lipsync video file", async () => {
    const adapter = getLipSyncAdapter("sync_labs", { dryRun: true })!;
    const outDir = makeTempDir();

    const result = await adapter.generate({
      audioPath: "/tmp/test-audio.wav",
      characterImageUrl: "https://example.com/face.jpg",
      durationSec: 5,
      outDir,
    });

    expect(result.vendor).toBe("mock");
    expect(result.durationSec).toBe(5);
    expect(existsSync(result.videoPath)).toBe(true);
    expect(result.videoPath).toContain("lipsync-mock");
  });

  it("audio path and character image URL are recorded in placeholder", async () => {
    const adapter = getLipSyncAdapter("mock", { dryRun: false })!;
    const outDir = makeTempDir();

    const result = await adapter.generate({
      audioPath: "/tmp/my-voiceover.wav",
      characterImageUrl: "https://cdn.example.com/soul-id/face.png",
      durationSec: 12,
      outDir,
    });

    // The mock writes the input details into the placeholder file
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(result.videoPath, "utf-8");
    expect(content).toContain("/tmp/my-voiceover.wav");
    expect(content).toContain("https://cdn.example.com/soul-id/face.png");
    expect(content).toContain("12");
  });
});

describe("isLipSyncAvailable", () => {
  it("returns false for 'none' vendor", () => {
    expect(isLipSyncAvailable("none")).toBe(false);
  });

  it("returns false for undefined vendor", () => {
    expect(isLipSyncAvailable(undefined)).toBe(false);
  });

  it("returns false for 'mock' vendor", () => {
    expect(isLipSyncAvailable("mock")).toBe(false);
  });

  it("returns false for sync_labs when SYNC_LABS_API_KEY is not set", () => {
    delete process.env.SYNC_LABS_API_KEY;
    expect(isLipSyncAvailable("sync_labs")).toBe(false);
  });

  it("returns true for sync_labs when SYNC_LABS_API_KEY is set", () => {
    process.env.SYNC_LABS_API_KEY = "test-key";
    expect(isLipSyncAvailable("sync_labs")).toBe(true);
    delete process.env.SYNC_LABS_API_KEY;
  });

  it("returns false for heygen when HEYGEN_API_KEY is not set", () => {
    delete process.env.HEYGEN_API_KEY;
    expect(isLipSyncAvailable("heygen")).toBe(false);
  });

  it("returns true for heygen when HEYGEN_API_KEY is set", () => {
    process.env.HEYGEN_API_KEY = "test-key";
    expect(isLipSyncAvailable("heygen")).toBe(true);
    delete process.env.HEYGEN_API_KEY;
  });
});
