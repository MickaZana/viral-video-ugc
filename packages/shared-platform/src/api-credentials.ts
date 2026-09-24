/**
 * API Credentials — PHASE D.2, D.3, D.4
 *
 * Secure API credential model for the future VUGC API platform.
 *
 * THIS FEATURE IS DORMANT (VVUGC_API_ENABLED=false).
 *
 * Security rules:
 *   - NEVER store raw API secrets after creation
 *   - NEVER return the secret after initial creation
 *   - NEVER log the secret
 *   - NEVER put API secrets into frontend JavaScript bundles
 *   - Use hashing for credential verification
 */

import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// API Scopes — PHASE D.4
// ---------------------------------------------------------------------------

export type ApiScope =
  | "runs:read"
  | "runs:create"
  | "runs:cancel"
  | "scripts:read"
  | "scripts:create"
  | "media:read"
  | "publishing:create"
  | "usage:read";

/**
 * All available API scopes. Used for validation when creating credentials.
 * Principle of least privilege: never grant "*" as a default scope.
 */
export const API_SCOPES: readonly ApiScope[] = [
  "runs:read",
  "runs:create",
  "runs:cancel",
  "scripts:read",
  "scripts:create",
  "media:read",
  "publishing:create",
  "usage:read"
];

// ---------------------------------------------------------------------------
// Credential model
// ---------------------------------------------------------------------------

export interface ApiCredential {
  id: string;
  orgId: string;
  name: string;
  /** First 8 chars of the key for display/identification (e.g., "vugc_sk_abc1..."). */
  keyPrefix: string;
  /** SHA-256 hash of the full secret key. NEVER store the raw secret. */
  secretHash: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** Returned ONLY at creation time — the raw secret is never retrievable after this. */
export interface ApiKeyPair {
  credential: ApiCredential;
  /** The raw secret key — show to user ONCE, then discard. */
  rawSecret: string;
}

// ---------------------------------------------------------------------------
// Hashing (one-way, constant-time verification)
// ---------------------------------------------------------------------------

/**
 * Hashes an API secret for storage. Uses SHA-256 — appropriate for
 * high-entropy random secrets (unlike passwords which need bcrypt/argon2,
 * API keys are generated with sufficient entropy that brute-force is
 * computationally infeasible against any hash function).
 */
export function hashApiSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Verifies an API secret against its stored hash. Constant-time comparison
 * to prevent timing attacks.
 */
export function verifyApiSecret(secret: string, storedHash: string): boolean {
  const candidateHash = hashApiSecret(secret);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Generates a new API key pair.
 * Format: vugc_sk_<32 random bytes as base64url>
 * 
 * The prefix "vugc_sk_" makes leaked keys identifiable in logs/code.
 */
export function generateApiKeyPair(): { prefix: string; rawSecret: string } {
  const randomPart = randomBytes(32).toString("base64url");
  const rawSecret = `vugc_sk_${randomPart}`;
  const prefix = rawSecret.slice(0, 15); // "vugc_sk_" + first 7 chars
  return { prefix, rawSecret };
}

// ---------------------------------------------------------------------------
// Credential store
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
        throw new Error(`Timed out waiting for api-credentials lock at ${lockPath}`);
      }
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
}

function releaseLock(dbPath: string): void {
  rmSync(`${dbPath}.lock`, { force: true });
}

function readAll(dbPath: string): ApiCredential[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAll(dbPath: string, records: ApiCredential[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, dbPath);
}

export interface ApiCredentialStore {
  /** Creates a new API credential. Returns the raw secret ONCE. */
  create(orgId: string, name: string, scopes: ApiScope[]): ApiKeyPair;
  
  /** Verifies an API key and returns the credential if valid and not revoked. */
  verify(rawSecret: string): ApiCredential | undefined;
  
  /** Lists all credentials for an org (excludes revoked). */
  listByOrg(orgId: string): Omit<ApiCredential, "secretHash">[];
  
  /** Revokes a credential. */
  revoke(orgId: string, credentialId: string): boolean;
  
  /** Records last usage timestamp. */
  recordUsage(credentialId: string): void;
  
  /** Removes all credentials for an org (org deletion). */
  deleteOrg(orgId: string): number;
}

/**
 * Audit event emitted by credential operations.
 * Wire this to writeSecurityEvent in the calling app.
 */
export interface ApiCredentialEvent {
  type: "api_key.created" | "api_key.revoked";
  orgId: string;
  credentialId: string;
  name?: string;
  at: string;
}

export interface ApiCredentialStoreOptions {
  onEvent?: (event: ApiCredentialEvent) => void;
}

export function createApiCredentialStore(dbPath: string, opts: ApiCredentialStoreOptions = {}): ApiCredentialStore {
  function mutate<T>(fn: (records: ApiCredential[]) => T): T {
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
    create(orgId, name, scopes) {
      // Validate scopes
      for (const scope of scopes) {
        if (!API_SCOPES.includes(scope)) {
          throw new Error(`Invalid API scope: "${scope}"`);
        }
      }
      if (scopes.length === 0) {
        throw new Error("At least one scope is required");
      }

      const { prefix, rawSecret } = generateApiKeyPair();
      const credential: ApiCredential = {
        id: randomUUID(),
        orgId,
        name,
        keyPrefix: prefix,
        secretHash: hashApiSecret(rawSecret),
        scopes,
        createdAt: new Date().toISOString()
      };

      mutate((records) => {
        records.push(credential);
      });
      
      opts.onEvent?.({
        type: "api_key.created",
        orgId,
        credentialId: credential.id,
        name,
        at: credential.createdAt
      });

      return { credential, rawSecret };
    },

    verify(rawSecret) {
      const hash = hashApiSecret(rawSecret);
      const records = readAll(dbPath);
      const cred = records.find((r) => r.secretHash === hash && !r.revokedAt);
      return cred;
    },

    listByOrg(orgId) {
      return readAll(dbPath)
        .filter((r) => r.orgId === orgId && !r.revokedAt)
        .map(({ secretHash: _, ...rest }) => rest);
    },

    revoke(orgId, credentialId) {
      const result = mutate((records) => {
        const cred = records.find((r) => r.orgId === orgId && r.id === credentialId && !r.revokedAt);
        if (!cred) return false;
        cred.revokedAt = new Date().toISOString();
        return true;
      });
      if (result) {
        opts.onEvent?.({
          type: "api_key.revoked",
          orgId,
          credentialId,
          at: new Date().toISOString()
        });
      }
      return result;
    },

    recordUsage(credentialId) {
      mutate((records) => {
        const cred = records.find((r) => r.id === credentialId);
        if (cred) cred.lastUsedAt = new Date().toISOString();
      });
    },

    deleteOrg(orgId) {
      return mutate((records) => {
        const before = records.length;
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i].orgId === orgId) records.splice(i, 1);
        }
        return before - records.length;
      });
    }
  };
}
