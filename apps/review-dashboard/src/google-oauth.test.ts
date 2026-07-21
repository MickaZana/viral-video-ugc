import { describe, expect, it, vi } from "vitest";
import {
  createGoogleOAuthState,
  exchangeGoogleAuthorizationCode,
  fetchGoogleYouTubeChannel,
  googleAuthorizationUrl,
  refreshGoogleAccessToken,
  verifyGoogleOAuthState
} from "./google-oauth.js";

describe("Google OAuth", () => {
  const secret = "oauth-state-secret-at-least-32-characters";

  it("creates a signed, scoped, expiring state and rejects tampering", () => {
    const created = createGoogleOAuthState("org-1", "client-1", secret);
    expect(verifyGoogleOAuthState(created.state, secret)).toMatchObject({ orgId: "org-1", clientId: "client-1" });
    expect(verifyGoogleOAuthState(`${created.state}x`, secret)).toBeUndefined();
  });

  it("builds the Google authorization URL with offline YouTube scopes", () => {
    const url = new URL(googleAuthorizationUrl({ clientId: "google-client", redirectUri: "https://app.example.com/oauth/google/callback", state: "signed" }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("youtube.upload");
    expect(url.searchParams.get("state")).toBe("signed");
  });

  it("exchanges a code and reads the authorized YouTube channel", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "channel-1", snippet: { title: "Agency Channel" } }] }), { status: 200 }));
    const tokens = await exchangeGoogleAuthorizationCode({
      code: "code",
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://app.example.com/oauth/google/callback"
    });
    expect(tokens).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    expect(await fetchGoogleYouTubeChannel(tokens.accessToken)).toEqual({ id: "channel-1", label: "Agency Channel" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it("refreshes an expired Google access token without replacing the refresh token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 })
    );
    const result = await refreshGoogleAccessToken({
      refreshToken: "durable-refresh",
      clientId: "client",
      clientSecret: "secret"
    });
    expect(result.accessToken).toBe("fresh-access");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("durable-refresh");
    expect(body.get("grant_type")).toBe("refresh_token");
    fetchMock.mockRestore();
  });
});
