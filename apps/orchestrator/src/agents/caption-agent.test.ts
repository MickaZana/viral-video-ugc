import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";
import type { RewrittenScript } from "@vvugc/shared-schema";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

const { generateCaptions } = await import("./caption-agent.js");

function makeScript(overrides: Partial<RewrittenScript> = {}): RewrittenScript {
  return {
    videoId: "v1",
    hook: "Wait for it",
    points: ["point one", "point two"],
    cta: "Follow for part 2",
    durationSec: 24,
    brandVoice: "energetic",
    locale: "en",
    trendingPhrases: [],
    ...overrides
  };
}

function arrayMessage(json: unknown, usage = { input_tokens: 60, output_tokens: 40 }) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], usage };
}

describe("generateCaptions", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("dry-run: even-splits the script into contiguous cues covering the full duration, without calling the Anthropic API", async () => {
    const script = makeScript({ durationSec: 24 });
    const cues = await generateCaptions(script, { dryRun: true });

    expect(mockCreate).not.toHaveBeenCalled();
    // hook + 2 points + cta = 4 lines
    expect(cues).toHaveLength(4);
    expect(cues[0].startSec).toBe(0);
    expect(cues[cues.length - 1].endSec).toBe(24);
    // contiguous: each cue's start matches the previous cue's end
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startSec).toBe(cues[i - 1].endSec);
    }
  });

  it("live: calls claude-haiku-4-5 (the model-mix policy's mechanical/high-volume assignment) and returns the parsed cues", async () => {
    mockCreate.mockResolvedValue(
      arrayMessage([
        { text: "Wait for it", startSec: 0, endSec: 1 },
        { text: "point one", startSec: 1, endSec: 12 },
        { text: "point two", startSec: 12, endSec: 20 },
        { text: "Follow for part 2", startSec: 20, endSec: 24 }
      ])
    );

    const cues = await generateCaptions(makeScript(), { dryRun: false });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5");
    expect(cues).toHaveLength(4);
    expect(cues[0]).toEqual({ text: "Wait for it", startSec: 0, endSec: 1 });
  });

  it("records Anthropic usage on the cost ledger under the caption_timing stage, priced by claude-haiku-4-5", async () => {
    mockCreate.mockResolvedValue(arrayMessage([{ text: "x", startSec: 0, endSec: 24 }]));
    const ledger = new CostLedger();

    await generateCaptions(makeScript(), { dryRun: false, costLedger: ledger });

    const events = ledger.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stage === "caption_timing" && e.model === "claude-haiku-4-5")).toBe(true);
  });

  it("throws a clear error when Claude's response contains no text block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "image" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(generateCaptions(makeScript(), { dryRun: false })).rejects.toThrow(/no text block/);
  });

  it("throws when the response text contains no JSON array", async () => {
    mockCreate.mockResolvedValue(arrayMessage("not an array")); // JSON.stringify("not an array") has no [ ]
    await expect(generateCaptions(makeScript(), { dryRun: false })).rejects.toThrow(/No JSON array found/);
  });

  it("throws a clear, actionable error when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateCaptions(makeScript(), { dryRun: false })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a malformed cue (missing required text field) fails Zod validation rather than silently reaching assembly", async () => {
    mockCreate.mockResolvedValue(arrayMessage([{ startSec: 0, endSec: 24 }]));
    await expect(generateCaptions(makeScript(), { dryRun: false })).rejects.toThrow();
  });
});
