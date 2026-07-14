import { describe, expect, it } from "vitest";
import { CostLedger, estimateCostUsd } from "./index.js";

describe("estimateCostUsd", () => {
  it("computes rate * quantity for a known vendor/unit", () => {
    expect(estimateCostUsd("higgsfield", "clip", 3)).toBeCloseTo(1.2, 6);
  });

  it("returns 0 for an unknown unit rather than throwing", () => {
    expect(estimateCostUsd("higgsfield", "unknown_unit", 5)).toBe(0);
  });
});

describe("CostLedger", () => {
  it("accumulates events and totals them", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "higgsfield", "clip", 4);
    ledger.record("video_gen", "kling", "clip", 2);
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.totalUsd()).toBeCloseTo(4 * 0.4 + 2 * 0.35, 6);
  });

  it("groups totals by vendor", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "higgsfield", "clip", 1);
    ledger.record("video_gen", "higgsfield", "clip", 1);
    ledger.record("video_gen", "kling", "clip", 1);
    const totals = ledger.totalsByVendor();
    expect(totals.higgsfield).toBeCloseTo(0.8, 6);
    expect(totals.kling).toBeCloseTo(0.35, 6);
  });

  it("recordAnthropicUsage records input/output tokens as separate events", () => {
    const ledger = new CostLedger();
    ledger.recordAnthropicUsage("script_rewrite", { input_tokens: 1000, output_tokens: 500 });
    expect(ledger.getEvents()).toHaveLength(2);
    expect(ledger.totalUsd()).toBeCloseTo(1000 * (3 / 1_000_000) + 500 * (15 / 1_000_000), 6);
  });

  it("toJSON returns a serializable summary", () => {
    const ledger = new CostLedger();
    ledger.record("video_gen", "runway", "clip", 2);
    const json = ledger.toJSON();
    expect(json.totalUsd).toBeCloseTo(1.0, 6);
    expect(json.totalsByVendor).toEqual({ runway: 1.0 });
    expect(json.events).toHaveLength(1);
  });
});
