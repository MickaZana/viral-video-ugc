import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";
import type { Platform, Transcript } from "@vvugc/shared-schema";
import { generateWithFailover } from "./llm-failover.js";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

// A plain Error (name "Error") is how the code surfaces response-shape problems, so
// give hard-failure Anthropic errors the SDK's real class names.
function sdkError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const { rewriteScript } = await import("./script-agent.js");

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return { videoId: "v1", source: "platform_captions", text: "source transcript", segments: [], ...overrides };
}

function baseOpts(overrides: Record<string, unknown> = {}) {
  return { niche: "fitness", brandVoice: "energetic", durationSec: 25, platforms: ["tiktok"] as Platform[], dryRun: false, ...overrides };
}

const geminiTextResponse = (json: unknown) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
  })
});

describe("generateWithFailover / schema-drift guardrail", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    vi.unstubAllGlobals();
  });

  it("falls back to Gemini on a hard provider failure and reports provider+model", async () => {
    mockCreate.mockRejectedValue(sdkError("APIError"));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(geminiTextResponse({ hook: "h", points: ["p"], cta: "c" }));
    const onFallback = vi.fn();

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro",
      stage: "script_rewrite", onFallback
    });

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("records Gemini usage on the ledger under the requested stage/model", async () => {
    mockCreate.mockRejectedValue(sdkError("APIConnectionError"));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(geminiTextResponse({ hook: "h", points: ["p"], cta: "c" }));
    const ledger = new CostLedger();

    await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro",
      stage: "script_rewrite", costLedger: ledger
    });

    const events = ledger.getEvents();
    expect(events.some((e) => e.stage === "script_rewrite" && e.model === "gemini-2.5-pro")).toBe(true);
    expect(ledger.totalUsd()).toBeGreaterThan(0);
  });

  it("does NOT fail over on auth/config errors (AuthenticationError) — the misconfig must surface", async () => {
    mockCreate.mockRejectedValue(sdkError("AuthenticationError"));
    const fetchMock = (global.fetch as ReturnType<typeof vi.fn>);

    await expect(generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", stage: "s"
    })).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT fail over on our own response-shape errors (plain Error) — not an outage", async () => {
    mockCreate.mockRejectedValue(sdkError("Error"));
    const fetchMock = (global.fetch as ReturnType<typeof vi.fn>);

    await expect(generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", stage: "s"
    })).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SCHEMA-DRIFT GUARDRAIL: a Gemini fallback response parses through the SAME RewrittenScriptSchema as a Claude response", async () => {
    // Anthropic hard-fails; Gemini (real fetch path, mocked transport) returns the same
    // JSON shape a Claude response would. rewriteScript must parse it identically.
    mockCreate.mockRejectedValue(sdkError("APIError"));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      geminiTextResponse({
        hook: "Wait for it...",
        points: ["point one", "point two"],
        cta: "Follow for more",
        trendingPhrases: ["no cap"],
        platformNotes: { tiktok: "fast cuts" }
      })
    );

    const result = await rewriteScript(makeTranscript(), baseOpts());

    // Provider swap changed the raw source but NOT the parsed contract — this is the
    // whole point of the schema-drift guardrail.
    expect(result.hook).toBe("Wait for it...");
    expect(result.points).toEqual(["point one", "point two"]);
    expect(result.cta).toBe("Follow for more");
    expect(result.trendingPhrases).toEqual(["no cap"]);
  });
});
