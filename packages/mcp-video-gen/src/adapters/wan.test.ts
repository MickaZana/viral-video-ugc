import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWanAdapter } from "./wan.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-wan`;

describe("createWanAdapter", () => {
  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.REPLICATE_API_TOKEN;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("submits to the fixed alibaba/wan-3 shortcut endpoint with a Bearer token and the input fields", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/predictions") && init?.method === "POST") {
        capturedUrl = urlStr;
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "pred-1", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "a hook", durationSec: 5, aspectRatio: "9:16" });

    expect(capturedUrl).toBe("https://api.replicate.com/v1/models/alibaba/wan-3/predictions");
    expect(capturedAuth).toBe("Bearer test-token");
    expect(capturedBody).toEqual({ input: { prompt: "a hook", aspect_ratio: "9:16", duration: 5 } });
    expect(clip.id).toBe("pred-1");
    expect(clip.vendor).toBe("wan");
    expect(clip.filePath).toContain("wan-0-pred-1.mp4");
  });

  it("polls until succeeded when the prediction isn't done inline", async () => {
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/predictions")) {
        return jsonResponse({ id: "pred-poll", status: "starting" });
      }
      if (urlStr.includes("/predictions/pred-poll")) {
        pollCount++;
        if (pollCount < 2) return jsonResponse({ id: "pred-poll", status: "processing" });
        return jsonResponse({ id: "pred-poll", status: "succeeded", output: "https://example.com/out.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });

    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(clip.id).toBe("pred-poll");
  }, 10_000);

  it("extracts a video URL from the confirmed-live bare-string output shape", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().endsWith("/predictions")) {
        return jsonResponse({ id: "pred-str", status: "succeeded", output: "https://example.com/str.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });
    expect(clip.id).toBe("pred-str");
  });

  it("also tolerates array/object output shapes defensively, matching replicate.ts", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().endsWith("/predictions")) {
        return jsonResponse({ id: "pred-obj", status: "succeeded", output: { video: "https://example.com/obj.mp4" } });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });
    expect(clip.id).toBe("pred-obj");
  });

  it("throws immediately when the prediction status is failed, without retrying", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().endsWith("/predictions")) return jsonResponse({ id: "pred-fail", status: "starting" });
      return jsonResponse({ id: "pred-fail", status: "failed", error: "NSFW content detected" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/pred-fail failed/);
  });

  it("throws a clear error when the submit call responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "model not found" }, false)));
    const adapter = createWanAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/prediction submit failed/);
  });

  // --- Image-input precedence: startingFrame > identityRef > referenceImageUrl >
  // referenceImageDataUri, matching every other adapter's single-image-field
  // convention (see VideoGenAdapter.ts's startingFrame doc).

  it("includes an image field only when a reference image is provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith("/predictions") && init?.method === "POST") {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "pred-img", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "9:16",
      referenceImageUrl: "https://example.com/ref.jpg"
    });

    expect((capturedBody!.input as Record<string, unknown>).image).toBe("https://example.com/ref.jpg");
  });

  it("does not set image when no reference is provided at all", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith("/predictions") && init?.method === "POST") {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "pred-noimg", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });

    expect((capturedBody!.input as Record<string, unknown>).image).toBeUndefined();
  });

  it("startingFrame.imageUrl takes priority over identityRef and referenceImageUrl", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith("/predictions") && init?.method === "POST") {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "pred-sf", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "9:16",
      startingFrame: { imageUrl: "https://example.com/frame.png" },
      identityRef: { primaryImageUrl: "https://example.com/identity.jpg", additionalImageUrls: [], mode: "reference_images" },
      referenceImageUrl: "https://example.com/generic-ref.jpg"
    });

    expect((capturedBody!.input as Record<string, unknown>).image).toBe("https://example.com/frame.png");
  });

  it("falls back to identityRef.primaryImageUrl when startingFrame is absent", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith("/predictions") && init?.method === "POST") {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "pred-id", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "9:16",
      identityRef: { primaryImageUrl: "https://example.com/identity.jpg", additionalImageUrls: [], mode: "reference_images" },
      referenceImageUrl: "https://example.com/generic-ref.jpg"
    });

    expect((capturedBody!.input as Record<string, unknown>).image).toBe("https://example.com/identity.jpg");
  });

  it("startingFrame.imageDataUri is used when imageUrl is absent", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith("/predictions") && init?.method === "POST") {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "pred-datauri", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createWanAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "9:16",
      startingFrame: { imageDataUri: "data:image/png;base64,AAAA" }
    });

    expect((capturedBody!.input as Record<string, unknown>).image).toBe("data:image/png;base64,AAAA");
  });
});
