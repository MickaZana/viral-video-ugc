/**
 * Idempotency — PHASE D.8
 *
 * Prevents duplicate paid work from:
 *   - retry
 *   - worker restart
 *   - provider timeout
 *   - webhook replay
 *   - duplicate request
 *
 * Future POST API operations that trigger paid work support:
 *   Idempotency-Key header
 *
 * Semantics:
 *   Same organization + same endpoint + same key = same logical operation
 *   (returns the original result rather than creating duplicate paid work)
 *
 * Records expire after 24 hours (configurable).
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Idempotency record
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  /** The idempotency key (from the Idempotency-Key header). */
  key: string;
  /** Organization that owns this key. */
  orgId: string;
  /** The endpoint/operation this key applies to. */
  endpoint: string;
  /** HTTP status code of the original response. */
  statusCode: number;
  /** Serialized response body of the original operation. */
  responseBody: string;
  /** When this record was created. */
  createdAt: string;
  /** When this record expires and can be garbage-collected. */
  expiresAt: string;
}

// Default TTL: 24 hours
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

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
        throw new Error(`Timed out waiting for idempotency lock at ${lockPath}`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

function readAll(dbPath: string): IdempotencyRecord[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAll(dbPath: string, records: IdempotencyRecord[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, dbPath);
}

export interface IdempotencyStore {
  /**
   * Checks if an idempotency key has been used for this org+endpoint.
   * Returns the stored response if it exists and hasn't expired.
   * Returns undefined if the key is fresh (operation should proceed).
   */
  check(orgId: string, endpoint: string, key: string): IdempotencyRecord | undefined;

  /**
   * Records the result of a completed operation against its idempotency key.
   * Must be called AFTER the operation succeeds (or fails deterministically).
   */
  record(orgId: string, endpoint: string, key: string, statusCode: number, responseBody: string, ttlMs?: number): IdempotencyRecord;

  /**
   * Garbage-collects expired records.
   * Call periodically (e.g., on a timer or before each write).
   */
  prune(): number;
}

export function createIdempotencyStore(dbPath: string): IdempotencyStore {
  function mutate<T>(fn: (records: IdempotencyRecord[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const records = readAll(dbPath);
      const result = fn(records);
      writeAll(dbPath, records);
      return result;
    } finally {
      releaseLock(dbPath);
    }
  }

  return {
    check(orgId, endpoint, key) {
      const now = Date.now();
      return readAll(dbPath).find(
        (r) =>
          r.orgId === orgId &&
          r.endpoint === endpoint &&
          r.key === key &&
          new Date(r.expiresAt).getTime() > now
      );
    },

    record(orgId, endpoint, key, statusCode, responseBody, ttlMs = DEFAULT_TTL_MS) {
      return mutate((records) => {
        // Prune expired while we're writing anyway
        const now = Date.now();
        for (let i = records.length - 1; i >= 0; i--) {
          if (new Date(records[i].expiresAt).getTime() <= now) {
            records.splice(i, 1);
          }
        }

        const record: IdempotencyRecord = {
          key,
          orgId,
          endpoint,
          statusCode,
          responseBody,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttlMs).toISOString()
        };
        records.push(record);
        return record;
      });
    },

    prune() {
      return mutate((records) => {
        const now = Date.now();
        const before = records.length;
        for (let i = records.length - 1; i >= 0; i--) {
          if (new Date(records[i].expiresAt).getTime() <= now) {
            records.splice(i, 1);
          }
        }
        return before - records.length;
      });
    }
  };
}
