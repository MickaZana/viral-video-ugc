import { describe, expect, it } from "vitest";
import {
  AssembledVideoSchema,
  CandidateVideoSchema,
  CaptionCueSchema,
  RawClipSchema,
  ReviewItemSchema,
  RewrittenScriptSchema,
  RunConfigSchema
} from "./index.js";

describe("RunConfigSchema", () => {
  const base = {
    runId: "run-1",
    niche: "fitness",
    platforms: ["tiktok"],
    createdAt: "2026-01-01T00:00:00.000Z"
  };

  it("applies defaults for optional fields", () => {
    const parsed = RunConfigSchema.parse(base);
    expect(parsed.brandVoice).toBe("neutral, energetic, concise");
    expect(parsed.targetDurationSec).toBe(25);
    expect(parsed.maxCandidates).toBe(10);
    expect(parsed.videoVendor).toBe("higgsfield");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.autoPost).toBe(false);
  });

  it("rejects an empty niche", () => {
    expect(() => RunConfigSchema.parse({ ...base, niche: "" })).toThrow();
  });

  it("rejects an empty platforms array", () => {
    expect(() => RunConfigSchema.parse({ ...base, platforms: [] })).toThrow();
  });

  it("rejects an unknown platform", () => {
    expect(() => RunConfigSchema.parse({ ...base, platforms: ["myspace"] })).toThrow();
  });

  it("rejects targetDurationSec outside 15-60", () => {
    expect(() => RunConfigSchema.parse({ ...base, targetDurationSec: 5 })).toThrow();
    expect(() => RunConfigSchema.parse({ ...base, targetDurationSec: 120 })).toThrow();
  });

  it("rejects a non-datetime createdAt", () => {
    expect(() => RunConfigSchema.parse({ ...base, createdAt: "not-a-date" })).toThrow();
  });

  it("rejects an unknown videoVendor", () => {
    expect(() => RunConfigSchema.parse({ ...base, videoVendor: "sora" })).toThrow();
  });

  it("leaves voiceVendor undefined by default — voiceover stays opt-in, not silently on", () => {
    const parsed = RunConfigSchema.parse(base);
    expect(parsed.voiceVendor).toBeUndefined();
  });

  it("accepts elevenlabs/grok as voiceVendor and rejects anything else", () => {
    expect(RunConfigSchema.parse({ ...base, voiceVendor: "elevenlabs" }).voiceVendor).toBe("elevenlabs");
    expect(RunConfigSchema.parse({ ...base, voiceVendor: "grok" }).voiceVendor).toBe("grok");
    expect(() => RunConfigSchema.parse({ ...base, voiceVendor: "amazon-polly" })).toThrow();
  });
});

describe("AssembledVideoSchema", () => {
  const base = {
    videoId: "v1",
    platform: "tiktok",
    filePath: "/tmp/out.mp4",
    durationSec: 25,
    aspectRatio: "9:16",
    captionsBurned: true
  };

  it("defaults voiceoverAdded to false so older manifests without the field stay valid", () => {
    expect(AssembledVideoSchema.parse(base).voiceoverAdded).toBe(false);
  });

  it("accepts an explicit voiceoverAdded: true", () => {
    expect(AssembledVideoSchema.parse({ ...base, voiceoverAdded: true }).voiceoverAdded).toBe(true);
  });
});

describe("CandidateVideoSchema", () => {
  it("requires a valid URL", () => {
    expect(() =>
      CandidateVideoSchema.parse({
        id: "v1",
        platform: "tiktok",
        url: "not-a-url",
        publishedAt: "2026-01-01T00:00:00.000Z",
        metrics: {},
        niche: "fitness"
      })
    ).toThrow();
  });

  it("defaults metrics fields to 0 when omitted", () => {
    const parsed = CandidateVideoSchema.parse({
      id: "v1",
      platform: "tiktok",
      url: "https://example.com/v1",
      publishedAt: "2026-01-01T00:00:00.000Z",
      metrics: {},
      niche: "fitness"
    });
    expect(parsed.metrics.views).toBe(0);
    expect(parsed.metrics.likes).toBe(0);
    expect(parsed.metrics.comments).toBe(0);
  });
});

describe("RewrittenScriptSchema", () => {
  const base = {
    videoId: "v1",
    hook: "Wait for it",
    points: ["Point one"],
    cta: "Follow for more",
    durationSec: 25,
    brandVoice: "energetic"
  };

  it("requires at least one point", () => {
    expect(() => RewrittenScriptSchema.parse({ ...base, points: [] })).toThrow();
  });

  it("rejects an empty hook or cta", () => {
    expect(() => RewrittenScriptSchema.parse({ ...base, hook: "" })).toThrow();
    expect(() => RewrittenScriptSchema.parse({ ...base, cta: "" })).toThrow();
  });

  it("defaults trendingPhrases to an empty array", () => {
    const parsed = RewrittenScriptSchema.parse(base);
    expect(parsed.trendingPhrases).toEqual([]);
  });
});

describe("CaptionCueSchema", () => {
  it("rejects an empty caption text", () => {
    expect(() => CaptionCueSchema.parse({ startSec: 0, endSec: 1, text: "" })).toThrow();
  });

  it("rejects negative timestamps", () => {
    expect(() => CaptionCueSchema.parse({ startSec: -1, endSec: 1, text: "hi" })).toThrow();
  });

  it("accepts a valid cue", () => {
    expect(CaptionCueSchema.parse({ startSec: 0, endSec: 1.5, text: "hi" })).toEqual({
      startSec: 0,
      endSec: 1.5,
      text: "hi"
    });
  });
});

describe("RawClipSchema", () => {
  it("rejects a non-positive duration", () => {
    expect(() =>
      RawClipSchema.parse({ id: "c1", scriptSegmentIndex: 0, vendor: "kling", filePath: "/x.mp4", durationSec: 0 })
    ).toThrow();
  });

  it("rejects an unknown vendor", () => {
    expect(() =>
      RawClipSchema.parse({ id: "c1", scriptSegmentIndex: 0, vendor: "sora", filePath: "/x.mp4", durationSec: 3 })
    ).toThrow();
  });
});

describe("ReviewItemSchema", () => {
  const script = {
    videoId: "v1",
    hook: "hi",
    points: ["p1"],
    cta: "cta",
    durationSec: 25,
    brandVoice: "energetic"
  };

  it("defaults status to pending and flags to empty", () => {
    const parsed = ReviewItemSchema.parse({
      id: "r1",
      runId: "run1",
      niche: "fitness",
      videoPath: "/x.mp4",
      platform: "tiktok",
      script,
      score: 80,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(parsed.status).toBe("pending");
    expect(parsed.flags).toEqual([]);
  });

  it("rejects a score outside 0-100", () => {
    expect(() =>
      ReviewItemSchema.parse({
        id: "r1",
        runId: "run1",
        niche: "fitness",
        videoPath: "/x.mp4",
        platform: "tiktok",
        script,
        score: 150,
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    ).toThrow();
  });
});
