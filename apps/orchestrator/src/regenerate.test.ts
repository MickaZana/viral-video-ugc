import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewItem } from "@vvugc/shared-schema";
import { regenerateScene, regenerateScript } from "./regenerate.js";

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  const script = {
    videoId: "v1",
    hook: "Original hook line",
    points: ["Original point one", "Original point two"],
    cta: "Original cta",
    durationSec: 24,
    brandVoice: "energetic",
    trendingPhrases: []
  };
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: "/tmp/old-final.mp4",
    platform: "tiktok",
    script,
    score: 70,
    flags: [],
    clips: [
      { id: "clip-0", scriptSegmentIndex: 0, vendor: "kling", filePath: "/tmp/clip-0.mp4", durationSec: 6 },
      { id: "clip-1", scriptSegmentIndex: 1, vendor: "kling", filePath: "/tmp/clip-1.mp4", durationSec: 6 },
      { id: "clip-2", scriptSegmentIndex: 2, vendor: "kling", filePath: "/tmp/clip-2.mp4", durationSec: 6 },
      { id: "clip-3", scriptSegmentIndex: 3, vendor: "kling", filePath: "/tmp/clip-3.mp4", durationSec: 6 }
    ],
    captions: [
      { startSec: 0, endSec: 6, text: script.hook },
      { startSec: 6, endSec: 12, text: script.points[0] },
      { startSec: 12, endSec: 18, text: script.points[1] },
      { startSec: 18, endSec: 24, text: script.cta }
    ],
    sourceTranscriptText: "A completely different original video transcript about an unrelated topic entirely.",
    status: "approved", // deliberately not "pending", to prove regeneration resets it
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("regenerateScene", () => {
  let outDir: string;

  afterEach(() => {
    if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("replaces only the targeted clip by scriptSegmentIndex, keeps the others, and resets status to pending", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-scene-"));
    const item = makeItem();

    const result = await regenerateScene(item, 1, { videoVendor: "kling", dryRun: true, outDir });

    expect(result.status).toBe("pending");
    expect(result.clips).toHaveLength(4);
    // Scene 1's clip changed (a fresh mock clip path), the rest are untouched.
    expect(result.clips![1].filePath).not.toBe(item.clips![1].filePath);
    expect(result.clips![0]).toEqual(item.clips![0]);
    expect(result.clips![2]).toEqual(item.clips![2]);
    expect(result.clips![3]).toEqual(item.clips![3]);
    expect(result.videoPath).not.toBe(item.videoPath);
  });

  it("recomputes originalityScore against the stored sourceTranscriptText", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-scene-"));
    const item = makeItem();
    const result = await regenerateScene(item, 0, { videoVendor: "kling", dryRun: true, outDir });
    expect(typeof result.originalityScore).toBe("number");
  });

  it("throws a clear error for an out-of-range scene index", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-scene-"));
    const item = makeItem();
    await expect(regenerateScene(item, 99, { videoVendor: "kling", dryRun: true, outDir })).rejects.toThrow(
      /out of range/
    );
  });

  it("throws a clear error when the item has no stored clips/captions to regenerate from", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-scene-"));
    const item = makeItem({ clips: undefined, captions: undefined });
    await expect(regenerateScene(item, 0, { videoVendor: "kling", dryRun: true, outDir })).rejects.toThrow(
      /no stored clips\/captions/
    );
  });
});

describe("regenerateScript", () => {
  let outDir: string;

  afterEach(() => {
    if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("regenerates every clip and caption against the edited script, resets status to pending", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-script-"));
    const item = makeItem();

    const result = await regenerateScript(
      item,
      { hook: "Brand new hook", points: ["New point one"], cta: "New cta" },
      { videoVendor: "kling", dryRun: true, outDir }
    );

    expect(result.status).toBe("pending");
    expect(result.script.hook).toBe("Brand new hook");
    expect(result.script.points).toEqual(["New point one"]);
    // 3 segments now (hook + 1 point + cta), not the original 4.
    expect(result.clips).toHaveLength(3);
    expect(result.captions).toHaveLength(3);
    expect(result.videoPath).not.toBe(item.videoPath);
  });

  it("leaves voiceoverPath untouched (does not implicitly re-synthesize narration)", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-script-"));
    const item = makeItem({ voiceoverPath: "/tmp/original-voiceover.mp3" });

    const result = await regenerateScript(
      item,
      { hook: "Different hook", points: item.script.points, cta: item.script.cta },
      { videoVendor: "kling", dryRun: true, outDir }
    );

    expect(result.voiceoverPath).toBe("/tmp/original-voiceover.mp3");
  });

  it("recomputes originalityScore against the edited script text", async () => {
    outDir = mkdtempSync(join(tmpdir(), "regen-script-"));
    const item = makeItem();
    const result = await regenerateScript(
      item,
      { hook: "Totally unrelated new hook about cooking", points: ["A point about recipes"], cta: "Try this recipe" },
      { videoVendor: "kling", dryRun: true, outDir }
    );
    expect(typeof result.originalityScore).toBe("number");
  });
});
