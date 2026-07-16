import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTikTokPublishAdapter } from "./tiktok.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("createTikTokPublishAdapter", () => {
  let dir: string;
  let videoPath: string;

  beforeEach(() => {
    process.env.TIKTOK_ACCESS_TOKEN = "test-access-token";
    dir = mkdtempSync(join(tmpdir(), "tiktok-publish-"));
    videoPath = join(dir, "final.mp4");
    writeFileSync(videoPath, Buffer.from("fake mp4 bytes"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TIKTOK_ACCESS_TOKEN;
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts to /v2/post/publish/video/init/ with a Bearer token, FILE_UPLOAD source, and SELF_ONLY privacy", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/init/")) {
        capturedUrl = urlStr;
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse({
          data: { publish_id: "publish-123", upload_url: "https://upload.tiktok.com/session-abc" },
          error: { code: "ok", message: "" }
        });
      }
      // PUT to the upload_url
      return { ok: true, status: 201, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createTikTokPublishAdapter();
    const result = await adapter.publish({ videoPath, caption: "Check this out", hashtags: ["#fitness"] });

    expect(capturedUrl).toBe("https://open.tiktokapis.com/v2/post/publish/video/init/");
    expect(capturedHeaders?.Authorization).toBe("Bearer test-access-token");
    expect(capturedBody?.post_info).toMatchObject({ privacy_level: "SELF_ONLY", title: "Check this out #fitness" });
    expect(capturedBody?.source_info).toMatchObject({ source: "FILE_UPLOAD", total_chunk_count: 1 });

    expect(result).toEqual({ platform: "tiktok", postId: "publish-123" });
  });

  it("uploads the video bytes to the upload_url with a Content-Range header", async () => {
    let uploadHeaders: Record<string, string> | undefined;
    let uploadUrl: string | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("/init/")) {
          return jsonResponse({ data: { publish_id: "p1", upload_url: "https://upload.tiktok.com/x" }, error: { code: "ok", message: "" } });
        }
        uploadUrl = urlStr;
        uploadHeaders = init?.headers as Record<string, string>;
        return { ok: true, status: 201, text: async () => "" } as Response;
      })
    );

    const adapter = createTikTokPublishAdapter();
    await adapter.publish({ videoPath, caption: "x" });

    expect(uploadUrl).toBe("https://upload.tiktok.com/x");
    expect(uploadHeaders?.["Content-Type"]).toBe("video/mp4");
    expect(uploadHeaders?.["Content-Range"]).toMatch(/^bytes 0-\d+\/\d+$/);
  });

  it("throws a clear error when init returns a non-ok error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: {}, error: { code: "spam_risk_too_many_posts", message: "rate limited" } }))
    );
    const adapter = createTikTokPublishAdapter();
    await expect(adapter.publish({ videoPath, caption: "x" })).rejects.toThrow(/spam_risk_too_many_posts/);
  });

  it("throws a clear error when the init HTTP call itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "bad request" }, false, 400)));
    const adapter = createTikTokPublishAdapter();
    await expect(adapter.publish({ videoPath, caption: "x" })).rejects.toThrow(/publish init failed/);
  });
});
