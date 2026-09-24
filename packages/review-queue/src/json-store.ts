import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReviewItem } from "@vvugc/shared-schema";
import type { ReviewItemFilter, ReviewQueueStore } from "./store.js";

/**
 * Plain JSON-file store — the default when DATABASE_URL is unset (see db.ts).
 * Good fit for a single machine: a small local scaffold (weekly-cadence CLI +
 * a review dashboard) without requiring native build tools or a hosted database
 * just to run it locally. Not safe across machines/processes that don't share a
 * filesystem — see postgres-store.ts for that case, and packages/review-queue/README.md
 * for when to switch.
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
function withLock(dbPath: string, fn: (items: ReviewItem[]) => ReviewItem[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  acquireLock(dbPath);
  try {
    writeAllUnlocked(dbPath, fn(readAllUnlocked(dbPath)));
  } finally {
    releaseLock(dbPath);
  }
}

export function createJsonStore(dbPath: string): ReviewQueueStore {
  return {
    insertReviewItem(item) {
      withLock(dbPath, (items) => [...items, item]);
    },

    listReviewItems(filter) {
      const items = readAllUnlocked(dbPath).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const { status, niche, platform, orgId, clientId, dryRun } = filter ?? ({} as ReviewItemFilter);
      return items.filter(
        (i) =>
          (!status || i.status === status) &&
          (!niche || i.niche === niche) &&
          (!platform || i.platform === platform) &&
          (!orgId || i.orgId === orgId) &&
          (!clientId || i.clientId === clientId) &&
          (dryRun === undefined || (i.dryRun ?? false) === dryRun)
      );
    },

    getReviewItem(id) {
      return readAllUnlocked(dbPath).find((i) => i.id === id);
    },

    setReviewItemStatus(id, status) {
      withLock(dbPath, (items) => {
        const item = items.find((i) => i.id === id);
        if (item) item.status = status;
        return items;
      });
    },

    setReviewItemsStatus(ids, status) {
      const updated: string[] = [];
      withLock(dbPath, (items) => {
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
    },

    replaceReviewItem(item) {
      withLock(dbPath, (items) => items.map((existing) => (existing.id === item.id ? item : existing)));
    },

    deleteByOrg(orgId) {
      let removed = 0;
      withLock(dbPath, (items) => {
        const kept = items.filter((item) => {
          if (item.orgId === orgId) {
            removed++;
            return false;
          }
          return true;
        });
        return kept;
      });
      return removed;
    }
  };
}
