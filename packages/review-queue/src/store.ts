import type { ReviewItem } from "@vvugc/shared-schema";

export interface ReviewItemFilter {
  status?: ReviewItem["status"];
  niche?: string;
  platform?: ReviewItem["platform"];
  orgId?: string;
  clientId?: string;
  /** When set, restrict to mock (`true`) or real (`false`) items. Items written
   *  before the `dryRun` field existed are treated as real (false). */
  dryRun?: boolean;
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
  /** Overwrites the stored item with the same id — used by scene/script regeneration
   *  (apps/orchestrator/src/regenerate.ts) to replace videoPath/clips/score/etc. in place
   *  after producing a new render. A no-op if no item with that id exists. */
  replaceReviewItem(item: ReviewItem): Promise<void> | void;
  /** Hard-deletes every item belonging to an org (account deletion of the org owner).
   *  Returns how many were removed. */
  deleteByOrg(orgId: string): Promise<number> | number;
}
