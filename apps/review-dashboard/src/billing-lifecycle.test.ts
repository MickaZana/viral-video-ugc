import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBillingRepository, PostgresBillingRepository } from "./billing-postgres.js";
import { applyStripeWebhookEventPostgres } from "./billing.js";
import { runIdForIdempotency } from "./accounts.js";

const directories: string[] = [];
function local() { const dir = mkdtempSync(join(tmpdir(), "vvugc-billing-lifecycle-")); directories.push(dir); return new LocalBillingRepository(dir); }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("billing reservation lifecycle (local adapter)", () => {
  it("releases a failed pre-execution overage and allows the same run id to reserve again", async () => {
    const billing = local(); await billing.upsertPlan("org", { tierId: "starter", status: "active" });
    const first = await billing.reserveRun({ orgId: "org", runId: "run", usageRunCount: 4 });
    expect(first.kind).toBe("overage");
    expect((await billing.overageSummary("org")).count).toBe(1);
    expect(await billing.releaseReservation({ orgId: "org", runId: "run" })).toBe(true);
    expect((await billing.overageSummary("org")).count).toBe(0);
    const retry = await billing.reserveRun({ orgId: "org", runId: "run", usageRunCount: 4 });
    expect(retry.kind).toBe("overage"); expect((await billing.overageSummary("org")).count).toBe(1);
  });
  it("maps an idempotent enqueue retry without a body run id to one reservation", async () => {
    const billing = local(); await billing.upsertPlan("org", { tierId: "starter", status: "active" });
    const runId = runIdForIdempotency("org", "retry-key");
    expect(runIdForIdempotency("org", "retry-key")).toBe(runId);
    await billing.reserveRun({ orgId: "org", runId, usageRunCount: 4 });
    await billing.reserveRun({ orgId: "org", runId, usageRunCount: 4 });
    expect((await billing.overageSummary("org")).count).toBe(1);
  });
});

describe("Stripe prerequisite ordering", () => {
  it("does not acknowledge an update or deletion before checkout has associated the subscription", async () => {
    const missing = { findPlanBySubscriptionId: async () => undefined } as unknown as PostgresBillingRepository;
    await expect(applyStripeWebhookEventPostgres({ type: "customer.subscription.updated", created: 20, data: { object: { id: "sub-x", status: "canceled" } } }, missing)).rejects.toThrow(/before checkout/i);
    await expect(applyStripeWebhookEventPostgres({ type: "customer.subscription.deleted", created: 20, data: { object: { id: "sub-x" } } }, missing)).rejects.toThrow(/before checkout/i);
  });
});
