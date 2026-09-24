/**
 * @vvugc/shared-product-analytics — in-app product/UX usage tracking.
 *
 * Distinct from @vvugc/shared-analytics (published-content performance
 * feeding back into script-agent prompts) — this package answers "is anyone
 * using this product, and which features," the "real usage feedback loop"
 * catch-up item from this session's Higgsfield gap analysis. See events.ts's
 * doc comment for the full framing.
 */
export {
  PRODUCT_EVENT_TYPES,
  ProductEventTypeSchema,
  ProductEventInputSchema,
  ProductEventSchema,
  type ProductEventType,
  type ProductEventInput,
  type ProductEvent
} from "./events.js";

export {
  createProductEventStore,
  type ProductEventStore,
  type ProductEventListFilter
} from "./event-store.js";

export {
  featureUsageCounts,
  mostUsedFeatures,
  activeAccountIds,
  summarizeUsage,
  type FeatureUsageRanking,
  type ProductUsageSummary
} from "./aggregate.js";
