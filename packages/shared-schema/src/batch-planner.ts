/**
 * Batch Variation Generation — Atom B: Variation Planning Algorithm
 *
 * Deterministic planner that takes a validated BatchRequest, verifies
 * referenced entities exist via a lookup interface, computes the full
 * combinatorial matrix, deduplicates, caps, cost-estimates, and returns
 * a BatchPlan with explanations.
 */
import { createHash } from "node:crypto";
import type { Platform } from "./platform.js";
import type {
  BatchPlan,
  BatchRequest,
  BatchVariation,
  BatchVariationStatus,
  CaptionStyle,
  DeduplicationMode,
  VideoVendor,
} from "./batch.js";
import { HARD_LIMITS } from "./batch.js";

// ─── Entity Lookup Interface ────────────────────────────────────────────────
/** Callers supply this so the planner can verify referenced IDs exist. */
export interface EntityLookup {
  productProfileExists(id: string): boolean | Promise<boolean>;
  creatorProfileExists(id: string): boolean | Promise<boolean>;
  templateExists(id: string): boolean | Promise<boolean>;
  visualTreatmentExists(id: string): boolean | Promise<boolean>;
}

// ─── Vendor Rate Table (per-variation estimated cost in USD) ────────────────
/** Estimated per-clip rates for batch cost estimation. Mirrors shared-cost's
 *  RATE_TABLE but expressed as per-variation (includes script+generation). */
const VENDOR_RATES: Record<VideoVendor, number> = {
  higgsfield: 0.40,
  kling: 0.35,
  runway: 0.50,
  pika: 0.30,
  gemini: 0.25,
  replicate: 0.40,
  seedance: 0.30,
  grok_video: 0.20,
};

// ─── Vendor Selection ───────────────────────────────────────────────────────
function selectVendor(
  policy: BatchRequest["vendorPolicy"]
): VideoVendor {
  switch (policy.policy) {
    case "cheapest":
      // Pick the vendor with the lowest per-clip rate
      return (Object.entries(VENDOR_RATES) as [VideoVendor, number][])
        .sort((a, b) => a[1] - b[1])[0][0];
    case "quality":
      // Prefer runway for quality (highest fidelity in our pipeline)
      return "runway";
    case "specific":
      return policy.specificVendor;
  }
}

// ─── Idempotency Key Generation ────────────────────────────────────────────
/** Generates a stable, deterministic key from all variation-defining axes.
 *  Same inputs always produce the same key regardless of ordering/timing. */
export function generateIdempotencyKey(parts: {
  batchId: string;
  productProfileId: string;
  templateId?: string;
  creatorProfileId?: string;
  hookIndex: number;
  scriptIndex: number;
  visualTreatment?: string;
  captionStyle: string;
  ctaVariant?: string;
  platform: string;
  vendorPolicy: string;
}): string {
  const payload = [
    parts.batchId,
    parts.productProfileId,
    parts.templateId ?? "",
    parts.creatorProfileId ?? "",
    String(parts.hookIndex),
    String(parts.scriptIndex),
    parts.visualTreatment ?? "",
    parts.captionStyle,
    parts.ctaVariant ?? "",
    parts.platform,
    parts.vendorPolicy,
  ].join("|");

  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ─── Deduplication ──────────────────────────────────────────────────────────
/** Strict mode: full key uniqueness. Relaxed: allows same hook+script
 *  across different platforms/caption styles (deduplicates only on
 *  product + creator + hook + script + visual + cta + vendor). */
function deduplicationKey(
  variation: BatchVariation,
  mode: DeduplicationMode
): string {
  if (mode === "strict") {
    return variation.idempotencyKey;
  }
  // Relaxed: ignore platform and captionStyle differences
  return [
    variation.productProfileId,
    variation.creatorProfileId ?? "",
    String(variation.hookIndex),
    String(variation.scriptIndex),
    variation.visualTreatment ?? "",
    variation.ctaVariant ?? "",
    variation.vendor,
  ].join("|");
}

// ─── Variation Label ────────────────────────────────────────────────────────
function buildVariationLabel(v: {
  hookIndex: number;
  scriptIndex: number;
  platform: string;
  creatorProfileId?: string;
  visualTreatment?: string;
  captionStyle: string;
  ctaVariant?: string;
}, index: number): string {
  const parts = [
    `H${v.hookIndex + 1}`,
    `S${v.scriptIndex + 1}`,
    v.platform,
  ];
  if (v.creatorProfileId) parts.push(`C:${v.creatorProfileId.slice(0, 6)}`);
  if (v.visualTreatment) parts.push(`VT:${v.visualTreatment.slice(0, 6)}`);
  parts.push(v.captionStyle);
  if (v.ctaVariant) parts.push(`CTA:${v.ctaVariant.slice(0, 12)}`);
  return `var-${String(index + 1).padStart(3, "0")}_${parts.join("_")}`;
}

// ─── Main Planner ───────────────────────────────────────────────────────────
export interface PlanBatchOptions {
  /** Unique batch ID — provided by caller, used in idempotency keys. */
  batchId: string;
  request: BatchRequest;
  lookup: EntityLookup;
}

export async function planBatch(options: PlanBatchOptions): Promise<BatchPlan> {
  const { batchId, request, lookup } = options;
  const warnings: string[] = [];
  const rejected: BatchPlan["rejected"] = [];

  // ── 1. Validate referenced entities ───────────────────────────────────────
  if (!(await lookup.productProfileExists(request.productProfileId))) {
    return {
      batchId,
      variations: [],
      totalEstimatedCost: 0,
      warnings: [],
      rejected: [{ reason: "product_profile_not_found", details: `Product profile '${request.productProfileId}' does not exist.` }],
    };
  }

  if (request.templateId && !(await lookup.templateExists(request.templateId))) {
    return {
      batchId,
      variations: [],
      totalEstimatedCost: 0,
      warnings: [],
      rejected: [{ reason: "template_not_found", details: `Template '${request.templateId}' does not exist.` }],
    };
  }

  // Validate creators — skip invalid ones with a warning
  const validCreatorIds: string[] = [];
  for (const creatorId of request.creatorProfileIds) {
    if (await lookup.creatorProfileExists(creatorId)) {
      validCreatorIds.push(creatorId);
    } else {
      warnings.push(`Creator '${creatorId}' not found — skipped.`);
    }
  }

  // Validate visual treatments — skip invalid ones with a warning
  const validVisualTreatments: string[] = [];
  if (request.visualTreatmentIds) {
    for (const vtId of request.visualTreatmentIds) {
      if (await lookup.visualTreatmentExists(vtId)) {
        validVisualTreatments.push(vtId);
      } else {
        warnings.push(`Visual treatment '${vtId}' not found — skipped.`);
      }
    }
  }

  // ── 2. Resolve dimension arrays ──────────────────────────────────────────
  const creators = validCreatorIds.length > 0 ? validCreatorIds : [undefined];
  const hooks = Array.from({ length: request.hookCount }, (_, i) => i);
  const scripts = Array.from({ length: request.scriptCount }, (_, i) => i);
  const platforms: Platform[] = request.platforms;
  const visualTreatments = validVisualTreatments.length > 0 ? validVisualTreatments : [undefined];
  const captionStyles: CaptionStyle[] = request.captionStyleIds && request.captionStyleIds.length > 0
    ? request.captionStyleIds
    : ["bold"];
  const ctaVariants: Array<string | undefined> = request.ctaVariants && request.ctaVariants.length > 0
    ? request.ctaVariants
    : [undefined];

  // ── 3. Select vendor ─────────────────────────────────────────────────────
  const vendor = selectVendor(request.vendorPolicy);
  const vendorPolicyStr = request.vendorPolicy.policy === "specific"
    ? `specific:${request.vendorPolicy.specificVendor}`
    : request.vendorPolicy.policy;

  // ── 4. Compute full combinatorial matrix ─────────────────────────────────
  const allVariations: BatchVariation[] = [];
  let variationIndex = 0;

  for (const hookIndex of hooks) {
    for (const scriptIndex of scripts) {
      for (const creatorId of creators) {
        for (const platform of platforms) {
          for (const vt of visualTreatments) {
            for (const captionStyle of captionStyles) {
              for (const ctaVariant of ctaVariants) {
                const idempotencyKey = generateIdempotencyKey({
                  batchId,
                  productProfileId: request.productProfileId,
                  templateId: request.templateId,
                  creatorProfileId: creatorId,
                  hookIndex,
                  scriptIndex,
                  visualTreatment: vt,
                  captionStyle,
                  ctaVariant,
                  platform,
                  vendorPolicy: vendorPolicyStr,
                });

                const variation: BatchVariation = {
                  variationId: `${batchId}_v${String(variationIndex + 1).padStart(4, "0")}`,
                  variationLabel: "", // placeholder, set after dedup
                  idempotencyKey,
                  productProfileId: request.productProfileId,
                  creatorProfileId: creatorId,
                  templateId: request.templateId,
                  hookIndex,
                  scriptIndex,
                  visualTreatment: vt,
                  captionStyle,
                  ctaVariant,
                  platform,
                  vendor,
                  estimatedCost: VENDOR_RATES[vendor],
                  status: "planned" as BatchVariationStatus,
                };

                allVariations.push(variation);
                variationIndex++;
              }
            }
          }
        }
      }
    }
  }

  // ── 5. Deduplicate ───────────────────────────────────────────────────────
  const seen = new Set<string>();
  const deduplicated: BatchVariation[] = [];

  for (const v of allVariations) {
    const key = deduplicationKey(v, request.deduplicationMode);
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(v);
    }
  }

  const removedByDedup = allVariations.length - deduplicated.length;
  if (removedByDedup > 0) {
    warnings.push(
      `Deduplication (${request.deduplicationMode}) removed ${removedByDedup} duplicate variation(s).`
    );
  }

  // ── 6. Apply maxVariations cap ───────────────────────────────────────────
  let capped = deduplicated;
  if (capped.length > request.maxVariations) {
    warnings.push(
      `Matrix produced ${capped.length} variations — capped to maxVariations=${request.maxVariations}.`
    );
    capped = capped.slice(0, request.maxVariations);
  }

  // Also enforce absolute hard limit
  if (capped.length > HARD_LIMITS.MAX_VARIATIONS_PER_BATCH) {
    warnings.push(
      `Exceeded hard limit of ${HARD_LIMITS.MAX_VARIATIONS_PER_BATCH} — truncating.`
    );
    capped = capped.slice(0, HARD_LIMITS.MAX_VARIATIONS_PER_BATCH);
  }

  // ── 7. Assign stable labels and IDs ──────────────────────────────────────
  const finalVariations = capped.map((v, i) => ({
    ...v,
    variationId: `${batchId}_v${String(i + 1).padStart(4, "0")}`,
    variationLabel: buildVariationLabel(v, i),
  }));

  // ── 8. Compute total estimated cost ──────────────────────────────────────
  const totalEstimatedCost = Number(
    finalVariations.reduce((sum, v) => sum + v.estimatedCost, 0).toFixed(4)
  );

  // ── 9. Cost cap enforcement ──────────────────────────────────────────────
  if (totalEstimatedCost > request.maxEstimatedCostUsd) {
    rejected.push({
      reason: "cost_cap_exceeded",
      details: `Estimated cost $${totalEstimatedCost.toFixed(2)} exceeds maxEstimatedCostUsd=$${request.maxEstimatedCostUsd.toFixed(2)}. Reduce variation dimensions or increase the budget.`,
    });
    return {
      batchId,
      variations: [],
      totalEstimatedCost,
      warnings,
      rejected,
    };
  }

  if (totalEstimatedCost > HARD_LIMITS.MAX_ESTIMATED_SPEND_USD) {
    rejected.push({
      reason: "hard_limit_cost_exceeded",
      details: `Estimated cost $${totalEstimatedCost.toFixed(2)} exceeds absolute hard limit of $${HARD_LIMITS.MAX_ESTIMATED_SPEND_USD}.`,
    });
    return {
      batchId,
      variations: [],
      totalEstimatedCost,
      warnings,
      rejected,
    };
  }

  return {
    batchId,
    variations: finalVariations,
    totalEstimatedCost,
    warnings,
    rejected,
  };
}

export { VENDOR_RATES };
