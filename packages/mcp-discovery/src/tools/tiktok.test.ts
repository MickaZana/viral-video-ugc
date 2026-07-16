import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTikTok } from "./tiktok.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("discoverTikTok", () => {
  beforeEach(() => {
    process.env.TIKTOK_CLIENT_KEY = "test-client-key";
    process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  });

  it("throws a clear error when TIKTOK_CLIENT_KEY is missing", async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    await expect(discoverTikTok("fitness", 5)).rejects.toThrow(/TIKTOK_CLIENT_KEY/);
  });

  it("throws a clear error when TIKTOK_CLIENT_SECRET is missing", async () => {
    delete process.env.TIKTOK_CLIENT_SECRET;
    await expect(discoverTikTok("fitness", 5)).rejects.toThrow(/TIKTOK_CLIENT_SECRET/);
  });

  it("exchanges client_key/client_secret for a Bearer token, then queries videos with it", async () => {
    let capturedTokenBody: string | undefined;
    let capturedAuth: string | undefined;
    let capturedQueryBody: any;

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/oauth/token/")) {
        // fetchWithRetry passes a URLSearchParams object through as-is (real fetch
        // serializes it); stringify here since our mock never sees real fetch's
        // own serialization step.
        capturedTokenBody = String(init?.body);
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
        return jsonResponse({ access_token: "test-access-token", expires_in: 7200, token_type: "Bearer" });
      }
      if (urlStr.includes("/research/video/query/")) {
        capturedAuth = (init?.headers as Record<string, string>).Authorization;
        capturedQueryBody = JSON.parse(init?.body as string);
        return jsonResponse({
          data: {
            videos: [
              {
                id: "7123456789",
                create_time: 1704067200,
                username: "fitnessguru",
                video_description: "Viral fitness clip",
                view_count: 500000,
                like_count: 40000,
                comment_count: 900,
                share_count: 1200
              }
            ],
            cursor: 1,
            has_more: false,
            search_id: "search-1"
          },
          error: { code: "ok", message: "", log_id: "log-1" }
        });
      }
      throw new Error(`unexpected fetch to ${urlStr}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await discoverTikTok("fitness", 5);

    expect(capturedTokenBody).toContain("client_key=test-client-key");
    expect(capturedTokenBody).toContain("client_secret=test-client-secret");
    expect(capturedTokenBody).toContain("grant_type=client_credentials");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedQueryBody.query.and[0]).toEqual({ operation: "EQ", field_name: "keyword", field_values: ["fitness"] });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "7123456789",
      platform: "tiktok",
      url: "https://www.tiktok.com/@fitnessguru/video/7123456789",
      title: "Viral fitness clip",
      niche: "fitness",
      metrics: { views: 500000, likes: 40000, comments: 900, shares: 1200 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("constructs the video URL from username + id (the API returns no direct URL field)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (url.toString().includes("/oauth/token/")) {
          return jsonResponse({ access_token: "tok", expires_in: 7200, token_type: "Bearer" });
        }
        return jsonResponse({
          data: {
            videos: [
              {
                id: "999",
                create_time: 1704067200,
                username: "someone",
                video_description: "x",
                view_count: 1,
                like_count: 1,
                comment_count: 1,
                share_count: 1
              }
            ],
            cursor: 0,
            has_more: false,
            search_id: "s"
          },
          error: { code: "ok", message: "", log_id: "l" }
        });
      })
    );
    const results = await discoverTikTok("x", 1);
    expect(results[0].url).toBe("https://www.tiktok.com/@someone/video/999");
  });

  it("throws when the OAuth token request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_client" }, false)));
    await expect(discoverTikTok("fitness", 5)).rejects.toThrow(/OAuth token request failed/);
  });

  it("throws when the query request returns a non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (url.toString().includes("/oauth/token/")) {
          return jsonResponse({ access_token: "tok", expires_in: 7200, token_type: "Bearer" });
        }
        return jsonResponse({ error: "forbidden" }, false);
      })
    );
    await expect(discoverTikTok("fitness", 5)).rejects.toThrow(/Research API query failed/);
  });

  it("throws when the API returns 200 with a non-ok error code in the body (TikTok's error shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (url.toString().includes("/oauth/token/")) {
          return jsonResponse({ access_token: "tok", expires_in: 7200, token_type: "Bearer" });
        }
        return jsonResponse({
          data: { videos: [], cursor: 0, has_more: false, search_id: "" },
          error: { code: "rate_limit_exceeded", message: "Too many requests", log_id: "abc" }
        });
      })
    );
    await expect(discoverTikTok("fitness", 5)).rejects.toThrow(/rate_limit_exceeded/);
  });

  it("caps max_count to the API's documented maximum of 100", async () => {
    let capturedQueryBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url.toString().includes("/oauth/token/")) {
          return jsonResponse({ access_token: "tok", expires_in: 7200, token_type: "Bearer" });
        }
        capturedQueryBody = JSON.parse(init?.body as string);
        return jsonResponse({ data: { videos: [], cursor: 0, has_more: false, search_id: "" }, error: { code: "ok", message: "", log_id: "" } });
      })
    );
    await discoverTikTok("fitness", 500);
    expect(capturedQueryBody.max_count).toBe(100);
  });
});
