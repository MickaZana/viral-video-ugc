import type { ReviewItem } from "@vvugc/shared-schema";

export interface ReviewItemFilter {
  status?: ReviewItem["status"];
  niche?: string;
  platform?: ReviewItem["platform"];
}

/**
 * Storage-backend contract shared by the JSON-file store (json-store.ts, default —
 * safe for concurrent processes on one machine) and the Postgres store
 * (postgres-store.ts, opt-in via DATABASE_URL — safe across machines/processes).
 * db.ts picks between them; callers only ever import from db.ts/index.ts.
 */
export interface ReviewQueueStore {
  insertReviewItem(item: ReviewItem): Promise<void> | void;
  listReviewItems(filter?: ReviewItemFilter): Promise<ReviewItem[]> | ReviewItem[];
  getReviewItem(id: string): Promise<ReviewItem | undefined> | ReviewItem | undefined;
  setReviewItemStatus(id: string, status: "approved" | "rejected"): Promise<void> | void;
  setReviewItemsStatus(ids: string[], status: "approved" | "rejected"): Promise<string[]> | string[];
}
