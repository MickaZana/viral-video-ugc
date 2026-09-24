import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ProductEventSchema, type ProductEvent, type ProductEventInput, type ProductEventType } from "./events.js";

/** Same exclusive-lockfile pattern as shared-billing's plan-store.ts (and
 *  shared-auth's accounts.ts/sessions.ts/settings.ts before it) — one flat
 *  JSON file, full read-modify-write per mutation, guarded by a lockfile.
 *  Accepted at this codebase's current scale for every other store built
 *  this way; a real analytics volume (thousands of events/day) would want
 *  an append-only log or a real datastore instead of rewriting the whole
 *  file per write — revisit this if/when usage actually reaches that point,
 *  not preemptively. */
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
        throw new Error(`Timed out waiting for product-event lock at ${lockPath}`);
      }
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

function readAllUnlocked(dbPath: string): ProductEvent[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, events: ProductEvent[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(events, null, 2));
}

export interface ProductEventListFilter {
  eventType?: ProductEventType;
  /** Inclusive lower bound on occurredAt, as epoch ms. */
  sinceMs?: number;
}

export interface ProductEventStore {
  /** Server-assigns id and occurredAt — a caller never supplies either
   *  (see events.ts's ProductEventInputSchema doc comment). */
  record(input: ProductEventInput): ProductEvent;
  listByOrg(orgId: string, filter?: ProductEventListFilter): ProductEvent[];
  /** Org deletion parity with every other org-scoped store in this codebase
   *  (TenantProfileRepository.deleteOrg, PlanStore.delete, etc.) — never
   *  leave usage events behind for a deleted org. */
  deleteOrg(orgId: string): void;
}

export function createProductEventStore(dbPath: string): ProductEventStore {
  return {
    record(input) {
      const event: ProductEvent = ProductEventSchema.parse({
        ...input,
        id: randomUUID(),
        occurredAt: new Date().toISOString()
      });
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        const all = readAllUnlocked(dbPath);
        all.push(event);
        writeAllUnlocked(dbPath, all);
        return event;
      } finally {
        releaseLock(dbPath);
      }
    },

    listByOrg(orgId, filter) {
      return readAllUnlocked(dbPath).filter((e) => {
        if (e.orgId !== orgId) return false;
        if (filter?.eventType && e.eventType !== filter.eventType) return false;
        if (filter?.sinceMs !== undefined && new Date(e.occurredAt).getTime() < filter.sinceMs) return false;
        return true;
      });
    },

    deleteOrg(orgId) {
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        const all = readAllUnlocked(dbPath);
        const remaining = all.filter((e) => e.orgId !== orgId);
        if (remaining.length !== all.length) writeAllUnlocked(dbPath, remaining);
      } finally {
        releaseLock(dbPath);
      }
    }
  };
}
