import { loadEnv } from "@vvugc/shared-config";
import type { ReviewItem } from "@vvugc/shared-schema";
import { createJsonStore } from "./json-store.js";
import type { ReviewItemFilter, ReviewQueueStore } from "./store.js";

export type { ReviewItemFilter } from "./store.js";

/**
 * Picks the storage backend once per (dbPath, databaseUrl) pair and reuses it —
 * a fresh `Pool`/lockfile per call would be wasteful, and DATABASE_URL/VVUGC_DB_PATH
 * don't change mid-process outside tests (which each set their own env + import
 * this module fresh, matching the existing test pattern in db.test.ts).
 */
let cached: { key: string; store: ReviewQueueStore } | undefined;

async function getStore(): Promise<ReviewQueueStore> {
  const { DATABASE_URL, VVUGC_DB_PATH } = loadEnv();
  const key = DATABASE_URL ?? `json:${VVUGC_DB_PATH}`;
  if (cached?.key === key) return cached.store;

  if (DATABASE_URL) {
    // Dynamic import, not a top-level one: `pg` opens real network I/O and is
    // unused entirely by the default JSON-store path — importing it eagerly
    // would mean every JSON-store-only deployment pays for loading it.
    const [{ Pool }, { createPostgresStore }] = await Promise.all([import("pg"), import("./postgres-store.js")]);
    cached = { key, store: createPostgresStore(new Pool({ connectionString: DATABASE_URL })) };
  } else {
    cached = { key, store: createJsonStore(VVUGC_DB_PATH) };
  }
  return cached.store;
}

export async function insertReviewItem(item: ReviewItem): Promise<void> {
  await (await getStore()).insertReviewItem(item);
}

/** Accepts either a bare status (legacy call shape, still supported) or a filter object. */
export async function listReviewItems(filter?: ReviewItem["status"] | ReviewItemFilter): Promise<ReviewItem[]> {
  const normalized: ReviewItemFilter | undefined = typeof filter === "string" ? { status: filter } : filter;
  return await (await getStore()).listReviewItems(normalized);
}

export async function getReviewItem(id: string): Promise<ReviewItem | undefined> {
  return await (await getStore()).getReviewItem(id);
}

export async function setReviewItemStatus(id: string, status: "approved" | "rejected"): Promise<void> {
  await (await getStore()).setReviewItemStatus(id, status);
}

/** Bulk variant, used by the dashboard's "select multiple, approve/reject" action —
 *  a single lock acquisition (JSON store) or single UPDATE (Postgres store) for the whole batch. */
export async function setReviewItemsStatus(ids: string[], status: "approved" | "rejected"): Promise<string[]> {
  return await (await getStore()).setReviewItemsStatus(ids, status);
}
