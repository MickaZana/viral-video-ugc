import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCode } from "./totp.js";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let runsDir: string;
let server: Server;
let baseUrl: string;

async function startServer() {
  vi.resetModules();
  const { app } = await import("./server.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
}

async function signUpAndGetAccount(email: string): Promise<{ cookie: string; orgId: string; accountId: string }> {
  const res = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned from signup");
  const { account } = await res.json();
  return { cookie: setCookie.split(";")[0], orgId: account.orgId, accountId: account.id };
}

/** Reads the MFA store file to get the account's TOTP secret, then computes a live code. */
function codeFor(accountId: string, windowMs = 0): string {
  const records = JSON.parse(readFileSync(join(runsDir, "mfa.json"), "utf-8")) as Array<{
    accountId: string;
    secret: string;
  }>;
  const record = records.find((r) => r.accountId === accountId);
  if (!record) throw new Error(`no MFA record for ${accountId}`);
  return totpCode(record.secret, Date.now() + windowMs);
}

describe("two-factor authentication (TOTP)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-mfa-test-"));
    runsDir = join(testDir, "runs");
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = runsDir;
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("enroll → verify makes login require a second factor, which succeeds with the right code", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("mfa@agency.com");

    const enroll = await fetch(`${baseUrl}/accounts/mfa/enroll`, { method: "POST", headers: { Cookie: owner.cookie } });
    expect(enroll.status).toBe(200);
    const { secret } = await enroll.json();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    // Pending enrollment must NOT gate login yet.
    const earlyLogin = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mfa@agency.com", password: "hunter22" })
    });
    expect((await earlyLogin.json()).mfaRequired).toBeUndefined();

    const verify = await fetch(`${baseUrl}/accounts/mfa/verify`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeFor(owner.accountId) })
    });
    expect(verify.status).toBe(200);
    expect((await verify.json()).enabled).toBe(true);

    // From now on, password alone no longer yields a session.
    const login = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mfa@agency.com", password: "hunter22" })
    });
    const challenge = await login.json();
    expect(challenge.mfaRequired).toBe(true);
    expect(typeof challenge.mfaToken).toBe("string");
    expect(login.headers.get("set-cookie")).toBeNull();

    // The challenge with the current code grants a session.
    const redeem = await fetch(`${baseUrl}/accounts/mfa/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: challenge.mfaToken, code: codeFor(owner.accountId) })
    });
    expect(redeem.status).toBe(200);
    const cookie = redeem.headers.get("set-cookie")!.split(";")[0];
    const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.mfaEnabled).toBe(true);
  });

  it("rejects a wrong code and a replayed challenge token", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("mfa2@agency.com");
    await fetch(`${baseUrl}/accounts/mfa/enroll`, { method: "POST", headers: { Cookie: owner.cookie } });
    await fetch(`${baseUrl}/accounts/mfa/verify`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeFor(owner.accountId) })
    });

    const login = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mfa2@agency.com", password: "hunter22" })
    });
    const challenge = await login.json();

    const wrong = await fetch(`${baseUrl}/accounts/mfa/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: challenge.mfaToken, code: "000000" })
    });
    expect(wrong.status).toBe(401);

    // The token was consumed by the failed attempt — a second attempt fails even with the right code.
    const replay = await fetch(`${baseUrl}/accounts/mfa/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: challenge.mfaToken, code: codeFor(owner.accountId) })
    });
    expect(replay.status).toBe(400);
  });

  it("disables MFA only with the current code, after which login is password-only again", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("mfa3@agency.com");
    await fetch(`${baseUrl}/accounts/mfa/enroll`, { method: "POST", headers: { Cookie: owner.cookie } });
    await fetch(`${baseUrl}/accounts/mfa/verify`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeFor(owner.accountId) })
    });

    const badDisable = await fetch(`${baseUrl}/accounts/mfa/disable`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000" })
    });
    expect(badDisable.status).toBe(401);

    const disable = await fetch(`${baseUrl}/accounts/mfa/disable`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeFor(owner.accountId) })
    });
    expect(disable.status).toBe(200);
    expect((await disable.json()).enabled).toBe(false);

    const login = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mfa3@agency.com", password: "hunter22" })
    });
    expect((await login.json()).mfaRequired).toBeUndefined();
  });

  it("records mfa.enrolled/enabled/disabled security events", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("mfa4@agency.com");
    await fetch(`${baseUrl}/accounts/mfa/enroll`, { method: "POST", headers: { Cookie: owner.cookie } });
    await fetch(`${baseUrl}/accounts/mfa/verify`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeFor(owner.accountId) })
    });
    await fetch(`${baseUrl}/accounts/mfa/disable`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeFor(owner.accountId) })
    });

    const res = await fetch(`${baseUrl}/accounts/security-events`, { headers: { Cookie: owner.cookie } });
    const { events } = await res.json();
    const types = events.map((e: { type: string }) => e.type);
    expect(types).toContain("mfa.enrolled");
    expect(types).toContain("mfa.enabled");
    expect(types).toContain("mfa.disabled");
  });

  it("gates enrollment to team.manage — an editor gets a real 403", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("mfa5@agency.com");
    // Invite an editor (default role) and accept.
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "editor-mfa@agency.com" })
    });
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const editorCookie = accept.headers.get("set-cookie")!.split(";")[0];

    const enroll = await fetch(`${baseUrl}/accounts/mfa/enroll`, { method: "POST", headers: { Cookie: editorCookie } });
    expect(enroll.status).toBe(403);
  });
});
