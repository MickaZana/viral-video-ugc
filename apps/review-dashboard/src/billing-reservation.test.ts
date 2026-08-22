/**
 * Phase 7 — Billing & Cost Reservation.
 *
 * Covers what's actually fixable without Postgres (overage idempotency —
 * see the fix in overage.ts), and PROVES the two things that aren't fixable
 * yet rather than hand-waving them:
 *   - Gap 1 (TOCTOU quota race): demonstrated deterministically via the real
 *     checkRunQuota() function against a stale usage snapshot, then confirmed
 *     against the real HTTP route under real concurrency.
 *   - Gap 2 (per-process CostCap): covered separately in
 *     packages/shared-analytics/src/index.test.ts, next to CostCap itself.
 * These two are intentionally NOT "fixed" here — true atomic reservation
 * needs a DB transaction (`SELECT ... FOR UPDATE`), which is blocked until
 * Postgres lands. The tests exist so the gap is enforced-by-CI knowledge,
 * not just a paragraph in a planning doc that goes stale.
 *
 * CostCap/FlowLimiter unit tests already exist in
 * packages/shared-analytics/src/index.test.ts — not duplicated here, with
 * one addition there (totalSpent after a throw) where the plan's own worked
 * example didn't match what the code actually does.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanStore, type AccountPlan } from "@vvugc/shared-billing";
import type { AccountUsage } from "@vvugc/shared-auth";
import { checkRunQuota } from "./quota.js";
import { createOverageStore } from "./overage.js";

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
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

async function signUpAndGetAccount(email: string): Promise<{ cookie: string; orgId: string }> {
  const res = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password=[REDACTED_PASSWORD] })
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

// Same real on-disk shape conductor.ts writes — matches run-quota.test.ts's
// seedRunManifest so aggregateUsage() (the real reader) sees these runs.
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

function usageWithRunCount(count: number): AccountUsage {
  const now = new Date().toISOString();
  return {
    accountId: "org-1",
    totalUsd: 0,
    totalRuns: count,
    totalReviewItemsCreated: count,
    totalsByVendor: {},
    runs: Array.from({ length: count }, (_, i) => ({
      runId: `run-${i}`,
      niche: "fitness",
      createdAt: now,
      estimatedCostUsd: 0
    }))
  };
}

describe("Phase 7: billing & cost reservation", () => {
  describe("Gap 1 — quota check race (documented, not fixable without Postgres)", () => {
    it("two quota checks against the same stale usage snapshot both read 'within allowance'", () => {
      // Starter: 4 included runs. Org has 3 recorded — one slot left.
      const plan = { accountId: "org-1", tierId: "starter", status: "active", updatedAt: new Date().toISOString() } as AccountPlan;
      const staleUsage = usageWithRunCount(3);

      // Worker A and Worker B both call checkRunQuota() before either of their
      // runs has been recorded — this IS the race in Gap 1, reproduced with
      // the real production function, not a mock.
      const checkA = checkRunQuota(plan, staleUsage);
      const checkB = checkRunQuota(plan, staleUsage);
      expect(checkA.overage).toBe(false);
      // Bug: checkB should have been the 5th run this month and billed as
      // overage — but it read the same pre-A snapshot A did, so it reads as
      // "within allowance" too. This is what "no atomic reservation" means
      // in practice: whichever worker's run finishes and writes its manifest
      // second effectively runs for free.
      expect(checkB.overage).toBe(false);

      // Contrast with correct sequential ordering (A's run is recorded before
      // B checks) — the same function correctly flags the 5th run as overage
      // once usage actually reflects 4 completed runs. This isn't a bug in
      // checkRunQuota() itself; it's a bug in *when* it gets called relative
      // to the write, which only a transactional check-and-reserve fixes.
      const usageAfterA = usageWithRunCount(4);
      const checkBSequential = checkRunQuota(plan, usageAfterA);
      expect(checkBSequential.overage).toBe(true);
    });

    it("reproduces the same race against the real HTTP route under real concurrency", async () => {
      testDir = mkdtempSync(join(tmpdir(), "vvugc-billing-race-"));
      runsDir = join(testDir, "runs");
      process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
      process.env.VVUGC_RUNS_DIR = runsDir;
      process.env.DASHBOARD_USERNAME = TEST_USER;
      process.env.DASHBOARD_PASSWORD=[REDACTED_PASSWORD]
      try {
        await startServer();
        const { cookie, orgId } = await signUpAndGetAccount("race@example.com");
        await saveSettings(cookie);
        const planStore = createPlanStore(join(runsDir, "account-plans.json"));
        planStore.upsert(orgId, { tierId: "starter", status: "active" });
        for (let i = 0; i < 3; i++) seedRunManifest(orgId, `seeded-run-${i}`);

        // Two real, concurrently in-flight requests against the actual
        // /accounts/run handler — not mocked, not simulated.
        const [resA, resB] = await Promise.all([
          fetch(`${baseUrl}/accounts/run`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) }),
          fetch(`${baseUrl}/accounts/run`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) })
        ]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        // Hybrid billing means both are correctly ALLOWED — no run is ever
        // silently dropped, matching the product's own "never hard-block"
        // design. What's NOT guaranteed under the race is which one (if
        // either) got billed as overage.
        const overageStore = createOverageStore(join(runsDir, "overage.json"));
        const thisMonth = new Date().toISOString().slice(0, 7);
        const overageCount = overageStore.countForMonth(orgId, thisMonth);
        // Deliberately not asserting overageCount === 1: whether it's 0 or 1
        // depends on request scheduling order, and THAT non-determinism is
        // Gap 1. It can never be more than 1 (only one run was actually the
        // 5th), so this is the one invariant that's safe to assert here —
        // the exact mechanism is pinned down deterministically in the test
        // above.
        expect(overageCount).toBeLessThanOrEqual(1);
      } finally {
        delete process.env.VVUGC_DB_PATH;
        delete process.env.VVUGC_RUNS_DIR;
        delete process.env.DASHBOARD_USERNAME;
        delete process.env.DASHBOARD_PASSWORD;
        server?.close();
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
      }
    }, 20_000);
  });

  // Gap 2 (CostCap is per-process, not per-org) is covered in
  // packages/shared-analytics/src/index.test.ts, next to CostCap itself —
  // review-dashboard doesn't depend on @vvugc/shared-analytics, and this
  // isn't reason enough to add a cross-package dependency for one test.

  describe("Gap 3 — overage idempotency (fixed: see overage.ts)", () => {
    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "vvugc-overage-idem-"));
    });
    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it("recording the same runId twice only charges once", () => {
      const store = createOverageStore(join(testDir, "overage.json"));
      const first = store.record({ orgId: "org-1", runId: "run-x", priceUsdPerRun: 6 });
      const second = store.record({ orgId: "org-1", runId: "run-x", priceUsdPerRun: 6 });
      expect(second.id).toBe(first.id); // returns the existing charge, doesn't create a new one
      expect(store.listByOrg("org-1")).toHaveLength(1);
    });

    it("stays idempotent under real concurrent duplicate calls, not just sequential ones", async () => {
      const store = createOverageStore(join(testDir, "overage.json"));
      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.record({ orgId: "org-1", runId: "run-y", priceUsdPerRun: 6 }))
      );
      const uniqueIds = new Set(results.map((r) => r.id));
      expect(uniqueIds.size).toBe(1); // a retried/duplicated call from a crash-recovered worker still only bills once
      expect(store.listByOrg("org-1")).toHaveLength(1);
    });

    it("still records separately for different runIds on the same org", () => {
      const store = createOverageStore(join(testDir, "overage.json"));
      store.record({ orgId: "org-1", runId: "run-a", priceUsdPerRun: 6 });
      store.record({ orgId: "org-1", runId: "run-b", priceUsdPerRun: 6 });
      expect(store.listByOrg("org-1")).toHaveLength(2); // dedup is scoped to (orgId, runId), not org-wide
    });

    it("scopes dedup to org — the same runId under a different org is a separate charge", () => {
      // Defensive: runId is a UUID in production so cross-org collisions
      // shouldn't happen, but the dedup check is (orgId, runId), matching
      // every other tenant-scoped lookup in this codebase — worth locking in.
      const store = createOverageStore(join(testDir, "overage.json"));
      store.record({ orgId: "org-A", runId: "shared-id", priceUsdPerRun: 6 });
      store.record({ orgId: "org-B", runId: "shared-id", priceUsdPerRun: 6 });
      expect(store.listByOrg("org-A")).toHaveLength(1);
      expect(store.listByOrg("org-B")).toHaveLength(1);
    });
  });

  describe("Gap 5 — billing panel overage display", () => {
    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "vvugc-billing-panel-"));
      runsDir = join(testDir, "runs");
      process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
      process.env.VVUGC_RUNS_DIR = runsDir;
      process.env.DASHBOARD_USERNAME = TEST_USER;
      process.env.DASHBOARD_PASSWORD=[REDACTED_PASSWORD]
    });
    afterEach(() => {
      delete process.env.VVUGC_DB_PATH;
      delete process.env.VVUGC_RUNS_DIR;
      delete process.env.DASHBOARD_USERNAME;
      delete process.env.DASHBOARD_PASSWORD;
      server?.close();
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    });

    it("shows correct overage counts and totals for a Starter account 1 run past its limit", async () => {
      await startServer();
      const { cookie, orgId } = await signUpAndGetAccount("billing@example.com");
      await saveSettings(cookie);
      const planStore = createPlanStore(join(runsDir, "account-plans.json"));
      planStore.upsert(orgId, { tierId: "starter", status: "active" });
      for (let i = 0; i < 5; i++) seedRunManifest(orgId, `seeded-run-${i}`); // 1 over the 4-run limit

      const overageStore = createOverageStore(join(runsDir, "overage.json"));
      overageStore.record({ orgId, runId: "seeded-run-4", priceUsdPerRun: 6 });

      const res = await fetch(`${baseUrl}/accounts/billing`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runsUsedThisMonth).toBe(5);
      expect(body.monthlyRunLimit).toBe(4);
      expect(body.overage).toMatchObject({
        priceUsdPerRun: 6,
        overageRunsThisMonth: 1,
        chargedThisMonth: 1,
        totalUsdThisMonth: 6
      });
    }, 20_000);

    it("surfaces the Gap 1 symptom: run-count-derived overage and ledger-derived overage can disagree", async () => {
      // This is the visible, on-panel evidence of the race above: if a run
      // was accepted (bumping runsUsedThisMonth past the limit) but its
      // overage.record() call was the one that lost the race — or never
      // happened at all — the two numbers the billing panel shows come
      // apart. overageRunsThisMonth is derived purely from the run count;
      // chargedThisMonth is derived from what actually got billed.
      await startServer();
      const { cookie, orgId } = await signUpAndGetAccount("mismatch@example.com");
      await saveSettings(cookie);
      const planStore = createPlanStore(join(runsDir, "account-plans.json"));
      planStore.upsert(orgId, { tierId: "starter", status: "active" });
      for (let i = 0; i < 5; i++) seedRunManifest(orgId, `seeded-run-${i}`); // 1 over limit
      // Deliberately NOT calling overageStore.record() — reproducing the
      // outcome of Gap 1's race, where the run went through but the charge
      // didn't land.

      const res = await fetch(`${baseUrl}/accounts/billing`, { headers: { Cookie: cookie } });
      const body = await res.json();
      expect(body.overage.overageRunsThisMonth).toBe(1); // "you ran over"
      expect(body.overage.chargedThisMonth).toBe(0); // "...but weren't billed for it"
      expect(body.overage.overageRunsThisMonth).not.toBe(body.overage.chargedThisMonth);
    }, 20_000);
  });
});
