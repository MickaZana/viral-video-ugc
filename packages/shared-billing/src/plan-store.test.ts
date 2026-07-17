import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanStore } from "./plan-store.js";

describe("createPlanStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "plan-store-"));
    return createPlanStore(join(dir, "plans.json"));
  }

  it("a brand-new account reads as no plan / no subscription", () => {
    const store = freshStore();
    const plan = store.get("account-1");
    expect(plan.tierId).toBeNull();
    expect(plan.status).toBe("none");
  });

  it("upsert activates a plan, get reflects it back", () => {
    const store = freshStore();
    store.upsert("account-1", { tierId: "growth", status: "active", stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" });
    const plan = store.get("account-1");
    expect(plan.tierId).toBe("growth");
    expect(plan.status).toBe("active");
    expect(plan.stripeCustomerId).toBe("cus_123");
  });

  it("upsert merges partial updates rather than overwriting the whole record", () => {
    const store = freshStore();
    store.upsert("account-1", { tierId: "growth", status: "active", stripeCustomerId: "cus_123" });
    store.upsert("account-1", { status: "past_due" });
    const plan = store.get("account-1");
    expect(plan.status).toBe("past_due");
    expect(plan.tierId).toBe("growth"); // untouched by the partial update
    expect(plan.stripeCustomerId).toBe("cus_123"); // untouched
  });

  it("plans for different accounts don't collide", () => {
    const store = freshStore();
    store.upsert("account-1", { tierId: "starter", status: "active" });
    store.upsert("account-2", { tierId: "agency", status: "active" });
    expect(store.get("account-1").tierId).toBe("starter");
    expect(store.get("account-2").tierId).toBe("agency");
  });

  it("findBySubscriptionId finds the account a Stripe subscription id belongs to", () => {
    const store = freshStore();
    store.upsert("account-1", { tierId: "growth", status: "active", stripeSubscriptionId: "sub_abc" });
    store.upsert("account-2", { tierId: "starter", status: "active", stripeSubscriptionId: "sub_xyz" });

    expect(store.findBySubscriptionId("sub_abc")?.accountId).toBe("account-1");
    expect(store.findBySubscriptionId("sub_xyz")?.accountId).toBe("account-2");
  });

  it("findBySubscriptionId returns undefined for an unknown subscription id", () => {
    const store = freshStore();
    store.upsert("account-1", { tierId: "growth", status: "active", stripeSubscriptionId: "sub_abc" });
    expect(store.findBySubscriptionId("sub_never_seen")).toBeUndefined();
  });
});
