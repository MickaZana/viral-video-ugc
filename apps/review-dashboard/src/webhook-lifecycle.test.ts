import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanStore } from "@vvugc/shared-billing";
import { applyStripeWebhookEvent } from "./billing.js";

let dir: string;
let planStore: ReturnType<typeof createPlanStore>;

function event(type: string, object: Record<string, unknown>) {
  return { type, data: { object } };
}

describe("applyStripeWebhookEvent: subscription lifecycle sync", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vvugc-webhook-test-"));
    planStore = createPlanStore(join(dir, "account-plans.json"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("checkout.session.completed activates the plan and records the subscription id for later lookup", () => {
    applyStripeWebhookEvent(
      event("checkout.session.completed", { client_reference_id: "org-1::growth", customer: "cus_1", subscription: "sub_1" }),
      planStore
    );
    const plan = planStore.get("org-1");
    expect(plan.status).toBe("active");
    expect(plan.tierId).toBe("growth");
    expect(plan.stripeSubscriptionId).toBe("sub_1");
  });

  it("checkout.session.completed with an unparseable client_reference_id is a no-op, not a crash", () => {
    expect(() => applyStripeWebhookEvent(event("checkout.session.completed", { client_reference_id: null }), planStore)).not.toThrow();
  });

  it("customer.subscription.updated with status past_due flips the real plan for the right account, found via the subscription id", () => {
    planStore.upsert("org-2", { tierId: "starter", status: "active", stripeSubscriptionId: "sub_2" });
    applyStripeWebhookEvent(event("customer.subscription.updated", { id: "sub_2", status: "past_due" }), planStore);
    expect(planStore.get("org-2").status).toBe("past_due");
  });

  it("customer.subscription.updated with status active recovers a past_due plan", () => {
    planStore.upsert("org-3", { tierId: "starter", status: "past_due", stripeSubscriptionId: "sub_3" });
    applyStripeWebhookEvent(event("customer.subscription.updated", { id: "sub_3", status: "active" }), planStore);
    expect(planStore.get("org-3").status).toBe("active");
  });

  it("customer.subscription.updated with status trialing also counts as active", () => {
    planStore.upsert("org-3b", { tierId: "starter", status: "past_due", stripeSubscriptionId: "sub_3b" });
    applyStripeWebhookEvent(event("customer.subscription.updated", { id: "sub_3b", status: "trialing" }), planStore);
    expect(planStore.get("org-3b").status).toBe("active");
  });

  it("customer.subscription.deleted cancels the real plan for the right account", () => {
    planStore.upsert("org-4", { tierId: "agency", status: "active", stripeSubscriptionId: "sub_4" });
    applyStripeWebhookEvent(event("customer.subscription.deleted", { id: "sub_4" }), planStore);
    expect(planStore.get("org-4").status).toBe("canceled");
  });

  it("an unmapped Stripe status (e.g. incomplete) leaves the existing plan status alone rather than guessing", () => {
    planStore.upsert("org-5", { tierId: "starter", status: "active", stripeSubscriptionId: "sub_5" });
    applyStripeWebhookEvent(event("customer.subscription.updated", { id: "sub_5", status: "incomplete" }), planStore);
    expect(planStore.get("org-5").status).toBe("active"); // unchanged
  });

  it("a subscription id with no matching account is a harmless no-op, not a crash", () => {
    expect(() =>
      applyStripeWebhookEvent(event("customer.subscription.updated", { id: "sub_never_seen", status: "active" }), planStore)
    ).not.toThrow();
    expect(() =>
      applyStripeWebhookEvent(event("customer.subscription.deleted", { id: "sub_never_seen" }), planStore)
    ).not.toThrow();
  });

  it("an event type this handler doesn't care about is ignored, not an error", () => {
    expect(() => applyStripeWebhookEvent(event("invoice.paid", { id: "in_1" }), planStore)).not.toThrow();
  });
});
