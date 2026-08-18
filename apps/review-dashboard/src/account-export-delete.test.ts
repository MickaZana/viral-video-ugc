import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

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

async function inviteMember(ownerCookie: string, email: string): Promise<{ cookie: string; accountId: string }> {
  const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  const { inviteToken } = await inviteRes.json();
  const acceptRes = await fetch(`${baseUrl}/accounts/invite/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, password: "hunter22" })
  });
  const setCookie = acceptRes.headers.get("set-cookie")!;
  const { account } = await acceptRes.json();
  return { cookie: setCookie.split(";")[0], accountId: account.id };
}

const CLIENT_BODY = {
  name: "Acme Fitness",
  niche: "fitness",
  brandVoice: "punchy",
  locale: "en",
  platforms: ["youtube_shorts"],
  targetDurationSec: 25,
  videoVendor: "higgsfield",
  cadence: "manual",
  active: true
};

async function createClient(cookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/accounts/clients`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(CLIENT_BODY)
  });
  if (res.status !== 201) throw new Error(`client create failed: ${res.status} ${await res.text()}`);
  const { client } = await res.json();
  return client.id;
}

function reviewItem(orgId: string, id: string): ReviewItem {
  return {
    id,
    runId: "export-run",
    orgId,
    niche: "fitness",
    videoPath: "/tmp/export.mp4",
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: "Wait, nobody told you this?",
      points: ["First point.", "Second point."],
      cta: "Follow for part 2.",
      durationSec: 25,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 82,
    flags: [],
    status: "pending",
    dryRun: false,
    createdAt: new Date().toISOString()
  };
}

function seedRunManifest(orgId: string, runId: string) {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      config: { accountId: orgId, niche: "fitness", createdAt: new Date().toISOString() },
      candidatesFound: 1,
      reviewItemsCreated: 1
    })
  );
}

function readJson(file: string): unknown {
  const path = join(runsDir, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : undefined;
}

describe("data export and account deletion", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-export-delete-test-"));
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

  it("exports the org's data as one JSON bundle", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("export@agency.com");
    await createClient(owner.cookie);
    await fetch(`${baseUrl}/accounts/settings`, {
      method: "PUT",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ niche: "fitness", brandVoice: "punchy", platforms: ["youtube_shorts"], targetDurationSec: 25, videoVendor: "higgsfield", cadence: "manual" })
    });
    await insertReviewItem(reviewItem(owner.orgId, "export-item-1"));
    seedRunManifest(owner.orgId, "export-run-1");
    const jobsRes = await fetch(`${baseUrl}/accounts/jobs`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: (await (await fetch(`${baseUrl}/accounts/clients`, { headers: { Cookie: owner.cookie } })).json()).clients[0].id })
    });
    expect(jobsRes.status).toBe(202);

    const res = await fetch(`${baseUrl}/accounts/export`, { headers: { Cookie: owner.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bundle = await res.json();

    expect(bundle.orgId).toBe(owner.orgId);
    expect(bundle.account.email).toBe("export@agency.com");
    expect(bundle.members.length).toBe(1);
    expect(bundle.settings.niche).toBe("fitness");
    expect(bundle.clients.length).toBe(1);
    expect(bundle.reviewItems.some((item: { id: string }) => item.id === "export-item-1")).toBe(true);
    expect(bundle.usage.totalRuns).toBe(1);
    expect(bundle.jobs.length).toBe(1);
    expect(bundle.securityEvents.some((event: { type: string }) => event.type === "account.created")).toBe(true);
  });

  it("a member deleting their own account removes only themselves — the org survives", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("owner-delete@agency.com");
    const member = await inviteMember(owner.cookie, "member-delete@agency.com");
    await createClient(owner.cookie);

    const del = await fetch(`${baseUrl}/accounts/delete-account`, {
      method: "POST",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", password: "hunter22" })
    });
    expect(del.status).toBe(204);

    // The member's session is dead and their account is gone.
    expect((await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: member.cookie } })).status).toBe(401);
    const accounts = readJson("accounts.json") as Array<{ email: string }> | undefined;
    expect(accounts?.some((a) => a.email === "member-delete@agency.com")).toBe(false);
    expect(accounts?.some((a) => a.email === "owner-delete@agency.com")).toBe(true);

    // The org's data is untouched.
    const clients = await (await fetch(`${baseUrl}/accounts/clients`, { headers: { Cookie: owner.cookie } })).json();
    expect(clients.clients.length).toBe(1);
  });

  it("an owner deleting their account deletes the whole org and all of its data", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("owner-del2@agency.com");
    await inviteMember(owner.cookie, "member-del2@agency.com");
    const clientId = await createClient(owner.cookie);
    await insertReviewItem(reviewItem(owner.orgId, "org-item-1"));
    seedRunManifest(owner.orgId, "org-run-1");
    await fetch(`${baseUrl}/accounts/social-connections`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        platform: "youtube_shorts",
        accountLabel: "Org YouTube",
        accessToken: "secret-access",
        refreshToken: "secret-refresh",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      })
    });
    const planStore = (await import("@vvugc/shared-billing")).createPlanStore(join(runsDir, "account-plans.json"));
    planStore.upsert(owner.orgId, { tierId: "starter", status: "active" });

    const del = await fetch(`${baseUrl}/accounts/delete-account`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", password: "hunter22" })
    });
    expect(del.status).toBe(204);
    expect((await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner-del2@agency.com", password: "hunter22" })
    })).status).toBe(401);

    // Every store is empty of the org's data.
    const accounts = readJson("accounts.json") as Array<{ orgId: string }> | undefined;
    expect(accounts?.some((a) => a.orgId === owner.orgId)).toBe(false);
    const clients = readJson("agency-clients.json") as Array<{ orgId: string }> | undefined;
    expect(clients?.some((c) => c.orgId === owner.orgId)).toBe(false);
    const connections = readJson("social-connections.json") as Array<{ orgId: string }> | undefined;
    expect(connections?.some((c) => c.orgId === owner.orgId)).toBe(false);
    const plans = readJson("account-plans.json") as Array<{ accountId: string }> | undefined;
    expect(plans?.some((p) => p.accountId === owner.orgId)).toBe(false);
    const jobs = readJson("pipeline-jobs.json") as Array<{ orgId: string }> | undefined;
    expect(jobs?.some((j) => j.orgId === owner.orgId)).toBe(false);
    expect(existsSync(join(runsDir, "org-run-1"))).toBe(false);

    // Review items for the org are gone from the queue store.
    const { listReviewItems } = await import("@vvugc/review-queue");
    expect((await listReviewItems({ orgId: owner.orgId })).length).toBe(0);

    // Security events for the org were pruned too.
    const securityEvents = readFileSync(join(runsDir, "security-events.ndjson"), "utf-8");
    expect(securityEvents).not.toContain(owner.orgId);
  });

  it("refuses deletion without the password or the DELETE confirmation", async () => {
    await startServer();
    const owner = await signUpAndGetAccount("owner-del3@agency.com");

    const noConfirm = await fetch(`${baseUrl}/accounts/delete-account`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "yes", password: "hunter22" })
    });
    expect(noConfirm.status).toBe(400);

    const wrongPassword = await fetch(`${baseUrl}/accounts/delete-account`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", password: "nope-nope" })
    });
    expect(wrongPassword.status).toBe(403);

    // Still alive and authenticated.
    expect((await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: owner.cookie } })).status).toBe(200);
  });
});
