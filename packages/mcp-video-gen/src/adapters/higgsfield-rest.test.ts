import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHiggsfieldRestAdapter } from "./higgsfield-rest.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-higgsfield-rest`;

describe("createHiggsfieldRestAdapter", () => {
  beforeEach(() => {
    process.env.HIGGSFIELD_ACCESS_KEY = "test-access-key";
    process.env.HIGGSFIELD_SECRET_KEY = "test-secret-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HIGGSFIELD_ACCESS_KEY;
    delete process.env.HIGGSFIELD_SECRET_KEY;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("sends the documented `Key {access}:{secret}` auth header, not a bearer token", async () => {
    let capturedAuth: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("higgsfield-ai/dop/standard")) {
        capturedAuth = (init!.headers as Record<string, string>).Authorization;
        capturedBody = JSON.parse(init!.body as string);
        return jsonResponse({ request_id: "req-1", status_url: "https://platform.higgsfield.ai/requests/req-1/status" });
      }
      if (urlStr.includes("/requests/req-1/status")) {
        return jsonResponse({ status: "completed", video: { url: "https://example.com/v.mp4" } });
      }
      return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHiggsfieldRestAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "a hook", durationSec: 5, aspectRatio: "9:16" });

    expect(capturedAuth).toBe("Key test-access-key:test-secret-key");
    expect(capturedBody).toEqual({ prompt: "a hook", duration: 5 });
    expect(clip.id).toBe("req-1");
    expect(clip.vendor).toBe("higgsfield");
    expect(clip.filePath).toContain("req-1");
  });

  it("includes image_url in the request body only when a reference image is provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("higgsfield-ai/dop/standard")) {
        capturedBody = JSON.parse(init!.body as string);
        return jsonResponse({ request_id: "req-img", status: "completed", video: { url: "https://example.com/v.mp4" } });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHiggsfieldRestAdapter(outDir);
    await adapter.generate({
      scriptSegmentIndex: 1,
      prompt: "x",
      durationSec: 3,
      aspectRatio: "1:1",
      referenceImageUrl: "https://example.com/ref.jpg"
    });

    expect(capturedBody).toEqual({ prompt: "x", duration: 3, image_url: "https://example.com/ref.jpg" });
  });

  it("returns immediately without polling when the submit response is already completed", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("higgsfield-ai/dop/standard")) {
        return jsonResponse({ request_id: "req-fast", status: "completed", video: { url: "https://example.com/fast.mp4" } });
      }
      if (urlStr === "https://example.com/fast.mp4") {
        return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
      }
      throw new Error(`unexpected fetch to ${urlStr}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHiggsfieldRestAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });

    expect(clip.id).toBe("req-fast");
    // Only the submit call and the download — no separate status-poll fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws immediately when the request status is failed, without retrying", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("higgsfield-ai/dop/standard")) {
        return jsonResponse({ request_id: "req-fail", status_url: "https://platform.higgsfield.ai/requests/req-fail/status" });
      }
      return jsonResponse({ status: "failed", error: "content policy" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHiggsfieldRestAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/req-fail failed: content policy/);
  });

  it("throws immediately on an nsfw status", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("higgsfield-ai/dop/standard")) {
        return jsonResponse({ request_id: "req-nsfw", status_url: "https://platform.higgsfield.ai/requests/req-nsfw/status" });
      }
      return jsonResponse({ status: "nsfw" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHiggsfieldRestAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/req-nsfw nsfw/);
  });

  it("throws a clear error when submit responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad request" }, false)));
    const adapter = createHiggsfieldRestAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" })
    ).rejects.toThrow(/generation submit failed/);
  });

  it("falls back to the {base}/requests/{id}/status path when the submit response has no status_url", async () => {
    let statusUrlCalled: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("higgsfield-ai/dop/standard")) {
        return jsonResponse({ request_id: "req-nostatusurl" });
      }
      if (urlStr === "https://example.com/v.mp4") {
        return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
      }
      statusUrlCalled = urlStr;
      return jsonResponse({ status: "completed", video: { url: "https://example.com/v.mp4" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHiggsfieldRestAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 3, aspectRatio: "9:16" });

    expect(statusUrlCalled).toBe("https://platform.higgsfield.ai/requests/req-nostatusurl/status");
  });
});
