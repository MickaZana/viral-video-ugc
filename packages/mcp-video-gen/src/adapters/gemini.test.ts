import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiAdapter, generateImage } from "./gemini.js";
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

  it("still forwards referenceImageDataUri to the image input slot now that it delegates to generateImage internally", async () => {
    const fixture = makeTestImage(`${outDir}/fixture-ref.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");
    const refDataUri = "data:image/png;base64,ZmFrZS1yZWZlcmVuY2UtaW1hZ2U=";

    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    const adapter = createGeminiAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 2,
      prompt: "x",
      durationSec: 2,
      aspectRatio: "9:16",
      referenceImageDataUri: refDataUri
    });

    const input = capturedBody?.input as { type: string; image?: string }[];
    expect(input[1]).toEqual({ type: "image", image: refDataUri });
  }, 30_000);
});

describe("generateImage (standalone, no video attached)", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_IMAGE_MODEL;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("posts to /v1beta/interactions with the default model and default 1:1/1K response_format, returning real image bytes", async () => {
    const fixture = makeTestImage(`${outDir}/standalone-fixture.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");
    const rawBytes = readFileSync(fixture);

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    const result = await generateImage("a red circle on a white background");

    expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("test-gemini-key");
    expect(capturedBody?.model).toBe("gemini-2.5-flash-image");
    expect((capturedBody?.input as { type: string; text: string }[])?.[0]).toEqual({ type: "text", text: "a red circle on a white background" });
    expect((capturedBody?.response_format as { aspect_ratio: string; image_size: string })?.aspect_ratio).toBe("1:1");
    expect((capturedBody?.response_format as { aspect_ratio: string; image_size: string })?.image_size).toBe("1K");

    expect(result.mimeType).toBe("image/png");
    expect(Buffer.compare(result.imageBytes, rawBytes)).toBe(0);
  });

  it("honors a per-call model override independent of GEMINI_IMAGE_MODEL", async () => {
    process.env.GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
    const fixture = makeTestImage(`${outDir}/standalone-fixture2.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");

    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    await generateImage("x", { model: "gemini-3-pro-image-preview" });

    expect(capturedBody?.model).toBe("gemini-3-pro-image-preview");
  });

  it("falls back to GEMINI_IMAGE_MODEL when no per-call model is given", async () => {
    process.env.GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
    const fixture = makeTestImage(`${outDir}/standalone-fixture3.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");

    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    await generateImage("x");

    expect(capturedBody?.model).toBe("gemini-3.1-flash-image");
  });

  it("passes referenceImageDataUri through as the single image input slot (image editing / image-to-image)", async () => {
    const fixture = makeTestImage(`${outDir}/standalone-fixture4.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");
    const refDataUri = "data:image/png;base64,ZmFrZS1yZWZlcmVuY2UtaW1hZ2U=";

    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    await generateImage("edit this image: add a hat", { referenceImageDataUri: refDataUri });

    const input = capturedBody?.input as { type: string; text?: string; image?: string }[];
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ type: "text", text: "edit this image: add a hat" });
    expect(input[1]).toEqual({ type: "image", image: refDataUri });
  });

  it("respects a custom aspectRatio and imageSize", async () => {
    const fixture = makeTestImage(`${outDir}/standalone-fixture5.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");

    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({ output_image: { data: imageBase64 } });
      })
    );

    await generateImage("x", { aspectRatio: "16:9", imageSize: "4K" });

    expect((capturedBody?.response_format as { aspect_ratio: string; image_size: string })?.aspect_ratio).toBe("16:9");
    expect((capturedBody?.response_format as { aspect_ratio: string; image_size: string })?.image_size).toBe("4K");
  });

  it("uses the response's mime_type when present instead of defaulting to image/png", async () => {
    const fixture = makeTestImage(`${outDir}/standalone-fixture6.png`);
    const imageBase64 = readFileSync(fixture).toString("base64");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ output_image: { data: imageBase64, mime_type: "image/jpeg" } })));

    const result = await generateImage("x");

    expect(result.mimeType).toBe("image/jpeg");
  });

  it("throws a clear error when the request responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "quota exceeded" }, false)));
    await expect(generateImage("x")).rejects.toThrow(/Gemini image generation failed/);
  });

  it("throws a clear error when the response has no output_image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    await expect(generateImage("x")).rejects.toThrow(/no output_image/);
  });
});
