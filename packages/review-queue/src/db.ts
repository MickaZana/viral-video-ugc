import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import type { ReviewItem } from "@vvugc/shared-schema";

/**
 * Plain JSON-file store instead of SQLite: this is a single-process local
 * scaffold (weekly-cadence CLI + a small review dashboard), so there's no
 * concurrent-writer scenario that needs real SQL — and it avoids requiring
 * native build tools (better-sqlite3) just to run the scaffold. Swap this
 * for a real datastore (Postgres/DynamoDB) when deploying to serverless
 * with concurrent invocations.
 */
function readAll(): ReviewItem[] {
  const { VVUGC_DB_PATH } = loadEnv();
  if (!existsSync(VVUGC_DB_PATH)) return [];
  return JSON.parse(readFileSync(VVUGC_DB_PATH, "utf-8"));
}

function writeAll(items: ReviewItem[]): void {
  const { VVUGC_DB_PATH } = loadEnv();
  mkdirSync(dirname(VVUGC_DB_PATH), { recursive: true });
  writeFileSync(VVUGC_DB_PATH, JSON.stringify(items, null, 2));
}

export function insertReviewItem(item: ReviewItem): void {
  const items = readAll();
  items.push(item);
  writeAll(items);
}

export function listReviewItems(status?: ReviewItem["status"]): ReviewItem[] {
  const items = readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return status ? items.filter((i) => i.status === status) : items;
}

export function getReviewItem(id: string): ReviewItem | undefined {
  return readAll().find((i) => i.id === id);
}

export function setReviewItemStatus(id: string, status: "approved" | "rejected"): void {
  const items = readAll();
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.status = status;
  writeAll(items);
}
