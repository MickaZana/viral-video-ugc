import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductEventStore, type ProductEventStore } from "./event-store.js";

let testDir: string;
let dbPath: string;
let store: ProductEventStore;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "vvugc-product-analytics-test-"));
  dbPath = join(testDir, "product-events.json");
  store = createProductEventStore(dbPath);
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("createProductEventStore", () => {
  it("record() server-assigns id and occurredAt, never trusting caller-supplied values", () => {
    const event = store.record({ orgId: "org-1", accountId: "acct-1", eventType: "run_started" });
    expect(event.id).toBeTruthy();
    expect(new Date(event.occurredAt).getTime()).not.toBeNaN();
    expect(event.orgId).toBe("org-1");
    expect(event.eventType).toBe("run_started");
  });

  it("record() persists to disk — a fresh store reading the same path sees it", () => {
    store.record({ orgId: "org-1", accountId: "acct-1", eventType: "run_started" });
    const reopened = createProductEventStore(dbPath);
    expect(reopened.listByOrg("org-1")).toHaveLength(1);
  });

  it("listByOrg scopes strictly to the given orgId", () => {
    store.record({ orgId: "org-1", accountId: "acct-1", eventType: "run_started" });
    store.record({ orgId: "org-2", accountId: "acct-2", eventType: "run_started" });
    expect(store.listByOrg("org-1")).toHaveLength(1);
    expect(store.listByOrg("org-2")).toHaveLength(1);
    expect(store.listByOrg("org-3")).toHaveLength(0);
  });

  it("listByOrg filters by eventType", () => {
    store.record({ orgId: "org-1", accountId: "acct-1", eventType: "run_started" });
    store.record({ orgId: "org-1", accountId: "acct-1", eventType: "batch_planned" });
    expect(store.listByOrg("org-1", { eventType: "batch_planned" })).toHaveLength(1);
    expect(store.listByOrg("org-1", { eventType: "run_started" })).toHaveLength(1);
  });

  it("listByOrg filters by sinceMs (inclusive)", () => {
    const event = store.record({ orgId: "org-1", accountId: "acct-1", eventType: "run_started" });
    const occurredAtMs = new Date(event.occurredAt).getTime();
    expect(store.listByOrg("org-1", { sinceMs: occurredAtMs })).toHaveLength(1);
    expect(store.listByOrg("org-1", { sinceMs: occurredAtMs + 1000 })).toHaveLength(0);
  });

  it("accepts small, typed meta on an event and round-trips it", () => {
    const event = store.record({ orgId: "org-1", accountId: "acct-1", eventType: "batch_enqueued", meta: { vendor: "higgsfield", variationCount: 12 } });
    expect(event.meta).toEqual({ vendor: "higgsfield", variationCount: 12 });
  });

  it("deleteOrg removes every event for that org and leaves others untouched", () => {
    store.record({ orgId: "org-1", accountId: "acct-1", eventType: "run_started" });
    store.record({ orgId: "org-2", accountId: "acct-2", eventType: "run_started" });
    store.deleteOrg("org-1");
    expect(store.listByOrg("org-1")).toHaveLength(0);
    expect(store.listByOrg("org-2")).toHaveLength(1);
  });

  it("deleteOrg on an org with no events is a safe no-op", () => {
    expect(() => store.deleteOrg("no-such-org")).not.toThrow();
  });
});
