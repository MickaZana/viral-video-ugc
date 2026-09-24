import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";
import type { AssembledVideo, RewrittenScript } from "@vvugc/shared-schema";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

const { scoreVideo } = await import("./qa-agent.js");

function makeScript(overrides: Partial<RewrittenScript> = {}): RewrittenScript {
  return {
    videoId: "v1",
    hook: "Wait for it",
    points: ["point one", "point two"],
    cta: "Follow for part 2",
    durationSec: 25,
    brandVoice: "energetic",
    locale: "en",
    trendingPhrases: ["no cap", "wait for it"],
    ...overrides
  };
}

function makeAssembled(overrides: Partial<AssembledVideo> = {}): AssembledVideo {
  return {
    videoId: "v1",
    platform: "tiktok",
    filePath: "/tmp/out.mp4",
    durationSec: 25,
    aspectRatio: "9:16",
    captionsBurned: true,
    hashtags: ["fitness", "viral", "fyp"],
    voiceoverAdded: false,
    ...overrides
  };
}

function textMessage(json: unknown, usage = { input_tokens: 80, output_tokens: 20 }) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], usage };
}

describe("scoreVideo", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Hermeticity: generateWithFailover's Gemini/Grok fallbacks read these
    // straight off process.env, so an ambient key left set in the shell (not
    // this test's own env) would otherwise leak this suite onto a real
    // network call. Clear them every test, and make any fetch a hard failure
    // rather than a silent live call — a fallback test stubs its own fetch.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected live fetch — mock it explicitly for this test");
    }));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  describe("dry-run heuristic scoring", () => {
    it("scores a strong script highly with no flags — short hook, trending phrases, on-duration, captioned, well-hashtagged", async () => {
      const result = await scoreVideo(makeAssembled(), makeScript(), { dryRun: true });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(result.flags).toEqual([]);
      expect(result.score).toBeGreaterThanOrEqual(90);
    });

    it("flags hook_too_long for a hook over 12 words", async () => {
      const script = makeScript({ hook: "this is a very long hook that goes on and on well past twelve words" });
      const result = await scoreVideo(makeAssembled(), script, { dryRun: true });
      expect(result.flags).toContain("hook_too_long");
    });

    it("flags low_trending_phrase_density with fewer than 2 trending phrases", async () => {
      const script = makeScript({ trendingPhrases: [] });
      const result = await scoreVideo(makeAssembled(), script, { dryRun: true });
      expect(result.flags).toContain("low_trending_phrase_density");
    });

    it("flags duration_mismatch when assembled duration drifts more than 2s from the script's target", async () => {
      const assembled = makeAssembled({ durationSec: 40 });
      const result = await scoreVideo(assembled, makeScript({ durationSec: 25 }), { dryRun: true });
      expect(result.flags).toContain("duration_mismatch");
    });

    it("flags no_captions when captionsBurned is false", async () => {
      const assembled = makeAssembled({ captionsBurned: false });
      const result = await scoreVideo(assembled, makeScript(), { dryRun: true });
      expect(result.flags).toContain("no_captions");
    });

    it("flags few_hashtags with fewer than 3 hashtags", async () => {
      const assembled = makeAssembled({ hashtags: ["one"] });
      const result = await scoreVideo(assembled, makeScript(), { dryRun: true });
      expect(result.flags).toContain("few_hashtags");
    });

    it("never exceeds 100 even when every positive signal stacks", async () => {
      const result = await scoreVideo(makeAssembled({ hashtags: ["a", "b", "c", "d", "e"] }), makeScript(), { dryRun: true });
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  describe("live scoring", () => {
    it("calls claude-sonnet-5 (the model-mix policy's gatekeeping-judgment assignment) and returns the parsed score/flags", async () => {
      mockCreate.mockResolvedValue(textMessage({ score: 72, flags: ["weak_cta"] }));

      const result = await scoreVideo(makeAssembled(), makeScript(), { dryRun: false });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0][0].model).toBe("claude-sonnet-5");
      expect(result).toEqual({ score: 72, flags: ["weak_cta"] });
    });

    it("clamps an out-of-range score from Claude into [0, 100] rather than trusting it blindly", async () => {
      mockCreate.mockResolvedValueOnce(textMessage({ score: 150, flags: [] }));
      const tooHigh = await scoreVideo(makeAssembled(), makeScript(), { dryRun: false });
      expect(tooHigh.score).toBe(100);

      mockCreate.mockResolvedValueOnce(textMessage({ score: -30, flags: [] }));
      const tooLow = await scoreVideo(makeAssembled(), makeScript(), { dryRun: false });
      expect(tooLow.score).toBe(0);
    });

    it("defaults flags to an empty array when Claude omits the field", async () => {
      mockCreate.mockResolvedValue(textMessage({ score: 80 }));
      const result = await scoreVideo(makeAssembled(), makeScript(), { dryRun: false });
      expect(result.flags).toEqual([]);
    });

    it("records Anthropic usage on the cost ledger under the qa_score stage, priced by claude-sonnet-5", async () => {
      mockCreate.mockResolvedValue(textMessage({ score: 90, flags: [] }));
      const ledger = new CostLedger();

      await scoreVideo(makeAssembled(), makeScript(), { dryRun: false, costLedger: ledger });

      const events = ledger.getEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.stage === "qa_score" && e.model === "claude-sonnet-5")).toBe(true);
    });

    it("throws a clear error when Claude's response contains no text block", async () => {
      mockCreate.mockResolvedValue({ content: [{ type: "image" }], usage: { input_tokens: 1, output_tokens: 1 } });
      await expect(scoreVideo(makeAssembled(), makeScript(), { dryRun: false })).rejects.toThrow(/no text block/);
    });

    it("throws when the response text contains no JSON object", async () => {
      mockCreate.mockResolvedValue(textMessage("not json at all"));
      await expect(scoreVideo(makeAssembled(), makeScript(), { dryRun: false })).rejects.toThrow(/No JSON object found/);
    });

    it("throws a clear, actionable error when ANTHROPIC_API_KEY is not configured", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      await expect(scoreVideo(makeAssembled(), makeScript(), { dryRun: false })).rejects.toThrow(/ANTHROPIC_API_KEY/);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
