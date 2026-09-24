import { describe, expect, it } from "vitest";
import {
  DURATION_TIERS,
  MAX_DURATION_SEC,
  PRICING_TIERS,
  computeOverageCost,
  getDurationTier,
  getTier,
} from "./tiers.js";

describe("getDurationTier", () => {
  it("matches on the inclusive upper bound of each tier", () => {
    expect(getDurationTier(0).label).toBe("short");
    expect(getDurationTier(15).label).toBe("short");
    expect(getDurationTier(16).label).toBe("standard");
    expect(getDurationTier(30).label).toBe("standard");
    expect(getDurationTier(31).label).toBe("extended");
    expect(getDurationTier(45).label).toBe("extended");
    expect(getDurationTier(46).label).toBe("premium");
    expect(getDurationTier(60).label).toBe("premium");
  });

  it("falls through to the highest tier when duration exceeds every bound", () => {
    // Callers validate against MAX_DURATION_SEC separately; the resolver must not throw.
    expect(getDurationTier(61).label).toBe("premium");
    expect(getDurationTier(10_000).label).toBe("premium");
    expect(getDurationTier(10_000).costMultiplier).toBe(4.0);
  });

  it("exposes multipliers 1.0 / 1.5 / 2.5 / 4.0 in ascending tier order", () => {
    expect(DURATION_TIERS.map((t) => t.costMultiplier)).toEqual([1.0, 1.5, 2.5, 4.0]);
    const bounds = DURATION_TIERS.map((t) => t.maxSec);
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));
    expect(MAX_DURATION_SEC).toBe(bounds[bounds.length - 1]);
    expect(MAX_DURATION_SEC).toBe(60);
  });
});

describe("computeOverageCost", () => {
  it("applies the tier multiplier to the base overage price", () => {
    expect(computeOverageCost(6, 10)).toBe(6);    // short ×1.0
    expect(computeOverageCost(6, 20)).toBe(9);    // standard ×1.5
    expect(computeOverageCost(6, 40)).toBe(15);   // extended ×2.5
    expect(computeOverageCost(6, 60)).toBe(24);   // premium ×4.0
  });

  it("does not multiply a zero base price", () => {
    expect(computeOverageCost(0, 60)).toBe(0);
  });
});

describe("getTier", () => {
  it("finds each defined pricing tier by id", () => {
    expect(getTier("starter")?.priceUsdPerMonth).toBe(39);
    expect(getTier("growth")?.priceUsdPerMonth).toBe(99);
    expect(getTier("agency")?.priceUsdPerMonth).toBe(249);
  });

  it("returns undefined for an unknown tier id (callers must handle)", () => {
    expect(getTier("enterprise")).toBeUndefined();
    expect(getTier("")).toBeUndefined();
  });

  it("keeps pricing tiers strictly ascending in runs and price", () => {
    const runs = PRICING_TIERS.map((t) => t.monthlyRunLimit);
    const prices = PRICING_TIERS.map((t) => t.priceUsdPerMonth);
    expect(runs).toEqual([...runs].sort((a, b) => a - b));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(PRICING_TIERS.map((t) => t.id)).size).toBe(PRICING_TIERS.length);
    for (const tier of PRICING_TIERS) {
      expect(tier.stripePriceIdEnvVar).toMatch(/^STRIPE_PRICE_ID_/);
      expect(tier.overagePriceUsdPerRun).toBeGreaterThan(0);
    }
  });
});
