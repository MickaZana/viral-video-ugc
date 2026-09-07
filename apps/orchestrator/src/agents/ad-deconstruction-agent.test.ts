import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "@vvugc/shared-cost";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } }))
}));

const mockSpawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => mockSpawnSync(...args) }));

// mkdtempSync/rmSync run for real (harmless, sandboxed temp-dir housekeeping); only
// readFileSync is stubbed, since no real ffmpeg process ever runs in this suite (spawnSync
// is mocked above) so no real frame file exists on disk to read.
const mockReadFileSync = vi.fn((..._args: unknown[]) => Buffer.from("fake-jpeg-bytes"));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: unknown[]) => mockReadFileSync(...args) };
});

const { deconstructAd } = await import("./ad-deconstruction-agent.js");

function textMessage(json: unknown, usage = { input_tokens: 200, output_tokens: 150 }) {
  return { content: [{ type: "text", text: JSON.stringify(json) }], usage };
}

const validScenes = [
  { startSec: 0, endSec: 3, shotDescription: "Hook shot, presenter direct to camera.", onScreenText: null, productOrBrandBeats: [] },
  { startSec: 3, endSec: 9, shotDescription: "Close-up product reveal.", onScreenText: "New!", productOrBrandBeats: ["product_reveal"] }
];

/** Configures spawnSync to answer `ffprobe -show_entries format=duration ...` with the
 *  given duration, and any `ffmpeg ... -frames:v 1 ...` frame-extraction call with success —
 *  matching resolveBinary's own `<bin> -version` probe as success too. */
function stubFfmpegSuccess(durationSec = 12) {
  mockSpawnSync.mockImplementation((bin: string, args: string[]) => {
    if (args.includes("-version")) return { status: 0, error: undefined, stdout: "", stderr: "" };
    if (args.includes("format=duration")) {
      return { status: 0, error: undefined, stdout: `${durationSec}\n`, stderr: "" };
    }
    // frame extraction
    return { status: 0, error: undefined, stdout: "", stderr: "" };
  });
}

describe("deconstructAd", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockSpawnSync.mockReset();
    mockReadFileSync.mockClear();
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Hermeticity: generateWithFailover's Gemini/Grok fallbacks read these straight off
    // process.env, so an ambient key left set in the shell would otherwise leak this suite
    // onto a real network call. Clear them every test, and make any fetch a hard failure
    // rather than a silent live call — a fallback test stubs its own fetch.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_API_KEY;
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unexpected live fetch — mock it explicitly for this test");
    }));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it("dry-run: returns deterministic mock scenes without touching ffmpeg or the Anthropic API", async () => {
    const scenes = await deconstructAd("/videos/source.mp4", { dryRun: true });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes[0].shotDescription).toContain("[mock]");
  });

  it("live: probes duration, samples frames via ffmpeg, and sends them as image content blocks to Claude", async () => {
    stubFfmpegSuccess(12);
    mockCreate.mockResolvedValue(textMessage(validScenes));

    const scenes = await deconstructAd("/videos/source.mp4", { dryRun: false, frameCount: 4 });

    expect(scenes).toEqual(validScenes.map((s) => ({ ...s, onScreenText: s.onScreenText ?? null })));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-5");
    const content = call.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    // 4 image blocks + 1 trailing text block
    const imageBlocks = content.filter((b: { type: string }) => b.type === "image");
    expect(imageBlocks).toHaveLength(4);
    for (const block of imageBlocks) {
      expect(block.source).toEqual({ type: "base64", media_type: "image/jpeg", data: "ZmFrZS1qcGVnLWJ5dGVz" });
    }
    expect(content[content.length - 1]).toEqual({ type: "text", text: expect.stringContaining("Source ad video duration: 12.00s") });
  });

  it("records Anthropic usage on the cost ledger under the ad_deconstruction stage", async () => {
    stubFfmpegSuccess(9);
    mockCreate.mockResolvedValue(textMessage(validScenes));
    const ledger = new CostLedger();

    await deconstructAd("/videos/source.mp4", { dryRun: false, costLedger: ledger });

    const events = ledger.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stage === "ad_deconstruction" && e.model === "claude-sonnet-5")).toBe(true);
    expect(ledger.totalUsd()).toBeGreaterThan(0);
  });

  it("throws a clear error when ffprobe cannot read a duration", async () => {
    mockSpawnSync.mockImplementation((bin: string, args: string[]) => {
      if (args.includes("-version")) return { status: 0, error: undefined, stdout: "", stderr: "" };
      if (args.includes("format=duration")) return { status: 0, error: undefined, stdout: "not-a-number\n", stderr: "" };
      return { status: 0, error: undefined, stdout: "", stderr: "" };
    });

    await expect(deconstructAd("/videos/source.mp4", { dryRun: false })).rejects.toThrow(/invalid duration/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("throws a clear, actionable error when ffmpeg is not found on PATH", async () => {
    mockSpawnSync.mockImplementation(() => ({ status: null, error: new Error("ENOENT"), stdout: "", stderr: "" }));

    await expect(deconstructAd("/videos/source.mp4", { dryRun: false })).rejects.toThrow(/not found on PATH/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a malformed scene (missing required shotDescription) fails Zod validation rather than silently reaching the storyboard step", async () => {
    stubFfmpegSuccess(6);
    mockCreate.mockResolvedValue(textMessage([{ startSec: 0, endSec: 3, onScreenText: null, productOrBrandBeats: [] }]));

    await expect(deconstructAd("/videos/source.mp4", { dryRun: false })).rejects.toThrow();
  });

  it("throws when the response text contains no JSON array", async () => {
    stubFfmpegSuccess(6);
    mockCreate.mockResolvedValue(textMessage("not an array"));

    await expect(deconstructAd("/videos/source.mp4", { dryRun: false })).rejects.toThrow(/No JSON array found/);
  });
});
