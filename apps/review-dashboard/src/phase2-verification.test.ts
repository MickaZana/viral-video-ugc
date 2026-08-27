import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

const TEST_USER = "test-operator";
const TEST_PASS = "test-operator-pass";

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
    body: JSON.stringify({ email, password: "TestP@ss123!" })
  });
  const setCookie = res.headers.get("set-cookie")!;
  const { account } = await res.json();
  return { cookie: setCookie.split(";")[0], orgId: account.orgId, accountId: account.id };
}

function csrfHeaders(cookie: string): Record<string, string> {
  const sessionToken = cookie.slice(cookie.indexOf("=") + 1);
  return {
    Cookie: cookie,
    "Content-Type": "application/json",
    "x-csrf-token": createHash("sha256").update(`vvugc-csrf:${sessionToken}`).digest("base64url")
  };
}

function reviewItem(orgId: string, id: string, marker: string): ReviewItem {
  return {
    id,
    runId: `run-${orgId}`,
    orgId,
    niche: "fitness",
    videoPath: `/tmp/${marker}.mp4`,
    platform: "tiktok",
    script: {
      videoId: "v1",
      hook: `MARKER_${marker}_HOOK`,
      points: [`Secret data for ${marker}`],
      cta: "Follow for part 2.",
      durationSec: 25,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 80,
    flags: [],
    status: "pending",
    dryRun: false,
    createdAt: new Date().toISOString()
  };
}

describe("Phase 2 Security Verification", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-phase2-verify-"));
    runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });
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

  // ─── PHASE 3: PUBLIC DATA LEAK TESTING ───────────────────────────────────────

  describe("public preview endpoints contain ONLY synthetic data", () => {
    it("preview endpoints never expose real customer data markers", async () => {
      await startServer();
      const a = await signUpAndGetAccount("real-customer@agency.com");

      // Insert real customer data with identifiable markers
      await insertReviewItem(reviewItem(a.orgId, "secret-item-a", "TENANT_A_SECRET"));

      // Create a real run manifest with identifiable data
      const runDir = join(runsDir, "real-run-001");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "manifest.json"), JSON.stringify({
        config: { accountId: a.orgId, niche: "TENANT_A_SECRET_NICHE", platforms: ["tiktok"] },
        chosen: [{ id: "src1", platform: "tiktok", title: "TENANT_A_SECRET_TITLE" }],
        candidatesFound: 5,
        reviewItemsCreated: 1
      }));

      // Hit ALL preview endpoints without auth
      const previewStats = await (await fetch(`${baseUrl}/preview/stats`)).json();
      const previewCreators = await (await fetch(`${baseUrl}/preview/creators`)).json();
      const previewRuns = await (await fetch(`${baseUrl}/preview/runs`)).json();
      const previewQueue = await (await fetch(`${baseUrl}/preview/queue`)).json();

      // Stringify all responses and search for markers
      const allPreviewData = JSON.stringify({ previewStats, previewCreators, previewRuns, previewQueue });

      // Must NOT contain any real customer data
      expect(allPreviewData).not.toContain("TENANT_A_SECRET");
      expect(allPreviewData).not.toContain(a.orgId);
      expect(allPreviewData).not.toContain(a.accountId);
      expect(allPreviewData).not.toContain("real-customer@agency.com");
      expect(allPreviewData).not.toContain("secret-item-a");
      expect(allPreviewData).not.toContain("real-run-001");
      expect(allPreviewData).not.toContain("TENANT_A_SECRET_NICHE");
      expect(allPreviewData).not.toContain("TENANT_A_SECRET_TITLE");

      // Must not contain sensitive field patterns
      expect(allPreviewData).not.toContain(runsDir);
    });
  });

  // ─── PHASE 1: UNAUTHENTICATED ACCESS ────────────────────────────────────────

  describe("authenticated routes reject unauthenticated requests", () => {
    it("API routes behind the auth wall return 401 without credentials", async () => {
      await startServer();

      const protectedRoutes = [
        { method: "GET", path: "/queue" },
        { method: "GET", path: "/stats" },
        { method: "GET", path: "/runs" },
        { method: "GET", path: "/creators" },
        { method: "POST", path: "/scheduler/run-due" },
      ];

      for (const { method, path } of protectedRoutes) {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: method === "POST" ? { "Content-Type": "application/json" } : {},
          body: method === "POST" ? JSON.stringify({}) : undefined
        });
        expect(res.status, `${method} ${path} should reject unauthenticated`).toBe(401);
      }
    });
  });

  // ─── PHASE 1: TENANT ISOLATION ON QUEUE MUTATIONS ───────────────────────────

  describe("cross-tenant mutation prevention on review queue", () => {
    it("tenant B cannot approve/reject/send-back tenant A's review items", async () => {
      await startServer();
      const a = await signUpAndGetAccount("owner-a@agency.com");
      const b = await signUpAndGetAccount("attacker-b@agency.com");

      // Insert an item belonging to tenant A
      await insertReviewItem(reviewItem(a.orgId, "item-owned-by-a", "A_PRIVATE"));

      // Tenant B tries to approve A's item
      const approveRes = await fetch(`${baseUrl}/queue/item-owned-by-a/approve`, {
        method: "POST",
        headers: csrfHeaders(b.cookie)
      });
      expect(approveRes.status).toBe(404);

      // Tenant B tries to reject A's item
      const rejectRes = await fetch(`${baseUrl}/queue/item-owned-by-a/reject`, {
        method: "POST",
        headers: csrfHeaders(b.cookie)
      });
      expect(rejectRes.status).toBe(404);

      // Tenant B cannot send A's item back either.
      const sendBackRes = await fetch(`${baseUrl}/queue/item-owned-by-a/send-back`, {
        method: "POST",
        headers: csrfHeaders(b.cookie)
      });
      expect(sendBackRes.status).toBe(404);

      // Tenant B tries to read A's item directly
      const readRes = await fetch(`${baseUrl}/queue/item-owned-by-a`, {
        headers: { Cookie: b.cookie }
      });
      expect(readRes.status).toBe(404);

      // Tenant A CAN access their own item
      const aReadRes = await fetch(`${baseUrl}/queue/item-owned-by-a`, {
        headers: { Cookie: a.cookie }
      });
      expect(aReadRes.status).toBe(200);
    });
  });

  // ─── PHASE 14: DSR CROSS-TENANT ────────────────────────────────────────────

  describe("DSR requests are tenant-scoped", () => {
    it("POST /accounts/dsr-requests derives orgId from session, not request body", async () => {
      await startServer();
      const a = await signUpAndGetAccount("dsr-a@agency.com");
      const b = await signUpAndGetAccount("dsr-b@agency.com");

      // Tenant A submits a DSR
      const dsrRes = await fetch(`${baseUrl}/accounts/dsr-requests`, {
        method: "POST",
        headers: { Cookie: a.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "access" })
      });
      expect(dsrRes.status).toBe(201);
      const dsr = await dsrRes.json();
      expect(dsr.type).toBe("access");

      // Tenant B cannot see A's DSR
      const bDsrList = await (await fetch(`${baseUrl}/accounts/dsr-requests`, {
        headers: { Cookie: b.cookie }
      })).json();
      expect(bDsrList.requests).toHaveLength(0);

      // Tenant A can see their own DSR
      const aDsrList = await (await fetch(`${baseUrl}/accounts/dsr-requests`, {
        headers: { Cookie: a.cookie }
      })).json();
      expect(aDsrList.requests).toHaveLength(1);
      expect(aDsrList.requests[0].type).toBe("access");
    });

    it("DSR rejects invalid type", async () => {
      await startServer();
      const a = await signUpAndGetAccount("dsr-invalid@agency.com");

      const res = await fetch(`${baseUrl}/accounts/dsr-requests`, {
        method: "POST",
        headers: { Cookie: a.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "hacking" })
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── PHASE 15: SESSION SECURITY ────────────────────────────────────────────

  describe("session security", () => {
    it("logged-out sessions are rejected", async () => {
      await startServer();
      const a = await signUpAndGetAccount("expire-test@agency.com");

      // Verify active session works
      const res1 = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: a.cookie } });
      expect(res1.status).toBe(200);

      // Logout invalidates session
      await fetch(`${baseUrl}/accounts/logout`, {
        method: "POST",
        headers: { Cookie: a.cookie }
      });

      // Same cookie is now rejected
      const res2 = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: a.cookie } });
      expect(res2.status).toBe(401);
    });

    it("CSRF: cross-origin mutation is rejected", async () => {
      await startServer();
      const a = await signUpAndGetAccount("csrf-test@agency.com");

      // Cross-origin POST is rejected
      const res = await fetch(`${baseUrl}/accounts/settings`, {
        method: "PUT",
        headers: {
          Cookie: a.cookie,
          "Content-Type": "application/json",
          "Origin": "https://evil.com"
        },
        body: JSON.stringify({ niche: "hacked" })
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("cross-origin");
    });
  });

  // ─── PHASE 16: HEALTH VS READINESS ────────────────────────────────────────

  describe("health and readiness probes", () => {
    it("/healthz returns 200 when service is running", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("uptimeSeconds");
    });

    it("/readyz checks storage accessibility", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ready");
      expect(body.storage).toBe("accessible");
    });
  });

  // ─── BATCH ROUTE TENANT ISOLATION ─────────────────────────────────────────

  describe("batch routes must not accept client-supplied orgId as authority", () => {
    it("POST /accounts/batch/plan uses the session's orgId, not the request body orgId", async () => {
      await startServer();
      const a = await signUpAndGetAccount("batch-a@agency.com");
      const b = await signUpAndGetAccount("batch-b@agency.com");

      // Create a client for tenant A
      const clientRes = await fetch(`${baseUrl}/accounts/clients`, {
        method: "POST",
        headers: { Cookie: a.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "A Secret Brand",
          niche: "fitness",
          brandVoice: "punchy",
          locale: "en",
          platforms: ["youtube_shorts"],
          targetDurationSec: 25,
          videoVendor: "higgsfield",
          cadence: "manual",
          active: true
        })
      });
      const { client } = await clientRes.json();

      // Tenant B tries to use batch/plan with A's orgId and clientId
      const batchRes = await fetch(`${baseUrl}/accounts/batch/plan`, {
        method: "POST",
        headers: { Cookie: b.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: a.orgId,
          clientId: client.id,
          variations: 3,
          dryRun: true
        })
      });

      // This should either:
      // 1. Return 403 (orgId mismatch detected)
      // 2. Return 404/400 (client not found for B's org)
      // 3. Use B's orgId regardless of what was supplied
      // It must NOT successfully use A's orgId
      if (batchRes.status === 200) {
        const plan = await batchRes.json();
        // If 200, it must have used B's org (not A's), so client lookup should fail
        // or plan should be empty/error
        expect(plan.orgId ?? plan.plan?.orgId).not.toBe(a.orgId);
      } else {
        // Non-200 is acceptable (properly rejected)
        expect([400, 403, 404]).toContain(batchRes.status);
      }
    });
  });
});
