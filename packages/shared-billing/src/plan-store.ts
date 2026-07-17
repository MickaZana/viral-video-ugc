import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PlanStatus = "none" | "active" | "past_due" | "canceled";

export interface AccountPlan {
  accountId: string;
  tierId: string | null;
  status: PlanStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  updatedAt: string;
}

/** Same exclusive-lockfile pattern as shared-auth's accounts.ts/sessions.ts/settings.ts. */
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
        throw new Error(`Timed out waiting for plan lock at ${lockPath}`);
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

function readAllUnlocked(dbPath: string): AccountPlan[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, plans: AccountPlan[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(plans, null, 2));
}

export interface PlanStore {
  /** A brand-new account with no subscription reads as {tierId: null, status: "none"}. */
  get(accountId: string): AccountPlan;
  upsert(accountId: string, update: Partial<Omit<AccountPlan, "accountId" | "updatedAt">>): AccountPlan;
}

export function createPlanStore(dbPath: string): PlanStore {
  return {
    get(accountId) {
      const existing = readAllUnlocked(dbPath).find((p) => p.accountId === accountId);
      if (existing) return existing;
      return { accountId, tierId: null, status: "none", updatedAt: new Date(0).toISOString() };
    },

    upsert(accountId, update) {
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        const all = readAllUnlocked(dbPath);
        const idx = all.findIndex((p) => p.accountId === accountId);
        const current = idx === -1 ? { accountId, tierId: null, status: "none" as PlanStatus } : all[idx];
        const merged: AccountPlan = { ...current, ...update, accountId, updatedAt: new Date().toISOString() };
        if (idx === -1) all.push(merged);
        else all[idx] = merged;
        writeAllUnlocked(dbPath, all);
        return merged;
      } finally {
        releaseLock(dbPath);
      }
    }
  };
}
