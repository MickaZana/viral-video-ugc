import { describe, expect, it } from "vitest";
import {
  ASPECT_RATIO_BY_PLATFORM,
  DIMENSIONS,
  assembleVideo,
  cuesToSrt,
  deriveHashtags,
  formatSrtTime
} from "./lib.js";

describe("formatSrtTime", () => {
  it("formats whole seconds", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(5)).toBe("00:00:05,000");
  });

  it("formats fractional seconds as milliseconds", () => {
    expect(formatSrtTime(1.5)).toBe("00:00:01,500");
  });

  it("rolls over into minutes and hours", () => {
    expect(formatSrtTime(65)).toBe("00:01:05,000");
    expect(formatSrtTime(3661)).toBe("01:01:01,000");
  });
});

describe("cuesToSrt", () => {
  it("serializes cues into numbered, timestamped SRT blocks", () => {
    const srt = cuesToSrt([
      { startSec: 0, endSec: 2, text: "Hook line" },
      { startSec: 2, endSec: 5, text: "Point one" }
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:02,000\nHook line\n\n2\n00:00:02,000 --> 00:00:05,000\nPoint one\n"
    );
  });

  it("returns an empty string for no cues", () => {
    expect(cuesToSrt([])).toBe("");
  });
});

describe("ASPECT_RATIO_BY_PLATFORM / DIMENSIONS", () => {
  it("maps every platform to a known aspect ratio with real dimensions", () => {
    for (const platform of Object.keys(ASPECT_RATIO_BY_PLATFORM) as (keyof typeof ASPECT_RATIO_BY_PLATFORM)[]) {
      const ratio = ASPECT_RATIO_BY_PLATFORM[platform];
      expect(DIMENSIONS[ratio]).toBeDefined();
      expect(DIMENSIONS[ratio].w).toBeGreaterThan(0);
      expect(DIMENSIONS[ratio].h).toBeGreaterThan(0);
    }
  });

  it("uses vertical 9:16 for short-form platforms", () => {
    expect(ASPECT_RATIO_BY_PLATFORM.tiktok).toBe("9:16");
    expect(ASPECT_RATIO_BY_PLATFORM.youtube_shorts).toBe("9:16");
    expect(ASPECT_RATIO_BY_PLATFORM.instagram_reels).toBe("9:16");
  });
});

describe("deriveHashtags", () => {
  const baseScript = {
    videoId: "v1",
    hook: "hi",
    points: ["p1"],
    cta: "cta",
    durationSec: 25,
    brandVoice: "energetic"
  };

  it("lowercases, strips spaces, and hash-prefixes trending phrases", () => {
    const tags = deriveHashtags({ ...baseScript, trendingPhrases: ["No Cap", "wait for it"] });
    expect(tags).toEqual(["#nocap", "#waitforit"]);
  });

  it("de-duplicates phrases that normalize to the same tag", () => {
    const tags = deriveHashtags({ ...baseScript, trendingPhrases: ["No Cap", "no cap"] });
    expect(tags).toEqual(["#nocap"]);
  });

  it("caps at 8 hashtags", () => {
    const phrases = Array.from({ length: 12 }, (_, i) => `phrase ${i}`);
    const tags = deriveHashtags({ ...baseScript, trendingPhrases: phrases });
    expect(tags.length).toBe(8);
  });

  it("returns an empty array when there are no trending phrases", () => {
    expect(deriveHashtags({ ...baseScript, trendingPhrases: [] })).toEqual([]);
  });
});

describe("assembleVideo --dry-run", () => {
  const script = {
    videoId: "test-video",
    hook: "hi",
    points: ["p1"],
    cta: "cta",
    durationSec: 25,
    brandVoice: "energetic",
    trendingPhrases: ["wait for it"]
  };
  const clips = [{ id: "c1", scriptSegmentIndex: 0, vendor: "kling" as const, filePath: "/tmp/c1.mp4", durationSec: 5 }];
  const captions = [{ startSec: 0, endSec: 5, text: "hi" }];

  it("skips ffmpeg entirely and returns a well-formed AssembledVideo", async () => {
    const outDir = `${process.cwd()}/.test-out-${Date.now()}`;
    const result = await assembleVideo({ clips, script, captions, platform: "tiktok", outDir, dryRun: true });
    expect(result.videoId).toBe("test-video");
    expect(result.platform).toBe("tiktok");
    expect(result.aspectRatio).toBe("9:16");
    expect(result.captionsBurned).toBe(true);
    expect(result.hashtags).toEqual(["#waitforit"]);
  });

  it("throws when given zero clips", async () => {
    const outDir = `${process.cwd()}/.test-out-${Date.now()}`;
    await expect(
      assembleVideo({ clips: [], script, captions, platform: "tiktok", outDir, dryRun: true })
    ).rejects.toThrow();
  });

  it("throws when given zero caption cues", async () => {
    const outDir = `${process.cwd()}/.test-out-${Date.now()}`;
    await expect(
      assembleVideo({ clips, script, captions: [], platform: "tiktok", outDir, dryRun: true })
    ).rejects.toThrow();
  });
});
