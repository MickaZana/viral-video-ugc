import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface Session {
  token: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — a dashboard login, not a banking session.

/** Same exclusive-lockfile pattern as accounts.ts / review-queue's json-store.ts. */
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
        throw new Error(`Timed out waiting for sessions lock at ${lockPath}`);
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

function readAllUnlocked(dbPath: string): Session[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, sessions: Session[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(sessions, null, 2));
}

export interface SessionStore {
  create(accountId: string, ttlMs?: number): Session;
  /** Returns the session only if it exists and hasn't expired — expired sessions are treated as absent, not surfaced. */
  verify(token: string): Session | undefined;
  revoke(token: string): void;
  /** Revokes every session belonging to an account — used when a security-sensitive change
   *  (password change, role change, account removal) should force all other logins to
   *  re-authenticate. */
  revokeAllForAccount(accountId: string): void;
}

export function createSessionStore(dbPath: string): SessionStore {
  return {
    create(accountId, ttlMs = DEFAULT_TTL_MS) {
      const now = Date.now();
      const session: Session = {
        token: randomBytes(32).toString("base64url"),
        accountId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString()
      };
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        writeAllUnlocked(dbPath, [...readAllUnlocked(dbPath), session]);
      } finally {
        releaseLock(dbPath);
      }
      return session;
    },

    verify(token) {
      const session = readAllUnlocked(dbPath).find((s) => s.token === token);
      if (!session) return undefined;
      if (new Date(session.expiresAt).getTime() <= Date.now()) return undefined;
      return session;
    },

    revoke(token) {
      acquireLock(dbPath);
      try {
        writeAllUnlocked(
          dbPath,
          readAllUnlocked(dbPath).filter((s) => s.token !== token)
        );
      } finally {
        releaseLock(dbPath);
      }
    },

    revokeAllForAccount(accountId) {
      acquireLock(dbPath);
      try {
        writeAllUnlocked(
          dbPath,
          readAllUnlocked(dbPath).filter((s) => s.accountId !== accountId)
        );
      } finally {
        releaseLock(dbPath);
      }
    }
  };
}
