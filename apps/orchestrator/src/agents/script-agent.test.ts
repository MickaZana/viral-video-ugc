import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";
import type { Platform, Transcript } from "@vvugc/shared-schema";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

const { rewriteScript } = await import("./script-agent.js");

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return { videoId: "v1", source: "platform_captions", text: "this is the source transcript", segments: [], ...overrides };
}

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    niche: "fitness",
    brandVoice: "energetic",
    durationSec: 25,
    platforms: ["tiktok"] as Platform[],
    dryRun: false,
    ...overrides
  };
}

function textMessage(json: unknown, usage = { input_tokens: 100, output_tokens: 50 }) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], usage };
}

describe("rewriteScript", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("dry-run: returns a deterministic mock script without calling the Anthropic API", async () => {
    const result = await rewriteScript(makeTranscript(), baseOpts({ dryRun: true }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.hook).toContain("fitness");
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.cta.length).toBeGreaterThan(0);
    expect(result.locale).toBe("en"); // defaults when not specified
  });

  it("dry-run: honors an explicit locale, both live and mocked", async () => {
    const result = await rewriteScript(makeTranscript(), baseOpts({ dryRun: true, locale: "es" }));
    expect(result.locale).toBe("es");
  });

  it("live: passes the locale into the prompt and onto the returned script", async () => {
    mockCreate.mockResolvedValue(textMessage({ hook: "Espera...", points: ["punto uno"], cta: "Sigue" }));
    const result = await rewriteScript(makeTranscript(), baseOpts({ locale: "es" }));

    const userPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userPrompt).toContain("es");
    expect(result.locale).toBe("es");
  });

  it("live: calls claude-fable-5 (the model-mix policy's creative-bottleneck assignment) and parses a valid response into a RewrittenScript", async () => {
    mockCreate.mockResolvedValue(
      textMessage({
        hook: "Wait for it...",
        points: ["point one", "point two"],
        cta: "Follow for more",
        trendingPhrases: ["no cap"],
        platformNotes: { tiktok: "fast cuts" }
      })
    );

    const result = await rewriteScript(makeTranscript(), baseOpts());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("claude-fable-5");
    expect(result.hook).toBe("Wait for it...");
    expect(result.points).toEqual(["point one", "point two"]);
    expect(result.cta).toBe("Follow for more");
    expect(result.trendingPhrases).toEqual(["no cap"]);
  });

  it("live: records Anthropic usage on the cost ledger under the script_rewrite stage, priced by claude-fable-5", async () => {
    mockCreate.mockResolvedValue(textMessage({ hook: "h", points: ["p"], cta: "c" }));
    const ledger = new CostLedger();

    await rewriteScript(makeTranscript(), baseOpts({ costLedger: ledger }));

    const events = ledger.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stage === "script_rewrite" && e.model === "claude-fable-5")).toBe(true);
    expect(ledger.totalUsd()).toBeGreaterThan(0);
  });

  it("live: throws a clear error when Claude's response contains no text block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "image" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(rewriteScript(makeTranscript(), baseOpts())).rejects.toThrow(/no text block/);
  });

  it("live: throws when the response text contains no JSON object", async () => {
    mockCreate.mockResolvedValue(textMessage("not json at all"));
    await expect(rewriteScript(makeTranscript(), baseOpts())).rejects.toThrow(/No JSON object found/);
  });

  it("live: throws a clear, actionable error when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(rewriteScript(makeTranscript(), baseOpts())).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("live: a response missing required schema fields (e.g. no hook) fails Zod validation rather than silently producing a broken script", async () => {
    mockCreate.mockResolvedValue(textMessage({ points: ["p"], cta: "c" }));
    await expect(rewriteScript(makeTranscript(), baseOpts())).rejects.toThrow();
  });
});
