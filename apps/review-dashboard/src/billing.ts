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
import { createAccountStore, aggregateUsage, resolveOrgId, roleHasPermission } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import type { AuthedRequest } from "./accounts.js";
import { runsUsedThisMonth } from "./quota.js";

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

/**
 * Stripe's webhook signature check needs the RAW request body, not the JSON-parsed
 * object express.json() produces — this must be registered on the Express app BEFORE
 * the global express.json() middleware runs (see server.ts's registration order), or
 * the raw bytes are already gone by the time this handler runs. Kept as its own
 * function (not bundled into registerBillingRoutes) specifically so server.ts can
 * call it at the right point in the middleware chain.
 */
export function registerStripeWebhookRoute(app: Express): void {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const planStore = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json"));

  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req: Request, res: Response) => {
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

    applyStripeWebhookEvent(event, planStore);
    res.json({ received: true });
  });
}

const CheckoutRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many checkout attempts — try again later" }
});

export function registerBillingRoutes(app: Express, requireSession: RequestHandler): void {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const planStore = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json"));
  const accountStore = createAccountStore(join(VVUGC_RUNS_DIR, "accounts.json"));

  app.get("/accounts/billing", requireSession, (req: AuthedRequest, res: Response) => {
    const account = accountStore.findById(req.accountId!);
    if (!account) return res.status(401).json({ error: "not authenticated" });
    const orgId = resolveOrgId(account);

    const plan = planStore.get(orgId);
    const tier = plan.tierId ? getTier(plan.tierId) : undefined;
    const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR);
    res.json({
      tiers: PRICING_TIERS,
      plan,
      runsUsedThisMonth: runsUsedThisMonth(usage),
      monthlyRunLimit: tier?.monthlyRunLimit
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
      const account = accountStore.findById(req.accountId!);
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
