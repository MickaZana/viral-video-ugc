import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@vvugc/shared-persistence";
import { MIGRATIONS, runMigrations } from "@vvugc/review-queue";
import { MfaSecretCipher, PostgresIdentityRepository } from "./identity-postgres.js";
import type { Account } from "@vvugc/shared-auth";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("MFA secret cipher", () => {
  it("fails closed without a dedicated deployment secret and authenticates ciphertext", () => {
    expect(() => new MfaSecretCipher(undefined)).toThrow("MFA_ENCRYPTION_KEY");
    const cipher = new MfaSecretCipher("mfa-test-key-that-is-longer-than-thirty-two-characters");
    const encrypted = cipher.encrypt("JBSWY3DPEHPK3PXP");
    expect(encrypted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(cipher.decrypt(encrypted)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => cipher.decrypt(`${encrypted}x`)).toThrow();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Postgres identity repository", () => {
  let database: IsolatedTestDatabase;
  let identity: PostgresIdentityRepository;
  beforeAll(async () => {
    database = await createIsolatedTestDatabase();
    await runMigrations(database.pool, MIGRATIONS);
    identity = new PostgresIdentityRepository(database.pool, new MfaSecretCipher("mfa-test-key-that-is-longer-than-thirty-two-characters"));
  });
  afterAll(async () => database?.dispose());

  it("preserves tenant boundaries and cascades the complete identity graph on org deletion", async () => {
    const first = await identity.signUp("owner-one@example.test", "correct horse battery staple", "One");
    const second = await identity.signUp("owner-two@example.test", "correct horse battery staple", "Two");
    const member = await identity.signUpAsMember("member@example.test", "correct horse battery staple", first.orgId);
    expect((await identity.listByOrg(first.orgId)).map((account: Account) => account.id).sort()).toEqual([first.id, member.id].sort());
    expect(await identity.listByOrg(second.orgId)).toHaveLength(1);
    const session = await identity.createSession(member.id);
    await identity.putMfa({ accountId: member.id, secret: "JBSWY3DPEHPK3PXP", createdAt: new Date().toISOString() });
    await identity.deleteOrg(first.orgId);
    expect(await identity.findById(member.id)).toBeUndefined();
    expect(await identity.verifySession(session.token)).toBeUndefined();
    expect(await database.pool.query("SELECT secret_ciphertext FROM account_mfa_records WHERE account_id=$1", [member.id])).toMatchObject({ rowCount: 0 });
  });

  it("keeps session/reset/challenge/nonce consumption single-use and expiry-aware", async () => {
    const account = await identity.signUp(`state-${Date.now()}@example.test`, "correct horse battery staple");
    const session = await identity.createSession(account.id, -1);
    expect(await identity.verifySession(session.token)).toBeUndefined();
    const reset = await identity.createReset(account.id, account.email);
    expect((await identity.consumeReset(reset.token))?.email).toBe(account.email);
    expect(await identity.consumeReset(reset.token)).toBeUndefined();
    const challenge = await identity.createMfaChallenge(account.id);
    expect((await identity.consumeMfaChallenge(challenge.token))?.accountId).toBe(account.id);
    expect(await identity.consumeMfaChallenge(challenge.token)).toBeUndefined();
    await identity.addOAuthNonce("nonce-one", new Date(Date.now() - 1));
    expect(await identity.consumeOAuthNonce("nonce-one")).toBe(false);
    await identity.addOAuthNonce("nonce-two");
    expect(await identity.consumeOAuthNonce("nonce-two")).toBe(true);
    expect(await identity.consumeOAuthNonce("nonce-two")).toBe(false);
  });

  it("never persists a plaintext MFA secret", async () => {
    const account = await identity.signUp(`mfa-${Date.now()}@example.test`, "correct horse battery staple");
    await identity.putMfa({ accountId: account.id, secret: "JBSWY3DPEHPK3PXP", createdAt: new Date().toISOString() });
    const row = await database.pool.query<{ secret_ciphertext: string }>("SELECT secret_ciphertext FROM account_mfa_records WHERE account_id=$1", [account.id]);
    expect(row.rows[0]?.secret_ciphertext).not.toContain("JBSWY3DPEHPK3PXP");
    expect((await identity.getMfa(account.id))?.secret).toBe("JBSWY3DPEHPK3PXP");
  });
});
