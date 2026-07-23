import { randomBytes } from "node:crypto";

const developmentKey = randomBytes(32).toString("base64url");

/**
 * Production must supply a stable key so encrypted OAuth tokens survive restarts.
 * Development gets one process-local key: convenient for local testing without
 * turning a repository-known constant into a usable credential.
 */
export function resolveSocialTokenEncryptionKey(): string {
  const configured = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY is required in production");
  }
  return developmentKey;
}
