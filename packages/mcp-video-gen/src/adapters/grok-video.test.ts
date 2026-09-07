import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoGenRequest } from "./VideoGenAdapter.js";
import { createGrokVideoAdapter } from "./grok-video.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const outDir = `${process.cwd()}/.test-out-grok-video`;
const SUBMIT_URL = "https://api.x.ai/v1/video/generations";

const baseReq: VideoGenRequest = {
  scriptSegmentIndex: 0,
  prompt: "a cat surfing a wave",
  durationSec: 5,
  aspectRatio: "9:16",
};

describe("createGrokVideoAdapter — xAI Grok Imagine Video", () => {
  beforeEach(() => {
    process.env.XAI_API_KEY = "test-xai-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.XAI_API_KEY;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("fast-fails on a 404 from submit with an actionable diagnostic — one round-trip, no status poll", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(
        { error: { code: 404, message: "The requested resource was not found." } },
        404
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokVideoAdapter(outDir);
    const err = await adapter.generate(baseReq).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("grok_video is not available");
    expect(message).toContain("404");
    expect(message).toContain(SUBMIT_URL);

    // Exactly one fetch — the submit — and never the status-poll endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(SUBMIT_URL);
    for (const call of fetchMock.mock.calls) {
      expect(call[0].toString().startsWith(`${SUBMIT_URL}/`)).toBe(false);
    }
  });

  it("keeps the existing 'Grok Video submit failed: <status>' path for a non-404 failure (401)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokVideoAdapter(outDir);
    await expect(adapter.generate(baseReq)).rejects.toThrow(/Grok Video submit failed: 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("happy path: an immediately-completed submit downloads and returns a grok_video RawClip", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          id: "gen-1",
          status: "completed",
          video: { url: "https://cdn.x.ai/gen-1.mp4" },
        });
      }
      return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokVideoAdapter(outDir);
    const clip = await adapter.generate(baseReq);

    expect(clip.vendor).toBe("grok_video");
    expect(clip.id).toBe("gen-1");
    expect(clip.scriptSegmentIndex).toBe(0);
    expect(clip.durationSec).toBe(5);
    expect(existsSync(clip.filePath)).toBe(true);
  });

  it("polls to completion via pollWithBackoff when submit returns status: processing", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ id: "gen-2", status: "processing" });
      }
      if (url.toString() === `${SUBMIT_URL}/gen-2`) {
        statusCalls += 1;
        return statusCalls === 1
          ? jsonResponse({ id: "gen-2", status: "processing" })
          : jsonResponse({
              id: "gen-2",
              status: "completed",
              video: { url: "https://cdn.x.ai/gen-2.mp4" },
            });
      }
      return { arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGrokVideoAdapter(outDir);
    const promise = adapter.generate(baseReq);
    await vi.runAllTimersAsync();
    const clip = await promise;

    expect(clip.id).toBe("gen-2");
    expect(clip.vendor).toBe("grok_video");
    expect(statusCalls).toBe(2);
  });
});
