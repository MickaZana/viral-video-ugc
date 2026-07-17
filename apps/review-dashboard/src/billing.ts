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
  getTier
} from "@vvugc/shared-billing";
import { createAccountStore, aggregateUsage, resolveOrgId } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import type { AuthedRequest } from "./accounts.js";
import { runsUsedThisMonth } from "./quota.js";

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
    } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
      const subscription = event.data.object as { id: string; status: string };
      // Best-effort: without a stored subscriptionId -> accountId index, a status
      // change can't be attributed here. Real production billing would maintain
      // that index; this scaffolding intentionally keeps checkout.session.completed
      // as the one authoritative activation path and treats this as advisory only.
      void subscription;
    }

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
      if (account.role !== "owner") {
        return res.status(403).json({ error: "only the org owner can manage billing" });
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
