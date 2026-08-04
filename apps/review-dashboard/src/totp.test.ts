import { describe, expect, it } from "vitest";
import { generateTotpSecret, otpauthTotpUrl, totpCode, verifyTotpCode } from "./totp.js";

describe("totp", () => {
  it("generates a base32 secret of the right shape", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret(10)).toMatch(/^[A-Z2-7]{16}$/);
  });

  it("produces a 6-digit code that verifies", () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects a wrong code, a malformed code, and an empty string", () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret);
    expect(verifyTotpCode(secret, code === "000000" ? "000001" : "000000")).toBe(false);
    expect(verifyTotpCode(secret, "12345")).toBe(false); // wrong length
    expect(verifyTotpCode(secret, "abcdef")).toBe(false); // non-digits
    expect(verifyTotpCode(secret, "")).toBe(false);
  });

  it("accepts a code from an adjacent 30-second window (clock drift tolerance)", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotpCode(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotpCode(secret, totpCode(secret, now + 30_000), now)).toBe(true);
    // But NOT from two windows out.
    expect(verifyTotpCode(secret, totpCode(secret, now - 60_000), now)).toBe(false);
  });

  it("is deterministic for a fixed secret and time", () => {
    const secret = generateTotpSecret();
    const t = Date.now();
    expect(totpCode(secret, t)).toBe(totpCode(secret, t));
  });

  it("builds a standard otpauth:// URL for a QR code", () => {
    const url = otpauthTotpUrl("owner@agency.com", "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    expect(url).toMatch(/^otpauth:\/\/totp\/Viral%20Video%20UGC:owner%40agency\.com\?/);
    expect(url).toContain("secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    expect(url).toContain("issuer=Viral+Video+UGC");
    expect(url).toContain("algorithm=SHA1");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});
