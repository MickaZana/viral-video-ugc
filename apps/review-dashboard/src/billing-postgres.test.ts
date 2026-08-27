import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@vvugc/shared-persistence";
import { MIGRATIONS, runMigrations } from "@vvugc/review-queue";
import { PostgresBillingRepository } from "./billing-postgres.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let database: IsolatedTestDatabase;
let billing: PostgresBillingRepository;
let sequence = 0;
async function organization(id = `org-billing-${++sequence}`) {
  await database.pool.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [id, id]);
  return id;
}

describe.skipIf(!TEST_DATABASE_URL)("PostgresBillingRepository", () => {
  beforeAll(async () => { database = await createIsolatedTestDatabase(); await runMigrations(database.pool, MIGRATIONS); billing = new PostgresBillingRepository(database.pool); });
  afterAll(async () => { await database?.dispose(); });

  it("makes duplicate Stripe event delivery a no-op with exactly one durable receipt", async () => {
    const orgId = await organization();
    const event = { id: "evt-duplicate", type: "checkout.session.completed", data: { object: {} } };
    const apply = async (transactional: PostgresBillingRepository) => { await transactional.upsertPlan(orgId, { tierId: "starter", status: "active", stripeSubscriptionId: "sub-duplicate" }); return orgId; };
    expect(await billing.processStripeEvent(event, apply)).toBe(true);
    expect(await billing.processStripeEvent(event, apply)).toBe(false);
    expect((await database.pool.query("SELECT * FROM stripe_webhook_events WHERE event_id=$1", [event.id])).rowCount).toBe(1);
    expect((await billing.getPlan(orgId)).stripeSubscriptionId).toBe("sub-duplicate");
  });

  it("serializes concurrent reservations and only bills the run beyond the allowance", async () => {
    const orgId = await organization();
    await billing.upsertPlan(orgId, { tierId: "starter", status: "active" });
    const reservations = await Promise.all(Array.from({ length: 5 }, (_, index) => billing.reserveRun({ orgId, runId: `run-${index}` })));
    expect(reservations.filter((row) => row.kind === "included")).toHaveLength(4);
    expect(reservations.filter((row) => row.kind === "overage")).toHaveLength(1);
    await Promise.all(reservations.map((row) => billing.settleReservation({ orgId, runId: row.runId })));
    expect(await billing.overageSummary(orgId)).toEqual({ count: 1, totalUsd: 6 });
  });

  it("tenant scopes reservations and cascades billing state on organization deletion", async () => {
    const first = await organization(); const second = await organization();
    await Promise.all([billing.reserveRun({ orgId: first, runId: "same-run" }), billing.reserveRun({ orgId: second, runId: "same-run" })]);
    expect((await database.pool.query("SELECT * FROM billing_run_reservations WHERE run_id='same-run'")).rowCount).toBe(2);
    await database.pool.query("DELETE FROM organizations WHERE id=$1", [first]);
    expect((await database.pool.query("SELECT * FROM billing_run_reservations WHERE org_id=$1", [first])).rowCount).toBe(0);
    expect((await database.pool.query("SELECT * FROM billing_run_reservations WHERE org_id=$1", [second])).rowCount).toBe(1);
  });

  it("releases a reserved overage atomically so a retry can reserve it once", async () => {
    const orgId = await organization(); await billing.upsertPlan(orgId, { tierId: "starter", status: "active" });
    await Promise.all(Array.from({ length: 4 }, (_, index) => billing.reserveRun({ orgId, runId: `included-${index}` })));
    expect((await billing.reserveRun({ orgId, runId: "retry-run" })).kind).toBe("overage");
    expect(await billing.releaseReservation({ orgId, runId: "retry-run" })).toBe(true);
    const row = await database.pool.query<{ status: string }>("SELECT status FROM billing_run_reservations WHERE org_id=$1 AND run_id='retry-run'", [orgId]);
    expect(row.rows[0]?.status).toBe("released");
    // The same retry id is restored atomically; it must not create a second
    // financial row or consume another allowance slot.
    expect((await billing.reserveRun({ orgId, runId: "retry-run" })).status).toBe("reserved");
    expect((await database.pool.query("SELECT * FROM billing_run_reservations WHERE org_id=$1 AND run_id='retry-run'", [orgId])).rowCount).toBe(1);
  });

  it("does not let an older Stripe event overwrite a newer cancellation", async () => {
    const orgId = await organization();
    await billing.applyStripePlanEvent(orgId, { tierId: "starter", status: "canceled", stripeSubscriptionId: `sub-order-${sequence}` }, 200);
    await billing.applyStripePlanEvent(orgId, { tierId: "starter", status: "active", stripeSubscriptionId: `sub-order-${sequence}` }, 100);
    expect((await billing.getPlan(orgId)).status).toBe("canceled");
  });

  it("rolls back an unprocessable Stripe receipt so delivery remains retryable", async () => {
    const event = { id: `evt-prerequisite-${sequence}`, type: "customer.subscription.updated", created: 10, data: { object: {} } };
    await expect(billing.processStripeEvent(event, async () => { throw new Error("checkout prerequisite missing"); })).rejects.toThrow(/prerequisite/);
    expect((await database.pool.query("SELECT * FROM stripe_webhook_events WHERE event_id=$1", [event.id])).rowCount).toBe(0);
  });
  it("uses one reservation for concurrent idempotent retries of the same run", async () => {
    const orgId = await organization(); await billing.upsertPlan(orgId, { tierId: "starter", status: "active" });
    await Promise.all(Array.from({ length: 4 }, (_, index) => billing.reserveRun({ orgId, runId: `base-${index}` })));
    const rows = await Promise.all(Array.from({ length: 6 }, () => billing.reserveRun({ orgId, runId: "idem-retry" })));
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect((await database.pool.query("SELECT * FROM billing_run_reservations WHERE org_id=$1 AND run_id='idem-retry'", [orgId])).rowCount).toBe(1);
  });
});
