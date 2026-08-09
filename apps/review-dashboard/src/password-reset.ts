import { existsSync, mkdirSync, readFileSync, writeFileSync, closeSync, openSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Single-use, short-lived password-recovery tokens, one per email. Mirrors the
 * MFA challenge store (same lockfile pattern, same "expired = absent" contract):
 * the token is worthless on its own (it only lets the holder set a new password
 * for the linked email) and it expires in minutes, so it never lives in a cookie.
 *
 * Deliberately lives in the dashboard (not @vvugc/shared-auth) — it's
 * dashboard-specific auth plumbing with no other consumer, same call as the
 * dashboard's own mfa/jobs stores.
 */

export interface PasswordResetToken {
  token: string;
  /** Normalized email this token can reset. */
  email: string;
  createdAt: string;
  expiresAt: string;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes — long enough to follow a recovery link.

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

export interface PasswordResetStore {
  /** Issues a fresh single-use token for an email, invalidating any prior one. */
  create(email: string): PasswordResetToken;
  /** Returns and consumes (single-use) the token only if it exists and hasn't
   *  expired — "expired = absent", same contract as sessions/invites. */
  consume(token: string): PasswordResetToken | undefined;
}

export function createPasswordResetStore(dbPath: string): PasswordResetStore {
  return {
    create(email) {
      const now = Date.now();
      const record: PasswordResetToken = {
        token: randomBytes(24).toString("base64url"),
        email,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TTL_MS).toISOString()
      };
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        // Drop any older token for the same email so only the newest is valid.
        const others = readAllUnlocked<PasswordResetToken>(dbPath).filter((t) => t.email !== email);
        writeAllUnlocked(dbPath, [...others, record]);
      } finally {
        releaseLock(dbPath);
      }
      return record;
    },

    consume(token) {
      let consumed: PasswordResetToken | undefined;
      acquireLock(dbPath);
      try {
        const tokens = readAllUnlocked<PasswordResetToken>(dbPath);
        const index = tokens.findIndex((t) => t.token === token);
        if (index !== -1 && new Date(tokens[index].expiresAt).getTime() > Date.now()) {
          consumed = tokens[index];
          tokens.splice(index, 1);
          writeAllUnlocked(dbPath, tokens);
        }
      } finally {
        releaseLock(dbPath);
      }
      return consumed;
    }
  };
}
