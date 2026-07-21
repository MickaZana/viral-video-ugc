import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface GoogleOAuthState {
  nonce: string;
  orgId: string;
  clientId: string;
  expiresAt: string;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createGoogleOAuthState(orgId: string, clientId: string, secret: string): { state: string; value: GoogleOAuthState } {
  const value: GoogleOAuthState = {
    nonce: randomBytes(24).toString("base64url"),
    orgId,
    clientId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return { state: `${payload}.${signature(payload, secret)}`, value };
}

export function verifyGoogleOAuthState(state: string, secret: string): GoogleOAuthState | undefined {
  const [payload, provided] = state.split(".");
  if (!payload || !provided) return undefined;
  const expected = signature(payload, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GoogleOAuthState;
    return new Date(value.expiresAt).getTime() > Date.now() ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createOAuthNonceStore(path: string) {
  const read = (): string[] => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  return {
    add(nonce: string) {
      const values = read();
      values.push(nonce);
      writeFileSync(path, JSON.stringify(values));
    },
    consume(nonce: string): boolean {
      const values = read();
      const index = values.indexOf(nonce);
      if (index === -1) return false;
      values.splice(index, 1);
      writeFileSync(path, JSON.stringify(values));
      return true;
    }
  };
}

export function googleAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: input.state
  }).toString();
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code"
    })
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error_description ?? "Google OAuth token exchange failed");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : undefined
  };
}

export async function refreshGoogleAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresAt?: string }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token"
    })
  });
  const body = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error_description ?? "Google OAuth token refresh failed");
  return {
    accessToken: body.access_token,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : undefined
  };
}

export async function fetchGoogleYouTubeChannel(accessToken: string): Promise<{ id: string; label: string }> {
  const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const body = await response.json() as { items?: Array<{ id: string; snippet?: { title?: string } }>; error?: { message?: string } };
  const channel = body.items?.[0];
  if (!response.ok || !channel) throw new Error(body.error?.message ?? "No YouTube channel found for this Google account");
  return { id: channel.id, label: channel.snippet?.title ?? channel.id };
}
