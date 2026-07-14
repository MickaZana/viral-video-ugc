import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunwayAdapter } from "./runway.js";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const outDir = `${process.cwd()}/.test-out-runway`;

describe("createRunwayAdapter", () => {
  beforeEach(() => {
    process.env.RUNWAY_API_KEY = "test-runway-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RUNWAY_API_KEY;
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("sends the required X-Runway-Version header and promptText field", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/v1/text_to_video")) {
        capturedInit = init;
        return jsonResponse({ id: "task-rw" });
      }
      if (urlStr.includes("/v1/tasks/task-rw")) {
        return jsonResponse({ id: "task-rw", status: "completed", output: ["https://example.com/out.mp4"] });
      }
      return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createRunwayAdapter(outDir);
    await adapter.generate({ scriptSegmentIndex: 0, prompt: "hello", durationSec: 4, aspectRatio: "9:16" });

    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["X-Runway-Version"]).toBeTruthy();
    expect(headers.Authorization).toBe("Bearer test-runway-key");
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.promptText).toBe("hello");
  });

  it("polls the /v1/tasks/{id} endpoint and reads status from the confirmed queued/generating/completed/error vocabulary", async () => {
    vi.useFakeTimers();
    try {
      let pollCount = 0;
      const fetchMock = vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.endsWith("/v1/text_to_video")) return jsonResponse({ id: "task-poll" });
        if (urlStr.includes("/v1/tasks/task-poll")) {
          pollCount++;
          if (pollCount < 2) return jsonResponse({ id: "task-poll", status: "generating" });
          return jsonResponse({ id: "task-poll", status: "completed", output: ["https://example.com/done.mp4"] });
        }
        return { arrayBuffer: async () => new ArrayBuffer(4) } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const adapter = createRunwayAdapter(outDir);
      const clipPromise = adapter.generate({ scriptSegmentIndex: 1, prompt: "x", durationSec: 4, aspectRatio: "16:9" });
      await vi.advanceTimersByTimeAsync(2000); // pollWithBackoff's default initial delay

      const clip = await clipPromise;
      expect(clip.id).toBe("task-poll");
      expect(pollCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws with the failure reason when status is error", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/v1/text_to_video")) return jsonResponse({ id: "task-err" });
      return jsonResponse({ id: "task-err", status: "error", failure: "content policy violation" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createRunwayAdapter(outDir);
    await expect(
      adapter.generate({ scriptSegmentIndex: 0, prompt: "x", durationSec: 4, aspectRatio: "9:16" })
    ).rejects.toThrow(/content policy violation/);
  });
});
