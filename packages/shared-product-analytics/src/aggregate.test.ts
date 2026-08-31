import { describe, expect, it } from "vitest";
import { PRODUCT_EVENT_TYPES, type ProductEvent } from "./events.js";
import { activeAccountIds, featureUsageCounts, mostUsedFeatures, summarizeUsage } from "./aggregate.js";

function makeEvent(overrides: Partial<ProductEvent> = {}): ProductEvent {
  return {
    id: "evt-1",
    orgId: "org-1",
    accountId: "acct-1",
    eventType: "run_started",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("featureUsageCounts", () => {
  it("every known event type is present, zeroed if unseen", () => {
    const counts = featureUsageCounts([]);
    for (const type of PRODUCT_EVENT_TYPES) expect(counts[type]).toBe(0);
  });

  it("counts each event type correctly", () => {
    const counts = featureUsageCounts([
      makeEvent({ eventType: "run_started" }),
      makeEvent({ eventType: "run_started" }),
      makeEvent({ eventType: "batch_planned" })
    ]);
    expect(counts.run_started).toBe(2);
    expect(counts.batch_planned).toBe(1);
    expect(counts.review_item_approved).toBe(0);
  });
});

describe("mostUsedFeatures", () => {
  it("ranks by count descending and excludes untouched features", () => {
    const ranking = mostUsedFeatures([
      makeEvent({ eventType: "run_started" }),
      makeEvent({ eventType: "run_started" }),
      makeEvent({ eventType: "run_started" }),
      makeEvent({ eventType: "batch_planned" })
    ]);
    expect(ranking).toEqual([
      { eventType: "run_started", count: 3 },
      { eventType: "batch_planned", count: 1 }
    ]);
  });

  it("returns an empty array for no events", () => {
    expect(mostUsedFeatures([])).toEqual([]);
  });
});

describe("activeAccountIds", () => {
  it("only counts distinct accounts with an event at/after the cutoff", () => {
    const cutoff = new Date("2026-01-02T00:00:00.000Z").getTime();
    const active = activeAccountIds(
      [
        makeEvent({ accountId: "acct-old", occurredAt: "2026-01-01T00:00:00.000Z" }),
        makeEvent({ accountId: "acct-new-1", occurredAt: "2026-01-03T00:00:00.000Z" }),
        makeEvent({ accountId: "acct-new-1", occurredAt: "2026-01-04T00:00:00.000Z" }),
        makeEvent({ accountId: "acct-new-2", occurredAt: "2026-01-02T00:00:00.000Z" })
      ],
      cutoff
    );
    expect(active).toEqual(new Set(["acct-new-1", "acct-new-2"]));
  });
});

describe("summarizeUsage", () => {
  it("composes totalEvents/activeAccountCount/mostUsedFeatures/featureUsageCounts consistently", () => {
    const cutoff = new Date("2026-01-01T00:00:00.000Z").getTime();
    const events = [
      makeEvent({ accountId: "acct-1", eventType: "run_started", occurredAt: "2026-01-02T00:00:00.000Z" }),
      makeEvent({ accountId: "acct-2", eventType: "batch_planned", occurredAt: "2026-01-03T00:00:00.000Z" })
    ];
    const summary = summarizeUsage(events, cutoff);
    expect(summary.totalEvents).toBe(2);
    expect(summary.activeAccountCount).toBe(2);
    expect(summary.mostUsedFeatures).toEqual([
      { eventType: "run_started", count: 1 },
      { eventType: "batch_planned", count: 1 }
    ]);
    expect(summary.featureUsageCounts.run_started).toBe(1);
  });
});
