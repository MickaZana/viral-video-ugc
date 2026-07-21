import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFacebookPagePublishAdapter, createInstagramReelsPublishAdapter } from "./meta.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("createFacebookPagePublishAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeEach(() => {
    process.env.META_PAGE_ACCESS_TOKEN = "page-token";
    process.env.META_USER_ACCESS_TOKEN = "user-token";
    process.env.META_APP_ID = "app-123";
    process.env.META_PAGE_ID = "page-456";
    dir = mkdtempSync(join(tmpdir(), "fb-publish-"));
    videoPath = join(dir, "final.mp4");
    writeFileSync(videoPath, Buffer.from("fake mp4 bytes"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.META_USER_ACCESS_TOKEN;
    delete process.env.META_APP_ID;
    delete process.env.META_PAGE_ID;
    rmSync(dir, { recursive: true, force: true });
  });

  it("walks the three-step resumable upload flow: init session, upload bytes, publish", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        calls.push({ url: urlStr, init });

        if (urlStr === "https://graph.facebook.com/v25.0/app-123/uploads") {
          return jsonResponse({ id: "upload:session-1" });
        }
        if (urlStr === "https://graph.facebook.com/v25.0/upload:session-1") {
          return jsonResponse({ h: "file-handle-xyz" });
        }
        if (urlStr === "https://graph-video.facebook.com/v25.0/page-456/videos") {
          return jsonResponse({ id: "video-789" });
        }
        throw new Error(`unexpected URL: ${urlStr}`);
      })
    );

    const adapter = createFacebookPagePublishAdapter();
    const result = await adapter.publish({ videoPath, caption: "Check this out" });

    expect(calls).toHaveLength(3);
    expect(result).toEqual({ platform: "facebook", postId: "video-789", url: "https://facebook.com/video-789" });
  });

  it("uses the OAuth auth scheme (not Bearer) and a file_offset header for the byte-upload step", async () => {
    let uploadInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("/uploads")) return jsonResponse({ id: "upload:s1" });
        if (urlStr.includes("upload:s1")) {
          uploadInit = init;
          return jsonResponse({ h: "handle" });
        }
        return jsonResponse({ id: "v1" });
      })
    );

    const adapter = createFacebookPagePublishAdapter();
    await adapter.publish({ videoPath, caption: "x" });

    const headers = uploadInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("OAuth user-token");
    expect(headers.file_offset).toBe("0");
  });

  it("throws a clear error when the upload session can't be created", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad app id" }, false, 400)));
    const adapter = createFacebookPagePublishAdapter();
    await expect(adapter.publish({ videoPath, caption: "x" })).rejects.toThrow(/upload session init failed/);
  });
});

describe("createInstagramReelsPublishAdapter", () => {
  beforeEach(() => {
    process.env.META_PAGE_ACCESS_TOKEN = "page-token";
    process.env.META_IG_BUSINESS_ACCOUNT_ID = "ig-user-1";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
  });

  it("throws without waiting on the network when publicVideoUrl is missing", async () => {
    const adapter = createInstagramReelsPublishAdapter();
    await expect(adapter.publish({ videoPath: "/tmp/x.mp4", caption: "x" })).rejects.toThrow(/publicVideoUrl/);
  });

  it("creates a media container, polls until FINISHED, then publishes it", async () => {
    const calls: string[] = [];
    let statusCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        calls.push(urlStr);
        if (urlStr === "https://graph.facebook.com/v25.0/ig-user-1/media") {
          return jsonResponse({ id: "container-1" });
        }
        if (urlStr.startsWith("https://graph.facebook.com/v25.0/container-1?")) {
          statusCallCount++;
          return jsonResponse({ status_code: statusCallCount < 2 ? "IN_PROGRESS" : "FINISHED" });
        }
        if (urlStr === "https://graph.facebook.com/v25.0/ig-user-1/media_publish") {
          return jsonResponse({ id: "media-99" });
        }
        throw new Error(`unexpected URL: ${urlStr}`);
      })
    );

    const adapter = createInstagramReelsPublishAdapter();
    const publishPromise = adapter.publish({
      videoPath: "/tmp/x.mp4",
      caption: "hello",
      publicVideoUrl: "https://dashboard.example.com/public/assets/tok"
    });
    const [result] = await Promise.all([publishPromise, vi.runAllTimersAsync()]);

    expect(result).toEqual({
      platform: "instagram_reels",
      postId: "media-99",
      url: "https://www.instagram.com/reel/media-99/"
    });
    expect(statusCallCount).toBe(2);
    expect(calls[0]).toBe("https://graph.facebook.com/v25.0/ig-user-1/media");
    expect(calls.at(-1)).toBe("https://graph.facebook.com/v25.0/ig-user-1/media_publish");
  });

  it("throws when the container's video fetch fails processing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.endsWith("/media")) return jsonResponse({ id: "container-1" });
        return jsonResponse({ status_code: "ERROR" });
      })
    );
    const adapter = createInstagramReelsPublishAdapter();
    const publishPromise = adapter.publish({
      videoPath: "/tmp/x.mp4",
      caption: "hello",
      publicVideoUrl: "https://dashboard.example.com/public/assets/tok"
    });
    await Promise.all([expect(publishPromise).rejects.toThrow(/failed processing/), vi.runAllTimersAsync()]);
  });
});
