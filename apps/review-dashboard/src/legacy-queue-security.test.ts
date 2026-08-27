import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;
const basic = { Authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}` };

function item(id: string, orgId?: string): ReviewItem {
  return { id, orgId, runId: "run-1", niche: "fitness", videoPath: "/tmp/x.mp4", platform: "tiktok", script: { videoId: "v", hook: "h", points: ["p"], cta: "c", durationSec: 20, brandVoice: "punchy", locale: "en", trendingPhrases: [] }, score: 80, flags: [], status: "pending", dryRun: true, createdAt: "2026-01-01T00:00:00.000Z" };
}

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((done) => { server = app.listen(0, () => done()); });
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
}

async function signup(email: string) {
  const res = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "hunter22" }) });
  const body = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0], csrf: body.csrfToken as string, orgId: body.account.orgId as string };
}

async function invite(owner: Awaited<ReturnType<typeof signup>>, email: string, role: "reviewer" | "viewer") {
  const created = await fetch(`${baseUrl}/accounts/invite`, { method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
  const { inviteToken } = await created.json();
  const accepted = await fetch(`${baseUrl}/accounts/invite/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken, password: "hunter22" }) });
  const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: accepted.headers.get("set-cookie")!.split(";")[0] } });
  const data = await me.json();
  return { cookie: accepted.headers.get("set-cookie")!.split(";")[0], csrf: data.csrfToken as string };
}

describe("legacy queue session security", () => {
  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-legacy-queue-security-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json"); process.env.VVUGC_RUNS_DIR = join(testDir, "runs"); process.env.DASHBOARD_USERNAME = "operator"; process.env.DASHBOARD_PASSWORD = "secret";
    await startServer();
  });
  afterEach(() => { server?.close(); delete process.env.VVUGC_DB_PATH; delete process.env.VVUGC_RUNS_DIR; delete process.env.DASHBOARD_USERNAME; delete process.env.DASHBOARD_PASSWORD; if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true }); });

  it("requires review.manage and a valid CSRF token for session approval, while Basic Auth remains supported", async () => {
    const owner = await signup("owner@example.com");
    const reviewer = await invite(owner, "reviewer@example.com", "reviewer");
    const viewer = await invite(owner, "viewer@example.com", "viewer");
    insertReviewItem(item("owned", owner.orgId));
    expect((await fetch(`${baseUrl}/queue/owned/approve`, { method: "POST", headers: { Cookie: viewer.cookie, Origin: baseUrl } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/queue/owned/approve`, { method: "POST", headers: { Cookie: reviewer.cookie } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/queue/owned/approve`, { method: "POST", headers: { Cookie: reviewer.cookie, Origin: baseUrl } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/queue/owned/approve`, { method: "POST", headers: { Cookie: reviewer.cookie, Origin: baseUrl, "X-CSRF-Token": "invalid" } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/queue/owned/approve`, { method: "POST", headers: { Cookie: reviewer.cookie, "X-CSRF-Token": reviewer.csrf } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/queue/owned/reject`, { method: "POST", headers: basic })).status).toBe(200);
  });

  it("fails closed for cross-tenant and unowned legacy items", async () => {
    const ownerA = await signup("a@example.com");
    const ownerB = await signup("b@example.com");
    insertReviewItem(item("other-org", ownerB.orgId)); insertReviewItem(item("unowned"));
    for (const id of ["other-org", "unowned"]) {
      expect((await fetch(`${baseUrl}/queue/${id}`, { headers: { Cookie: ownerA.cookie } })).status).toBe(404);
      expect((await fetch(`${baseUrl}/queue/${id}/approve`, { method: "POST", headers: { Cookie: ownerA.cookie, Origin: baseUrl, "X-CSRF-Token": ownerA.csrf } })).status).toBe(404);
    }
  });

  it("requires stronger permissions for regeneration and publishing", async () => {
    const owner = await signup("strong@example.com"); const reviewer = await invite(owner, "reviewer-strong@example.com", "reviewer");
    insertReviewItem(item("owned", owner.orgId));
    const headers = { Cookie: reviewer.cookie, Origin: baseUrl, "X-CSRF-Token": reviewer.csrf, "Content-Type": "application/json" };
    expect((await fetch(`${baseUrl}/queue/owned/regenerate-script`, { method: "POST", headers, body: JSON.stringify({ hook: "h", points: ["p"], cta: "c" }) })).status).toBe(403);
    expect((await fetch(`${baseUrl}/queue/owned/publish`, { method: "POST", headers })).status).toBe(403);
  });
});
