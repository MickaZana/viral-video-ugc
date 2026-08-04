import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  const setCookie = res.headers.get("set-cookie")!;
  const { account } = await res.json();
  return { cookie: setCookie.split(";")[0], orgId: account.orgId, accountId: account.id };
}

const CLIENT_BODY = {
  name: "Tenant A Brand",
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
  const { client } = await res.json();
  return client.id;
}

function reviewItem(orgId: string, id: string): ReviewItem {
  return {
    id,
    runId: "matrix-run",
    orgId,
    niche: "fitness",
    videoPath: "/tmp/matrix.mp4",
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: "Wait, nobody told you this?",
      points: ["First point."],
      cta: "Follow for part 2.",
      durationSec: 25,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 80,
    flags: [],
    status: "pending",
    createdAt: new Date().toISOString()
  };
}

describe("cross-tenant isolation matrix: every route scoped to the requester's org", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-isolation-test-"));
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

  it("tenant B cannot read or mutate tenant A's clients, settings, review items, jobs, or members", async () => {
    await startServer();
    const a = await signUpAndGetAccount("a@agency.com");
    const b = await signUpAndGetAccount("b@agency.com");

    // Tenant A's data: distinct settings, a client, a review item, and a queued job.
    await fetch(`${baseUrl}/accounts/settings`, {
      method: "PUT",
      headers: { Cookie: a.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ niche: "tenant-a-niche", brandVoice: "punchy", platforms: ["youtube_shorts"], targetDurationSec: 25, videoVendor: "higgsfield", cadence: "manual" })
    });
    const aClientId = await createClient(a.cookie);
    await insertReviewItem(reviewItem(a.orgId, "matrix-item-a"));
    const jobsRes = await fetch(`${baseUrl}/accounts/jobs`, {
      method: "POST",
      headers: { Cookie: a.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: aClientId })
    });
    const { job } = await jobsRes.json();

    // B's own reads never surface A's data.
    const bSettings = await (await fetch(`${baseUrl}/accounts/settings`, { headers: { Cookie: b.cookie } })).json();
    expect(bSettings.niche).not.toBe("tenant-a-niche");
    const bClients = await (await fetch(`${baseUrl}/accounts/clients`, { headers: { Cookie: b.cookie } })).json();
    expect(bClients.clients.some((c: { id: string }) => c.id === aClientId)).toBe(false);
    const bJobs = await (await fetch(`${baseUrl}/accounts/jobs`, { headers: { Cookie: b.cookie } })).json();
    expect(bJobs.jobs.some((j: { id: string }) => j.id === job.id)).toBe(false);
    const bReview = await (await fetch(`${baseUrl}/accounts/review-items`, { headers: { Cookie: b.cookie } })).json();
    expect(bReview.items.some((i: { id: string }) => i.id === "matrix-item-a")).toBe(false);

    // B addressing A's resources by id gets 404s (not 403/200) — the resource is
    // treated as nonexistent rather than revealing it exists behind a permission wall.
    const matrix: Array<[string, string, RequestInit | undefined]> = [
      ["PUT", `/accounts/clients/${aClientId}`, { method: "PUT", headers: { Cookie: b.cookie, "Content-Type": "application/json" }, body: JSON.stringify(CLIENT_BODY) }],
      ["DELETE", `/accounts/clients/${aClientId}`, { method: "DELETE", headers: { Cookie: b.cookie } }],
      ["POST", `/accounts/clients/${aClientId}/acceptance`, { method: "POST", headers: { Cookie: b.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ live: false }) }],
      ["POST", `/accounts/clients/${aClientId}/oauth/google/start`, { method: "POST", headers: { Cookie: b.cookie } }],
      ["GET", `/accounts/jobs/${job.id}`, { headers: { Cookie: b.cookie } }],
      ["DELETE", `/accounts/jobs/${job.id}`, { method: "DELETE", headers: { Cookie: b.cookie } }],
      ["POST", `/accounts/jobs/${job.id}/replay`, { method: "POST", headers: { Cookie: b.cookie } }],
      ["POST", "/accounts/jobs", { method: "POST", headers: { Cookie: b.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientId: aClientId }) }],
      ["GET", `/accounts/review-items/${"matrix-item-a"}`, { headers: { Cookie: b.cookie } }],
      ["POST", `/accounts/review-items/${"matrix-item-a"}/approve`, { method: "POST", headers: { Cookie: b.cookie } }],
      ["POST", `/accounts/review-items/${"matrix-item-a"}/reject`, { method: "POST", headers: { Cookie: b.cookie } }],
      ["POST", `/accounts/social-connections`, { method: "POST", headers: { Cookie: b.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientId: aClientId, platform: "youtube_shorts", accountLabel: "x", accessToken: "tok" }) }],
      ["GET", `/accounts/social-connections?clientId=${aClientId}`, { headers: { Cookie: b.cookie } }],
      ["POST", "/accounts/run", { method: "POST", headers: { Cookie: b.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ clientId: aClientId, dryRun: true }) }]
    ];
    for (const [method, path, init] of matrix) {
      const res = await fetch(`${baseUrl}${path}`, init);
      expect(res.status, `${method} ${path} from tenant B`).toBe(404);
    }
  });

  it("tenant B cannot re-role or remove tenant A's members, and B's export contains none of A's data", async () => {
    await startServer();
    const a = await signUpAndGetAccount("a2@agency.com");
    const b = await signUpAndGetAccount("b2@agency.com");
    await createClient(a.cookie);

    const roleChange = await fetch(`${baseUrl}/accounts/members/${a.accountId}/role`, {
      method: "PUT",
      headers: { Cookie: b.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "viewer" })
    });
    expect(roleChange.status).toBe(404);

    const remove = await fetch(`${baseUrl}/accounts/members/${a.accountId}`, { method: "DELETE", headers: { Cookie: b.cookie } });
    expect(remove.status).toBe(404);

    // B can still read its own (empty) member list, and A is untouched.
    const bMembers = await (await fetch(`${baseUrl}/accounts/members`, { headers: { Cookie: b.cookie } })).json();
    expect(bMembers.members.length).toBe(1);
    const aMembers = await (await fetch(`${baseUrl}/accounts/members`, { headers: { Cookie: a.cookie } })).json();
    expect(aMembers.members.length).toBe(1);
    expect(aMembers.members[0].id).toBe(a.accountId);

    // B's export bundle never contains A's orgId or client data.
    const bExport = await (await fetch(`${baseUrl}/accounts/export`, { headers: { Cookie: b.cookie } })).json();
    expect(bExport.orgId).toBe(b.orgId);
    expect(bExport.clients.length).toBe(0);
    expect(JSON.stringify(bExport)).not.toContain(a.orgId);
  });

  it("a security event written by tenant A is invisible to tenant B's security-events view", async () => {
    await startServer();
    const a = await signUpAndGetAccount("a3@agency.com");
    const b = await signUpAndGetAccount("b3@agency.com");

    // A creates some org-scoped events (signup already wrote account.created).
    const aEvents = await (await fetch(`${baseUrl}/accounts/security-events`, { headers: { Cookie: a.cookie } })).json();
    expect(aEvents.events.length).toBeGreaterThan(0);

    const bEvents = await (await fetch(`${baseUrl}/accounts/security-events`, { headers: { Cookie: b.cookie } })).json();
    // B's events are scoped to B's own org; none of A's events leak through.
    expect(bEvents.events.every((e: { orgId?: string }) => e.orgId === b.orgId)).toBe(true);
    expect(bEvents.events.every((e: { actorAccountId?: string; targetAccountId?: string }) =>
      e.actorAccountId !== a.accountId && e.targetAccountId !== a.accountId
    )).toBe(true);
  });
});
