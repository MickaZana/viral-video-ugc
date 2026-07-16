import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverMeta } from "./meta.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("discoverMeta — instagram_reels (real ig_hashtag_search + top_media flow)", () => {
  beforeEach(() => {
    process.env.META_ACCESS_TOKEN = "test-token";
    process.env.META_IG_BUSINESS_ACCOUNT_ID = "test-business-id";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
  });

  it("throws a clear error when META_ACCESS_TOKEN is missing", async () => {
    delete process.env.META_ACCESS_TOKEN;
    await expect(discoverMeta("fitness", 5, "instagram_reels")).rejects.toThrow(/META_ACCESS_TOKEN/);
  });

  it("throws a clear error when META_IG_BUSINESS_ACCOUNT_ID is missing (a token alone is not enough)", async () => {
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
    await expect(discoverMeta("fitness", 5, "instagram_reels")).rejects.toThrow(/META_IG_BUSINESS_ACCOUNT_ID/);
  });

  it("calls ig_hashtag_search then {hashtag-id}/top_media, mapping video media into candidates", async () => {
    let searchUrl: URL | undefined;
    let mediaUrl: URL | undefined;

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(url.toString());
      if (u.pathname.endsWith("/ig_hashtag_search")) {
        searchUrl = u;
        return jsonResponse({ data: [{ id: "hashtag-123" }] });
      }
      if (u.pathname.endsWith("/top_media")) {
        mediaUrl = u;
        return jsonResponse({
          data: [
            {
              id: "media-1",
              caption: "Viral fitness reel",
              comments_count: 50,
              like_count: 3000,
              media_type: "VIDEO",
              permalink: "https://www.instagram.com/reel/media-1/",
              timestamp: "2026-01-01T00:00:00+0000"
            },
            {
              id: "media-2",
              caption: "A photo, not a video",
              comments_count: 5,
              like_count: 10,
              media_type: "IMAGE",
              permalink: "https://www.instagram.com/p/media-2/",
              timestamp: "2026-01-01T00:00:00+0000"
            }
          ]
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await discoverMeta("fitness", 5, "instagram_reels");

    expect(searchUrl?.searchParams.get("user_id")).toBe("test-business-id");
    expect(searchUrl?.searchParams.get("q")).toBe("fitness");
    expect(searchUrl?.searchParams.get("access_token")).toBe("test-token");
    expect(mediaUrl?.pathname).toContain("hashtag-123");
    expect(mediaUrl?.searchParams.get("user_id")).toBe("test-business-id");

    // Only the VIDEO item should survive — IMAGE items are filtered out.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "media-1",
      platform: "instagram_reels",
      url: "https://www.instagram.com/reel/media-1/",
      title: "Viral fitness reel",
      niche: "fitness",
      metrics: { likes: 3000, comments: 50 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lowercases and strips whitespace from the niche when building the hashtag query", async () => {
    let capturedQuery: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/ig_hashtag_search")) {
          capturedQuery = u.searchParams.get("q");
          return jsonResponse({ data: [] });
        }
        throw new Error("should not reach top_media when hashtag search finds nothing");
      })
    );
    await discoverMeta("Personal Finance", 5, "instagram_reels");
    expect(capturedQuery).toBe("personalfinance");
  });

  it("returns an empty array without calling top_media when the hashtag doesn't exist", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await discoverMeta("some-obscure-niche", 5, "instagram_reels");

    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws with the response body when ig_hashtag_search returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid token" }, false)));
    await expect(discoverMeta("fitness", 5, "instagram_reels")).rejects.toThrow(/ig_hashtag_search failed/);
  });

  it("throws with the response body when top_media returns a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = new URL(url.toString());
        if (u.pathname.endsWith("/ig_hashtag_search")) return jsonResponse({ data: [{ id: "h1" }] });
        return jsonResponse({ error: "rate limited" }, false);
      })
    );
    await expect(discoverMeta("fitness", 5, "instagram_reels")).rejects.toThrow(/top_media failed/);
  });
});

describe("discoverMeta — facebook", () => {
  beforeEach(() => {
    process.env.META_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.META_ACCESS_TOKEN;
  });

  it("throws a clear, specific error explaining the Page ID gap rather than attempting a hashtag search", async () => {
    await expect(discoverMeta("fitness", 5, "facebook")).rejects.toThrow(/tracked Page ID/);
  });

  it("still requires META_ACCESS_TOKEN before explaining the Page ID gap", async () => {
    delete process.env.META_ACCESS_TOKEN;
    await expect(discoverMeta("fitness", 5, "facebook")).rejects.toThrow(/META_ACCESS_TOKEN/);
  });
});
