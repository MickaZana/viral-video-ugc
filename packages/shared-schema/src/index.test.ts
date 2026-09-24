import { describe, expect, it } from "vitest";
import {
  AssembledVideoSchema,
  CandidateVideoSchema,
  CaptionCueSchema,
  LongFormProductionJobSchema,
  LongFormProductionRequestSchema,
  LongFormScenePlanSchema,
  LongFormTutorialSchema,
  PlatformSchema,
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
    expect(parsed.outputVariants).toBe(2);
    expect(parsed.videoVendor).toBe("kling");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.autoPost).toBe(false);
  });

  it("bounds outputVariants to 2 through 4", () => {
    for (const count of [2, 3, 4]) expect(RunConfigSchema.parse({ ...base, outputVariants: count }).outputVariants).toBe(count);
    for (const count of [1, 5]) expect(() => RunConfigSchema.parse({ ...base, outputVariants: count })).toThrow();
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

  it("accepts youtube_long as a platform without expanding the Shorts duration bound", () => {
    expect(RunConfigSchema.parse({ ...base, platforms: ["youtube_long"], targetDurationSec: 60 }).platforms).toEqual([
      "youtube_long"
    ]);
    expect(() => RunConfigSchema.parse({ ...base, platforms: ["youtube_long"], targetDurationSec: 61 })).toThrow();
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

  it("keeps the Shorts duration maximum at 60 seconds", () => {
    expect(() => RewrittenScriptSchema.parse({ ...base, durationSec: 61 })).toThrow();
  });
});

describe("LongFormTutorialSchema", () => {
  const base = {
    platform: "youtube_long",
    title: "How I use the tutorial pipeline",
    durationSec: 720,
    aspectRatio: "16:9",
    scenes: [
      {
        narration: "Open the dashboard and create a new tutorial.",
        durationSec: 720,
        assetType: "screen_recording",
        assetPath: "/assets/dashboard-demo.mp4",
        source: "Recorded in the local dashboard on 2026-08-30",
        proofStatus: "illustrative"
      }
    ]
  };

  it("parses a sourced 16:9 YouTube tutorial", () => {
    expect(LongFormTutorialSchema.parse(base)).toEqual(base);
    expect(LongFormTutorialSchema.parse({
      ...base,
      scenes: [{ ...base.scenes[0], assetType: "animated_image", proofStatus: "illustrative" }]
    }).scenes[0].assetType).toBe("animated_image");
    expect(PlatformSchema.parse("youtube_long")).toBe("youtube_long");
  });

  it("requires a sourced, classified scene and enforces long-form duration and scene bounds", () => {
    expect(() => LongFormTutorialSchema.parse({ ...base, durationSec: 299 })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, durationSec: 1801 })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, aspectRatio: "9:16" })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, scenes: [] })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, scenes: [{ ...base.scenes[0], source: "" }] })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, scenes: [{ ...base.scenes[0], proofStatus: "unverified" }] })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, scenes: [{ ...base.scenes[0], durationSec: 0 }] })).toThrow();
    expect(() => LongFormTutorialSchema.parse({ ...base, scenes: [{ ...base.scenes[0], durationSec: 719 }] })).toThrow();
  });
});

describe("idea-to-long-form production schemas", () => {
  const request = {
    idea: "Explain a repeatable way to plan a short campaign",
    sourcePointer: "https://video.example.test/reference",
    durationSec: 300,
    aspectRatio: "16:9",
    videoProviderChain: ["wan", "replicate"]
  };

  const scene = {
    id: "scene-1",
    narration: "Start by identifying the audience and the problem.",
    visualPrompt: "A clean animated diagram of a creator planning a campaign.",
    durationSec: 150,
    visualMode: "animated_image",
    proofStatus: "illustrative"
  };

  const plan = {
    title: "A practical campaign plan",
    durationSec: 300,
    aspectRatio: "16:9",
    scenes: [scene, { ...scene, id: "scene-2", durationSec: 150 }]
  };

  it("defaults to five minutes, 16:9 and the Wan-to-Replicate provider chain", () => {
    expect(LongFormProductionRequestSchema.parse({ idea: request.idea })).toMatchObject({
      durationSec: 300,
      aspectRatio: "16:9",
      videoProviderChain: ["wan", "replicate"],
      useHiggsfield: false
    });
  });

  it("accepts a source pointer, ten-minute request, and explicitly selected Higgsfield node", () => {
    const parsed = LongFormProductionRequestSchema.parse({
      ...request,
      durationSec: 600,
      videoProviderChain: ["wan", "higgsfield", "replicate"],
      useHiggsfield: true
    });
    expect(parsed.durationSec).toBe(600);
    expect(parsed.videoProviderChain).toContain("higgsfield");
  });

  it("rejects out-of-range durations, duplicate providers, and implicit Higgsfield selection", () => {
    expect(() => LongFormProductionRequestSchema.parse({ ...request, durationSec: 299 })).toThrow();
    expect(() => LongFormProductionRequestSchema.parse({ ...request, durationSec: 601 })).toThrow();
    expect(() => LongFormProductionRequestSchema.parse({ ...request, videoProviderChain: ["wan", "wan"] })).toThrow();
    expect(() => LongFormProductionRequestSchema.parse({
      ...request,
      videoProviderChain: ["wan", "higgsfield"]
    })).toThrow();
  });

  it("validates a timed scene plan and labels animated imagery as illustrative", () => {
    expect(LongFormScenePlanSchema.parse(plan)).toEqual(plan);
    expect(() => LongFormScenePlanSchema.parse({ ...plan, durationSec: 600 })).toThrow();
    expect(() => LongFormScenePlanSchema.parse({ ...plan, scenes: [{ ...scene, proofStatus: "verified" }, plan.scenes[1]] })).toThrow();
  });

  it("requires a user-recording asset and labels screen-recording substitution honestly", () => {
    expect(() => LongFormScenePlanSchema.parse({
      ...plan,
      scenes: [
        { ...scene, visualMode: "user_recording", proofStatus: "verified" },
        plan.scenes[1]
      ]
    })).toThrow();

    const fallbackScene = {
      ...scene,
      illustrativeFallback: {
        substitutedFor: "screen_recording",
        reason: "No screen recording was supplied; use an animated illustrative sequence.",
        proofStatus: "illustrative"
      }
    };
    expect(LongFormScenePlanSchema.parse({ ...plan, scenes: [fallbackScene, plan.scenes[1]] }).scenes[0])
      .toMatchObject({ visualMode: "animated_image", proofStatus: "illustrative" });
    expect(() => LongFormScenePlanSchema.parse({
      ...plan,
      scenes: [{ ...fallbackScene, proofStatus: "verified" }, plan.scenes[1]]
    })).toThrow();
  });

  it("validates a durable job envelope without changing the Shorts duration bound", () => {
    const job = LongFormProductionJobSchema.parse({
      id: "lf-job-1",
      orgId: "org-1",
      request,
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z"
    });
    expect(job.status).toBe("queued");
    expect(job.progress).toBe(0);
    expect(() => RunConfigSchema.parse({
      runId: "shorts-1",
      niche: "education",
      platforms: ["youtube_long"],
      targetDurationSec: 300,
      createdAt: "2026-09-23T00:00:00.000Z"
    })).toThrow();
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
