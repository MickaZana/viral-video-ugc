/**
 * VAD atom A5 — batch enqueue metering.
 *
 * Proves the three properties of the enqueue-path billing fix directly against
 * the real route (registerBatchRoutes wired into a bare Express app with an
 * injected fake billing repository — the jobs.test.ts:40 fake pattern):
 *
 *  (a) the quota pre-check consults the INJECTED billing repository, not the
 *      local account-plans.json file. The fixture deliberately never creates
 *      that file (stale/empty = what production Postgres deployments have),
 *      yet plan state from the fake billing repo flips the check to overage —
 *      impossible when the route read the JSON file directly;
 *  (b) reserveRun is called exactly once per live batch with the correct
 *      orgId/runId(=batchId)/clientId/duration, and is NOT called when the
 *      VVUGC_LLM_LIVE / dryRun gates say no vendor spend will happen;
 *  (c) settleReservation is called after successful handoff with the batch's
 *      estimated vendor cost (execution completes in video-worker, which has
 *      no billing handle — the settle chain runs on the enqueue Promise.all).
 *
 * Also implicitly asserts no double-reserve: one reserveRun per batch even
 * though the batch fans out to N provider jobs (runId is the batchId).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express, { type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryProviderJobStore } from "@vvugc/review-queue";

import { registerBatchRoutes, setProviderJobStore } from "./batch-routes.js";
import type { BillingRepository } from "./billing-postgres.js";
import type { IdentityRepository } from "./accounts.js";
import type { TenantProfileRepository } from "./tenant-profile-postgres.js";

const ORG_ID = "org-batch-meter";
const ACCOUNT_ID = "acct-batch-meter";

type TestBilling = BillingRepository & {
  getPlan: ReturnType<typeof vi.fn>;
  reserveRun: ReturnType<typeof vi.fn>;
  settleReservation: ReturnType<typeof vi.fn>;
};

let testDir: string;
let runsDir: string;
let server: Server | undefined;
let baseUrl: string;

const previousRunsDir = process.env.VVUGC_RUNS_DIR;
const previousLlmLive = process.env.VVUGC_LLM_LIVE;

function makeBilling(
  plan: { tierId: string | null; status: "none" | "active" | "past_due" | "canceled" } = { tierId: null, status: "none" }
): TestBilling {
  return {
    getPlan: vi.fn(async () => ({ accountId: ORG_ID, tierId: plan.tierId, status: plan.status, updatedAt: new Date(0).toISOString() })),
    reserveRun: vi.fn(async (input: { orgId: string; runId: string; clientId?: string }) => ({
      id: `res-${input.runId}`,
      orgId: input.orgId,
      runId: input.runId,
      clientId: input.clientId,
      month: new Date().toISOString().slice(0, 7),
      kind: "included" as const,
      amountCents: 0,
      status: "reserved" as const,
      createdAt: new Date().toISOString(),
    })),
    settleReservation: vi.fn(async () => undefined),
    releaseReservation: vi.fn(async () => false),
    findPlanBySubscriptionId: vi.fn(async () => undefined),
    upsertPlan: vi.fn(),
    deletePlan: vi.fn(async () => false),
    overageSummary: vi.fn(async () => ({ count: 0, totalUsd: 0 })),
  } as unknown as TestBilling;
}

async function startApp(billing: BillingRepository): Promise<void> {
  const app = express();
  app.use(express.json());
  const requireSession: RequestHandler = (req, _res, next) => {
    (req as { accountId?: string }).accountId = ACCOUNT_ID;
    next();
  };
  const identity = {
    findById: vi.fn(async (id: string) =>
      id === ACCOUNT_ID ? { id: ACCOUNT_ID, orgId: ORG_ID, email: "batch@example.com" } : undefined
    ),
  } as unknown as IdentityRepository;
  registerBatchRoutes(app, requireSession, {
    identity,
    tenantProfiles: {} as TenantProfileRepository,
    billing,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server!.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

function seedMonthlyRuns(count: number): void {
  const createdAt = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const dir = join(runsDir, `seed-run-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ config: { accountId: ORG_ID, niche: "fitness", createdAt } })
    );
  }
}

function payload(batchId: string, dryRun: boolean) {
  const variation = {
    variationId: `${batchId}-v1`,
    variationLabel: "Variation 1",
    idempotencyKey: `${batchId}-idem`,
    productProfileId: "prod-1",
    hookIndex: 0,
    scriptIndex: 0,
    captionStyle: "clean",
    platform: "youtube_shorts",
    vendor: "kling",
    estimatedCost: 1.2,
    status: "planned",
  };
  return {
    plan: { batchId, variations: [variation], totalEstimatedCost: 1.2, warnings: [], rejected: [] },
    request: {
      productProfileId: "prod-1",
      platforms: ["youtube_shorts"],
      clientId: "client-1",
      orgId: ORG_ID,
      requestedBy: "tester",
      dryRun,
      targetDurationSec: 25,
      maxEstimatedCostUsd: 50,
    },
  };
}

async function enqueue(batchId: string, dryRun: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/accounts/batch/enqueue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload(batchId, dryRun)),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "vvugc-batch-billing-"));
  runsDir = join(testDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  process.env.VVUGC_RUNS_DIR = runsDir;
  vi.stubEnv("VVUGC_LLM_LIVE", "");
  setProviderJobStore(createInMemoryProviderJobStore());
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  if (previousRunsDir === undefined) delete process.env.VVUGC_RUNS_DIR;
  else process.env.VVUGC_RUNS_DIR = previousRunsDir;
  if (previousLlmLive === undefined) delete process.env.VVUGC_LLM_LIVE;
  else process.env.VVUGC_LLM_LIVE = previousLlmLive;
  rmSync(testDir, { recursive: true, force: true });
});

describe("batch enqueue quota pre-check (injected billing path)", () => {
  it("reflects plan state from the injected billing repository, not the local account-plans.json file", async () => {
    // Production reality under the bug: account-plans.json is stale/empty, so
    // the old file-only read saw plan.status "none" and never reported
    // overage. Here the file does not exist AT ALL, yet the injected
    // repository says active-starter and the runs dir shows 4/4 included
    // runs used — the pre-check must surface overage from that.
    expect(existsSync(join(runsDir, "account-plans.json"))).toBe(false);
    seedMonthlyRuns(4);
    const billing = makeBilling({ tierId: "starter", status: "active" });
    await startApp(billing);

    const { status, body } = await enqueue("batch_precheck_injected", true);

    expect(status).toBe(202);
    expect(billing.getPlan).toHaveBeenCalledWith(ORG_ID);
    expect(body.overage).toBe(true);
    expect(body.overagePriceUsdPerRun).toBe(6);
    // Dry-run batch: the pre-check answers truthfully but meters nothing.
    expect(billing.reserveRun).not.toHaveBeenCalled();
    expect(billing.settleReservation).not.toHaveBeenCalled();
  });

  it("reports no overage when the injected repository says the account has no active plan", async () => {
    seedMonthlyRuns(4);
    const billing = makeBilling({ tierId: null, status: "none" });
    await startApp(billing);

    const { status, body } = await enqueue("batch_precheck_noplan", true);

    expect(status).toBe(202);
    expect(billing.getPlan).toHaveBeenCalledWith(ORG_ID);
    expect(body.overage).toBe(false);
  });
});

describe("batch enqueue metering (reserve/settle)", () => {
  it("reserves exactly once per live batch with orgId/runId/clientId/duration, then settles with the estimated cost", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    const billing = makeBilling({ tierId: "starter", status: "active" });
    await startApp(billing);
    const batchId = "batch_live_meter";

    const { status, body } = await enqueue(batchId, false);

    expect(status).toBe(202);
    expect(body.isDryRun).toBe(false);
    // One reservation for the whole batch — the batchId is the runId for
    // every child provider job, and reserveRun is idempotent per
    // (orgId, runId), so the N-job fan-out cannot double-reserve.
    expect(billing.reserveRun).toHaveBeenCalledTimes(1);
    expect(billing.reserveRun).toHaveBeenCalledWith({
      orgId: ORG_ID,
      runId: batchId,
      clientId: "client-1",
      durationSec: 25,
      usageRunCount: 0,
    });

    // Settle runs on the fire-and-forget enqueue chain — wait for it.
    await vi.waitFor(() => expect(billing.settleReservation).toHaveBeenCalledTimes(1));
    expect(billing.settleReservation).toHaveBeenCalledWith({
      orgId: ORG_ID,
      runId: batchId,
      estimatedVendorCostUsd: 1.2,
    });
  });

  it("never reserves or settles when the request explicitly asks for a dry run", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    const billing = makeBilling({ tierId: "starter", status: "active" });
    await startApp(billing);

    const { status, body } = await enqueue("batch_dryrun_no_spend", true);

    expect(status).toBe(202);
    expect(body.isDryRun).toBe(true);
    expect(billing.reserveRun).not.toHaveBeenCalled();
    expect(billing.settleReservation).not.toHaveBeenCalled();
  });

  it("never reserves or settles when VVUGC_LLM_LIVE is not enabled (no vendor spend possible)", async () => {
    // beforeEach stubs VVUGC_LLM_LIVE to "" — the env half of the two-key gate.
    vi.stubEnv("VVUGC_LLM_LIVE", "");
    const billing = makeBilling({ tierId: "starter", status: "active" });
    await startApp(billing);

    const { status, body } = await enqueue("batch_gate_off_no_spend", false);

    expect(status).toBe(202);
    expect(body.isDryRun).toBe(true);
    expect(billing.reserveRun).not.toHaveBeenCalled();
    expect(billing.settleReservation).not.toHaveBeenCalled();
  });
});
