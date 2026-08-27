import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "@vvugc/shared-persistence";
import { computeOverageCost, getTier, type AccountPlan, type PlanStatus } from "@vvugc/shared-billing";
import { createPlanStore } from "@vvugc/shared-billing";
import { createOverageStore } from "./overage.js";

export interface BillingReservation {
  id: string; orgId: string; runId: string; clientId?: string; month: string;
  kind: "included" | "overage"; amountCents: number; status: "reserved" | "settled" | "released"; createdAt: string;
}
export interface BillingOverageCharge {
  id: string; orgId: string; runId: string; month: string; amountCents: number; estimatedVendorCostCents: number; clientId?: string; createdAt: string;
}
export interface BillingRepository {
  getPlan(orgId: string): Promise<AccountPlan>;
  findPlanBySubscriptionId(subscriptionId: string): Promise<AccountPlan | undefined>;
  upsertPlan(orgId: string, update: Partial<Omit<AccountPlan, "accountId" | "updatedAt">>): Promise<AccountPlan>;
  deletePlan(orgId: string): Promise<boolean>;
  reserveRun(input: { orgId: string; runId: string; clientId?: string; durationSec?: number; usageRunCount?: number }): Promise<BillingReservation>;
  settleReservation(input: { orgId: string; runId: string; estimatedVendorCostUsd?: number }): Promise<BillingOverageCharge | undefined>;
  releaseReservation(input: { orgId: string; runId: string }): Promise<boolean>;
  overageSummary(orgId: string, billingMonth?: string): Promise<{ count: number; totalUsd: number }>;
}

const month = () => new Date().toISOString().slice(0, 7);
const cents = (value: number) => Math.round(value * 100);
const dollars = (value: number) => value / 100;
const planFrom = (row: Record<string, unknown> | undefined, orgId: string): AccountPlan => row
  ? { accountId: orgId, tierId: row.tier_id ? String(row.tier_id) : null, status: String(row.status) as PlanStatus, stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : undefined, stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : undefined, updatedAt: new Date(String(row.updated_at)).toISOString() }
  : { accountId: orgId, tierId: null, status: "none", updatedAt: new Date(0).toISOString() };

/** PostgreSQL is the production billing source of truth.  Every mutating call
 * uses a transaction; reservation allocation takes an advisory xact lock keyed
 * by tenant so concurrent workers cannot both consume the final included run. */
export class PostgresBillingRepository {
  constructor(private readonly pool: Pool) {}
  async getPlan(orgId: string) { return planFrom((await this.pool.query("SELECT * FROM billing_plans WHERE org_id=$1", [orgId])).rows[0], orgId); }
  async findPlanBySubscriptionId(subscriptionId: string) { const row = (await this.pool.query("SELECT * FROM billing_plans WHERE stripe_subscription_id=$1", [subscriptionId])).rows[0]; return row ? planFrom(row, String(row.org_id)) : undefined; }
  async upsertPlan(orgId: string, update: Partial<Omit<AccountPlan, "accountId" | "updatedAt">>) {
    const current = await this.getPlan(orgId);
    const next = { ...current, ...update, accountId: orgId };
    const result = await this.pool.query("INSERT INTO billing_plans(org_id,tier_id,status,stripe_customer_id,stripe_subscription_id,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(org_id) DO UPDATE SET tier_id=EXCLUDED.tier_id,status=EXCLUDED.status,stripe_customer_id=EXCLUDED.stripe_customer_id,stripe_subscription_id=EXCLUDED.stripe_subscription_id,updated_at=now() RETURNING *", [orgId, next.tierId, next.status, next.stripeCustomerId ?? null, next.stripeSubscriptionId ?? null]);
    return planFrom(result.rows[0], orgId);
  }
  async deletePlan(orgId: string) { return (await this.pool.query("DELETE FROM billing_plans WHERE org_id=$1", [orgId])).rowCount === 1; }
  async applyStripePlanEvent(orgId: string, update: Partial<Omit<AccountPlan, "accountId" | "updatedAt">>, created: number) {
    const current = await this.getPlan(orgId); const next = { ...current, ...update, accountId: orgId };
    const result = await this.pool.query("INSERT INTO billing_plans(org_id,tier_id,status,stripe_customer_id,stripe_subscription_id,stripe_event_created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(org_id) DO UPDATE SET tier_id=EXCLUDED.tier_id,status=EXCLUDED.status,stripe_customer_id=EXCLUDED.stripe_customer_id,stripe_subscription_id=EXCLUDED.stripe_subscription_id,stripe_event_created_at=EXCLUDED.stripe_event_created_at,updated_at=now() WHERE billing_plans.stripe_event_created_at <= EXCLUDED.stripe_event_created_at RETURNING *", [orgId,next.tierId,next.status,next.stripeCustomerId ?? null,next.stripeSubscriptionId ?? null,created]);
    return result.rows[0] ? planFrom(result.rows[0], orgId) : this.getPlan(orgId);
  }
  async reserveRun(input: { orgId: string; runId: string; clientId?: string; durationSec?: number; usageRunCount?: number }): Promise<BillingReservation> {
    return withTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vvugc-billing:${input.orgId}`]);
      const existing = await db.query("SELECT * FROM billing_run_reservations WHERE org_id=$1 AND run_id=$2", [input.orgId, input.runId]);
      if (existing.rows[0]) {
        if (existing.rows[0].status === "released") {
          const restored = await db.query("UPDATE billing_run_reservations SET status='reserved', released_at=NULL WHERE id=$1 RETURNING *", [existing.rows[0].id]);
          return this.reservation(restored.rows[0]);
        }
        return this.reservation(existing.rows[0]);
      }
      const plan = planFrom((await db.query("SELECT * FROM billing_plans WHERE org_id=$1 FOR UPDATE", [input.orgId])).rows[0], input.orgId);
      const tier = plan.status === "active" && plan.tierId ? getTier(plan.tierId) : undefined;
      const billingMonth = month();
      const used = await db.query<{ count: string }>("SELECT count(*) FROM billing_run_reservations WHERE org_id=$1 AND billing_month=$2 AND status IN ('reserved','settled')", [input.orgId, billingMonth]);
      const isOverage = Boolean(tier && Number(used.rows[0]?.count ?? 0) >= tier.monthlyRunLimit);
      const amountCents = isOverage && tier ? cents(computeOverageCost(tier.overagePriceUsdPerRun, input.durationSec ?? 30)) : 0;
      const result = await db.query("INSERT INTO billing_run_reservations(id,org_id,run_id,client_id,billing_month,kind,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [randomUUID(), input.orgId, input.runId, input.clientId ?? null, billingMonth, isOverage ? "overage" : "included", amountCents]);
      return this.reservation(result.rows[0]);
    });
  }
  async settleReservation(input: { orgId: string; runId: string; estimatedVendorCostUsd?: number }): Promise<BillingOverageCharge | undefined> {
    return withTransaction(this.pool, async (db) => {
      const found = await db.query("SELECT * FROM billing_run_reservations WHERE org_id=$1 AND run_id=$2 FOR UPDATE", [input.orgId, input.runId]);
      const reservation = found.rows[0]; if (!reservation || reservation.status === "released") return undefined;
      await db.query("UPDATE billing_run_reservations SET status='settled', settled_at=COALESCE(settled_at,now()) WHERE id=$1", [reservation.id]);
      if (reservation.kind !== "overage") return undefined;
      const existing = await db.query("SELECT * FROM billing_overage_charges WHERE org_id=$1 AND run_id=$2", [input.orgId, input.runId]);
      if (existing.rows[0]) return this.charge(existing.rows[0]);
      const result = await db.query("INSERT INTO billing_overage_charges(id,org_id,run_id,reservation_id,client_id,billing_month,amount_cents,estimated_vendor_cost_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [randomUUID(), input.orgId, input.runId, reservation.id, reservation.client_id, reservation.billing_month, reservation.amount_cents, cents(input.estimatedVendorCostUsd ?? dollars(Number(reservation.amount_cents)))]);
      return this.charge(result.rows[0]);
    });
  }
  async releaseReservation(input: { orgId: string; runId: string }) { return withTransaction(this.pool, async (db) => (await db.query("UPDATE billing_run_reservations SET status='released', released_at=now() WHERE org_id=$1 AND run_id=$2 AND status='reserved'", [input.orgId,input.runId])).rowCount === 1); }
  async overageSummary(orgId: string, billingMonth = month()) { const r = await this.pool.query<{ count: string; total: string }>("SELECT count(*) AS count, COALESCE(sum(amount_cents),0) AS total FROM billing_overage_charges WHERE org_id=$1 AND billing_month=$2", [orgId, billingMonth]); return { count: Number(r.rows[0]?.count ?? 0), totalUsd: dollars(Number(r.rows[0]?.total ?? 0)) }; }
  /** The callback runs only if this event id has never succeeded. An event receipt
   * and its effects share one transaction, so redelivery is a no-op. */
  async processStripeEvent(event: { id: string; type: string; created?: number; data: { object: unknown } }, apply: (db: PostgresBillingRepository) => Promise<string | undefined>) {
    return withTransaction(this.pool, async (db) => {
      const receipt = await db.query("INSERT INTO stripe_webhook_events(event_id,event_type,payload,status) VALUES($1,$2,$3,'processed') ON CONFLICT(event_id) DO NOTHING RETURNING event_id", [event.id, event.type, event]);
      if (!receipt.rowCount) return false;
      const transactional = new PostgresBillingRepository(db as unknown as Pool);
      const orgId = await apply(transactional);
      if (orgId) await db.query("UPDATE stripe_webhook_events SET org_id=$2 WHERE event_id=$1", [event.id, orgId]);
      return true;
    });
  }
  private reservation(row: Record<string, unknown>): BillingReservation { return { id: String(row.id), orgId: String(row.org_id), runId: String(row.run_id), clientId: row.client_id ? String(row.client_id) : undefined, month: String(row.billing_month), kind: String(row.kind) as BillingReservation["kind"], amountCents: Number(row.amount_cents), status: String(row.status) as BillingReservation["status"], createdAt: new Date(String(row.created_at)).toISOString() }; }
  private charge(row: Record<string, unknown>): BillingOverageCharge { return { id: String(row.id), orgId: String(row.org_id), runId: String(row.run_id), clientId: row.client_id ? String(row.client_id) : undefined, month: String(row.billing_month), amountCents: Number(row.amount_cents), estimatedVendorCostCents: Number(row.estimated_vendor_cost_cents), createdAt: new Date(String(row.created_at)).toISOString() }; }
}

/** Development/test adapter only. Production selects Postgres at startup; this
 * preserves the same awaitable boundary without pretending file locks can offer
 * multi-instance transaction semantics. */
export class LocalBillingRepository implements BillingRepository {
  private readonly plans; private readonly overages;
  constructor(runsDir: string) { this.plans = createPlanStore(`${runsDir}/account-plans.json`); this.overages = createOverageStore(`${runsDir}/overage.json`); }
  async getPlan(orgId: string) { return this.plans.get(orgId); }
  async findPlanBySubscriptionId(id: string) { return this.plans.findBySubscriptionId(id); }
  async upsertPlan(orgId: string, update: Partial<Omit<AccountPlan, "accountId" | "updatedAt">>) { return this.plans.upsert(orgId, update); }
  async deletePlan(orgId: string) { return this.plans.delete(orgId); }
  async reserveRun(input: { orgId: string; runId: string; clientId?: string; durationSec?: number; usageRunCount?: number }) {
    const plan = this.plans.get(input.orgId); const tier = plan.status === "active" && plan.tierId ? getTier(plan.tierId) : undefined;
    const isOverage = Boolean(tier && (input.usageRunCount ?? 0) >= tier.monthlyRunLimit);
    const amountCents = isOverage && tier ? cents(computeOverageCost(tier.overagePriceUsdPerRun, input.durationSec ?? 30)) : 0;
    const charge = isOverage ? this.overages.record({ orgId: input.orgId, runId: input.runId, clientId: input.clientId, priceUsdPerRun: dollars(amountCents) }) : undefined;
    return { id: charge?.id ?? `local-${input.orgId}-${input.runId}`, orgId: input.orgId, runId: input.runId, clientId: input.clientId, month: month(), kind: isOverage ? "overage" : "included", amountCents, status: "reserved", createdAt: charge?.createdAt ?? new Date().toISOString() } satisfies BillingReservation;
  }
  async settleReservation(input: { orgId: string; runId: string; estimatedVendorCostUsd?: number }) {
    const charge = this.overages.listByOrg(input.orgId).find((row) => row.runId === input.runId); if (!charge) return undefined;
    return { id: charge.id, orgId: charge.orgId, runId: charge.runId, clientId: charge.clientId, month: charge.month, amountCents: cents(charge.priceUsdPerRun), estimatedVendorCostCents: cents(input.estimatedVendorCostUsd ?? charge.estimatedVendorCostUsd), createdAt: charge.createdAt };
  }
  async releaseReservation(input: { orgId: string; runId: string }) { return this.overages.release(input.orgId,input.runId); }
  async overageSummary(orgId: string, billingMonth = month()) { return { count: this.overages.countForMonth(orgId, billingMonth), totalUsd: this.overages.totalForMonth(orgId, billingMonth) }; }
}
