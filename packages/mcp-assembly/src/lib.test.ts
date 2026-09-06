import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASPECT_RATIO_BY_PLATFORM,
  DIMENSIONS,
  assembleVideo,
  cuesToSrt,
  deriveHashtags,
  formatSrtTime
} from "./lib.js";

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

  it("uses widescreen 16:9 for long-form YouTube", () => {
    expect(ASPECT_RATIO_BY_PLATFORM.youtube_long).toBe("16:9");
  });
});

describe("deriveHashtags", () => {
  const baseScript = {
    videoId: "v1",
    hook: "hi",
    points: ["p1"],
    cta: "cta",
    durationSec: 25,
    brandVoice: "energetic",
    locale: "en"
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
    locale: "en",
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

  it("accepts nvidia-labelled clips and returns the same well-formed AssembledVideo shape", async () => {
    // Nothing downstream of generation branches on clip.vendor — an "nvidia" clip
    // must assemble identically to a "kling" one. Mirrors the sibling assertion above.
    const nvidiaClips = [
      { id: "c1", scriptSegmentIndex: 0, vendor: "nvidia" as const, filePath: "/tmp/c1.mp4", durationSec: 5 }
    ];
    const outDir = `${process.cwd()}/.test-out-nvidia-${Date.now()}`;
    const result = await assembleVideo({ clips: nvidiaClips, script, captions, platform: "tiktok", outDir, dryRun: true });
    expect(result.videoId).toBe("test-video");
    expect(result.platform).toBe("tiktok");
    expect(result.aspectRatio).toBe("9:16");
    expect(result.captionsBurned).toBe(true);
    expect(result.hashtags).toEqual(["#waitforit"]);
    expect(typeof result.filePath).toBe("string");
    expect(result.filePath.length).toBeGreaterThan(0);
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

/**
 * A real, non-mocked ffmpeg run — not a --dry-run stub. Skips itself (via ffmpegAvailable())
 * on machines without a working ffmpeg on PATH rather than failing, since CI/dev environments
 * vary. Where it *can* run, this is the actual verification that the concat-list quoting,
 * scale/crop/subtitle-burn filter chain, and path escaping all produce a real, correctly-shaped
 * video file — confirmed live against real system ffmpeg after ffmpeg-static's bundled binary
 * turned out to be unexecutable in this project's dev sandbox (see resolveFfmpegPath in lib.ts).
 * VVUGC_FFMPEG_THREADS=1 avoids a real failure mode found this way: x264's default
 * one-thread-per-CPU allocation can exceed a memory-constrained host's address space and crash
 * the encoder outright — unrelated to correctness, but real enough to guard against here.
 */
describe.skipIf(!ffmpegAvailable())("assembleVideo — live ffmpeg", () => {
  it("produces a real playable mp4 with the correct dimensions and duration, plus a thumbnail", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vvugc-assembly-live-test-"));
    const clipsDir = join(workDir, "clips");
    const outDir = join(workDir, "assembled");

    try {
      execFileSync("node", ["-e", "1"]); // sanity: node itself works before we shell out more
      mkdirSync(clipsDir, { recursive: true });
      for (const [name, color] of [["clip0.mp4", "blue"], ["clip1.mp4", "red"]] as const) {
        execFileSync("ffmpeg", [
          "-y",
          "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1`,
          "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
          "-c:v", "libx264", "-c:a", "aac", "-shortest",
          join(clipsDir, name)
        ], { cwd: workDir, stdio: "ignore" });
      }

      const script = {
        videoId: "live-verify",
        hook: "hook",
        points: ["point"],
        cta: "cta",
        durationSec: 2,
        brandVoice: "energetic",
        locale: "en",
        trendingPhrases: ["realtest"]
      };
      const clips = [
        { id: "clip-0", scriptSegmentIndex: 0, filePath: join(clipsDir, "clip0.mp4"), durationSec: 1, vendor: "kling" as const },
        { id: "clip-1", scriptSegmentIndex: 1, filePath: join(clipsDir, "clip1.mp4"), durationSec: 1, vendor: "kling" as const }
      ];
      const captions = [
        { startSec: 0, endSec: 1, text: "hook" },
        { startSec: 1, endSec: 2, text: "point" }
      ];

      const prevThreads = process.env.VVUGC_FFMPEG_THREADS;
      process.env.VVUGC_FFMPEG_THREADS = "1";
      let result;
      try {
        result = await assembleVideo({ clips, script, captions, platform: "tiktok", outDir, dryRun: false });
      } finally {
        if (prevThreads === undefined) delete process.env.VVUGC_FFMPEG_THREADS;
        else process.env.VVUGC_FFMPEG_THREADS = prevThreads;
      }

      expect(existsSync(result.filePath)).toBe(true);
      expect(existsSync(result.thumbnailPath!)).toBe(true);

      const probe = execFileSync("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_name,width,height",
        "-show_entries", "format=duration",
        "-of", "json",
        result.filePath
      ]).toString();
      const parsed = JSON.parse(probe);
      const videoStream = parsed.streams.find((s: { codec_name: string }) => s.codec_name === "h264");
      expect(videoStream.width).toBe(DIMENSIONS["9:16"].w);
      expect(videoStream.height).toBe(DIMENSIONS["9:16"].h);
      expect(Math.round(Number(parsed.format.duration))).toBe(2);
      expect(result.voiceoverAdded).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("assembles nvidia-labelled clips into a real 9:16 mp4 — vendor label doesn't change the ffmpeg path", async () => {
    // Same two-clip live concat + caption burn + 9:16 crop as the test above, but
    // the RawClips are labelled vendor: "nvidia". Proves an nvidia clip coexists
    // with captions + platform aspect ratio + real ffmpeg concat end to end.
    const workDir = mkdtempSync(join(tmpdir(), "vvugc-assembly-nvidia-live-test-"));
    const clipsDir = join(workDir, "clips");
    const outDir = join(workDir, "assembled");

    try {
      mkdirSync(clipsDir, { recursive: true });
      for (const [name, color] of [["clip0.mp4", "blue"], ["clip1.mp4", "red"]] as const) {
        execFileSync("ffmpeg", [
          "-y",
          "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1`,
          "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
          "-c:v", "libx264", "-c:a", "aac", "-shortest",
          join(clipsDir, name)
        ], { cwd: workDir, stdio: "ignore" });
      }

      const script = {
        videoId: "nvidia-live-verify",
        hook: "hook",
        points: ["point"],
        cta: "cta",
        durationSec: 2,
        brandVoice: "energetic",
        locale: "en",
        trendingPhrases: ["realtest"]
      };
      const clips = [
        { id: "clip-0", scriptSegmentIndex: 0, filePath: join(clipsDir, "clip0.mp4"), durationSec: 1, vendor: "nvidia" as const },
        { id: "clip-1", scriptSegmentIndex: 1, filePath: join(clipsDir, "clip1.mp4"), durationSec: 1, vendor: "nvidia" as const }
      ];
      const captions = [
        { startSec: 0, endSec: 1, text: "hook" },
        { startSec: 1, endSec: 2, text: "point" }
      ];

      const prevThreads = process.env.VVUGC_FFMPEG_THREADS;
      process.env.VVUGC_FFMPEG_THREADS = "1";
      let result;
      try {
        result = await assembleVideo({ clips, script, captions, platform: "tiktok", outDir, dryRun: false });
      } finally {
        if (prevThreads === undefined) delete process.env.VVUGC_FFMPEG_THREADS;
        else process.env.VVUGC_FFMPEG_THREADS = prevThreads;
      }

      expect(existsSync(result.filePath)).toBe(true);
      expect(existsSync(result.thumbnailPath!)).toBe(true);

      const probe = execFileSync("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_name,width,height",
        "-show_entries", "format=duration",
        "-of", "json",
        result.filePath
      ]).toString();
      const parsed = JSON.parse(probe);
      const videoStream = parsed.streams.find((s: { codec_name: string }) => s.codec_name === "h264");
      expect(videoStream.width).toBe(DIMENSIONS["9:16"].w);
      expect(videoStream.height).toBe(DIMENSIONS["9:16"].h);
      expect(Math.round(Number(parsed.format.duration))).toBe(2);
      expect(result.voiceoverAdded).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    "when voiceoverPath is given, the final output's audio comes from it, not the clips — proven by using video-only clips with no audio track at all",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "vvugc-assembly-voiceover-test-"));
      const clipsDir = join(workDir, "clips");
      const outDir = join(workDir, "assembled");

      try {
        mkdirSync(clipsDir, { recursive: true });
        // Deliberately video-only (no -f lavfi audio input, no -c:a) — if the
        // final output ends up with an audio stream anyway, it can only have
        // come from voiceoverPath, since these clips have nothing to concat.
        for (const [name, color] of [["clip0.mp4", "green"], ["clip1.mp4", "yellow"]] as const) {
          execFileSync(
            "ffmpeg",
            ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1`, "-c:v", "libx264", join(clipsDir, name)],
            { cwd: workDir, stdio: "ignore" }
          );
        }

        const voiceoverPath = join(workDir, "voiceover.wav");
        execFileSync(
          "ffmpeg",
          ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", voiceoverPath],
          { cwd: workDir, stdio: "ignore" }
        );

        const script = {
          videoId: "voiceover-verify",
          hook: "hook",
          points: ["point"],
          cta: "cta",
          durationSec: 2,
          brandVoice: "energetic",
          locale: "en",
          trendingPhrases: []
        };
        const clips = [
          { id: "clip-0", scriptSegmentIndex: 0, filePath: join(clipsDir, "clip0.mp4"), durationSec: 1, vendor: "kling" as const },
          { id: "clip-1", scriptSegmentIndex: 1, filePath: join(clipsDir, "clip1.mp4"), durationSec: 1, vendor: "kling" as const }
        ];
        const captions = [
          { startSec: 0, endSec: 1, text: "hook" },
          { startSec: 1, endSec: 2, text: "point" }
        ];

        const prevThreads = process.env.VVUGC_FFMPEG_THREADS;
        process.env.VVUGC_FFMPEG_THREADS = "1";
        let result;
        try {
          result = await assembleVideo({ clips, script, captions, platform: "tiktok", outDir, dryRun: false, voiceoverPath });
        } finally {
          if (prevThreads === undefined) delete process.env.VVUGC_FFMPEG_THREADS;
          else process.env.VVUGC_FFMPEG_THREADS = prevThreads;
        }

        expect(result.voiceoverAdded).toBe(true);
        expect(existsSync(result.filePath)).toBe(true);

        const probe = execFileSync("ffprobe", [
          "-v", "error",
          "-show_entries", "stream=codec_type,codec_name",
          "-of", "json",
          result.filePath
        ]).toString();
        const parsed = JSON.parse(probe);
        const audioStream = parsed.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
        expect(audioStream).toBeDefined();
        const videoStream = parsed.streams.find((s: { codec_type: string }) => s.codec_type === "video");
        expect(videoStream).toBeDefined();
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
