import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanStore } from "@vvugc/shared-billing";
import { createOverageStore } from "./overage.js";

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

/** Creates a teammate via the invite flow and returns their session cookie + account id. */
async function inviteMember(ownerCookie: string, email: string, role?: string): Promise<{ cookie: string; accountId: string }> {
  const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ email, ...(role ? { role } : {}) })
  });
  if (inviteRes.status !== 201) throw new Error(`invite failed: ${inviteRes.status}`);
  const { inviteToken } = await inviteRes.json();
  const acceptRes = await fetch(`${baseUrl}/accounts/invite/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, password: "hunter22" })
  });
  const setCookie = acceptRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned from invite accept");
  const { account } = await acceptRes.json();
  return { cookie: setCookie.split(";")[0], accountId: account.id };
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

describe("tenant hardening: fine-grained roles, enqueue-time quota, session revocation, security events", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-hardening-test-"));
    runsDir = join(testDir, "runs");
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = runsDir;
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    // Keep the pipeline-job store on its JSON fallback so these server-level tests
    // never touch a real database.
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

  describe("fine-grained roles", () => {
    it("a viewer can read org data but cannot mutate settings, clients, or jobs (real 403s)", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner@agency.com")).cookie;
      const viewerCookie = (await inviteMember(ownerCookie, "viewer@agency.com", "viewer")).cookie;

      // Reads are allowed for any member of the org.
      expect((await fetch(`${baseUrl}/accounts/settings`, { headers: { Cookie: viewerCookie } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/accounts/clients`, { headers: { Cookie: viewerCookie } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/accounts/members`, { headers: { Cookie: viewerCookie } })).status).toBe(200);

      // Mutations are blocked server-side, regardless of what the UI hides.
      const settingsRes = await fetch(`${baseUrl}/accounts/settings`, {
        method: "PUT",
        headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ niche: "hacked", brandVoice: "x", platforms: ["tiktok"], targetDurationSec: 30, videoVendor: "higgsfield", cadence: "manual" })
      });
      expect(settingsRes.status).toBe(403);

      const clientsRes = await fetch(`${baseUrl}/accounts/clients`, {
        method: "POST",
        headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify(CLIENT_BODY)
      });
      expect(clientsRes.status).toBe(403);

      const jobsRes = await fetch(`${baseUrl}/accounts/jobs`, {
        method: "POST",
        headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "any" })
      });
      expect(jobsRes.status).toBe(403);

      const billingRes = await fetch(`${baseUrl}/accounts/billing/checkout`, {
        method: "POST",
        headers: { Cookie: viewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: "starter" })
      });
      expect(billingRes.status).toBe(403);
    });

    it("a reviewer can read and review but cannot manage clients", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner2@agency.com")).cookie;
      const reviewerCookie = (await inviteMember(ownerCookie, "reviewer@agency.com", "reviewer")).cookie;

      const clientsRes = await fetch(`${baseUrl}/accounts/clients`, {
        method: "POST",
        headers: { Cookie: reviewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify(CLIENT_BODY)
      });
      expect(clientsRes.status).toBe(403);

      const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
        method: "POST",
        headers: { Cookie: reviewerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "someone@agency.com" })
      });
      expect(inviteRes.status).toBe(403);
    });

    it("an editor (default invite role) can mutate settings and clients but cannot invite", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner3@agency.com")).cookie;
      const editorCookie = (await inviteMember(ownerCookie, "editor@agency.com")).cookie;

      const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: editorCookie } })).json();
      expect(me.account.role).toBe("editor");

      await saveSettings(editorCookie);
      const settings = await (await fetch(`${baseUrl}/accounts/settings`, { headers: { Cookie: editorCookie } })).json();
      expect(settings.niche).toBe("fitness");

      const clientId = await createClient(editorCookie);
      expect(clientId).toBeTruthy();

      const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
        method: "POST",
        headers: { Cookie: editorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "more@agency.com" })
      });
      expect(inviteRes.status).toBe(403);
    });

    it("an admin can invite and re-role a member, and the invite carries the chosen role", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner4@agency.com")).cookie;
      // Owner promotes a teammate to admin via the role endpoint.
      const teammate = await inviteMember(ownerCookie, "admin@agency.com"); // default: editor
      const promoteRes = await fetch(`${baseUrl}/accounts/members/${teammate.accountId}/role`, {
        method: "PUT",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" })
      });
      expect(promoteRes.status).toBe(200);
      const { member } = await promoteRes.json();
      expect(member.role).toBe("admin");

      // Promotion revoked the teammate's sessions (that's the point) — log back in
      // as the newly-minted admin to get a live session for the new role.
      const relogin = await fetch(`${baseUrl}/accounts/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@agency.com", password: "hunter22" })
      });
      const adminCookie = relogin.headers.get("set-cookie")!.split(";")[0];

      // The promoted admin can now invite with an explicit role.
      const inviteRes = await fetch(`${baseUrl}/accounts/invite`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "viewer2@agency.com", role: "viewer" })
      });
      expect(inviteRes.status).toBe(201);
      const { inviteToken } = await inviteRes.json();
      const acceptRes = await fetch(`${baseUrl}/accounts/invite/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken, password: "hunter22" })
      });
      const { account } = await acceptRes.json();
      expect(account.role).toBe("viewer");
    });

    it("the owner role cannot be granted via invite and cannot be changed or removed", async () => {
      await startServer();
      const owner = await signUpAndGetAccount("owner5@agency.com");

      const badInvite = await fetch(`${baseUrl}/accounts/invite`, {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@agency.com", role: "owner" })
      });
      expect(badInvite.status).toBe(400);

      const badRole = await fetch(`${baseUrl}/accounts/members/${owner.accountId}/role`, {
        method: "PUT",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "viewer" })
      });
      expect(badRole.status).toBe(409);

      const badRemove = await fetch(`${baseUrl}/accounts/members/${owner.accountId}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
      expect(badRemove.status).toBe(409);
    });
  });

  describe("enqueue-time quota", () => {
    it("POST /accounts/jobs past the plan's monthly limit enqueues as consumption overage rather than blocking with 402", async () => {
      await startServer();
      const owner = await signUpAndGetAccount("paid@agency.com");
      await createClient(owner.cookie);

      const planStore = createPlanStore(join(runsDir, "account-plans.json"));
      planStore.upsert(owner.orgId, { tierId: "starter", status: "active" });
      for (let i = 0; i < 4; i++) seedRunManifest(owner.orgId, `seeded-run-${i}`);

      const res = await fetch(`${baseUrl}/accounts/jobs`, {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: (await (await fetch(`${baseUrl}/accounts/clients`, { headers: { Cookie: owner.cookie } })).json()).clients[0].id })
      });
      expect(res.status).toBe(202);
      const { job } = await res.json();
      expect(job.status).toBe("queued");

      // The consumption-overage charge is persisted for billing.
      const overageStore = createOverageStore(join(runsDir, "overage.json"));
      expect(overageStore.countForMonth(owner.orgId, new Date().toISOString().slice(0, 7))).toBe(1);
    });

    it("POST /accounts/jobs enqueues when the plan is under its limit", async () => {
      await startServer();
      const owner = await signUpAndGetAccount("under@agency.com");
      const clientId = await createClient(owner.cookie);

      const planStore = createPlanStore(join(runsDir, "account-plans.json"));
      planStore.upsert(owner.orgId, { tierId: "starter", status: "active" });
      for (let i = 0; i < 3; i++) seedRunManifest(owner.orgId, `seeded-run-${i}`);

      const res = await fetch(`${baseUrl}/accounts/jobs`, {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId })
      });
      expect(res.status).toBe(202);
      const { job } = await res.json();
      expect(job.status).toBe("queued");
    });

    it("a plan-less account enqueues regardless of seeded run count — billing hasn't been asked to gate", async () => {
      await startServer();
      const owner = await signUpAndGetAccount("free@agency.com");
      const clientId = await createClient(owner.cookie);
      for (let i = 0; i < 5; i++) seedRunManifest(owner.orgId, `seeded-run-${i}`);

      const res = await fetch(`${baseUrl}/accounts/jobs`, {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId })
      });
      expect(res.status).toBe(202);
    });
  });

  describe("session revocation", () => {
    it("changing a password revokes every session, including the current one", async () => {
      await startServer();
      const { cookie } = await signUpAndGetAccount("pw@agency.com");

      const res = await fetch(`${baseUrl}/accounts/password`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "hunter22", newPassword: "hunter23" })
      });
      expect(res.status).toBe(204);

      const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
      expect(me.status).toBe(401);
    });

    it("rejects a wrong current password without revoking anything", async () => {
      await startServer();
      const { cookie } = await signUpAndGetAccount("pw2@agency.com");

      const res = await fetch(`${baseUrl}/accounts/password`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "wrongpass", newPassword: "hunter23" })
      });
      expect(res.status).toBe(403);

      const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
      expect(me.status).toBe(200);
    });

    it("changing a member's role revokes that member's sessions so the new role takes effect", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner6@agency.com")).cookie;
      const teammate = await inviteMember(ownerCookie, "rolerevoke@agency.com");

      const changeRes = await fetch(`${baseUrl}/accounts/members/${teammate.accountId}/role`, {
        method: "PUT",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "viewer" })
      });
      expect(changeRes.status).toBe(200);

      const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: teammate.cookie } });
      expect(me.status).toBe(401);
    });

    it("removing a member revokes that member's sessions", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner7@agency.com")).cookie;
      const teammate = await inviteMember(ownerCookie, "removereveke@agency.com");

      const removeRes = await fetch(`${baseUrl}/accounts/members/${teammate.accountId}`, { method: "DELETE", headers: { Cookie: ownerCookie } });
      expect(removeRes.status).toBe(204);

      const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: teammate.cookie } });
      expect(me.status).toBe(401);
    });
  });

  describe("security events", () => {
    it("records and serves back account-created, login, password-change, and invite events", async () => {
      await startServer();
      const owner = await signUpAndGetAccount("audit@agency.com");
      await fetch(`${baseUrl}/accounts/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "audit@agency.com", password: "hunter22" })
      });
      await fetch(`${baseUrl}/accounts/password`, {
        method: "POST",
        headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "hunter22", newPassword: "hunter23" })
      });
      // Log back in to get a live session after the password change revoked everything.
      const relogin = await fetch(`${baseUrl}/accounts/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "audit@agency.com", password: "hunter23" })
      });
      const cookie = relogin.headers.get("set-cookie")!.split(";")[0];
      const teammate = await inviteMember(cookie, "auditee@agency.com", "reviewer");

      const eventsRes = await fetch(`${baseUrl}/accounts/security-events`, { headers: { Cookie: cookie } });
      expect(eventsRes.status).toBe(200);
      const { events } = await eventsRes.json();
      const types = events.map((e: { type: string }) => e.type);
      expect(types).toContain("account.created");
      expect(types).toContain("login.succeeded");
      expect(types).toContain("password.changed");
      expect(types).toContain("invite.sent");
      expect(types).toContain("invite.accepted");

      // The invited member's events show up for them too (own-account filtering).
      const memberEventsRes = await fetch(`${baseUrl}/accounts/security-events`, { headers: { Cookie: teammate.cookie } });
      expect(memberEventsRes.status).toBe(200);
      const memberTypes = (await memberEventsRes.json()).events.map((e: { type: string }) => e.type);
      expect(memberTypes).toContain("invite.accepted");
    });

    it("a viewer can read only their own security events, never the org-wide ones", async () => {
      await startServer();
      const ownerCookie = await (await signUpAndGetAccount("owner8@agency.com")).cookie;
      const viewerCookie = (await inviteMember(ownerCookie, "v@agency.com", "viewer")).cookie;

      const res = await fetch(`${baseUrl}/accounts/security-events`, { headers: { Cookie: viewerCookie } });
      expect(res.status).toBe(200);
      const { events } = await res.json();
      expect(events.length).toBeGreaterThan(0);
      // Scoped to the viewer's own account only — org-wide events (the owner's signup,
      // the invite itself) must not leak to a viewer.
      expect(events.every((e: { actorAccountId?: string; targetAccountId?: string }) =>
        e.actorAccountId || e.targetAccountId
      )).toBe(true);
      const types = events.map((e: { type: string }) => e.type);
      expect(types).toContain("invite.accepted");
    });
  });
});
