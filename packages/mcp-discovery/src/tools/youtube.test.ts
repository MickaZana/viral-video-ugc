import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverYouTube } from "./youtube.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("discoverYouTube", () => {
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.YOUTUBE_API_KEY;
  });

  it("throws a clear error when YOUTUBE_API_KEY is missing", async () => {
    delete process.env.YOUTUBE_API_KEY;
    await expect(discoverYouTube("fitness", 5)).rejects.toThrow(/YOUTUBE_API_KEY/);
  });

  it("makes a search.list call then a videos.list call, mapping fields correctly", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/search")) {
        expect(urlStr).toContain("q=fitness");
        return jsonResponse({
          items: [
            { id: { videoId: "abc123" }, snippet: { title: "Viral fitness clip", publishedAt: "2026-01-01T00:00:00Z" } }
          ]
        });
      }
      if (urlStr.includes("/videos")) {
        expect(urlStr).toContain("id=abc123");
        return jsonResponse({
          items: [{ id: "abc123", statistics: { viewCount: "50000", likeCount: "1200", commentCount: "80" } }]
        });
      }
      throw new Error(`unexpected fetch to ${urlStr}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await discoverYouTube("fitness", 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "abc123",
      platform: "youtube_shorts",
      url: "https://www.youtube.com/watch?v=abc123",
      title: "Viral fitness clip",
      niche: "fitness",
      metrics: { views: 50000, likes: 1200, comments: 80 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array without calling videos.list when search finds nothing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await discoverYouTube("obscure-niche", 5);

    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws with the response body when search.list returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "quota exceeded" }, false)));
    await expect(discoverYouTube("fitness", 5)).rejects.toThrow(/search\.list failed/);
  });

  it("defaults missing statistics fields to 0 rather than throwing", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("/search")) {
        return jsonResponse({
          items: [{ id: { videoId: "no-stats" }, snippet: { title: "t", publishedAt: "2026-01-01T00:00:00Z" } }]
        });
      }
      // videos.list returns no matching stats entry for this id
      return jsonResponse({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await discoverYouTube("fitness", 5);
    expect(results[0].metrics).toEqual({ views: 0, likes: 0, comments: 0 });
  });
});
