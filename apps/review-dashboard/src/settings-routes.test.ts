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

describe("account settings and self-service run routes", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-settings-test-"));
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

  it("GET /accounts/settings returns built-in defaults for a brand-new account", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("new@example.com");
    const res = await fetch(`${baseUrl}/accounts/settings`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const settings = await res.json();
    expect(settings.cadence).toBe("manual");
  });

  it("PUT /accounts/settings saves and GET reflects it back", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("saver@example.com");

    const put = await fetch(`${baseUrl}/accounts/settings`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        niche: "fitness",
        brandVoice: "punchy",
        platforms: ["tiktok", "youtube_shorts"],
        targetDurationSec: 30,
        videoVendor: "kling",
        voiceVendor: "elevenlabs",
        cadence: "weekly"
      })
    });
    expect(put.status).toBe(200);

    const get = await (await fetch(`${baseUrl}/accounts/settings`, { headers: { Cookie: cookie } })).json();
    expect(get.niche).toBe("fitness");
    expect(get.platforms).toEqual(["tiktok", "youtube_shorts"]);
  });

  it("PUT /accounts/settings rejects an invalid platform with 400, doesn't save", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("bad@example.com");
    const res = await fetch(`${baseUrl}/accounts/settings`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        niche: "fitness",
        brandVoice: "punchy",
        platforms: ["not_a_real_platform"],
        targetDurationSec: 30,
        videoVendor: "kling",
        cadence: "manual"
      })
    });
    expect(res.status).toBe(400);
  });

  it("settings and run routes require a session, not Basic Auth", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/settings`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("POST /accounts/run refuses to run before a niche is saved", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("norun@example.com");
    const res = await fetch(`${baseUrl}/accounts/run`, { method: "POST", headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });

  it("POST /accounts/run with saved settings runs a real dry-run cycle tagged with accountId", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("runner@example.com");
    await fetch(`${baseUrl}/accounts/settings`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        niche: "fitness",
        brandVoice: "punchy",
        platforms: ["youtube_shorts"],
        targetDurationSec: 25,
        videoVendor: "higgsfield",
        cadence: "manual"
      })
    });

    const runRes = await fetch(`${baseUrl}/accounts/run`, { method: "POST", headers: { Cookie: cookie } });
    expect(runRes.status).toBe(200);
    const result = await runRes.json();
    expect(result.reviewItemsCreated).toBeGreaterThan(0);

    const usage = await (await fetch(`${baseUrl}/accounts/usage`, { headers: { Cookie: cookie } })).json();
    expect(usage.totalRuns).toBe(1);
  }, 20_000);

  it("GET /account redirects to the SPA workspace", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/account`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
  });
});
