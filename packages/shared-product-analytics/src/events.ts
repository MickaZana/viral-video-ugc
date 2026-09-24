import { z } from "zod";

/**
 * Product/UX usage events — distinct from @vvugc/shared-analytics, which
 * tracks published-CONTENT performance (TikTok/Meta/YouTube post-publish
 * metrics feeding back into script-agent prompts). This package answers a
 * different question: is anyone actually USING the product, and which
 * features. That's the "real usage feedback loop" catch-up item from this
 * session's Higgsfield gap analysis — Higgsfield's advantage here was never
 * a missing feature per se, it's simply market-testedness: a large existing
 * user base whose behavior already shapes the roadmap. This package is the
 * plumbing this app needs to start closing that gap the same way, not a
 * claim that usage data already exists to learn from yet.
 *
 * A closed, small vocabulary — real actions tied to real routes that exist
 * today (see docs/surfaces.md's route inventory), not a generic "track
 * anything" event bus. Extend this list deliberately as real features ship;
 * don't let call sites invent ad-hoc event type strings.
 */
export const PRODUCT_EVENT_TYPES = [
  "discovery_viewed",
  "remix_started",
  "run_started",
  "batch_planned",
  "batch_enqueued",
  "review_item_approved",
  "review_item_rejected",
  "brand_product_created",
  "brand_creator_created",
  "settings_viewed",
  "billing_viewed"
] as const;
export const ProductEventTypeSchema = z.enum(PRODUCT_EVENT_TYPES);
export type ProductEventType = z.infer<typeof ProductEventTypeSchema>;

/** What a caller supplies — id/occurredAt are always server-assigned (see
 *  createProductEventStore.record), same reason orgId/accountId are always
 *  derived from the authenticated session server-side, never trusted from
 *  the request body (see review-dashboard's product-analytics-routes.ts). */
export const ProductEventInputSchema = z.object({
  orgId: z.string().min(1),
  accountId: z.string().min(1),
  eventType: ProductEventTypeSchema,
  /** Small, non-sensitive context (e.g. { platform: "tiktok" }, { vendor: "higgsfield" }).
   *  Never put PII, free-text user content, or anything sensitive here — this file is a
   *  flat JSON log, not an access-controlled data store. */
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
});
export type ProductEventInput = z.infer<typeof ProductEventInputSchema>;

export const ProductEventSchema = ProductEventInputSchema.extend({
  id: z.string().min(1),
  occurredAt: z.string().datetime()
});
export type ProductEvent = z.infer<typeof ProductEventSchema>;
