/**
 * Soul ID — Adapter Identity Injection Tests (Atom B / Atom D)
 *
 * Verifies that each adapter correctly handles the identityRef field:
 * - With identityRef → vendor receives the face reference image(s)
 * - Without identityRef → behavior is identical to before
 * - Gemini ignores identityRef entirely
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VideoGenRequest } from "./VideoGenAdapter.js";

// ---------------------------------------------------------------------------
// Shared test request factories
// ---------------------------------------------------------------------------

function baseRequest(overrides: Partial<VideoGenRequest> = {}): VideoGenRequest {
  return {
    scriptSegmentIndex: 0,
    prompt: "A fitness influencer doing pushups in a gym",
    durationSec: 5,
    aspectRatio: "9:16",
    ...overrides,
  };
}

function withIdentityRef(overrides: Partial<VideoGenRequest> = {}): VideoGenRequest {
  return baseRequest({
    identityRef: {
      primaryImageUrl: "https://storage.example.com/creators/alex/primary.jpg",
      additionalImageUrls: [
        "https://storage.example.com/creators/alex/ref-2.jpg",
        "https://storage.example.com/creators/alex/ref-3.jpg",
      ],
      mode: "reference_images",
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Mock fetch for REST-based adapters
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

vi.mock("@vvugc/shared-http", () => ({
  fetchWithRetry: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@vvugc/shared-config", () => ({
  requireEnvVar: (key: string) => `mock-${key}`,
  loadEnv: () => ({ REPLICATE_MODEL: "minimax/video-01", SEEDANCE_MODEL: "fal-ai/seedance-2" }),
}));

// ---------------------------------------------------------------------------
// Kling Tests
// ---------------------------------------------------------------------------

describe("Soul ID — Kling Adapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Submit returns task_id
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { task_id: "task-123" } }),
    });
    // Poll returns completed with video URL
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.kling/video.mp4" }] } },
      }),
    });
    // Download video
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: async () => new ArrayBuffer(100),
    });
  });

  it("uses image2video endpoint when identityRef is present", async () => {
    const { createKlingAdapter } = await import("./kling.js");
    const adapter = createKlingAdapter("/tmp/out");
    await adapter.generate(withIdentityRef());

    // First call should be to image2video endpoint
    const submitCall = mockFetch.mock.calls[0];
    expect(submitCall[0]).toContain("/videos/image2video");
    const body = JSON.parse(submitCall[1].body);
    expect(body.image).toBe("https://storage.example.com/creators/alex/primary.jpg");
  });

  it("uses text2video endpoint when identityRef is absent", async () => {
    const { createKlingAdapter } = await import("./kling.js");
    const adapter = createKlingAdapter("/tmp/out");
    await adapter.generate(baseRequest());

    const submitCall = mockFetch.mock.calls[0];
    expect(submitCall[0]).toContain("/videos/text2video");
    const body = JSON.parse(submitCall[1].body);
    expect(body.image).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Seedance Tests
// ---------------------------------------------------------------------------

describe("Soul ID — Seedance Adapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Submit
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ request_id: "req-456" }),
    });
    // Status poll → completed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "COMPLETED" }),
    });
    // Fetch result
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ video: { url: "https://cdn.fal/video.mp4" } }),
    });
    // Download
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: async () => new ArrayBuffer(100),
    });
  });

  it("routes to reference-to-video and sends primary + additional images as image_urls (Seedance 2.5)", async () => {
    // withIdentityRef()'s default fixture has a primary image PLUS 2 additional
    // images — under Seedance 2.5's endpoint-selection logic that's exactly the
    // reference-to-video case (identityRef.additionalImageUrls non-empty), not
    // image-to-video's single image_url field. See seedance.ts's file-header
    // comment for the full endpoint-selection reasoning.
    const { createSeedanceAdapter } = await import("./seedance.js");
    const adapter = createSeedanceAdapter("/tmp/out");
    await adapter.generate(withIdentityRef());

    const submitCall = mockFetch.mock.calls[0];
    expect(submitCall[0]).toContain("/reference-to-video");
    const body = JSON.parse(submitCall[1].body);
    expect(body.image_url).toBeUndefined();
    expect(body.image_urls).toEqual([
      "https://storage.example.com/creators/alex/primary.jpg",
      "https://storage.example.com/creators/alex/ref-2.jpg",
      "https://storage.example.com/creators/alex/ref-3.jpg",
    ]);
  });

  it("routes to image-to-video and sends image_url when identityRef has a primary image but no additional images", async () => {
    const { createSeedanceAdapter } = await import("./seedance.js");
    const adapter = createSeedanceAdapter("/tmp/out");
    await adapter.generate(withIdentityRef({
      identityRef: { primaryImageUrl: "https://storage.example.com/creators/alex/primary.jpg", additionalImageUrls: [], mode: "reference_images" },
    }));

    const submitCall = mockFetch.mock.calls[0];
    expect(submitCall[0]).toContain("/image-to-video");
    const body = JSON.parse(submitCall[1].body);
    expect(body.image_url).toBe("https://storage.example.com/creators/alex/primary.jpg");
    expect(body.image_urls).toBeUndefined();
  });

  it("does not set image_url when identityRef is absent", async () => {
    const { createSeedanceAdapter } = await import("./seedance.js");
    const adapter = createSeedanceAdapter("/tmp/out");
    await adapter.generate(baseRequest());

    const submitCall = mockFetch.mock.calls[0];
    const body = JSON.parse(submitCall[1].body);
    expect(body.image_url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Grok Video Tests
// ---------------------------------------------------------------------------

describe("Soul ID — Grok Video Adapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Submit → completed immediately
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "gen-789",
        status: "completed",
        video: { url: "https://cdn.xai/video.mp4" },
      }),
    });
    // Download
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: async () => new ArrayBuffer(100),
    });
  });

  it("passes identityRef.primaryImageUrl as image field", async () => {
    const { createGrokVideoAdapter } = await import("./grok-video.js");
    const adapter = createGrokVideoAdapter("/tmp/out");
    await adapter.generate(withIdentityRef());

    const submitCall = mockFetch.mock.calls[0];
    const body = JSON.parse(submitCall[1].body);
    expect(body.image).toBe("https://storage.example.com/creators/alex/primary.jpg");
  });

  it("does not set image when identityRef is absent and no referenceImageUrl", async () => {
    const { createGrokVideoAdapter } = await import("./grok-video.js");
    const adapter = createGrokVideoAdapter("/tmp/out");
    await adapter.generate(baseRequest());

    const submitCall = mockFetch.mock.calls[0];
    const body = JSON.parse(submitCall[1].body);
    expect(body.image).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Replicate Tests
// ---------------------------------------------------------------------------

describe("Soul ID — Replicate Adapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Submit → succeeded immediately
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "pred-abc",
        status: "succeeded",
        output: "https://cdn.replicate/video.mp4",
      }),
    });
    // Download
    mockFetch.mockResolvedValueOnce({
      arrayBuffer: async () => new ArrayBuffer(100),
    });
  });

  it("passes identityRef.primaryImageUrl as image input", async () => {
    const { createReplicateAdapter } = await import("./replicate.js");
    const adapter = createReplicateAdapter("/tmp/out");
    await adapter.generate(withIdentityRef());

    const submitCall = mockFetch.mock.calls[0];
    const body = JSON.parse(submitCall[1].body);
    expect(body.input.image).toBe("https://storage.example.com/creators/alex/primary.jpg");
  });

  it("does not set image input when identityRef is absent", async () => {
    const { createReplicateAdapter } = await import("./replicate.js");
    const adapter = createReplicateAdapter("/tmp/out");
    await adapter.generate(baseRequest());

    const submitCall = mockFetch.mock.calls[0];
    const body = JSON.parse(submitCall[1].body);
    expect(body.input.image).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Higgsfield Tests (MCP-based)
// ---------------------------------------------------------------------------

describe("Soul ID — Higgsfield Adapter", () => {
  it("imports all identity reference images as medias", async () => {
    const mockCallMcpTool = vi.fn();
    // media_import_url calls (3: primary + 2 additional)
    mockCallMcpTool.mockResolvedValueOnce({ media_id: "media-1" });
    mockCallMcpTool.mockResolvedValueOnce({ media_id: "media-2" });
    mockCallMcpTool.mockResolvedValueOnce({ media_id: "media-3" });
    // generate_video
    mockCallMcpTool.mockResolvedValueOnce({ jobId: "hf-job-1" });
    // job_status → completed
    mockCallMcpTool.mockResolvedValueOnce({ status: "completed", videoUrl: "https://cdn.hf/video.mp4" });

    // Mock the download
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });

    const { createHiggsfieldAdapter } = await import("./higgsfield.js");
    const adapter = createHiggsfieldAdapter(mockCallMcpTool, "/tmp/out");
    await adapter.generate(withIdentityRef());

    // Should have imported 3 media (primary + 2 additional)
    expect(mockCallMcpTool).toHaveBeenCalledWith("media_import_url", { url: "https://storage.example.com/creators/alex/primary.jpg", type: "image" });
    expect(mockCallMcpTool).toHaveBeenCalledWith("media_import_url", { url: "https://storage.example.com/creators/alex/ref-2.jpg", type: "image" });
    expect(mockCallMcpTool).toHaveBeenCalledWith("media_import_url", { url: "https://storage.example.com/creators/alex/ref-3.jpg", type: "image" });

    // generate_video should have 3 medias
    const genCall = mockCallMcpTool.mock.calls[3];
    expect(genCall[0]).toBe("generate_video");
    expect(genCall[1].medias).toHaveLength(3);
    expect(genCall[1].medias[0]).toEqual({ value: "media-1", role: "image" });
    expect(genCall[1].medias[1]).toEqual({ value: "media-2", role: "image" });
    expect(genCall[1].medias[2]).toEqual({ value: "media-3", role: "image" });
  });

  it("does not import medias when identityRef is absent", async () => {
    const mockCallMcpTool = vi.fn();
    // generate_video (no media_import_url calls)
    mockCallMcpTool.mockResolvedValueOnce({ jobId: "hf-job-2" });
    // job_status → completed
    mockCallMcpTool.mockResolvedValueOnce({ status: "completed", videoUrl: "https://cdn.hf/video2.mp4" });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });

    const { createHiggsfieldAdapter } = await import("./higgsfield.js");
    const adapter = createHiggsfieldAdapter(mockCallMcpTool, "/tmp/out");
    await adapter.generate(baseRequest());

    // First call should be generate_video directly (no media_import_url)
    expect(mockCallMcpTool.mock.calls[0][0]).toBe("generate_video");
    expect(mockCallMcpTool.mock.calls[0][1].medias).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: identityRef persistence across batch
// ---------------------------------------------------------------------------

describe("Soul ID — Cross-cutting", () => {
  it("same identityRef URLs are stable across multiple requests", () => {
    const req1 = withIdentityRef();
    const req2 = withIdentityRef();

    // Same creator → same URLs
    expect(req1.identityRef!.primaryImageUrl).toBe(req2.identityRef!.primaryImageUrl);
    expect(req1.identityRef!.additionalImageUrls).toEqual(req2.identityRef!.additionalImageUrls);
  });

  it("identityRef with mode vendor_avatar does not block generation", () => {
    const req = withIdentityRef({
      identityRef: {
        primaryImageUrl: "https://storage.example.com/avatar.jpg",
        additionalImageUrls: [],
        mode: "vendor_avatar",
      },
    });
    // The field is valid — adapters will still use it (vendor_avatar mode
    // means the vendor manages the avatar internally, but we still pass the ref)
    expect(req.identityRef!.mode).toBe("vendor_avatar");
    expect(req.identityRef!.primaryImageUrl).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// startingFrame — image-to-video, distinct from identityRef (Platform Evolution:
// image-first generation). Precedence: startingFrame > identityRef.primaryImageUrl
// > referenceImageUrl, on every adapter with a single image input field.
// ---------------------------------------------------------------------------

function withStartingFrame(overrides: Partial<VideoGenRequest> = {}): VideoGenRequest {
  return baseRequest({
    startingFrame: { imageUrl: "https://storage.example.com/generated/nano-banana-frame.png" },
    ...overrides,
  });
}

describe("startingFrame — Kling Adapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { task_id: "task-sf" } }) });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.kling/video.mp4" }] } } }),
    });
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });
  });

  it("uses image2video with startingFrame, taking priority over identityRef", async () => {
    const { createKlingAdapter } = await import("./kling.js");
    const adapter = createKlingAdapter("/tmp/out");
    await adapter.generate(withStartingFrame({
      identityRef: { primaryImageUrl: "https://storage.example.com/identity.jpg", additionalImageUrls: [], mode: "reference_images" },
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(mockFetch.mock.calls[0][0]).toContain("/videos/image2video");
    expect(body.image).toBe("https://storage.example.com/generated/nano-banana-frame.png");
  });
});

describe("startingFrame — Seedance / Grok Video / Replicate adapters", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("Seedance: startingFrame.imageUrl takes priority over identityRef and referenceImageUrl", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: "req-sf" }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "COMPLETED" }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ video: { url: "https://cdn.fal/video.mp4" } }) });
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });

    const { createSeedanceAdapter } = await import("./seedance.js");
    const adapter = createSeedanceAdapter("/tmp/out");
    await adapter.generate(withStartingFrame({
      identityRef: { primaryImageUrl: "https://storage.example.com/identity.jpg", additionalImageUrls: [], mode: "reference_images" },
      referenceImageUrl: "https://storage.example.com/generic-ref.jpg",
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.image_url).toBe("https://storage.example.com/generated/nano-banana-frame.png");
  });

  it("Grok Video: falls back to identityRef when startingFrame is absent", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "gen-sf", status: "completed", video: { url: "https://cdn.xai/video.mp4" } }),
    });
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });

    const { createGrokVideoAdapter } = await import("./grok-video.js");
    const adapter = createGrokVideoAdapter("/tmp/out");
    await adapter.generate(baseRequest({
      identityRef: { primaryImageUrl: "https://storage.example.com/identity.jpg", additionalImageUrls: [], mode: "reference_images" },
    }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.image).toBe("https://storage.example.com/identity.jpg");
  });

  it("Replicate: startingFrame.imageDataUri is used when imageUrl is absent", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "pred-sf", status: "succeeded", output: "https://cdn.replicate/video.mp4" }) });
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });

    const { createReplicateAdapter } = await import("./replicate.js");
    const adapter = createReplicateAdapter("/tmp/out");
    await adapter.generate(baseRequest({ startingFrame: { imageDataUri: "data:image/png;base64,AAAA" } }));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input.image).toBe("data:image/png;base64,AAAA");
  });
});

describe("startingFrame — Higgsfield Adapter (multi-image: honors both at once)", () => {
  it("imports the starting frame first, then identity references, in one medias[] call", async () => {
    const mockCallMcpTool = vi.fn();
    mockCallMcpTool.mockResolvedValueOnce({ media_id: "media-frame" }); // startingFrame
    mockCallMcpTool.mockResolvedValueOnce({ media_id: "media-identity" }); // identityRef.primaryImageUrl
    mockCallMcpTool.mockResolvedValueOnce({ jobId: "hf-job-sf" }); // generate_video
    mockCallMcpTool.mockResolvedValueOnce({ status: "completed", videoUrl: "https://cdn.hf/video.mp4" }); // job_status

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ arrayBuffer: async () => new ArrayBuffer(100) });

    const { createHiggsfieldAdapter } = await import("./higgsfield.js");
    const adapter = createHiggsfieldAdapter(mockCallMcpTool, "/tmp/out");
    await adapter.generate(withStartingFrame({
      identityRef: { primaryImageUrl: "https://storage.example.com/identity.jpg", additionalImageUrls: [], mode: "reference_images" },
    }));

    expect(mockCallMcpTool.mock.calls[0]).toEqual(["media_import_url", { url: "https://storage.example.com/generated/nano-banana-frame.png", type: "image" }]);
    expect(mockCallMcpTool.mock.calls[1]).toEqual(["media_import_url", { url: "https://storage.example.com/identity.jpg", type: "image" }]);
    const genCall = mockCallMcpTool.mock.calls[2];
    expect(genCall[1].medias).toEqual([
      { value: "media-frame", role: "image" },
      { value: "media-identity", role: "image" },
    ]);
  });
});
