import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiAdapter } from "./gemini.js";
import { makeTestImage } from "../test-fixtures.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-gemini`;

// Real Ken Burns rendering at production dimensions (2160x3840 doubled-for-9:16) is
// already verified against real ffmpeg by ken-burns.test.ts at a small resolution —
// re-running a full-res encode here on every adapter test just adds slow, flaky
// (Windows subprocess contention under parallel test runs) coverage of the same
// code path. This test owns the HTTP contract instead: what gets sent to Gemini,
// and that the adapter wires stillImageToClip's result into the returned RawClip.
vi.mock("../ken-burns.js", () => ({
  stillImageToClip: vi.fn(async (_imagePath: string, _durationSec: number, _dims: unknown, outPath: string) => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, "stub clip");
  })
}));

describe("createGeminiAdapter", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_IMAGE_MODEL;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("posts to /v1beta/interactions with the x-goog-api-key header and the default model", async () => {
    const fixture = makeTestImage(`${outDir}/fixture.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({ output_image: { data: imageBase64 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGeminiAdapter(outDir);
    const clip = await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "a fitness creator recording a morning routine, vertical video still",
      durationSec: 2,
      aspectRatio: "9:16"
    });

    expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("test-gemini-key");
    expect(capturedBody?.model).toBe("gemini-2.5-flash-image");
    expect((capturedBody?.input as { text: string }[])?.[0]?.text).toContain("fitness creator");
    expect((capturedBody?.response_format as { aspect_ratio: string })?.aspect_ratio).toBe("9:16");

    expect(clip.vendor).toBe("gemini");
    expect(clip.scriptSegmentIndex).toBe(0);
    expect(clip.durationSec).toBe(2);
    expect(existsSync(clip.filePath)).toBe(true);
  }, 30_000);

  it("honors GEMINI_IMAGE_MODEL override", async () => {
    process.env.GEMINI_IMAGE_MODEL = "gemini-3-pro-image";
    const fixture = makeTestImage(`${outDir}/fixture2.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");

    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    const adapter = createGeminiAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 1, prompt: "x", durationSec: 2, aspectRatio: "1:1" });

    expect(capturedBody?.model).toBe("gemini-3-pro-image");
  }, 30_000);

  it("throws a clear error when the request responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "quota exceeded" }, false)));
    const adapter = createGeminiAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 2, aspectRatio: "9:16" })
    ).rejects.toThrow(/Gemini image generation failed/);
  });

  it("throws a clear error when the response has no output_image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    const adapter = createGeminiAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 2, aspectRatio: "9:16" })
    ).rejects.toThrow(/no output_image/);
  });
});
