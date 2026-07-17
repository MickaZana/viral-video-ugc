import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanStore } from "@vvugc/shared-billing";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let runsDir: string;
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

async function signUpAndGetAccount(email: string): Promise<{ cookie: string; orgId: string }> {
  const res = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned from signup");
  const { account } = await res.json();
  return { cookie: setCookie.split(";")[0], orgId: account.orgId };
}

async function saveSettings(cookie: string) {
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
}

// Directly seeds a run manifest matching the real on-disk shape conductor.ts
// writes (nested config, runId as the directory name) — the same real
// aggregateUsage() code path the quota check uses reads this, so this is
// exercising the real reader, just without paying for N real pipeline runs
// to build up usage history.
function seedRunManifest(orgId: string, runId: string) {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      config: { accountId: orgId, niche: "fitness", createdAt: new Date().toISOString() },
      candidatesFound: 1,
      chosen: [],
      reviewItemsCreated: 1,
      candidatesFailed: 0,
      platformsFailed: [],
      failures: []
    })
  );
}

describe("billing: real run-quota enforcement", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-quota-test-"));
    runsDir = join(testDir, "runs");
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = runsDir;
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

  it("an account with no active plan can run past what would be a paid tier's limit — billing hasn't been asked to gate anything yet", async () => {
    await startServer();
    const { cookie, orgId } = await signUpAndGetAccount("free@example.com");
    await saveSettings(cookie);
    // Starter's real limit is 4 — seed past it with no plan on file at all.
    for (let i = 0; i < 5; i++) seedRunManifest(orgId, `seeded-run-${i}`);

    const res = await fetch(`${baseUrl}/accounts/run`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    expect(res.status).toBe(200);
  }, 20_000);

  it("an active Starter-tier account is blocked with a real 402 once it hits its real 4-run monthly limit", async () => {
    await startServer();
    const { cookie, orgId } = await signUpAndGetAccount("paid@example.com");
    await saveSettings(cookie);

    const planStore = createPlanStore(join(runsDir, "account-plans.json"));
    planStore.upsert(orgId, { tierId: "starter", status: "active" });
    for (let i = 0; i < 4; i++) seedRunManifest(orgId, `seeded-run-${i}`);

    const res = await fetch(`${baseUrl}/accounts/run`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/monthly run limit reached/);
    expect(body.error).toMatch(/Starter/);
  });

  it("an active Starter-tier account under its limit can still run for real", async () => {
    await startServer();
    const { cookie, orgId } = await signUpAndGetAccount("underlimit@example.com");
    await saveSettings(cookie);

    const planStore = createPlanStore(join(runsDir, "account-plans.json"));
    planStore.upsert(orgId, { tierId: "starter", status: "active" });
    for (let i = 0; i < 3; i++) seedRunManifest(orgId, `seeded-run-${i}`);

    const res = await fetch(`${baseUrl}/accounts/run`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    });
    expect(res.status).toBe(200);
  }, 20_000);
});
