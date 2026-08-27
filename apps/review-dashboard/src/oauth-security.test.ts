import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleOAuthState,
  createOAuthNonceStore,
  verifyGoogleOAuthState
} from "./google-oauth.js";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const SECRET = "oauth-state-secret-at-least-32-characters-long!!";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

const CLIENT_PAYLOAD = {
  name: "Acme Agency Client",
  niche: "fitness",
  brandVoice: "energetic",
  locale: "en",
  platforms: ["youtube_shorts"],
  targetDurationSec: 25,
  videoVendor: "gemini",
  cadence: "manual",
  active: true
};

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header on response");
  return setCookie.split(";")[0];
}

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

async function signupAndGetSession(email: string) {
  const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const cookie = sessionCookieFrom(signupRes);
  const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken, account: me.account };
}

async function createTestClient(cookie: string, csrfToken: string): Promise<string> {
  const clientRes = await fetch(`${baseUrl}/accounts/clients`, {
    method: "POST",
    headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(CLIENT_PAYLOAD)
  });
  if (clientRes.status !== 201) throw new Error(`client create failed: ${clientRes.status} ${await clientRes.text()}`);
  const data = await clientRes.json();
  return data.client.id;
}

// ─── Unit Tests: State Signing & Verification ───────────────────────────────

describe("OAuth state: signing, expiry, and tamper detection", () => {
  it("creates a valid state and verifies it with the correct secret", () => {
    const { state, value } = createGoogleOAuthState("org-1", "client-1", SECRET);
    const verified = verifyGoogleOAuthState(state, SECRET);
    expect(verified).toBeDefined();
    expect(verified!.orgId).toBe("org-1");
    expect(verified!.clientId).toBe("client-1");
    expect(verified!.nonce).toBe(value.nonce);
  });

  it("rejects a tampered signature (appended character)", () => {
    const { state } = createGoogleOAuthState("org-1", "client-1", SECRET);
    expect(verifyGoogleOAuthState(`${state}x`, SECRET)).toBeUndefined();
  });

  it("rejects a tampered signature (different character)", () => {
    const { state } = createGoogleOAuthState("org-1", "client-1", SECRET);
    const [payload, sig] = state.split(".");
    const flipped = sig[0] === "A" ? "B" : "A";
    expect(verifyGoogleOAuthState(`${payload}.${flipped}${sig.slice(1)}`, SECRET)).toBeUndefined();
  });

  it("rejects a tampered payload (orgId changed)", () => {
    const { state } = createGoogleOAuthState("org-1", "client-1", SECRET);
    const [, sig] = state.split(".");
    const fakePayload = Buffer.from(JSON.stringify({
      nonce: "fake-nonce",
      orgId: "org-ATTACKER",
      clientId: "client-1",
      expiresAt: new Date(Date.now() + 600_000).toISOString()
    })).toString("base64url");
    expect(verifyGoogleOAuthState(`${fakePayload}.${sig}`, SECRET)).toBeUndefined();
  });

  it("rejects a state signed with a different secret", () => {
    const { state } = createGoogleOAuthState("org-1", "client-1", SECRET);
    expect(verifyGoogleOAuthState(state, "completely-different-secret-abcdef")).toBeUndefined();
  });

  it("rejects an expired state (>10 min old)", () => {
    const { state } = createGoogleOAuthState("org-1", "client-1", SECRET);
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 11 * 60 * 1000;
    try {
      expect(verifyGoogleOAuthState(state, SECRET)).toBeUndefined();
    } finally {
      Date.now = realDateNow;
    }
  });

  it("accepts a state that is still within the 10-minute window", () => {
    const { state } = createGoogleOAuthState("org-1", "client-1", SECRET);
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 9 * 60 * 1000;
    try {
      expect(verifyGoogleOAuthState(state, SECRET)).toBeDefined();
    } finally {
      Date.now = realDateNow;
    }
  });

  it("rejects a state with no dot separator (malformed)", () => {
    expect(verifyGoogleOAuthState("no-dot-separator", SECRET)).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(verifyGoogleOAuthState("", SECRET)).toBeUndefined();
  });

  it("rejects a state with invalid base64 payload", () => {
    const sig = "somesig";
    expect(verifyGoogleOAuthState(`not-valid-base64!!!.${sig}`, SECRET)).toBeUndefined();
  });
});

// ─── Unit Tests: Nonce Store (Single-Use Enforcement) ────────────────────────

describe("OAuth nonce store: single-use enforcement", () => {
  let storePath: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vvugc-nonce-test-"));
    storePath = join(dir, "nonces.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("consumes a nonce exactly once — second attempt returns false", () => {
    const store = createOAuthNonceStore(storePath);
    store.add("nonce-1");
    expect(store.consume("nonce-1")).toBe(true);
    expect(store.consume("nonce-1")).toBe(false);
  });

  it("rejects a nonce that was never added", () => {
    const store = createOAuthNonceStore(storePath);
    expect(store.consume("never-added")).toBe(false);
  });

  it("handles multiple distinct nonces independently", () => {
    const store = createOAuthNonceStore(storePath);
    store.add("a");
    store.add("b");
    expect(store.consume("a")).toBe(true);
    expect(store.consume("b")).toBe(true);
    expect(store.consume("a")).toBe(false);
    expect(store.consume("b")).toBe(false);
  });
});

// ─── Integration Tests: /start and /callback Routes ─────────────────────────

describe("OAuth route-level security (/start and /callback)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-oauth-route-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    process.env.GOOGLE_CLIENT_ID = "fake-google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fake-google-client-secret";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "http://localhost/oauth/google/callback";
    process.env.OAUTH_STATE_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    delete process.env.OAUTH_STATE_SECRET;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("/start requires social.manage permission — unauthenticated requests get 401", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/clients/any-client/oauth/google/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    expect(res.status).toBe(401);
  });

  it("/start returns 404 for a client that doesn't belong to the requesting org", async () => {
    await startServer();
    const { cookie } = await signupAndGetSession("oauth-start@example.com");
    const res = await fetch(`${baseUrl}/accounts/clients/nonexistent-client/oauth/google/start`, {
      method: "POST",
      headers: { Cookie: cookie }
    });
    expect(res.status).toBe(404);
  });

  it("/start returns a Google authorization URL with the state parameter embedded", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("oauth-url@example.com");
    const clientId = await createTestClient(cookie, csrfToken);

    const startRes = await fetch(`${baseUrl}/accounts/clients/${clientId}/oauth/google/start`, {
      method: "POST",
      headers: { Cookie: cookie }
    });
    expect(startRes.status).toBe(200);
    const body = await startRes.json();
    expect(body.authorizationUrl).toContain("accounts.google.com");
    expect(body.authorizationUrl).toContain("state=");
  });

  it("/callback rejects missing code parameter with 400", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/oauth/google/callback?state=something`);
    expect(res.status).toBe(400);
  });

  it("/callback rejects missing state parameter with 400", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/oauth/google/callback?code=something`);
    expect(res.status).toBe(400);
  });

  it("/callback rejects a tampered state with 400", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/oauth/google/callback?code=real-code&state=tampered-state`);
    expect(res.status).toBe(400);
  });

  it("/callback rejects a replayed (already-consumed) state with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("oauth-replay@example.com");
    const clientId = await createTestClient(cookie, csrfToken);

    const startRes = await fetch(`${baseUrl}/accounts/clients/${clientId}/oauth/google/start`, {
      method: "POST",
      headers: { Cookie: cookie }
    });
    const { authorizationUrl } = await startRes.json();
    const stateParam = new URL(authorizationUrl).searchParams.get("state")!;

    await fetch(`${baseUrl}/oauth/google/callback?code=fake-code&state=${encodeURIComponent(stateParam)}`);

    const second = await fetch(`${baseUrl}/oauth/google/callback?code=fake-code&state=${encodeURIComponent(stateParam)}`);
    expect(second.status).toBe(400);
    const body = await second.text();
    expect(body).toContain("invalid");
  });

  it("/callback always redirects to a hardcoded safe URL, never an open redirect", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("oauth-redirect@example.com");
    const clientId = await createTestClient(cookie, csrfToken);

    const startRes = await fetch(`${baseUrl}/accounts/clients/${clientId}/oauth/google/start`, {
      method: "POST",
      headers: { Cookie: cookie }
    });
    const { authorizationUrl } = await startRes.json();
    const stateParam = new URL(authorizationUrl).searchParams.get("state")!;

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("googleapis.com/youtube")) {
        return new Response(JSON.stringify({ items: [{ id: "ch-1", snippet: { title: "Test Channel" } }] }), { status: 200 });
      }
      return realFetch(input, init);
    };

    try {
      const callbackRes = await realFetch(`${baseUrl}/oauth/google/callback?code=auth-code&state=${encodeURIComponent(stateParam)}`, {
        redirect: "manual"
      });
      expect(callbackRes.status).toBe(302);
      const location = callbackRes.headers.get("location");
      expect(location).toBe(`/app/brand/clients/${clientId}?oauth=google-connected`);
      expect(location).not.toContain("http://");
      expect(location).not.toContain("https://");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
