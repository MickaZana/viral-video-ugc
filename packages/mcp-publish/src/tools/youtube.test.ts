import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createYouTubePublishAdapter } from "./youtube.js";

function initResponse(location: string | null, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
    text: async () => ""
  } as unknown as Response;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("createYouTubePublishAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeEach(() => {
    process.env.YOUTUBE_ACCESS_TOKEN = "yt-token";
    dir = mkdtempSync(join(tmpdir(), "yt-publish-"));
    videoPath = join(dir, "final.mp4");
    writeFileSync(videoPath, Buffer.from("fake mp4 bytes"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.YOUTUBE_ACCESS_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  it("initiates a resumable upload with metadata, then PUTs bytes to the Location header URL", async () => {
    let initUrl: string | undefined;
    let initHeaders: Record<string, string> | undefined;
    let initBody: Record<string, unknown> | undefined;
    let uploadUrl: string | undefined;
    let uploadHeaders: Record<string, string> | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("uploadType=resumable")) {
          initUrl = urlStr;
          initHeaders = init?.headers as Record<string, string>;
          initBody = JSON.parse(init?.body as string);
          return initResponse("https://upload.youtube.com/session/abc");
        }
        uploadUrl = urlStr;
        uploadHeaders = init?.headers as Record<string, string>;
        return jsonResponse({ id: "video-id-1" });
      })
    );

    const adapter = createYouTubePublishAdapter();
    const result = await adapter.publish({ videoPath, caption: "My Short Title", hashtags: ["#fitness"] });

    expect(initUrl).toContain("https://www.googleapis.com/upload/youtube/v3/videos");
    expect(initHeaders?.Authorization).toBe("Bearer yt-token");
    expect(initBody?.status).toEqual({ privacyStatus: "private" });
    expect((initBody?.snippet as { title: string }).title).toBe("My Short Title");

    expect(uploadUrl).toBe("https://upload.youtube.com/session/abc");
    expect(uploadHeaders?.["Content-Type"]).toBe("video/mp4");

    expect(result).toEqual({ platform: "youtube_shorts", postId: "video-id-1", url: "https://youtube.com/shorts/video-id-1" });
  });

  it("uses an explicitly supplied client OAuth token instead of the global token", async () => {
    let authorization: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (url.toString().includes("uploadType=resumable")) {
        authorization = (init?.headers as Record<string, string>).Authorization;
        return initResponse("https://upload.youtube.com/session/client");
      }
      return jsonResponse({ id: "client-video" });
    }));

    await createYouTubePublishAdapter({ accessToken: "client-token" }).publish({ videoPath, caption: "Client video" });
    expect(authorization).toBe("Bearer client-token");
  });

  it("truncates the title to YouTube's 100-character limit", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url.toString().includes("uploadType=resumable")) {
          capturedBody = JSON.parse(init?.body as string);
          return initResponse("https://upload.youtube.com/x");
        }
        return jsonResponse({ id: "v1" });
      })
    );

    const longTitle = "x".repeat(150);
    const adapter = createYouTubePublishAdapter();
    await adapter.publish({ videoPath, caption: longTitle });

    expect((capturedBody?.snippet as { title: string }).title.length).toBe(100);
  });

  it("throws a clear error when the init response has no Location header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => initResponse(null)));
    const adapter = createYouTubePublishAdapter();
    await expect(adapter.publish({ videoPath, caption: "x" })).rejects.toThrow(/no Location header/);
  });

  it("throws a clear error when the init HTTP call itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => initResponse(null, false, 401)));
    const adapter = createYouTubePublishAdapter();
    await expect(adapter.publish({ videoPath, caption: "x" })).rejects.toThrow(/resumable upload init failed/);
  });
});
