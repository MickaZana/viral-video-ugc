import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface Invite {
  token: string;
  orgId: string;
  email: string;
  invitedByAccountId: string;
  createdAt: string;
  expiresAt: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — long enough for a real invite to actually get opened.

/** Same exclusive-lockfile pattern as accounts.ts/sessions.ts/settings.ts. */
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
        throw new Error(`Timed out waiting for invites lock at ${lockPath}`);
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

function readAllUnlocked(dbPath: string): Invite[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, invites: Invite[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(invites, null, 2));
}

export interface InviteStore {
  create(orgId: string, email: string, invitedByAccountId: string, ttlMs?: number): Invite;
  /** Returns the invite only if it exists and hasn't expired — same "expired = absent" contract as sessions. */
  verify(token: string): Invite | undefined;
  consume(token: string): void;
}

export function createInviteStore(dbPath: string): InviteStore {
  return {
    create(orgId, email, invitedByAccountId, ttlMs = DEFAULT_TTL_MS) {
      const now = Date.now();
      const invite: Invite = {
        token: randomBytes(24).toString("base64url"),
        orgId,
        email: email.trim().toLowerCase(),
        invitedByAccountId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString()
      };
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        writeAllUnlocked(dbPath, [...readAllUnlocked(dbPath), invite]);
      } finally {
        releaseLock(dbPath);
      }
      return invite;
    },

    verify(token) {
      const invite = readAllUnlocked(dbPath).find((i) => i.token === token);
      if (!invite) return undefined;
      if (new Date(invite.expiresAt).getTime() <= Date.now()) return undefined;
      return invite;
    },

    consume(token) {
      acquireLock(dbPath);
      try {
        writeAllUnlocked(
          dbPath,
          readAllUnlocked(dbPath).filter((i) => i.token !== token)
        );
      } finally {
        releaseLock(dbPath);
      }
    }
  };
}
