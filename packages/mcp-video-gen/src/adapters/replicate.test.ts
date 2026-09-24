import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplicateAdapter } from "./replicate.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-replicate`;

describe("createReplicateAdapter", () => {
  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_MODEL;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("submits to the official-model shortcut endpoint with a Bearer token and the input fields", async () => {
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

    const adapter = createReplicateAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "a hook", durationSec: 5, aspectRatio: "9:16" });

    expect(capturedUrl).toBe("https://api.replicate.com/v1/models/minimax/video-01/predictions");
    expect(capturedAuth).toBe("Bearer test-token");
    expect(capturedBody).toEqual({ input: { prompt: "a hook", aspect_ratio: "9:16", duration: 5 } });
    expect(clip.id).toBe("pred-1");
    expect(clip.vendor).toBe("replicate");
  });

  it("uses REPLICATE_MODEL to override the default model slug", async () => {
    process.env.REPLICATE_MODEL = "luma/ray-3.2";
    let capturedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/predictions")) {
        capturedUrl = urlStr;
        return jsonResponse({ id: "pred-luma", status: "succeeded", output: "https://example.com/v.mp4" });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createReplicateAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "1:1" });

    expect(capturedUrl).toBe("https://api.replicate.com/v1/models/luma/ray-3.2/predictions");
  });

  it("polls until succeeded when the prediction isn't done inline", async () => {
    vi.useFakeTimers();
    try {
      let pollCount = 0;
      const fetchMock = vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.endsWith("/predictions")) {
          return jsonResponse({ id: "pred-poll", status: "starting" });
        }
        if (urlStr.includes("/predictions/pred-poll")) {
          pollCount++;
          if (pollCount < 2) return jsonResponse({ id: "pred-poll", status: "processing" });
          return jsonResponse({ id: "pred-poll", status: "succeeded", output: ["https://example.com/out.mp4"] });
        }
        return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = createReplicateAdapter(outDir);
      const clipPromise = adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });
      await vi.advanceTimersByTimeAsync(3000); // Replicate poll opts: initialDelayMs 3s

      const clip = await clipPromise;
      expect(pollCount).toBeGreaterThanOrEqual(2);
      expect(clip.id).toBe("pred-poll");
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a poll timeout: requests cancellation and throws a distinct 'did not finish' error", async () => {
    vi.useFakeTimers();
    try {
      let cancelUrl: string | undefined;
      let cancelMethod: string | undefined;
      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.endsWith("/predictions") && init?.method === "POST") {
          return jsonResponse({ id: "pred-timeout", status: "starting" });
        }
        if (urlStr.endsWith("/predictions/pred-timeout/cancel")) {
          cancelUrl = urlStr;
          cancelMethod = init?.method;
          return jsonResponse({ id: "pred-timeout", status: "canceled" });
        }
        if (urlStr.includes("/predictions/pred-timeout")) {
          return jsonResponse({ id: "pred-timeout", status: "processing" }); // never finishes
        }
        return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = createReplicateAdapter(outDir);
      const promise = adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });
      const rejection = expect(promise).rejects.toThrow(
        /did not finish within \d+s \(last status: processing\); cancellation requested/
      );

      // Default Replicate poll deadline is 8 min — drive it entirely with fake time.
      await vi.advanceTimersByTimeAsync(8 * 60_000 + 5000);
      await rejection;

      expect(cancelMethod).toBe("POST");
      expect(cancelUrl).toBe("https://api.replicate.com/v1/predictions/pred-timeout/cancel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timeout error survives a failing cancel request (cancel failure is not swallowed)", async () => {
    vi.useFakeTimers();
    try {
      let cancelAttempted = false;
      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.endsWith("/predictions") && init?.method === "POST") {
          return jsonResponse({ id: "pred-nocancel", status: "starting" });
        }
        if (urlStr.endsWith("/predictions/pred-nocancel/cancel")) {
          cancelAttempted = true;
          throw new Error("network down");
        }
        if (urlStr.includes("/predictions/pred-nocancel")) {
          return jsonResponse({ id: "pred-nocancel", status: "processing" });
        }
        return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = createReplicateAdapter(outDir);
      const promise = adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });
      const rejection = expect(promise).rejects.toThrow(/did not finish within \d+s \(last status: processing\)/);

      await vi.advanceTimersByTimeAsync(8 * 60_000 + 5000);
      await rejection;

      expect(cancelAttempted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws immediately when the prediction status is canceled, without retrying", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().endsWith("/predictions")) return jsonResponse({ id: "pred-canc", status: "starting" });
      return jsonResponse({ id: "pred-canc", status: "canceled", error: "user canceled" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createReplicateAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/pred-canc canceled/);
  });

  it("extracts a video URL from an object output shape ({video: url} or {url})", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().endsWith("/predictions")) {
        return jsonResponse({ id: "pred-obj", status: "succeeded", output: { video: "https://example.com/obj.mp4" } });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createReplicateAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });
    expect(clip.id).toBe("pred-obj");
  });

  it("throws immediately when the prediction status is failed, without retrying", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (url.toString().endsWith("/predictions")) return jsonResponse({ id: "pred-fail", status: "starting" });
      return jsonResponse({ id: "pred-fail", status: "failed", error: "NSFW content detected" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createReplicateAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/pred-fail failed/);
  });

  it("throws a clear error when the submit call responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "model not found" }, false)));
    const adapter = createReplicateAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/prediction submit failed/);
  });

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

    const adapter = createReplicateAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 0,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "9:16",
      referenceImageUrl: "https://example.com/ref.jpg"
    });

    expect((capturedBody!.input as Record<string, unknown>).image).toBe("https://example.com/ref.jpg");
  });
});
