import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCookies } from "./accounts.js";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header on response");
  return setCookie.split(";")[0]; // "vvugc_session=<token>"
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

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("vvugc_session=abc123")).toEqual({ vvugc_session: "abc123" });
  });

  it("parses multiple cookies and URL-decodes values", () => {
    expect(parseCookies("a=1; b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });

  it("returns an empty object for an undefined or malformed header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("not-a-cookie-pair")).toEqual({});
  });
});

describe("account signup/login/session routes (additive, separate from dashboard Basic Auth)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-accounts-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("signup creates an account, sets a session cookie, and does not require Basic Auth", async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "agency@example.com", password: "hunter22", orgName: "Acme Agency" })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.account.email).toBe("agency@example.com");
    expect(body.account).not.toHaveProperty("passwordHash");
    expect(res.headers.get("set-cookie")).toContain("vvugc_session=");
  });

  it("rejects a weak password or invalid email with 400, no account created", async () => {
    await startServer();
    const shortPassword = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "short" })
    });
    expect(shortPassword.status).toBe(400);

    const badEmail = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "longenough1" })
    });
    expect(badEmail.status).toBe(400);
  });

  it("rejects a duplicate signup with 409", async () => {
    await startServer();
    const body = JSON.stringify({ email: "dup@example.com", password: "hunter22" });
    const headers = { "Content-Type": "application/json" };
    await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers, body });
    const second = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers, body });
    expect(second.status).toBe(409);
  });

  it("login with correct credentials returns a session cookie; wrong password returns 401", async () => {
    await startServer();
    const headers = { "Content-Type": "application/json" };
    await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "loginme@example.com", password: "correctpass1" })
    });

    const wrong = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "loginme@example.com", password: "wrongpass" })
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "loginme@example.com", password: "correctpass1" })
    });
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain("vvugc_session=");
  });

  it("GET /accounts/me requires a valid session cookie, not Basic Auth", async () => {
    await startServer();
    const unauthed = await fetch(`${baseUrl}/accounts/me`);
    expect(unauthed.status).toBe(401);

    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "me@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);

    const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.account.email).toBe("me@example.com");
  });

  it("requires the session-bound CSRF token for browser-originated mutations", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "csrf@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);
    const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();

    const rejected = await fetch(`${baseUrl}/accounts/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl }
    });
    expect(rejected.status).toBe(403);

    const accepted = await fetch(`${baseUrl}/accounts/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": me.csrfToken }
    });
    expect(accepted.status).toBe(204);
  });

  it("logout revokes the session — a subsequent /accounts/me with the same cookie is unauthenticated", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "logout@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);

    const logoutRes = await fetch(`${baseUrl}/accounts/logout`, { method: "POST", headers: { Cookie: cookie } });
    expect(logoutRes.status).toBe(204);

    const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
  });

  it("GET /accounts/usage returns zeroed usage for a brand-new account with no runs", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "usage@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);

    const usage = await (await fetch(`${baseUrl}/accounts/usage`, { headers: { Cookie: cookie } })).json();
    expect(usage.totalRuns).toBe(0);
    expect(usage.totalUsd).toBe(0);
  });

  it("account routes are reachable without the dashboard's Basic Auth header at all", async () => {
    await startServer();
    // No Authorization header anywhere in this test — proves accounts routes
    // are registered ahead of the Basic Auth gate, not accidentally behind it.
    const res = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrongpass" })
    });
    expect(res.status).toBe(401); // reached the handler (wrong creds), not blocked by Basic Auth (which would be 401 with WWW-Authenticate)
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});
