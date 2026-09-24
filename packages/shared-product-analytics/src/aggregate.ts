import { PRODUCT_EVENT_TYPES, type ProductEvent, type ProductEventType } from "./events.js";

/** Count of each event type present in the given events — every known
 *  ProductEventType is present in the result (zeroed if unseen), so a caller
 *  never has to guard against a missing key. */
export function featureUsageCounts(events: ProductEvent[]): Record<ProductEventType, number> {
  const counts = Object.fromEntries(PRODUCT_EVENT_TYPES.map((type) => [type, 0])) as Record<ProductEventType, number>;
  for (const event of events) counts[event.eventType]++;
  return counts;
}

export interface FeatureUsageRanking {
  eventType: ProductEventType;
  count: number;
}

/** Event types ranked by usage count, descending. Only includes types with
 *  at least one event — a feature nobody has touched yet doesn't clutter a
 *  "most used" list, but IS still visible via featureUsageCounts() above. */
export function mostUsedFeatures(events: ProductEvent[]): FeatureUsageRanking[] {
  const counts = featureUsageCounts(events);
  return PRODUCT_EVENT_TYPES
    .map((eventType) => ({ eventType, count: counts[eventType] }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Distinct accountIds with at least one event at/after sinceMs — the
 *  simplest real "is anyone actually using this" signal: active users in a
 *  window, not just events recorded. */
export function activeAccountIds(events: ProductEvent[], sinceMs: number): Set<string> {
  const active = new Set<string>();
  for (const event of events) {
    if (new Date(event.occurredAt).getTime() >= sinceMs) active.add(event.accountId);
  }
  return active;
}

export interface ProductUsageSummary {
  totalEvents: number;
  activeAccountCount: number;
  mostUsedFeatures: FeatureUsageRanking[];
  featureUsageCounts: Record<ProductEventType, number>;
}

/** The one-call summary a usage-analytics endpoint/dashboard wants —
 *  composes the helpers above rather than duplicating their logic. */
export function summarizeUsage(events: ProductEvent[], sinceMs: number): ProductUsageSummary {
  return {
    totalEvents: events.length,
    activeAccountCount: activeAccountIds(events, sinceMs).size,
    mostUsedFeatures: mostUsedFeatures(events),
    featureUsageCounts: featureUsageCounts(events)
  };
}
