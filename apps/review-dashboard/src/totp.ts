import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Hand-rolled RFC 6238 TOTP (the algorithm behind Google Authenticator / Authy /
 * 1Password-style one-time codes) — deliberately no new dependency, matching this
 * repo's preference for small self-contained utilities over libraries for simple
 * crypto (see accounts.ts's manual cookie parsing for the same reasoning). TOTP is
 * ~40 lines of spec: HMAC-SHA1 over a 64-bit time counter, truncated to 6 digits,
 * plus base32 secret encoding. Rolling it by hand also makes the exact algorithm
 * testable in isolation (totp.test.ts) and lets the e2e suite compute live codes
 * with the same function the server verifies with — no external authenticator
 * needed in tests.
 *
 * The only real spec nuance is that a code is accepted within a small window
 * (±1 step) around the current 30-second period to tolerate clock drift on the
 * user's phone.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_CODE_DIGITS = 6;

/** Random base32 secret for an authenticator app. 20 random bytes = 160 bits,
 *  the size Google Authenticator itself generates. */
export function generateTotpSecret(byteLength = 20): string {
  const bytes = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes a base32 string (no padding needed) into its raw bytes. */
function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
  const bytes = Buffer.alloc(Math.floor((cleaned.length * 5) / 8));
  let bufferBits = 0;
  let value = 0;
  let pos = 0;
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character "${char}" in TOTP secret`);
    value = (value << 5) | index;
    bufferBits += 5;
    if (bufferBits >= 8) {
      bytes[pos++] = (value >>> (bufferBits - 8)) & 0xff;
      bufferBits -= 8;
    }
  }
  return bytes;
}

/**
 * The current TOTP code for a secret. `windowOffset` shifts the time step by that
 * many 30-second periods (0 = now, -1 = previous step, +1 = next) — verification
 * checks all three so a code generated a few seconds across a step boundary still
 * works (the common "code expired, try again in a second" annoyance).
 */
export function totpCode(secret: string, timeMs = Date.now(), windowOffset = 0): string {
  const counter = Math.floor(timeMs / (TOTP_STEP_SECONDS * 1000)) + windowOffset;
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(truncated % 10 ** TOTP_CODE_DIGITS).padStart(TOTP_CODE_DIGITS, "0");
}

/** True if `code` matches the current (or an adjacent) 30-second period's code.
 *  Comparison is timing-safe (constant-time) so a wrong guess leaks nothing about
 *  the correct code through response timing. */
export function verifyTotpCode(secret: string, code: string, timeMs = Date.now(), allowedWindow = 1): boolean {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const expected = Buffer.from(code);
  for (let offset = -allowedWindow; offset <= allowedWindow; offset++) {
    const candidate = Buffer.from(totpCode(secret, timeMs, offset));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** otpauth:// URL for a QR code — standard format consumed by every authenticator app. */
export function otpauthTotpUrl(accountName: string, secret: string, issuer = "Viral Video UGC"): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_CODE_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?${params.toString()}`;
}
