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

  it("uses grok-4.3 (not the dead grok-2) as the default model when no explicit/GROK_MODEL override is given", async () => {
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

    expect(capturedModel).toBe("grok-4.3");
    expect(result.model).toBe("grok-4.3");
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

  it("uses gemini-3.1-pro-preview (not the dead gemini-2.5-pro) as the default model when geminiModel is omitted", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_MODEL;
    let capturedUrl: string | URL | undefined;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string | URL) => {
      capturedUrl = url;
      return geminiTextResponse({ hook: "h", points: ["p"], cta: "c" });
    });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5",
      // geminiModel intentionally omitted — exercises the module default.
      stage: "script_rewrite"
    });

    expect(String(capturedUrl)).toContain("/models/gemini-3.1-pro-preview:generateContent");
    expect(result.model).toBe("gemini-3.1-pro-preview");
  });

  it("GEMINI_MODEL overrides the default model even when the caller doesn't pass geminiModel explicitly", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_MODEL = "gemini-3.6-flash";
    let capturedUrl: string | URL | undefined;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string | URL) => {
      capturedUrl = url;
      return geminiTextResponse({ hook: "h", points: ["p"], cta: "c" });
    });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-fable-5",
      stage: "script_rewrite"
    });

    expect(String(capturedUrl)).toContain("/models/gemini-3.6-flash:generateContent");
    expect(result.model).toBe("gemini-3.6-flash");
    delete process.env.GEMINI_MODEL;
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

const kimiTextResponse = (json: unknown) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 90, completion_tokens: 45 }
  })
});

describe("generateWithFailover / Kimi (Moonshot AI) as an opt-in preferredProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GROK_API_KEY = "xai-test-key";
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected live fetch — mock it explicitly for this test");
    }));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_MODEL;
    vi.unstubAllGlobals();
  });

  it("does nothing for callers that don't set preferredProvider, even when MOONSHOT_API_KEY is configured (no regression to the 3 existing callers)", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ hook: "h", points: ["p"], cta: "c" }) }], usage: { input_tokens: 1, output_tokens: 1 } });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      stage: "s"
    });

    expect(result.provider).toBe("anthropic");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preferredProvider 'kimi' + MOONSHOT_API_KEY configured: tries Kimi first via the OpenAI-compatible shape and never touches Anthropic", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    const fetchMock = vi.fn().mockResolvedValue(kimiTextResponse({ scenes: ["kimi scene"] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      preferredProvider: "kimi",
      stage: "ad_storyboard"
    });

    expect(result.provider).toBe("kimi");
    expect(result.model).toBe("kimi-k3");
    expect(mockCreate).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer moonshot-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("kimi-k3");
    expect(body.max_tokens).toBe(100);
  });

  it("KIMI_MODEL overrides the default kimi-k3 model", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    process.env.KIMI_MODEL = "kimi-k2.6";
    let capturedModel: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      capturedModel = JSON.parse(init.body as string).model;
      return kimiTextResponse({ ok: true });
    }));

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      preferredProvider: "kimi",
      stage: "ad_storyboard"
    });

    expect(capturedModel).toBe("kimi-k2.6");
    expect(result.model).toBe("kimi-k2.6");
  });

  it("preferredProvider 'kimi' with no Moonshot key configured: falls straight through to the standard chain (Anthropic), fetch never called", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], usage: { input_tokens: 1, output_tokens: 1 } });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      preferredProvider: "kimi",
      stage: "ad_storyboard"
    });

    expect(result.provider).toBe("anthropic");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preferredProvider 'kimi' configured but Kimi's call fails (500): falls through to the standard chain instead of throwing", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" }));
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], usage: { input_tokens: 1, output_tokens: 1 } });

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      preferredProvider: "kimi",
      stage: "ad_storyboard"
    });

    expect(result.provider).toBe("anthropic");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("KEY ALIAS: KIMI_API_KEY works the same as MOONSHOT_API_KEY", async () => {
    process.env.KIMI_API_KEY = "kimi-alias-key";
    const fetchMock = vi.fn().mockResolvedValue(kimiTextResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      preferredProvider: "kimi",
      stage: "ad_storyboard"
    });

    expect(result.provider).toBe("kimi");
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer kimi-alias-key");
  });

  it("records Kimi usage on the ledger under the requested stage/model", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(kimiTextResponse({ ok: true })));
    const ledger = new CostLedger();

    await generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      preferredProvider: "kimi",
      stage: "ad_storyboard", costLedger: ledger
    });

    const events = ledger.getEvents();
    // "kimi" isn't in shared-cost's CostVendor union yet (see recordKimiUsage's comment in
    // llm-failover.ts) — cast to string here rather than widen the ledger's real type.
    expect(events.some((e) => e.stage === "ad_storyboard" && (e.vendor as string) === "kimi" && e.model === "kimi-k3")).toBe(true);
  });
});

describe("generateWithFailover / multimodal images", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GROK_API_KEY = "xai-test-key";
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected live fetch — mock it explicitly for this test");
    }));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    vi.unstubAllGlobals();
  });

  const oneImage = [{ mediaType: "image/jpeg" as const, base64: "ZmFrZQ==" }];

  it("Anthropic: images become content blocks ahead of a trailing text block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], usage: { input_tokens: 1, output_tokens: 1 } });

    await generateWithFailover({
      system: "s", userPrompt: "describe this", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      images: oneImage,
      stage: "ad_deconstruction"
    });

    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZmFrZQ==" } },
      { type: "text", text: "describe this" }
    ]);
  });

  it("Anthropic: with no images, content stays a plain string (byte-identical to the pre-multimodal shape)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], usage: { input_tokens: 1, output_tokens: 1 } });

    await generateWithFailover({
      system: "s", userPrompt: "plain text prompt", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      stage: "script_rewrite"
    });

    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe("plain text prompt");
  });

  it("Gemini fallback: images become inline_data parts ahead of the text part", async () => {
    mockCreate.mockRejectedValue(sdkError("APIError"));
    const fetchMock = vi.fn().mockResolvedValue(geminiTextResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await generateWithFailover({
      system: "sys", userPrompt: "usr", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      images: oneImage,
      stage: "ad_deconstruction"
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.contents[0].parts).toEqual([
      { inline_data: { mime_type: "image/jpeg", data: "ZmFrZQ==" } },
      { text: "sys\n\nusr" }
    ]);
  });

  it("Grok: rejects a request carrying images with a clear error rather than silently dropping them", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;

    await expect(generateWithFailover({
      system: "s", userPrompt: "u", maxTokens: 100,
      anthropicModel: "claude-sonnet-5", geminiModel: "gemini-2.5-pro",
      images: oneImage,
      stage: "ad_deconstruction"
    })).rejects.toThrow(/does not support multimodal/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
