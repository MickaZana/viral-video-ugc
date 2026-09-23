import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface Session {
  /** Raw session token handed to the caller. On disk this field holds the SHA-256
   *  hex digest of the token instead (legacy pre-hash records hold it verbatim
   *  and are rewritten hashed on first successful verify). */
  token: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

/** A stored token is a hash iff it is exactly 64 lowercase hex chars (SHA-256 hex).
 *  Legacy plaintext tokens are base64url of 32 bytes = 43 chars, so the two
 *  formats can never be confused structurally — no version field needed. */
const HASHED_TOKEN_RE = /^[0-9a-f]{64}$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of the presented token against a stored token field.
 *  SHA-256 (fast hash) is correct here because the token itself is 256 bits of
 *  CSPRNG entropy — no KDF stretching needed. Fails CLOSED: any malformed
 *  stored value (e.g. hex-looking but wrong length) that isn't a structurally
 *  valid 64-hex digest is only accepted via exact legacy-plaintext equality,
 *  and timingSafeEqual is only reached when both sides are known 32-byte digests. */
function tokenMatches(stored: string, presented: string): boolean {
  if (HASHED_TOKEN_RE.test(stored)) {
    const storedDigest = Buffer.from(stored, "hex");
    const presentedDigest = Buffer.from(hashToken(presented), "hex");
    if (storedDigest.length !== presentedDigest.length) return false;
    return timingSafeEqual(storedDigest, presentedDigest);
  }
  // Legacy plaintext record (pre-hash format): direct compare; verify() rewrites it hashed on success.
  return stored === presented;
}

// P1: Configurable via SESSION_TTL_SECONDS env var. Defaults to 30 days.
// Rejects non-positive, NaN, and unreasonably large (>1 year) values.
const DEFAULT_TTL_MS = (() => {
  const envSeconds = process.env.SESSION_TTL_SECONDS;
  if (!envSeconds) return 30 * 24 * 60 * 60 * 1000;
  const parsed = Number(envSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 365 * 24 * 60 * 60) {
    return 30 * 24 * 60 * 60 * 1000; // fallback to 30 days for invalid values
  }
  return parsed * 1000;
})();

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
  { const _atomicTmp = `${dbPath}.${randomUUID()}.tmp`; writeFileSync(_atomicTmp, JSON.stringify(sessions, null, 2)); renameSync(_atomicTmp, dbPath); };
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
      const token = randomBytes(32).toString("base64url");
      const session: Session = {
        token,
        accountId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString()
      };
      // Only the SHA-256 digest is persisted; the raw token is returned to the caller.
      const stored: Session = { ...session, token: hashToken(token) };
      mkdirSync(dirname(dbPath), { recursive: true });
      acquireLock(dbPath);
      try {
        writeAllUnlocked(dbPath, [...readAllUnlocked(dbPath), stored]);
      } finally {
        releaseLock(dbPath);
      }
      return session;
    },

    verify(token) {
      const sessions = readAllUnlocked(dbPath);
      const session = sessions.find((s) => tokenMatches(s.token, token));
      if (!session) return undefined;
      if (new Date(session.expiresAt).getTime() <= Date.now()) return undefined;
      if (!HASHED_TOKEN_RE.test(session.token)) {
        // Legacy plaintext record verified successfully: rewrite it hashed so the
        // file self-heals on first use (expired records never reach this point,
        // so they are left as-is and keep failing at the expiry check above).
        acquireLock(dbPath);
        try {
          writeAllUnlocked(
            dbPath,
            readAllUnlocked(dbPath).map((s) => (s.token === token ? { ...s, token: hashToken(token) } : s))
          );
        } finally {
          releaseLock(dbPath);
        }
      }
      return { ...session, token };
    },

    revoke(token) {
      acquireLock(dbPath);
      try {
        writeAllUnlocked(
          dbPath,
          readAllUnlocked(dbPath).filter((s) => !tokenMatches(s.token, token))
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
