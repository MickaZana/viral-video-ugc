import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedanceAdapter } from "./seedance.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-seedance`;

describe("createSeedanceAdapter — Seedance 2.5", () => {
  beforeEach(() => {
    process.env.FAL_KEY = "test-fal-key";
    delete process.env.SEEDANCE_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FAL_KEY;
    delete process.env.SEEDANCE_MODEL;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  function mockQueueFlow(videoUrl = "https://cdn.fal/seedance.mp4") {
    let submitUrl: string | undefined;
    let submitAuth: string | undefined;
    let submitBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (init?.method === "POST") {
        submitUrl = urlStr;
        submitAuth = (init.headers as Record<string, string>).Authorization;
        submitBody = JSON.parse(init.body as string);
        return jsonResponse({ request_id: "req-1" });
      }
      if (urlStr.endsWith("/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      if (urlStr.includes("/requests/req-1")) {
        return jsonResponse({ video: { url: videoUrl } });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      getSubmit: () => ({ url: submitUrl, auth: submitAuth, body: submitBody! }),
    };
  }

  // -------------------------------------------------------------------------
  // Endpoint selection (the core 2.5 upgrade: 3 explicit endpoints instead of 1)
  // -------------------------------------------------------------------------

  it("routes to text-to-video when no image signal is present", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "a sunrise over mountains", durationSec: 8, aspectRatio: "16:9" });

    const { url, body } = getSubmit();
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/text-to-video");
    expect(body.image_url).toBeUndefined();
    expect(body.image_urls).toBeUndefined();
    expect(body.prompt).toBe("a sunrise over mountains");
    expect(body.duration).toBe("8");
    expect(body.aspect_ratio).toBe("16:9");
  });

  it("routes to image-to-video when startingFrame is present", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "animate this frame",
      durationSec: 5,
      aspectRatio: "9:16",
      startingFrame: { imageUrl: "https://storage.example.com/frame.png" },
    });

    const { url, body } = getSubmit();
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/image-to-video");
    expect(body.image_url).toBe("https://storage.example.com/frame.png");
    expect(body.image_urls).toBeUndefined();
  });

  it("routes to image-to-video when identityRef has a primary image but no additional images", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "hi",
      durationSec: 5,
      aspectRatio: "9:16",
      identityRef: { primaryImageUrl: "https://storage.example.com/face.jpg", additionalImageUrls: [], mode: "reference_images" },
    });

    const { url, body } = getSubmit();
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/image-to-video");
    expect(body.image_url).toBe("https://storage.example.com/face.jpg");
    expect(body.image_urls).toBeUndefined();
  });

  it("routes to image-to-video when only a generic referenceImageUrl is present", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "hi",
      durationSec: 5,
      aspectRatio: "9:16",
      referenceImageUrl: "https://storage.example.com/generic-ref.jpg",
    });

    const { url, body } = getSubmit();
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/image-to-video");
    expect(body.image_url).toBe("https://storage.example.com/generic-ref.jpg");
  });

  it("routes to reference-to-video when identityRef has multiple images and no startingFrame", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "hi",
      durationSec: 5,
      aspectRatio: "9:16",
      identityRef: {
        primaryImageUrl: "https://storage.example.com/creators/alex/primary.jpg",
        additionalImageUrls: [
          "https://storage.example.com/creators/alex/ref-2.jpg",
          "https://storage.example.com/creators/alex/ref-3.jpg",
        ],
        mode: "reference_images",
      },
    });

    const { url, body } = getSubmit();
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/reference-to-video");
    expect(body.image_url).toBeUndefined();
    expect(body.image_urls).toEqual([
      "https://storage.example.com/creators/alex/primary.jpg",
      "https://storage.example.com/creators/alex/ref-2.jpg",
      "https://storage.example.com/creators/alex/ref-3.jpg",
    ]);
  });

  it("startingFrame takes priority over a multi-image identityRef (still routes to image-to-video)", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "hi",
      durationSec: 5,
      aspectRatio: "9:16",
      startingFrame: { imageUrl: "https://storage.example.com/generated/nano-banana-frame.png" },
      identityRef: {
        primaryImageUrl: "https://storage.example.com/creators/alex/primary.jpg",
        additionalImageUrls: ["https://storage.example.com/creators/alex/ref-2.jpg"],
        mode: "reference_images",
      },
    });

    const { url, body } = getSubmit();
    expect(url).toBe("https://queue.fal.run/bytedance/seedance-2.5/image-to-video");
    expect(body.image_url).toBe("https://storage.example.com/generated/nano-banana-frame.png");
    expect(body.image_urls).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Model base / SEEDANCE_MODEL override (must keep working across the 2.5 bump)
  // -------------------------------------------------------------------------

  it("defaults to the bytedance/seedance-2.5 model base", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" });
    expect(getSubmit().url).toBe("https://queue.fal.run/bytedance/seedance-2.5/text-to-video");
  });

  it("SEEDANCE_MODEL env var overrides the model base (e.g. pinning back to 2.0), endpoint suffix still applied", async () => {
    process.env.SEEDANCE_MODEL = "bytedance/seedance-2.0";
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "hi",
      durationSec: 5,
      aspectRatio: "9:16",
      startingFrame: { imageUrl: "https://storage.example.com/frame.png" },
    });
    expect(getSubmit().url).toBe("https://queue.fal.run/bytedance/seedance-2.0/image-to-video");
  });

  // -------------------------------------------------------------------------
  // Auth, cinema controls, error handling (unchanged behavior, still covered)
  // -------------------------------------------------------------------------

  it("uses the fal.ai queue API with Authorization: Key <fal-key>", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" });

    expect(getSubmit().auth).toBe("Key test-fal-key");
    expect(clip.vendor).toBe("seedance");
    expect(clip.id).toBe("req-1");
  });

  it("requires FAL_KEY", async () => {
    delete process.env.FAL_KEY;
    const adapter = createSeedanceAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" })
    ).rejects.toThrow(/FAL_KEY/);
  });

  it("merges Cinema Controls params from visualDirection into the request body", async () => {
    const { getSubmit } = mockQueueFlow();
    const adapter = createSeedanceAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "hi",
      durationSec: 5,
      aspectRatio: "9:16",
      visualDirection: { cameraMovement: "dolly_in", tempo: "dynamic" },
    });

    const { body } = getSubmit();
    expect(body.camera_control).toBeDefined();
    expect(body.motion_mode).toBeDefined();
  });

  it("throws when the request completes without a video URL", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ request_id: "req-empty" });
      if (url.toString().endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
      return jsonResponse({}); // no `video` field
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createSeedanceAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" })
    ).rejects.toThrow(/no video URL found/);
  });

  it("throws when submit fails", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "bad request" }, false));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createSeedanceAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" })
    ).rejects.toThrow(/Seedance submit failed/);
  });
});
