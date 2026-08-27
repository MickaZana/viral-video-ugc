import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Consumption-overage ledger. When an account's runs exceed their tier's included
 * monthly allowance, each additional run is billed at the tier's overage price and
 * recorded here so the billing panel can show accrued overage dollars and so the
 * org owner has an auditable trail. Same exclusive-lockfile JSON pattern as the
 * other stores in this repo (plan-store.ts, shared-auth's accounts.ts, etc.).
 */

export interface OverageCharge {
  id: string;
  orgId: string;
  runId: string;
  /** "YYYY-MM" — the billing month this charge is counted in. */
  month: string;
  priceUsdPerRun: number;
  /** Duration of the video that triggered this overage charge. */
  durationSec?: number;
  /** Duration multiplier applied (1.0× for ≤15s, up to 4.0× for ≤60s). */
  durationMultiplier?: number;
  estimatedVendorCostUsd: number;
  clientId?: string;
  createdAt: string;
}

export interface OverageStore {
  record(input: {
    orgId: string;
    runId: string;
    priceUsdPerRun: number;
    durationSec?: number;
    durationMultiplier?: number;
    estimatedVendorCostUsd?: number;
    clientId?: string;
  }): OverageCharge;
  /** All charges for an org. */
  listByOrg(orgId: string): OverageCharge[];
  /** Total overage dollars charged to an org in the given "YYYY-MM" month. */
  totalForMonth(orgId: string, month: string): number;
  /** Number of overage runs charged to an org in the given "YYYY-MM" month. */
  countForMonth(orgId: string, month: string): number;
  /** Removes a pre-execution overage reservation when work never begins. */
  release(orgId: string, runId: string): boolean;
}

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
        throw new Error(`Timed out waiting for overage lock at ${lockPath}`);
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

function readAllUnlocked(dbPath: string): OverageCharge[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, rows: OverageCharge[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(rows, null, 2));
}

export function createOverageStore(dbPath: string): OverageStore {
  return {
    record({ orgId, runId, priceUsdPerRun, durationSec, durationMultiplier, estimatedVendorCostUsd = priceUsdPerRun, clientId }) {
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        const all = readAllUnlocked(dbPath);
        // Idempotency: a runId can only ever be billed once. The read-check-append
        // sequence has to happen under the SAME lock acquisition as the write below —
        // checking before acquiring (or releasing between check and append) would just
        // reintroduce the exact TOCTOU race this guard exists to close, since two
        // concurrent record() calls for the same runId could otherwise both pass the
        // check before either had appended.
        const existing = all.find((c) => c.orgId === orgId && c.runId === runId);
        if (existing) return existing;
        const charge: OverageCharge = {
          id: randomUUID(),
          orgId,
          runId,
          month: new Date().toISOString().slice(0, 7),
          priceUsdPerRun,
          durationSec,
          durationMultiplier,
          estimatedVendorCostUsd,
          clientId,
          createdAt: new Date().toISOString()
        };
        all.push(charge);
        writeAllUnlocked(dbPath, all);
        return charge;
      } finally {
        releaseLock(dbPath);
      }
    },

    listByOrg(orgId) {
      return readAllUnlocked(dbPath).filter((c) => c.orgId === orgId);
    },

    totalForMonth(orgId, month) {
      return Number(
        readAllUnlocked(dbPath)
          .filter((c) => c.orgId === orgId && c.month === month)
          .reduce((sum, c) => sum + c.priceUsdPerRun, 0)
          .toFixed(2)
      );
    },

    countForMonth(orgId, month) {
      return readAllUnlocked(dbPath).filter((c) => c.orgId === orgId && c.month === month).length;
    },
    release(orgId, runId) {
      acquireLock(dbPath);
      try {
        const rows = readAllUnlocked(dbPath); const index = rows.findIndex((row) => row.orgId === orgId && row.runId === runId);
        if (index < 0) return false;
        rows.splice(index, 1); writeAllUnlocked(dbPath, rows); return true;
      } finally { releaseLock(dbPath); }
    }
  };
}
