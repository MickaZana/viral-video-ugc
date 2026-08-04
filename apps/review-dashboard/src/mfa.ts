import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Two stores for the TOTP two-factor feature, in one module because they're the
 * same feature and share the same lockfile pattern:
 *
 *  - mfa.json holds the TOTP secret per account. A record exists as soon as the
 *    user starts enrollment (so the same secret is shown on refresh), but only
 *    becomes ACTIVE once `confirmedAt` is set — a pending enrollment never
 *    blocks login.
 *  - mfa-challenges.json holds single-use, short-lived login challenges issued
 *    when a password login succeeds but the account has active MFA. The client
 *    must present a valid TOTP code for that challenge within its TTL to receive
 *    a real session — this is what makes the second factor actually second
 *    (the challenge token alone is worthless without the code, and it expires
 *    in minutes rather than living in a cookie).
 *
 * Both deliberately live in the dashboard (not @vvugc/shared-auth) — they're
 * dashboard-specific auth plumbing with no other consumer, same call as the
 * dashboard's own jobs store.
 */

export interface MfaRecord {
  accountId: string;
  /** base32 TOTP secret. */
  secret: string;
  /** Present only once the user has confirmed enrollment with a valid code —
   *  absent means "pending enrollment", which never gates login. */
  confirmedAt?: string;
  createdAt: string;
}

export interface MfaChallenge {
  token: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes — enough to switch to the authenticator app.

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
        throw new Error(`Timed out waiting for lock at ${lockPath}`);
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

function readAllUnlocked<T>(dbPath: string): T[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked<T>(dbPath: string, records: T[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(records, null, 2));
}

export interface MfaStore {
  get(accountId: string): MfaRecord | undefined;
  /** Inserts or replaces the record for an account. */
  put(record: MfaRecord): void;
  remove(accountId: string): boolean;
  /** All records — used by org deletion to wipe every member's secret. */
  list(): MfaRecord[];
}

export function createMfaStore(dbPath: string): MfaStore {
  function mutate<T>(fn: (records: MfaRecord[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const records = readAllUnlocked<MfaRecord>(dbPath);
      const result = fn(records);
      writeAllUnlocked(dbPath, records);
      return result;
    } finally {
      releaseLock(dbPath);
    }
  }

  return {
    get(accountId) {
      return readAllUnlocked<MfaRecord>(dbPath).find((record) => record.accountId === accountId);
    },

    put(record) {
      mutate((records) => {
        const index = records.findIndex((existing) => existing.accountId === record.accountId);
        if (index === -1) records.push(record);
        else records[index] = record;
      });
    },

    remove(accountId) {
      return mutate((records) => {
        const index = records.findIndex((record) => record.accountId === accountId);
        if (index === -1) return false;
        records.splice(index, 1);
        return true;
      });
    },

    list() {
      return readAllUnlocked<MfaRecord>(dbPath);
    }
  };
}

export interface MfaChallengeStore {
  create(accountId: string): MfaChallenge;
  /** Returns the challenge and consumes it (single-use) only if it exists and
   *  hasn't expired — same "expired = absent" contract as sessions/invites. */
  consume(token: string): MfaChallenge | undefined;
}

export function createMfaChallengeStore(dbPath: string): MfaChallengeStore {
  return {
    create(accountId) {
      const now = Date.now();
      const challenge: MfaChallenge = {
        token: randomBytes(24).toString("base64url"),
        accountId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString()
      };
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        writeAllUnlocked<MfaChallenge>(dbPath, [...readAllUnlocked<MfaChallenge>(dbPath), challenge]);
      } finally {
        releaseLock(dbPath);
      }
      return challenge;
    },

    consume(token) {
      let consumed: MfaChallenge | undefined;
      acquireLock(dbPath);
      try {
        const challenges = readAllUnlocked<MfaChallenge>(dbPath);
        const index = challenges.findIndex((challenge) => challenge.token === token);
        if (index !== -1 && new Date(challenges[index].expiresAt).getTime() > Date.now()) {
          consumed = challenges[index];
          challenges.splice(index, 1);
          writeAllUnlocked(dbPath, challenges);
        }
      } finally {
        releaseLock(dbPath);
      }
      return consumed;
    }
  };
}
