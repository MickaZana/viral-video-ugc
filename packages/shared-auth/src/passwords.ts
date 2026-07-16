import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/**
 * scrypt (Node's built-in, no native dependency like bcrypt needs) with a random
 * 16-byte salt per password, stored alongside the hash as `salt:hash` (both hex).
 * scrypt's memory-hardness makes GPU/ASIC brute-forcing meaningfully more expensive
 * than a plain fast hash (even iterated SHA-256) at a fixed CPU/memory cost — the
 * right default for a password store with no other stack (this repo has no existing
 * auth dependency to match).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== KEY_LENGTH) return false;

  const actual = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}
