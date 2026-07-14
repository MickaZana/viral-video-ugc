import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPikaAdapter } from "./pika.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-pika`;

describe("createPikaAdapter", () => {
  beforeEach(() => {
    process.env.FAL_KEY = "test-fal-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FAL_KEY;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("uses the fal.ai queue API (Authorization: Key <fal-key>), not a standalone Pika endpoint", async () => {
    let submitUrl: string | undefined;
    let submitAuth: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (init?.method === "POST") {
        submitUrl = urlStr;
        submitAuth = (init.headers as Record<string, string>).Authorization;
        return jsonResponse({ request_id: "req-1" });
      }
      if (urlStr.endsWith("/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      if (urlStr.includes("/requests/req-1")) {
        return jsonResponse({ video: { url: "https://example.com/pika.mp4" } });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createPikaAdapter(outDir);
    const clip = await adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" });

    expect(submitUrl).toBe("https://queue.fal.run/pika/v2.2/text-to-video");
    expect(submitAuth).toBe("Key test-fal-key");
    expect(clip.vendor).toBe("pika");
    expect(clip.id).toBe("req-1");
  });

  it("requires FAL_KEY, not a Pika-specific key", async () => {
    delete process.env.FAL_KEY;
    const adapter = createPikaAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" })
    ).rejects.toThrow(/FAL_KEY/);
  });

  it("throws when the request completes without a video URL", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ request_id: "req-empty" });
      if (url.toString().endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
      return jsonResponse({}); // no `video` field
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createPikaAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "hi", durationSec: 5, aspectRatio: "9:16" })
    ).rejects.toThrow(/without a video URL/);
  });
});
