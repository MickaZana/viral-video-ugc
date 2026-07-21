import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Platform } from "@vvugc/shared-schema";

interface StoredSocialConnection {
  id: string;
  orgId: string;
  clientId: string;
  platform: Platform;
  accountLabel: string;
  providerAccountId?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialConnection {
  id: string;
  orgId: string;
  clientId: string;
  platform: Platform;
  accountLabel: string;
  providerAccountId?: string;
  expiresAt?: string;
  status: "connected" | "expiring" | "expired";
  hasRefreshToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SocialConnectionSecrets {
  accessToken: string;
  refreshToken?: string;
}

function keyFromSecret(secret: string): Buffer {
  if (secret.length < 32) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY must be at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function decrypt(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

function acquireLock(path: string): void {
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(`${path}.lock`, "wx"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > 5000) throw new Error("Timed out waiting for social-connections lock");
    }
  }
}

function statusFor(expiresAt?: string): SocialConnection["status"] {
  if (!expiresAt) return "connected";
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "expired";
  return remaining <= 7 * 24 * 60 * 60 * 1000 ? "expiring" : "connected";
}

function publicRecord(record: StoredSocialConnection): SocialConnection {
  return {
    id: record.id,
    orgId: record.orgId,
    clientId: record.clientId,
    platform: record.platform,
    accountLabel: record.accountLabel,
    providerAccountId: record.providerAccountId,
    expiresAt: record.expiresAt,
    status: statusFor(record.expiresAt),
    hasRefreshToken: Boolean(record.encryptedRefreshToken),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function createSocialConnectionStore(dbPath: string, encryptionSecret: string) {
  const key = keyFromSecret(encryptionSecret);
  const read = (): StoredSocialConnection[] => existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : [];
  const mutate = <T>(fn: (records: StoredSocialConnection[]) => T): T => {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const records = read();
      const result = fn(records);
      writeFileSync(dbPath, JSON.stringify(records, null, 2));
      return result;
    } finally {
      rmSync(`${dbPath}.lock`, { force: true });
    }
  };
  return {
    list(orgId: string, clientId?: string): SocialConnection[] {
      return read().filter((record) => record.orgId === orgId && (!clientId || record.clientId === clientId)).map(publicRecord);
    },
    connect(orgId: string, input: { clientId: string; platform: Platform; accountLabel: string; providerAccountId?: string; accessToken: string; refreshToken?: string; expiresAt?: string }): SocialConnection {
      return mutate((records) => {
        const now = new Date().toISOString();
        const existing = records.find((record) => record.orgId === orgId && record.clientId === input.clientId && record.platform === input.platform);
        const next: StoredSocialConnection = {
          id: existing?.id ?? randomUUID(),
          orgId,
          clientId: input.clientId,
          platform: input.platform,
          accountLabel: input.accountLabel,
          providerAccountId: input.providerAccountId,
          encryptedAccessToken: encrypt(input.accessToken, key),
          encryptedRefreshToken: input.refreshToken ? encrypt(input.refreshToken, key) : undefined,
          expiresAt: input.expiresAt,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
        if (existing) records[records.indexOf(existing)] = next;
        else records.push(next);
        return publicRecord(next);
      });
    },
    getSecrets(orgId: string, connectionId: string): SocialConnectionSecrets | undefined {
      const record = read().find((entry) => entry.orgId === orgId && entry.id === connectionId);
      if (!record) return undefined;
      return {
        accessToken: decrypt(record.encryptedAccessToken, key),
        refreshToken: record.encryptedRefreshToken ? decrypt(record.encryptedRefreshToken, key) : undefined
      };
    },
    disconnect(orgId: string, connectionId: string): boolean {
      return mutate((records) => {
        const index = records.findIndex((record) => record.orgId === orgId && record.id === connectionId);
        if (index === -1) return false;
        records.splice(index, 1);
        return true;
      });
    }
  };
}

/** Re-encrypts every stored token in one locked, all-or-nothing file rewrite.
 * Callers should back up the store first and retain the old key until verification. */
export function rotateSocialConnectionEncryptionKey(dbPath: string, oldSecret: string, newSecret: string): number {
  const oldKey = keyFromSecret(oldSecret);
  const newKey = keyFromSecret(newSecret);
  if (!existsSync(dbPath)) return 0;
  acquireLock(dbPath);
  try {
    const records: StoredSocialConnection[] = JSON.parse(readFileSync(dbPath, "utf8"));
    const rotated = records.map((record) => ({
      ...record,
      encryptedAccessToken: encrypt(decrypt(record.encryptedAccessToken, oldKey), newKey),
      encryptedRefreshToken: record.encryptedRefreshToken
        ? encrypt(decrypt(record.encryptedRefreshToken, oldKey), newKey)
        : undefined,
      updatedAt: new Date().toISOString()
    }));
    writeFileSync(dbPath, JSON.stringify(rotated, null, 2));
    return rotated.length;
  } finally {
    rmSync(`${dbPath}.lock`, { force: true });
  }
}
