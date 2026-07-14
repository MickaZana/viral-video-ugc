import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import type { ReviewItem } from "@vvugc/shared-schema";

/**
 * Plain JSON-file store instead of SQLite: this is a small local scaffold
 * (weekly-cadence CLI + a review dashboard), and it avoids requiring native
 * build tools (better-sqlite3) just to run it. Swap this for a real
 * datastore (Postgres/DynamoDB) when deploying to serverless with
 * concurrent invocations across multiple processes/machines.
 *
 * Within a single machine, concurrent writers (e.g. two rapid dashboard
 * clicks, or a dashboard approve racing a CLI run's insert) are made safe
 * by a simple exclusive lockfile: `open(path, "wx")` atomically fails if
 * the lock already exists, so only one read-modify-write cycle proceeds at
 * a time. This is a real fix for the read-all/write-all race, not a full
 * substitute for a database's transactional guarantees across machines.
 */
function acquireLock(dbPath: string, timeoutMs = 5000): void {
  const lockPath = `${dbPath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for review-queue lock at ${lockPath}`);
      }
      // Busy-wait synchronously (this store's callers are simple sync request
      // handlers, not async, so there's no event loop work to yield to).
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

function readAllUnlocked(dbPath: string): ReviewItem[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, items: ReviewItem[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(items, null, 2));
}

/** Runs `fn` against the current items with the lock held, writing back whatever `fn` returns. */
function withLock(fn: (items: ReviewItem[]) => ReviewItem[]): void {
  const { VVUGC_DB_PATH } = loadEnv();
  mkdirSync(dirname(VVUGC_DB_PATH), { recursive: true });
  acquireLock(VVUGC_DB_PATH);
  try {
    writeAllUnlocked(VVUGC_DB_PATH, fn(readAllUnlocked(VVUGC_DB_PATH)));
  } finally {
    releaseLock(VVUGC_DB_PATH);
  }
}

export function insertReviewItem(item: ReviewItem): void {
  withLock((items) => [...items, item]);
}

export interface ReviewItemFilter {
  status?: ReviewItem["status"];
  niche?: string;
  platform?: ReviewItem["platform"];
}

/** Accepts either a bare status (legacy call shape, still supported) or a filter object. */
export function listReviewItems(filter?: ReviewItem["status"] | ReviewItemFilter): ReviewItem[] {
  const { VVUGC_DB_PATH } = loadEnv();
  const items = readAllUnlocked(VVUGC_DB_PATH).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { status, niche, platform } = typeof filter === "string" ? { status: filter } : (filter ?? {});
  return items.filter(
    (i) => (!status || i.status === status) && (!niche || i.niche === niche) && (!platform || i.platform === platform)
  );
}

export function getReviewItem(id: string): ReviewItem | undefined {
  const { VVUGC_DB_PATH } = loadEnv();
  return readAllUnlocked(VVUGC_DB_PATH).find((i) => i.id === id);
}

export function setReviewItemStatus(id: string, status: "approved" | "rejected"): void {
  withLock((items) => {
    const item = items.find((i) => i.id === id);
    if (item) item.status = status;
    return items;
  });
}

/** Bulk variant, used by the dashboard's "select multiple, approve/reject" action —
 *  a single lock acquisition for the whole batch rather than one per item. */
export function setReviewItemsStatus(ids: string[], status: "approved" | "rejected"): string[] {
  const updated: string[] = [];
  withLock((items) => {
    const idSet = new Set(ids);
    for (const item of items) {
      if (idSet.has(item.id)) {
        item.status = status;
        updated.push(item.id);
      }
    }
    return items;
  });
  return updated;
}
