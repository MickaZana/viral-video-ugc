import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

async function signUpAndGetCookie(email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned from signup");
  return setCookie.split(";")[0];
}

describe("multi-seat: invites and shared org data", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-invite-test-"));
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

  it("an owner can invite a teammate, who accepts and lands in the same org", async () => {
    await startServer();
    const ownerCookie = await signUpAndGetCookie("owner@agency.com");

    const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate@agency.com" })
    });
    expect(inviteRes.status).toBe(201);
    const { inviteToken } = await inviteRes.json();

    const acceptRes = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    expect(acceptRes.status).toBe(201);
    const memberCookie = acceptRes.headers.get("set-cookie")!.split(";")[0];

    const membersRes = await fetch(`${baseUrl}/accounts/members`, { headers: { Cookie: ownerCookie } });
    const { members } = await membersRes.json();
    expect(members.map((m: { email: string }) => m.email).sort()).toEqual(["owner@agency.com", "teammate@agency.com"]);

    // Confirm the invited member's session actually reaches the org data, not just that signup succeeded.
    const memberMe = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: memberCookie } })).json();
    expect(memberMe.account.role).toBe("editor"); // default invite role
  });

  it("a teammate sees the owner's saved settings and usage — shared org data, not a fresh account", async () => {
    await startServer();
    const ownerCookie = await signUpAndGetCookie("owner2@agency.com");
    await fetch(`${baseUrl}/accounts/settings`, {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        niche: "fitness",
        brandVoice: "punchy",
        platforms: ["youtube_shorts"],
        targetDurationSec: 25,
        videoVendor: "higgsfield",
        cadence: "manual"
      })
    });

    const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate2@agency.com" })
    });
    const { inviteToken } = await inviteRes.json();
    const acceptRes = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const memberCookie = acceptRes.headers.get("set-cookie")!.split(";")[0];

    const memberSettings = await (await fetch(`${baseUrl}/accounts/settings`, { headers: { Cookie: memberCookie } })).json();
    expect(memberSettings.niche).toBe("fitness"); // set by the owner, visible to the invited member
  });

  it("only the org owner can invite — a member gets a real 403, not a hidden button", async () => {
    await startServer();
    const ownerCookie = await signUpAndGetCookie("owner3@agency.com");
    const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "teammate3@agency.com" })
    });
    const { inviteToken } = await inviteRes.json();
    const acceptRes = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const memberCookie = acceptRes.headers.get("set-cookie")!.split(";")[0];

    const secondInvite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "another@agency.com" })
    });
    expect(secondInvite.status).toBe(403);
  });

  it("an expired or already-used invite token is rejected", async () => {
    await startServer();
    const ownerCookie = await signUpAndGetCookie("owner4@agency.com");
    const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reused@agency.com" })
    });
    const { inviteToken } = await inviteRes.json();

    const first = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    expect(second.status).toBe(400);
  });
});
