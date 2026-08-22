import { describe, expect, it } from "vitest";
import {
  BatchRequestSchema,
  CaptionStyleSchema,
  DeduplicationModeSchema,
  HARD_LIMITS,
  VendorPolicySchema,
  VideoVendorSchema,
} from "./batch.js";
import {
  type EntityLookup,
  generateIdempotencyKey,
  planBatch,
  VENDOR_RATES,
} from "./batch-planner.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
const ALL_EXIST_LOOKUP: EntityLookup = {
  productProfileExists: () => true,
  creatorProfileExists: () => true,
  templateExists: () => true,
  visualTreatmentExists: () => true,
};

function makeRequest(overrides: Record<string, unknown> = {}) {
  return BatchRequestSchema.parse({
    productProfileId: "prod-001",
    creatorProfileIds: ["creator-a"],
    hookCount: 2,
    scriptCount: 1,
    platforms: ["tiktok"],
    clientId: "client-1",
    orgId: "org-1",
    requestedBy: "user-1",
    ...overrides,
  });
}

// ─── BatchRequestSchema Tests ───────────────────────────────────────────────
describe("BatchRequestSchema", () => {
  it("parses a minimal valid request with defaults", () => {
    const req = BatchRequestSchema.parse({
      productProfileId: "prod-1",
      platforms: ["tiktok"],
      clientId: "client-1",
      orgId: "org-1",
      requestedBy: "user-1",
    });
    expect(req.hookCount).toBe(3);
    expect(req.scriptCount).toBe(1);
    expect(req.maxVariations).toBe(50);
    expect(req.maxEstimatedCostUsd).toBe(50);
    expect(req.dryRun).toBe(true);
    expect(req.locale).toBe("en");
    expect(req.deduplicationMode).toBe("strict");
    expect(req.targetDurationSec).toBe(25);
    expect(req.vendorPolicy).toEqual({ policy: "cheapest" });
    expect(req.creatorProfileIds).toEqual([]);
  });

  it("rejects empty productProfileId", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "",
        platforms: ["tiktok"],
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects empty platforms array", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: [],
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects more than MAX_PLATFORMS", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok", "youtube_shorts", "instagram_reels", "facebook", "tiktok"],
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects hookCount > MAX_HOOKS", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        hookCount: 11,
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects maxVariations > MAX_VARIATIONS_PER_BATCH", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        maxVariations: 201,
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects maxEstimatedCostUsd > MAX_ESTIMATED_SPEND_USD", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        maxEstimatedCostUsd: 501,
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects more than 5 creators", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        creatorProfileIds: ["a", "b", "c", "d", "e", "f"],
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects invalid captionStyleIds", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        captionStyleIds: ["clean", "neon"],
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("accepts a specific vendor policy", () => {
    const req = BatchRequestSchema.parse({
      productProfileId: "p",
      platforms: ["tiktok"],
      vendorPolicy: { policy: "specific", specificVendor: "seedance" },
      clientId: "c",
      orgId: "o",
      requestedBy: "u",
    });
    expect(req.vendorPolicy).toEqual({ policy: "specific", specificVendor: "seedance" });
  });

  it("rejects an unknown deduplicationMode", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        deduplicationMode: "fuzzy",
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });

  it("rejects targetDurationSec outside 15-60", () => {
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        targetDurationSec: 14,
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
    expect(() =>
      BatchRequestSchema.parse({
        productProfileId: "p",
        platforms: ["tiktok"],
        targetDurationSec: 61,
        clientId: "c",
        orgId: "o",
        requestedBy: "u",
      })
    ).toThrow();
  });
});

// ─── HARD_LIMITS Tests ──────────────────────────────────────────────────────
describe("HARD_LIMITS", () => {
  it("has all expected keys with correct values", () => {
    expect(HARD_LIMITS.MAX_VARIATIONS_PER_BATCH).toBe(200);
    expect(HARD_LIMITS.MAX_CREATORS).toBe(5);
    expect(HARD_LIMITS.MAX_HOOKS).toBe(10);
    expect(HARD_LIMITS.MAX_PLATFORMS).toBe(4);
    expect(HARD_LIMITS.MAX_ESTIMATED_SPEND_USD).toBe(500);
    expect(HARD_LIMITS.MAX_CONCURRENT_PROVIDER_JOBS).toBe(10);
    expect(HARD_LIMITS.MAX_BATCH_RUNTIME_MINUTES).toBe(120);
    expect(HARD_LIMITS.MAX_RETRIES_PER_VARIATION).toBe(3);
  });

  it("is frozen (not user-overridable)", () => {
    // TypeScript's `as const` makes it readonly, but let's also verify at runtime
    expect(Object.isFrozen(HARD_LIMITS)).toBe(true);
  });
});

// ─── planBatch: Deterministic Output ────────────────────────────────────────
describe("planBatch — deterministic output", () => {
  it("produces the same plan for the same input across multiple calls", async () => {
    const request = makeRequest();
    const opts = { batchId: "batch-det-1", request, lookup: ALL_EXIST_LOOKUP };

    const plan1 = await planBatch(opts);
    const plan2 = await planBatch(opts);

    expect(plan1.variations.length).toBe(plan2.variations.length);
    expect(plan1.totalEstimatedCost).toBe(plan2.totalEstimatedCost);
    for (let i = 0; i < plan1.variations.length; i++) {
      expect(plan1.variations[i].idempotencyKey).toBe(plan2.variations[i].idempotencyKey);
      expect(plan1.variations[i].variationId).toBe(plan2.variations[i].variationId);
      expect(plan1.variations[i].variationLabel).toBe(plan2.variations[i].variationLabel);
    }
  });

  it("computes the correct matrix size (hooks × scripts × creators × platforms × VTs × captionStyles × CTAs)", async () => {
    const request = makeRequest({
      hookCount: 2,
      scriptCount: 2,
      creatorProfileIds: ["c1", "c2"],
      platforms: ["tiktok", "instagram_reels"],
      visualTreatmentIds: ["vt1", "vt2"],
      captionStyleIds: ["clean", "bold"],
      ctaVariants: ["Buy now", "Learn more"],
      maxVariations: 200,
    });

    const plan = await planBatch({ batchId: "batch-matrix", request, lookup: ALL_EXIST_LOOKUP });
    // 2 hooks × 2 scripts × 2 creators × 2 platforms × 2 VTs × 2 captions × 2 CTAs = 128
    expect(plan.variations.length).toBe(128);
  });

  it("uses 'bold' as default captionStyle when none specified", async () => {
    const request = makeRequest({ captionStyleIds: undefined });
    const plan = await planBatch({ batchId: "batch-cap-def", request, lookup: ALL_EXIST_LOOKUP });
    for (const v of plan.variations) {
      expect(v.captionStyle).toBe("bold");
    }
  });

  it("assigns all variations status 'planned'", async () => {
    const request = makeRequest();
    const plan = await planBatch({ batchId: "batch-status", request, lookup: ALL_EXIST_LOOKUP });
    for (const v of plan.variations) {
      expect(v.status).toBe("planned");
    }
  });
});

// ─── planBatch: Duplicate Elimination ───────────────────────────────────────
describe("planBatch — duplicate elimination", () => {
  it("strict mode: removes exact duplicates (same idempotency key)", async () => {
    // With only 1 of each dimension, there can be no strict duplicates in a normal matrix.
    // The combinatorial approach doesn't produce dups on its own; this is a baseline.
    const request = makeRequest({
      hookCount: 3,
      scriptCount: 1,
      platforms: ["tiktok"],
      deduplicationMode: "strict",
    });
    const plan = await planBatch({ batchId: "batch-strict", request, lookup: ALL_EXIST_LOOKUP });
    const keys = plan.variations.map((v) => v.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("relaxed mode: reduces variations by collapsing across platform + captionStyle", async () => {
    const request = makeRequest({
      hookCount: 1,
      scriptCount: 1,
      creatorProfileIds: ["c1"],
      platforms: ["tiktok", "instagram_reels"],
      captionStyleIds: ["clean", "bold"],
      deduplicationMode: "relaxed",
    });
    const plan = await planBatch({ batchId: "batch-relaxed", request, lookup: ALL_EXIST_LOOKUP });
    // Without relaxed: 1×1×1×2×1×2×1 = 4 variations
    // With relaxed: platform and captionStyle are ignored in the dedup key,
    // so all 4 map to the same key → only 1 survives.
    expect(plan.variations.length).toBe(1);
  });

  it("strict mode preserves all platform × captionStyle combinations", async () => {
    const request = makeRequest({
      hookCount: 1,
      scriptCount: 1,
      creatorProfileIds: ["c1"],
      platforms: ["tiktok", "instagram_reels"],
      captionStyleIds: ["clean", "bold"],
      deduplicationMode: "strict",
    });
    const plan = await planBatch({ batchId: "batch-strict-plat", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBe(4);
  });
});

// ─── planBatch: Hard-Limit Enforcement ──────────────────────────────────────
describe("planBatch — hard-limit enforcement", () => {
  it("caps at maxVariations when matrix exceeds it", async () => {
    const request = makeRequest({
      hookCount: 10,
      scriptCount: 3,
      creatorProfileIds: ["c1", "c2"],
      platforms: ["tiktok", "instagram_reels"],
      maxVariations: 20,
      maxEstimatedCostUsd: 500,
    });
    // Matrix: 10×3×2×2 = 120, capped to 20
    const plan = await planBatch({ batchId: "batch-cap", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBe(20);
    expect(plan.warnings.some((w) => w.includes("capped to maxVariations=20"))).toBe(true);
  });

  it("rejects if product profile doesn't exist", async () => {
    const request = makeRequest();
    const lookup: EntityLookup = {
      ...ALL_EXIST_LOOKUP,
      productProfileExists: () => false,
    };
    const plan = await planBatch({ batchId: "batch-no-prod", request, lookup });
    expect(plan.variations.length).toBe(0);
    expect(plan.rejected.length).toBe(1);
    expect(plan.rejected[0].reason).toBe("product_profile_not_found");
  });

  it("rejects if template doesn't exist", async () => {
    const request = makeRequest({ templateId: "tmpl-missing" });
    const lookup: EntityLookup = {
      ...ALL_EXIST_LOOKUP,
      templateExists: () => false,
    };
    const plan = await planBatch({ batchId: "batch-no-tmpl", request, lookup });
    expect(plan.variations.length).toBe(0);
    expect(plan.rejected[0].reason).toBe("template_not_found");
  });

  it("skips non-existent creators with a warning", async () => {
    const request = makeRequest({ creatorProfileIds: ["good", "bad"] });
    const lookup: EntityLookup = {
      ...ALL_EXIST_LOOKUP,
      creatorProfileExists: (id) => id === "good",
    };
    const plan = await planBatch({ batchId: "batch-skip-creator", request, lookup });
    expect(plan.variations.every((v) => v.creatorProfileId === "good")).toBe(true);
    expect(plan.warnings.some((w) => w.includes("'bad' not found"))).toBe(true);
  });

  it("skips non-existent visual treatments with a warning", async () => {
    const request = makeRequest({ visualTreatmentIds: ["vt-ok", "vt-gone"] });
    const lookup: EntityLookup = {
      ...ALL_EXIST_LOOKUP,
      visualTreatmentExists: (id) => id === "vt-ok",
    };
    const plan = await planBatch({ batchId: "batch-skip-vt", request, lookup });
    expect(plan.variations.every((v) => v.visualTreatment === "vt-ok")).toBe(true);
    expect(plan.warnings.some((w) => w.includes("'vt-gone' not found"))).toBe(true);
  });
});

// ─── planBatch: Cost Cap Enforcement ────────────────────────────────────────
describe("planBatch — cost cap enforcement", () => {
  it("rejects if totalEstimatedCost exceeds maxEstimatedCostUsd", async () => {
    // With cheapest vendor (grok_video at $0.20), need >250 variations to exceed $50
    // Let's use a large matrix with low budget
    const request = makeRequest({
      hookCount: 10,
      scriptCount: 3,
      creatorProfileIds: ["c1", "c2"],
      platforms: ["tiktok", "instagram_reels"],
      maxVariations: 200,
      maxEstimatedCostUsd: 5, // very low budget
    });
    const plan = await planBatch({ batchId: "batch-cost-reject", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBe(0);
    expect(plan.rejected.some((r) => r.reason === "cost_cap_exceeded")).toBe(true);
  });

  it("allows plan when cost is within budget", async () => {
    const request = makeRequest({
      hookCount: 2,
      scriptCount: 1,
      platforms: ["tiktok"],
      maxEstimatedCostUsd: 50,
    });
    const plan = await planBatch({ batchId: "batch-cost-ok", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBeGreaterThan(0);
    expect(plan.rejected.length).toBe(0);
    expect(plan.totalEstimatedCost).toBeLessThanOrEqual(50);
  });

  it("reports the estimated cost even when rejecting", async () => {
    const request = makeRequest({
      hookCount: 5,
      scriptCount: 3,
      creatorProfileIds: ["c1", "c2", "c3"],
      platforms: ["tiktok", "instagram_reels"],
      maxVariations: 200,
      maxEstimatedCostUsd: 1, // impossibly low
    });
    const plan = await planBatch({ batchId: "batch-cost-report", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.totalEstimatedCost).toBeGreaterThan(1);
    expect(plan.rejected.length).toBe(1);
    expect(plan.rejected[0].details).toContain("$");
  });

  it("selects cheapest vendor correctly for 'cheapest' policy", async () => {
    const request = makeRequest({ vendorPolicy: { policy: "cheapest" } });
    const plan = await planBatch({ batchId: "batch-cheapest", request, lookup: ALL_EXIST_LOOKUP });
    // grok_video is cheapest at $0.20
    const cheapest = (Object.entries(VENDOR_RATES) as [string, number][])
      .sort((a, b) => a[1] - b[1])[0][0];
    expect(plan.variations[0].vendor).toBe(cheapest);
  });

  it("uses specific vendor when policy is 'specific'", async () => {
    const request = makeRequest({
      vendorPolicy: { policy: "specific", specificVendor: "runway" },
    });
    const plan = await planBatch({ batchId: "batch-specific", request, lookup: ALL_EXIST_LOOKUP });
    for (const v of plan.variations) {
      expect(v.vendor).toBe("runway");
      expect(v.estimatedCost).toBe(VENDOR_RATES.runway);
    }
  });
});

// ─── Idempotency Key Stability ──────────────────────────────────────────────
describe("idempotency key stability", () => {
  it("produces the same key for identical inputs", () => {
    const parts = {
      batchId: "batch-123",
      productProfileId: "prod-1",
      templateId: "tmpl-1",
      creatorProfileId: "creator-a",
      hookIndex: 0,
      scriptIndex: 0,
      visualTreatment: "vt-cinematic",
      captionStyle: "bold",
      ctaVariant: "Buy now",
      platform: "tiktok",
      vendorPolicy: "cheapest",
    };
    const key1 = generateIdempotencyKey(parts);
    const key2 = generateIdempotencyKey(parts);
    expect(key1).toBe(key2);
  });

  it("produces different keys when any single field changes", () => {
    const base = {
      batchId: "batch-123",
      productProfileId: "prod-1",
      templateId: "tmpl-1",
      creatorProfileId: "creator-a",
      hookIndex: 0,
      scriptIndex: 0,
      visualTreatment: "vt-cinematic",
      captionStyle: "bold",
      ctaVariant: "Buy now",
      platform: "tiktok",
      vendorPolicy: "cheapest",
    };

    const baseKey = generateIdempotencyKey(base);
    const fields: (keyof typeof base)[] = [
      "batchId", "productProfileId", "templateId", "creatorProfileId",
      "hookIndex", "scriptIndex", "visualTreatment", "captionStyle",
      "ctaVariant", "platform", "vendorPolicy",
    ];

    for (const field of fields) {
      const modified = { ...base };
      if (typeof modified[field] === "number") {
        (modified as Record<string, unknown>)[field] = (modified[field] as number) + 1;
      } else {
        (modified as Record<string, unknown>)[field] = `${modified[field]}-changed`;
      }
      const newKey = generateIdempotencyKey(modified as typeof base);
      expect(newKey).not.toBe(baseKey);
    }
  });

  it("is exactly 32 hex characters", () => {
    const key = generateIdempotencyKey({
      batchId: "b",
      productProfileId: "p",
      hookIndex: 0,
      scriptIndex: 0,
      captionStyle: "bold",
      platform: "tiktok",
      vendorPolicy: "cheapest",
    });
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles optional fields as empty string for consistent hashing", () => {
    const withUndefined = generateIdempotencyKey({
      batchId: "b",
      productProfileId: "p",
      templateId: undefined,
      creatorProfileId: undefined,
      hookIndex: 0,
      scriptIndex: 0,
      visualTreatment: undefined,
      captionStyle: "bold",
      ctaVariant: undefined,
      platform: "tiktok",
      vendorPolicy: "cheapest",
    });
    const withoutOptionals = generateIdempotencyKey({
      batchId: "b",
      productProfileId: "p",
      hookIndex: 0,
      scriptIndex: 0,
      captionStyle: "bold",
      platform: "tiktok",
      vendorPolicy: "cheapest",
    });
    expect(withUndefined).toBe(withoutOptionals);
  });
});

// ─── Sub-schema enums ───────────────────────────────────────────────────────
describe("sub-schemas", () => {
  it("VideoVendorSchema includes seedance and grok_video", () => {
    expect(VideoVendorSchema.parse("seedance")).toBe("seedance");
    expect(VideoVendorSchema.parse("grok_video")).toBe("grok_video");
  });

  it("CaptionStyleSchema validates correctly", () => {
    expect(CaptionStyleSchema.parse("clean")).toBe("clean");
    expect(CaptionStyleSchema.parse("bold")).toBe("bold");
    expect(CaptionStyleSchema.parse("minimal")).toBe("minimal");
    expect(() => CaptionStyleSchema.parse("neon")).toThrow();
  });

  it("DeduplicationModeSchema validates correctly", () => {
    expect(DeduplicationModeSchema.parse("strict")).toBe("strict");
    expect(DeduplicationModeSchema.parse("relaxed")).toBe("relaxed");
    expect(() => DeduplicationModeSchema.parse("fuzzy")).toThrow();
  });

  it("VendorPolicySchema validates discriminated union", () => {
    expect(VendorPolicySchema.parse({ policy: "cheapest" })).toEqual({ policy: "cheapest" });
    expect(VendorPolicySchema.parse({ policy: "quality" })).toEqual({ policy: "quality" });
    expect(
      VendorPolicySchema.parse({ policy: "specific", specificVendor: "kling" })
    ).toEqual({ policy: "specific", specificVendor: "kling" });
    expect(() => VendorPolicySchema.parse({ policy: "specific" })).toThrow();
    expect(() => VendorPolicySchema.parse({ policy: "random" })).toThrow();
  });
});

// ─── planBatch: Edge cases ──────────────────────────────────────────────────
describe("planBatch — edge cases", () => {
  it("produces variations even with no creators (uses undefined)", async () => {
    const request = makeRequest({ creatorProfileIds: [] });
    const plan = await planBatch({ batchId: "batch-no-creators", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBeGreaterThan(0);
    expect(plan.variations[0].creatorProfileId).toBeUndefined();
  });

  it("produces variations even with no visual treatments", async () => {
    const request = makeRequest({ visualTreatmentIds: undefined });
    const plan = await planBatch({ batchId: "batch-no-vt", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBeGreaterThan(0);
    expect(plan.variations[0].visualTreatment).toBeUndefined();
  });

  it("produces variations even with no CTAs", async () => {
    const request = makeRequest({ ctaVariants: undefined });
    const plan = await planBatch({ batchId: "batch-no-cta", request, lookup: ALL_EXIST_LOOKUP });
    expect(plan.variations.length).toBeGreaterThan(0);
    expect(plan.variations[0].ctaVariant).toBeUndefined();
  });

  it("variation IDs are sequential and stable", async () => {
    const request = makeRequest({ hookCount: 3 });
    const plan = await planBatch({ batchId: "batch-ids", request, lookup: ALL_EXIST_LOOKUP });
    for (let i = 0; i < plan.variations.length; i++) {
      expect(plan.variations[i].variationId).toBe(
        `batch-ids_v${String(i + 1).padStart(4, "0")}`
      );
    }
  });

  it("quality policy selects runway", async () => {
    const request = makeRequest({ vendorPolicy: { policy: "quality" } });
    const plan = await planBatch({ batchId: "batch-quality", request, lookup: ALL_EXIST_LOOKUP });
    for (const v of plan.variations) {
      expect(v.vendor).toBe("runway");
    }
  });
});
