import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "./sessions.js";

describe("createSessionStore", () => {
  let dir: string;
  let dbPath: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "sessions-"));
    dbPath = join(dir, "sessions.json");
    return createSessionStore(dbPath);
  }

  it("creates a session and verifies it back with the same accountId", () => {
    const store = freshStore();
    const session = store.create("account-1");
    const verified = store.verify(session.token);
    expect(verified?.accountId).toBe("account-1");
  });

  it("issues a different token each time, even for the same account", () => {
    const store = freshStore();
    const a = store.create("account-1");
    const b = store.create("account-1");
    expect(a.token).not.toBe(b.token);
  });

  it("returns undefined for an unknown token", () => {
    const store = freshStore();
    expect(store.verify("not-a-real-token")).toBeUndefined();
  });

  it("treats an expired session as absent", () => {
    const store = freshStore();
    const session = store.create("account-1", -1000); // already expired
    expect(store.verify(session.token)).toBeUndefined();
  });

  it("revoke makes a previously-valid session unverifiable", () => {
    const store = freshStore();
    const session = store.create("account-1");
    expect(store.verify(session.token)).toBeDefined();
    store.revoke(session.token);
    expect(store.verify(session.token)).toBeUndefined();
  });

  it("revoking one session doesn't affect another session for the same account", () => {
    const store = freshStore();
    const a = store.create("account-1");
    const b = store.create("account-1");
    store.revoke(a.token);
    expect(store.verify(a.token)).toBeUndefined();
    expect(store.verify(b.token)).toBeDefined();
  });

  it("revokeAllForAccount revokes every session for one account but leaves other accounts alone", () => {
    const store = freshStore();
    const a1 = store.create("account-1");
    const a2 = store.create("account-1");
    const other = store.create("account-2");
    store.revokeAllForAccount("account-1");
    expect(store.verify(a1.token)).toBeUndefined();
    expect(store.verify(a2.token)).toBeUndefined();
    expect(store.verify(other.token)).toBeDefined();
  });

  it("issues a URL-safe 32-byte random token (base64url, no padding)", () => {
    const store = freshStore();
    const session = store.create("account-1");
    expect(session.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(session.token, "base64url")).toHaveLength(32);
  });

  it("treats a session whose expiresAt equals createdAt as expired (expiry boundary is inclusive)", () => {
    const store = freshStore();
    const session = store.create("account-1", 0);
    expect(new Date(session.expiresAt).getTime()).toBe(new Date(session.createdAt).getTime());
    expect(store.verify(session.token)).toBeUndefined();
  });

  it("persists sessions to disk so a fresh store instance over the same path verifies them", () => {
    const first = freshStore();
    const session = first.create("account-1");
    const second = createSessionStore(dbPath);
    expect(second.verify(session.token)?.accountId).toBe("account-1");
  });

  it("releases the exclusive lockfile after every mutation (no stale .lock left behind)", () => {
    const store = freshStore();
    const session = store.create("account-1");
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    store.revoke(session.token);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    const other = store.create("account-2");
    store.revokeAllForAccount("account-2");
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(store.verify(other.token)).toBeUndefined();
  });

  // Replaces the earlier "CURRENT BEHAVIOR" characterization that pinned the
  // KNOWN plaintext-token concern (raw token stored verbatim). Hash-at-rest
  // landed in atom B7: storage now holds the SHA-256 hex digest only.
  it("stores the SHA-256 hex digest of the token (64 lowercase hex chars), never the raw token", () => {
    const store = freshStore();
    const session = store.create("account-1");
    const rawFile = readFileSync(dbPath, "utf-8");
    const onDisk = JSON.parse(rawFile);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].token).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk[0].token).not.toBe(session.token);
    expect(onDisk[0].token).toBe(createHash("sha256").update(session.token, "utf8").digest("hex"));
    expect(rawFile).not.toContain(session.token);
  });

  it("rejects a wrong token, even one that differs from a valid token by a single character", () => {
    const store = freshStore();
    const session = store.create("account-1");
    const nearMiss =
      session.token.slice(0, -1) + (session.token.endsWith("A") ? "B" : "A");
    expect(store.verify(nearMiss)).toBeUndefined();
    expect(store.verify(session.token + "x")).toBeUndefined();
    expect(store.verify(session.token.slice(0, -1))).toBeUndefined();
  });

  it("legacy plaintext record: verify succeeds once, rewrites the file hashed, and verify still succeeds (self-heal is idempotent)", () => {
    const store = freshStore();
    const legacyToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      dbPath,
      JSON.stringify([{ token: legacyToken, accountId: "account-1", createdAt: new Date().toISOString(), expiresAt }])
    );

    const first = store.verify(legacyToken);
    expect(first?.accountId).toBe("account-1");
    expect(first?.token).toBe(legacyToken);
    let onDisk = JSON.parse(readFileSync(dbPath, "utf-8"));
    expect(onDisk[0].token).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk[0].token).not.toBe(legacyToken);
    expect(onDisk[0].token).toBe(createHash("sha256").update(legacyToken, "utf8").digest("hex"));

    const second = store.verify(legacyToken);
    expect(second?.accountId).toBe("account-1");
    onDisk = JSON.parse(readFileSync(dbPath, "utf-8"));
    expect(onDisk[0].token).toBe(createHash("sha256").update(legacyToken, "utf8").digest("hex"));
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it("expired legacy plaintext record: verify fails and leaves the file un-migrated (expiry is checked before migration)", () => {
    const store = freshStore();
    const legacyToken = randomBytes(32).toString("base64url");
    const record = {
      token: legacyToken,
      accountId: "account-1",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    };
    writeFileSync(dbPath, JSON.stringify([record]));

    expect(store.verify(legacyToken)).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(dbPath, "utf-8"));
    expect(onDisk[0].token).toBe(legacyToken);
  });

  it("revoke removes a legacy plaintext record by its raw token as well as a hashed record", () => {
    const store = freshStore();
    const legacyToken = randomBytes(32).toString("base64url");
    writeFileSync(
      dbPath,
      JSON.stringify([
        { token: legacyToken, accountId: "account-1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
      ])
    );
    store.revoke(legacyToken);
    expect(JSON.parse(readFileSync(dbPath, "utf-8"))).toHaveLength(0);

    const hashed = store.create("account-2");
    store.revoke(hashed.token);
    expect(JSON.parse(readFileSync(dbPath, "utf-8"))).toHaveLength(0);
    expect(store.verify(hashed.token)).toBeUndefined();
  });

  it("malformed stored token values fail closed (undefined, no throw) instead of opening verification", () => {
    const store = freshStore();
    const presented = randomBytes(32).toString("base64url");
    // Not structurally valid digests: 63 hex chars (wrong length) and 64 non-hex chars.
    // Neither may match an unrelated presented token, and none of this may throw
    // (timingSafeEqual is only reached for structurally valid 64-hex digests).
    writeFileSync(
      dbPath,
      JSON.stringify([
        { token: "a".repeat(63), accountId: "account-1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
        { token: "z".repeat(64), accountId: "account-2", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
        { token: "a".repeat(64), accountId: "account-3", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
      ])
    );
    expect(store.verify(presented)).toBeUndefined();
    // A structurally valid digest stored as the token field must be checked via
    // timingSafeEqual against sha256(presented) — never accepted by plaintext
    // equality just because presented === stored.
    expect(store.verify("a".repeat(64))).toBeUndefined();
    expect(JSON.parse(readFileSync(dbPath, "utf-8"))[0].token).toBe("a".repeat(63));
    // And a record whose stored digest genuinely is sha256(presented) still verifies.
    const legit = store.create("account-4");
    expect(store.verify(legit.token)?.accountId).toBe("account-4");
  });
});

describe("SESSION_TTL_SECONDS parsing (evaluated once at module load)", () => {
  const ORIGINAL_TTL = process.env.SESSION_TTL_SECONDS;
  const createdDirs: string[] = [];

  afterEach(() => {
    if (ORIGINAL_TTL === undefined) delete process.env.SESSION_TTL_SECONDS;
    else process.env.SESSION_TTL_SECONDS = ORIGINAL_TTL;
    vi.resetModules();
    while (createdDirs.length > 0) {
      const d = createdDirs.pop()!;
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  async function importFreshStore(ttlSeconds: string | undefined) {
    if (ttlSeconds === undefined) delete process.env.SESSION_TTL_SECONDS;
    else process.env.SESSION_TTL_SECONDS = ttlSeconds;
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), "sessions-ttl-"));
    createdDirs.push(dir);
    const mod = await import("./sessions.js");
    return mod.createSessionStore(join(dir, "sessions.json"));
  }

  it("honors a valid SESSION_TTL_SECONDS as the default session lifetime", async () => {
    const store = await importFreshStore("3600");
    const session = store.create("account-1");
    const lifetimeMs = new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime();
    expect(lifetimeMs).toBe(3600 * 1000);
  });

  it.each(["0", "-1", "not-a-number", String(366 * 24 * 60 * 60)])(
    "falls back to the 30-day default for invalid SESSION_TTL_SECONDS=%s",
    async (value) => {
      const store = await importFreshStore(value);
      const session = store.create("account-1");
      const lifetimeMs = new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime();
      expect(lifetimeMs).toBe(30 * 24 * 60 * 60 * 1000);
    }
  );

  it("uses the 30-day default when SESSION_TTL_SECONDS is unset", async () => {
    const store = await importFreshStore(undefined);
    const session = store.create("account-1");
    const lifetimeMs = new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime();
    expect(lifetimeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
