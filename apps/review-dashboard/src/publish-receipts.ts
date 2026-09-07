import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Closes the "adapter.publish() succeeded but the DB write to persist
 * publishedPostId crashed" gap: the existing `if (item.publishedPostId)`
 * guard in server.ts only catches double-publish once that write has
 * actually landed. Between a real vendor success and that write failing,
 * a retry has no way to know a post already exists — this receipt is
 * written first, synchronously, right after the vendor call returns, so a
 * retry has somewhere to check before calling the vendor again.
 *
 * Append-only NDJSON, not the JSON-store's read-lock-mutate-write pattern:
 * a single `appendFileSync` call is one write() syscall for lines well
 * under PIPE_BUF (4096 bytes on Linux), so concurrent appends from the
 * same process don't interleave or corrupt each other. What this does NOT
 * do is stop two concurrent requests from both reaching adapter.publish()
 * in the first place — see the in-flight guard in server.ts's publish
 * route for that; this module only prevents a *retried* duplicate.
 */
export interface PublishReceipt {
  itemId: string;
  orgId?: string;
  postId: string;
  url?: string;
  platform: string;
  at: string;
}

export interface PublishReceiptStore {
  record(receipt: PublishReceipt): void;
  /** Scoped by itemId AND orgId (when the item has one) — defense in depth,
   *  even though the publish route already rejects cross-org access to an
   *  item before this is ever consulted. Returns the earliest receipt for
   *  the item, since that's the one real vendor post that happened. */
  find(itemId: string, orgId?: string): PublishReceipt | undefined;
}

export function createPublishReceiptStore(path: string): PublishReceiptStore {
  function readAll(): PublishReceipt[] {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PublishReceipt);
  }

  return {
    record(receipt) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(receipt) + "\n");
    },
    find(itemId, orgId) {
      const matches = readAll().filter(
        (r) => r.itemId === itemId && (orgId === undefined || r.orgId === undefined || r.orgId === orgId)
      );
      return matches[0];
    }
  };
}
