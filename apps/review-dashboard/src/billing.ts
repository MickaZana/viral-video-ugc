import { join } from "node:path";
import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import express from "express";
import {
  createCheckoutSession,
  createPlanStore,
  constructWebhookEvent,
  parseClientReferenceId,
  PRICING_TIERS,
  getTier,
  type PlanStore
} from "@vvugc/shared-billing";
import { aggregateUsage, resolveOrgId, roleHasPermission } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import type { AuthedRequest } from "./accounts.js";
import { runsUsedThisMonth } from "./quota.js";
import { createOverageStore } from "./overage.js";
import { PostgresBillingRepository } from "./billing-postgres.js";
import type { Pool } from "pg";

/**
 * Stripe's subscription.status vocabulary is wider than our own PlanStatus —
 * this maps the values that clearly correspond to one of ours and leaves
 * everything else (incomplete, incomplete_expired mid-setup, paused) alone
 * rather than guessing, since none of those cleanly means "billing them" or
 * "not billing them" the way active/past_due/canceled do.
 */
function mapStripeSubscriptionStatus(stripeStatus: string): "active" | "past_due" | "canceled" | undefined {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return undefined;
  }
}

/**
 * The actual event-handling logic, deliberately separated from Express/HTTP/signature
 * verification concerns so it's directly unit-testable with plain event objects and a
 * real PlanStore — no need to mock the "stripe" package or spin up a server to prove
 * "this event type produces this plan-store write."
 */
export function applyStripeWebhookEvent(event: { type: string; data: { object: unknown } }, planStore: PlanStore): void {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as { client_reference_id?: string | null; customer?: string | null; subscription?: string | null };
    const parsed = parseClientReferenceId(session.client_reference_id);
    if (parsed) {
      planStore.upsert(parsed.accountId, {
        tierId: parsed.tierId,
        status: "active",
        stripeCustomerId: session.customer ?? undefined,
        stripeSubscriptionId: session.subscription ?? undefined
      });
    }
  } else if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as { id: string };
    const plan = planStore.findBySubscriptionId(subscription.id);
    if (plan) planStore.upsert(plan.accountId, { status: "canceled" });
  } else if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as { id: string; status: string };
    const plan = planStore.findBySubscriptionId(subscription.id);
    const mapped = mapStripeSubscriptionStatus(subscription.status);
    // A status Stripe uses that doesn't cleanly map to ours (e.g. "incomplete",
    // "paused") leaves the existing plan status alone rather than guessing —
    // same fail-safe posture as everywhere else in this file.
    if (plan && mapped) planStore.upsert(plan.accountId, { status: mapped });
  }
}
class StripePlanPrerequisiteMissing extends Error {}

export async function applyStripeWebhookEventPostgres(event: { type: string; created?: number; data: { object: unknown } }, billing: PostgresBillingRepository): Promise<string | undefined> {
  const created = Number.isSafeInteger(event.created) ? event.created! : Math.floor(Date.now() / 1000);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as { client_reference_id?: string | null; customer?: string | null; subscription?: string | null };
    const parsed = parseClientReferenceId(session.client_reference_id);
    if (!parsed) return undefined;
    await billing.applyStripePlanEvent(parsed.accountId, { tierId: parsed.tierId, status: "active", stripeCustomerId: session.customer ?? undefined, stripeSubscriptionId: session.subscription ?? undefined }, created);
    return parsed.accountId;
  }
  if (event.type === "customer.subscription.deleted") {
    const plan = await billing.findPlanBySubscriptionId((event.data.object as { id: string }).id);
    if (!plan) throw new StripePlanPrerequisiteMissing("subscription deletion arrived before checkout association");
    await billing.applyStripePlanEvent(plan.accountId, { status: "canceled" }, created); return plan.accountId;
  }
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as { id: string; status: string };
    const plan = await billing.findPlanBySubscriptionId(subscription.id);
    const mapped = mapStripeSubscriptionStatus(subscription.status);
    if (!plan) throw new StripePlanPrerequisiteMissing("subscription update arrived before checkout association");
    if (mapped) { await billing.applyStripePlanEvent(plan.accountId, { status: mapped }, created); return plan.accountId; }
  }
  return undefined;
}

/**
 * Stripe's webhook signature check needs the RAW request body, not the JSON-parsed
 * object express.json() produces — this must be registered on the Express app BEFORE
 * the global express.json() middleware runs (see server.ts's registration order), or
 * the raw bytes are already gone by the time this handler runs. Kept as its own
 * function (not bundled into registerBillingRoutes) specifically so server.ts can
 * call it at the right point in the middleware chain.
 */
export function registerStripeWebhookRoute(app: Express, options: { pool?: Pool } = {}): void {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const planStore = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json"));

  const billing = options.pool ? new PostgresBillingRepository(options.pool) : undefined;
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return res.status(400).json({ error: "missing stripe-signature header" });
    }

    let event;
    try {
      event = constructWebhookEvent(req.body as Buffer, signature);
    } catch (err) {
      return res.status(400).json({ error: `webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    try {
      if (billing) await billing.processStripeEvent(event, (transactionalBilling) => applyStripeWebhookEventPostgres(event, transactionalBilling));
      else applyStripeWebhookEvent(event, planStore);
      res.json({ received: true });
    } catch (err) {
      // Deliberately return 500: Stripe must retry an event whose durable receipt
      // and subscription effect failed together. Never acknowledge partial work.
      res.status(500).json({ error: "webhook processing failed", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

const CheckoutRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many checkout attempts — try again later" }
});

export function registerBillingRoutes(app: Express, requireSession: RequestHandler, options: { pool?: Pool } = {}): void {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const planStore = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json"));
  const overageStore = createOverageStore(join(VVUGC_RUNS_DIR, "overage.json"));
  const billing = options.pool ? new PostgresBillingRepository(options.pool) : undefined;

  app.get("/accounts/billing", requireSession, async (req: AuthedRequest, res: Response) => {
    const account = req.account;
    if (!account) return res.status(401).json({ error: "not authenticated" });
    const orgId = resolveOrgId(account);

    const plan = billing ? await billing.getPlan(orgId) : planStore.get(orgId);
    const tier = plan.tierId ? getTier(plan.tierId) : undefined;
    const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const runsUsed = runsUsedThisMonth(usage);
    const summary = billing ? await billing.overageSummary(orgId, thisMonth) : { count: overageStore.countForMonth(orgId, thisMonth), totalUsd: overageStore.totalForMonth(orgId, thisMonth) };
    const limit = tier?.monthlyRunLimit;
    const overageRuns = limit !== undefined && runsUsed > limit ? runsUsed - limit : 0;
    res.json({
      tiers: PRICING_TIERS,
      plan,
      runsUsedThisMonth: runsUsed,
      monthlyRunLimit: limit,
      // Consumption-overage info: runs beyond the included allowance are billed
      // at the tier's per-run rate (hybrid billing — no hard quota stop).
      overage: {
        priceUsdPerRun: tier?.overagePriceUsdPerRun ?? 0,
        overageRunsThisMonth: overageRuns,
        chargedThisMonth: summary.count,
        totalUsdThisMonth: summary.totalUsd
      }
    });
  });

  app.post(
    "/accounts/billing/checkout",
    requireSession,
    CheckoutRateLimiter,
    async (req: AuthedRequest, res: Response) => {
      const tierId = req.body?.tierId;
      if (typeof tierId !== "string" || !getTier(tierId)) {
        return res.status(400).json({ error: `tierId must be one of: ${PRICING_TIERS.map((t) => t.id).join(", ")}` });
      }
      const account = req.account;
      if (!account) return res.status(401).json({ error: "not authenticated" });
      if (!roleHasPermission(account.role, "billing.manage")) {
        return res.status(403).json({ error: "requires the billing.manage permission" });
      }

      const origin = `${req.protocol}://${req.get("host")}`;
      try {
        const { url } = await createCheckoutSession({
          accountId: resolveOrgId(account),
          email: account.email,
          tierId,
          successUrl: `${origin}/account?checkout=success`,
          cancelUrl: `${origin}/account?checkout=canceled`
        });
        res.json({ url });
      } catch (err) {
        res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}
