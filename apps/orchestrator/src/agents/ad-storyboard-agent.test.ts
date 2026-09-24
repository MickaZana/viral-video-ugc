import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";
import type { AdDeconstructionResult } from "./ad-deconstruction-agent.js";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

const { buildAdStoryboard } = await import("./ad-storyboard-agent.js");

function makeDeconstruction(): AdDeconstructionResult {
  return [
    { startSec: 0, endSec: 3, shotDescription: "Hook shot, presenter direct to camera.", onScreenText: null, productOrBrandBeats: [] },
    { startSec: 3, endSec: 9, shotDescription: "Close-up product reveal.", onScreenText: "New!", productOrBrandBeats: ["product_reveal"] }
  ];
}

function textMessage(json: unknown, usage = { input_tokens: 300, output_tokens: 200 }) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], usage };
}

const validStoryboard = [
  { sceneIndex: 0, prompt: "A presenter looks straight at camera in a bright kitchen, energetic delivery.", visualDirection: { cameraMovement: "static", lighting: "natural", tempo: "dynamic" }, durationSec: 3 },
  { sceneIndex: 1, prompt: "Macro shot of a hand lifting a sleek product box off a counter.", visualDirection: { cameraMovement: "dolly_in", lens: "macro", lighting: "studio" }, durationSec: 6 }
];

describe("buildAdStoryboard", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Hermeticity, same convention as caption-agent.test.ts / ad-deconstruction-agent.test.ts:
    // clear every other provider key (including the new Kimi ones — this agent is the ONLY
    // caller that sets preferredProvider: "kimi") and make any fetch a hard failure by
    // default so an ambient key never leaks this suite onto a real network call.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_MODEL;
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected live fetch — mock it explicitly for this test");
    }));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it("dry-run: maps each deconstruction scene 1:1 into a mock storyboard entry without calling the API", async () => {
    const storyboard = await buildAdStoryboard(makeDeconstruction(), { dryRun: true });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(storyboard).toHaveLength(2);
    expect(storyboard[0].sceneIndex).toBe(0);
    expect(storyboard[0].prompt).toContain("[mock]");
    expect(storyboard[1].durationSec).toBe(6);
  });

  it("no MOONSHOT_API_KEY/KIMI_API_KEY configured: falls straight through to the standard chain (Anthropic here) without ever hitting fetch", async () => {
    mockCreate.mockResolvedValue(textMessage(validStoryboard));

    const storyboard = await buildAdStoryboard(makeDeconstruction(), { dryRun: false });

    expect(storyboard).toEqual(validStoryboard);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("claude-sonnet-5");
    // fetch would throw synchronously per the beforeEach stub if Kimi (or anything else) had
    // actually been attempted over the network — it wasn't called at all.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("MOONSHOT_API_KEY configured: tries Kimi first via the OpenAI-compatible chat/completions shape", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(validStoryboard) } }],
        usage: { prompt_tokens: 500, completion_tokens: 300 }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const storyboard = await buildAdStoryboard(makeDeconstruction(), { dryRun: false });

    expect(storyboard).toEqual(validStoryboard);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer moonshot-test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("kimi-k3");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("MOONSHOT_API_KEY configured but Kimi fails: falls through to the standard Anthropic-primary chain, not a thrown error", async () => {
    process.env.MOONSHOT_API_KEY = "moonshot-test-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" });
    vi.stubGlobal("fetch", fetchMock);
    mockCreate.mockResolvedValue(textMessage(validStoryboard));

    const storyboard = await buildAdStoryboard(makeDeconstruction(), { dryRun: false });

    expect(storyboard).toEqual(validStoryboard);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("visualDirection in the response is validated against the exact VideoGenAdapter field/enum set — an invented value fails Zod", async () => {
    mockCreate.mockResolvedValue(
      textMessage([{ sceneIndex: 0, prompt: "x", visualDirection: { cameraMovement: "zoom_burst" }, durationSec: 3 }])
    );

    await expect(buildAdStoryboard(makeDeconstruction(), { dryRun: false })).rejects.toThrow();
  });

  it("records usage on the cost ledger under the ad_storyboard stage when the standard chain serves the call", async () => {
    mockCreate.mockResolvedValue(textMessage(validStoryboard));
    const ledger = new CostLedger();

    await buildAdStoryboard(makeDeconstruction(), { dryRun: false, costLedger: ledger });

    const events = ledger.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stage === "ad_storyboard" && e.model === "claude-sonnet-5")).toBe(true);
  });

  it("throws when the response text contains no JSON array", async () => {
    mockCreate.mockResolvedValue(textMessage("not an array"));
    await expect(buildAdStoryboard(makeDeconstruction(), { dryRun: false })).rejects.toThrow(/No JSON array found/);
  });
});
