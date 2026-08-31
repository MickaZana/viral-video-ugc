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

const grokTextResponse = (json: unknown) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 120, completion_tokens: 60 }
  })
});

describe("generateWithFailover / multi-provider failover chain", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GROK_API_KEY = "xai-test-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    vi.unstubAllGlobals();
  });

  it("falls back to Gemini on a hard Anthropic failure and reports provider+model", async () => {
    mockCreate.mockRejectedValue(sdkError("APIError"));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(geminiTextResponse({ hook: "h", points: ["p"], cta: "c" }));
    const onFallback = vi.fn();

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", grokModel: "grok-2-latest",
      stage: "script_rewrite", onFallback
    });

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-2.5-pro");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("gemini", "gemini-2.5-pro", expect.anything());
  });

  it("falls back to Grok if Gemini is not funded / fails, without replacing primary when working", async () => {
    mockCreate.mockRejectedValue(sdkError("APIError"));
    // First fetch call (Gemini) returns 402 Payment Required / quota error (unfunded)
    // Second fetch call (Grok) succeeds
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 402,
        text: async () => "QuotaExceeded: Resource has been exhausted (billing not funded)"
      })
      .mockResolvedValueOnce(grokTextResponse({ hook: "grok hook", points: ["grok point"], cta: "grok cta" }));

    const onFallback = vi.fn();

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", grokModel: "grok-2-latest",
      stage: "script_rewrite", onFallback
    });

    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-2-latest");
    // Fallback fired for Gemini, then for Grok
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenNthCalledWith(1, "gemini", "gemini-2.5-pro", expect.anything());
    expect(onFallback).toHaveBeenNthCalledWith(2, "grok", "grok-2-latest", expect.anything());
  });

  it("uses Grok as the first fallback if Anthropic is unset and Gemini is unfunded", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    // Gemini fails (unfunded / 403 / 429)
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "API key has no quota / unfunded"
      })
      .mockResolvedValueOnce(grokTextResponse({ hook: "h", points: ["p"], cta: "c" }));

    const onFallback = vi.fn();
    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", grokModel: "grok-2-latest",
      stage: "script_rewrite", onFallback
    });

    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-2-latest");
    expect(onFallback).toHaveBeenCalledWith("grok", "grok-2-latest", expect.anything());
  });

  it("records Grok usage on the ledger under the requested stage/model", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(grokTextResponse({ hook: "h", points: ["p"], cta: "c" }));
    const ledger = new CostLedger();

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", grokModel: "grok-2-latest",
      stage: "script_rewrite", costLedger: ledger
    });

    expect(result.provider).toBe("grok");
    const events = ledger.getEvents();
    expect(events.some((e) => e.stage === "script_rewrite" && e.vendor === "grok" && e.model === "grok-2-latest")).toBe(true);
    expect(ledger.totalUsd()).toBeGreaterThan(0);
  });

  it("records Gemini usage on the ledger when Gemini succeeds", async () => {
    mockCreate.mockRejectedValue(sdkError("APIConnectionError"));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(geminiTextResponse({ hook: "h", points: ["p"], cta: "c" }));
    const ledger = new CostLedger();

    await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro", grokModel: "grok-2-latest",
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

  it("Grok call retries with the alternate candidate key on a 403 (unfunded/no-permission team), and succeeds", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    // xaiGrokKeyCandidates tries GROK_API_KEY before XAI_API_KEY when neither
    // comes from .env (always true under Vitest) — the unfunded key must be
    // under GROK_API_KEY so the first live attempt is the one that 403s.
    process.env.GROK_API_KEY = "unfunded-team-key";
    process.env.XAI_API_KEY = "funded-team-key";
    const capturedAuthHeaders: string[] = [];
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      capturedAuthHeaders.push(auth);
      if (auth === "Bearer funded-team-key") {
        return grokTextResponse({ hook: "h", points: ["p"], cta: "c" });
      }
      return { ok: false, status: 403, text: async () => '{"error":"team has no credits or licenses yet"}' };
    });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro",
      stage: "script_rewrite"
    });

    expect(result.provider).toBe("grok");
    expect(capturedAuthHeaders).toEqual(["Bearer unfunded-team-key", "Bearer funded-team-key"]);
  });

  it("uses grok-2 (not the invalid grok-2-latest) as the default model when no explicit/GROK_MODEL override is given", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_MODEL;
    let capturedModel: string | undefined;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      capturedModel = JSON.parse(init?.body as string).model;
      return grokTextResponse({ hook: "h", points: ["p"], cta: "c" });
    });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro",
      // grokModel intentionally omitted — exercises the module default.
      stage: "script_rewrite"
    });

    expect(capturedModel).toBe("grok-2");
    expect(result.model).toBe("grok-2");
  });

  it("GROK_MODEL overrides the default model even when the caller doesn't pass grokModel explicitly", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GROK_MODEL = "grok-3";
    let capturedModel: string | undefined;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      capturedModel = JSON.parse(init?.body as string).model;
      return grokTextResponse({ hook: "h", points: ["p"], cta: "c" });
    });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5", geminiModel: "gemini-2.5-pro",
      stage: "script_rewrite"
    });

    expect(capturedModel).toBe("grok-3");
    expect(result.model).toBe("grok-3");
    delete process.env.GROK_MODEL;
  });

  it("SCHEMA-DRIFT GUARDRAIL: a Grok fallback response parses through the SAME RewrittenScriptSchema", async () => {
    mockCreate.mockRejectedValue(sdkError("APIError"));
    // Gemini fails, Grok succeeds
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 402,
        text: async () => "Payment Required"
      })
      .mockResolvedValueOnce(
        grokTextResponse({
          hook: "Wait for it with Grok...",
          points: ["grok point one", "grok point two"],
          cta: "Follow for more",
          trendingPhrases: ["no cap"],
          platformNotes: { tiktok: "fast cuts" }
        })
      );

    const result = await rewriteScript(makeTranscript(), baseOpts());

    expect(result.hook).toBe("Wait for it with Grok...");
    expect(result.points).toEqual(["grok point one", "grok point two"]);
    expect(result.cta).toBe("Follow for more");
    expect(result.trendingPhrases).toEqual(["no cap"]);
  });
});
