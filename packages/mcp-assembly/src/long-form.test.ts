import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LongFormTutorial } from "@vvugc/shared-schema";
import { assembleLongFormTutorial } from "./long-form.js";

function tutorial(assetPath: string, durationSec = 300): LongFormTutorial {
  return {
    platform: "youtube_long",
    title: "Honest tool walkthrough",
    durationSec,
    aspectRatio: "16:9",
    scenes: [{
      narration: "This demonstrates a possible workflow, not an earnings claim.",
      durationSec,
      assetType: "screen_recording",
      assetPath,
      source: "Creator-provided recording",
      proofStatus: "illustrative"
    }]
  };
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("assembleLongFormTutorial --dry-run", () => {
  it("returns 16:9 long-form metadata without invoking ffmpeg or checking mock asset paths", async () => {
    const result = await assembleLongFormTutorial({
      tutorial: tutorial("/not-a-real-file.mp4"),
      outDir: join(tmpdir(), "vvugc-long-form-dry-run"),
      dryRun: true
    });
    expect(result.platform).toBe("youtube_long");
    expect(result.aspectRatio).toBe("16:9");
    expect(result.durationSec).toBe(300);
    expect(result.captionsBurned).toBe(false);
  });

  it("rejects missing user-supplied assets before ffmpeg processing", async () => {
    await expect(
      assembleLongFormTutorial({ tutorial: tutorial("/not-a-real-file.mp4"), outDir: join(tmpdir(), "vvugc-long-form") })
    ).rejects.toThrow("Long-form scene asset does not exist");
  });
});

describe.skipIf(!ffmpegAvailable())("assembleLongFormTutorial — live ffmpeg", () => {
  it("normalizes an image and a video into a real 16:9 MP4 respecting both scene durations", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vvugc-long-form-live-test-"));
    const imagePath = join(workDir, "slide.jpg");
    const videoPath = join(workDir, "recording.mp4");
    const outDir = join(workDir, "out");
    try {
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", imagePath], {
        stdio: "ignore"
      });
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1", "-c:v", "libx264", videoPath], {
        stdio: "ignore"
      });
      const tinyTutorial = {
        platform: "youtube_long",
        title: "Two Scene Test",
        durationSec: 2,
        aspectRatio: "16:9",
        scenes: [
          {
            narration: "Illustrative slide.", durationSec: 1, assetType: "slide", assetPath: imagePath,
            source: "Test fixture", proofStatus: "illustrative"
          },
          {
            narration: "Recorded test video.", durationSec: 1, assetType: "video", assetPath: videoPath,
            source: "Test fixture", proofStatus: "verified"
          }
        ]
      } as LongFormTutorial;
      const oldThreadLimit = process.env.VVUGC_FFMPEG_THREADS;
      process.env.VVUGC_FFMPEG_THREADS = "1";
      let result;
      try {
        result = await assembleLongFormTutorial({ tutorial: tinyTutorial, outDir });
      } finally {
        if (oldThreadLimit === undefined) delete process.env.VVUGC_FFMPEG_THREADS;
        else process.env.VVUGC_FFMPEG_THREADS = oldThreadLimit;
      }
      expect(existsSync(result.filePath)).toBe(true);
      const probe = JSON.parse(execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", result.filePath
      ]).toString());
      const video = probe.streams.find((stream: { width?: number }) => stream.width);
      expect(video.width).toBe(1920);
      expect(video.height).toBe(1080);
      expect(Math.round(Number(probe.format.duration))).toBe(2);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});
