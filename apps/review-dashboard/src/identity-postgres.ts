import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "@vvugc/shared-persistence";
import { EmailAlreadyRegisteredError, hashPassword, verifyPassword, type Account, type AccountRole, type Invite } from "@vvugc/shared-auth";
import type { MfaChallenge, MfaRecord } from "./mfa.js";
import type { PasswordResetToken } from "./password-reset.js";

type Row = Record<string, unknown>;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;

function asAccount(row: Row): Account {
  return { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), orgId: String(row.org_id), role: String(row.role) as AccountRole | "member", orgName: row.org_name ? String(row.org_name) : undefined, createdAt: new Date(String(row.created_at)).toISOString() };
}

/** Application AEAD for TOTP secrets. Requires a dedicated 32+ char deployment
 * secret; it is deliberately not a database key or reversible password hash. */
export class MfaSecretCipher {
  private readonly key: Buffer;
  constructor(secret: string | undefined) {
    if (!secret || secret.length < 32) throw new Error("MFA_ENCRYPTION_KEY (at least 32 characters) is required when DATABASE_URL is configured");
    this.key = createHash("sha256").update(secret).digest();
  }
  encrypt(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${payload.toString("base64url")}`;
  }
  decrypt(value: string): string {
    const [version, iv64, tag64, body64] = value.split(".");
    if (version !== "v1" || !iv64 || !tag64 || !body64) throw new Error("invalid encrypted MFA secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv64, "base64url"));
    decipher.setAuthTag(Buffer.from(tag64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body64, "base64url")), decipher.final()]).toString("utf8");
  }
}

export class PostgresIdentityRepository {
  constructor(private readonly pool: Pool, private readonly mfaCipher: MfaSecretCipher) {}
  private async query<T extends Row = Row>(sql: string, values: unknown[] = []) { return this.pool.query<T>(sql, values); }
  private async accountBy(sql: string, values: unknown[]): Promise<Account | undefined> { const result = await this.query(sql, values); return result.rows[0] ? asAccount(result.rows[0]) : undefined; }

  async signUp(email: string, password: string, orgName?: string): Promise<Account> {
    const normalized = email.trim().toLowerCase(); const accountId = randomUUID(); const orgId = randomUUID(); const now = new Date();
    try { return await withTransaction(this.pool, async (db) => {
      await db.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)", [orgId, orgName ?? null, now]);
      await db.query("INSERT INTO accounts (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)", [accountId, normalized, hashPassword(password), now]);
      await db.query("INSERT INTO organization_members (org_id, account_id, role, created_at) VALUES ($1, $2, 'owner', $3)", [orgId, accountId, now]);
      return { id: accountId, email: normalized, passwordHash: "", orgName, orgId, role: "owner", createdAt: now.toISOString() } as Account;
    }); } catch (error: unknown) { if ((error as { code?: string }).code === "23505") throw new EmailAlreadyRegisteredError(normalized); throw error; }
  }
  async signUpAsMember(email: string, password: string, orgId: string, role: AccountRole = "editor"): Promise<Account> {
    const normalized = email.trim().toLowerCase(); const id = randomUUID(); const now = new Date();
    try { return await withTransaction(this.pool, async (db) => {
      const org = await db.query("SELECT name FROM organizations WHERE id = $1", [orgId]); if (!org.rowCount) throw new Error("organization not found");
      await db.query("INSERT INTO accounts (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)", [id, normalized, hashPassword(password), now]);
      await db.query("INSERT INTO organization_members (org_id, account_id, role, created_at) VALUES ($1, $2, $3, $4)", [orgId, id, role, now]);
      return { id, email: normalized, passwordHash: "", orgId, role, createdAt: now.toISOString() } as Account;
    }); } catch (error: unknown) { if ((error as { code?: string }).code === "23505") throw new EmailAlreadyRegisteredError(normalized); throw error; }
  }
  /** Claims the invitation and creates the account/membership in one database
   * transaction. DELETE ... RETURNING is the single-use primitive: concurrent
   * callers cannot both receive an invite row, and a failed account insert rolls
   * the deletion back so the owner can resolve the conflict without losing it. */
  async acceptInvite(invite: Invite, password: string): Promise<Account | undefined> {
    const id = randomUUID(); const createdAt = new Date();
    try {
      return await withTransaction(this.pool, async (db) => {
        const claimed = await db.query<{ token: string; org_id: string; email: string; role: AccountRole; created_at: Date }>("DELETE FROM organization_invites WHERE token=$1 AND org_id=$2 AND email=$3 AND expires_at > now() RETURNING token,org_id,email,role,created_at", [invite.token, invite.orgId, invite.email.trim().toLowerCase()]);
        const row = claimed.rows[0];
        if (!row) return undefined;
        await db.query("INSERT INTO accounts (id,email,password_hash,created_at) VALUES($1,$2,$3,$4)", [id, row.email, hashPassword(password), createdAt]);
        await db.query("INSERT INTO organization_members (org_id,account_id,role,created_at) VALUES($1,$2,$3,$4)", [row.org_id, id, row.role, createdAt]);
        return { id, email: row.email, passwordHash: "", orgId: row.org_id, role: row.role, createdAt: createdAt.toISOString() } satisfies Account;
      });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") throw new EmailAlreadyRegisteredError(invite.email.trim().toLowerCase());
      throw error;
    }
  }
  async authenticate(email: string, password: string) { const found = await this.findByEmail(email); return found && verifyPassword(password, found.passwordHash) ? found : undefined; }
  async findById(id: string) { return this.accountBy("SELECT a.*, m.org_id, m.role, o.name AS org_name FROM accounts a JOIN organization_members m ON m.account_id=a.id JOIN organizations o ON o.id=m.org_id WHERE a.id=$1", [id]); }
  async findByEmail(email: string) { return this.accountBy("SELECT a.*, m.org_id, m.role, o.name AS org_name FROM accounts a JOIN organization_members m ON m.account_id=a.id JOIN organizations o ON o.id=m.org_id WHERE a.email=$1", [email.trim().toLowerCase()]); }
  async listByOrg(orgId: string) { const result = await this.query("SELECT a.*, m.org_id, m.role, o.name AS org_name FROM accounts a JOIN organization_members m ON m.account_id=a.id JOIN organizations o ON o.id=m.org_id WHERE m.org_id=$1 ORDER BY a.created_at", [orgId]); return result.rows.map(asAccount); }
  async updatePassword(accountId: string, password: string) { return (await this.query("UPDATE accounts SET password_hash=$2 WHERE id=$1", [accountId, hashPassword(password)])).rowCount === 1; }
  async setRole(orgId: string, accountId: string, role: AccountRole) { const result = await this.query("UPDATE organization_members SET role=$3 WHERE org_id=$1 AND account_id=$2 AND role <> 'owner' RETURNING account_id", [orgId, accountId, role]); return result.rowCount ? this.findById(accountId) : undefined; }
  async removeMember(orgId: string, accountId: string) {
    return withTransaction(this.pool, async (db) => {
      const member = await db.query("SELECT account_id FROM organization_members WHERE org_id=$1 AND account_id=$2 AND role <> 'owner' FOR UPDATE", [orgId, accountId]);
      if (!member.rowCount) return false;
      return (await db.query("DELETE FROM accounts WHERE id=$1", [accountId])).rowCount === 1;
    });
  }
  async deleteAccount(id: string) { return (await this.query("DELETE FROM accounts WHERE id=$1", [id])).rowCount === 1; }
  async deleteOrg(id: string) {
    return withTransaction(this.pool, async (db) => {
      const accounts = await db.query<{ account_id: string }>("SELECT account_id FROM organization_members WHERE org_id=$1 FOR UPDATE", [id]);
      if (!accounts.rowCount) return false;
      // Delete account parents first so their sessions, MFA records, challenges,
      // and reset tokens are removed by FK cascades. This preserves legacy
      // deleteOrg semantics: no orphan identity can survive tenant deletion.
      await db.query("DELETE FROM accounts WHERE id = ANY($1::text[])", [accounts.rows.map((row) => row.account_id)]);
      await db.query("DELETE FROM organizations WHERE id=$1", [id]);
      return true;
    });
  }

  async createSession(accountId: string, ttlMs = SESSION_TTL_MS) { const now = new Date(); const session = { token: randomBytes(32).toString("base64url"), accountId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() }; await this.query("INSERT INTO account_sessions (token, account_id, created_at, expires_at) VALUES ($1,$2,$3,$4)", [session.token, session.accountId, session.createdAt, session.expiresAt]); return session; }
  async verifySession(token: string) { const result = await this.query("SELECT token, account_id, created_at, expires_at FROM account_sessions WHERE token=$1 AND expires_at > now()", [token]); const row = result.rows[0]; return row ? { token: String(row.token), accountId: String(row.account_id), createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString() } : undefined; }
  async revokeSession(token: string) { await this.query("DELETE FROM account_sessions WHERE token=$1", [token]); }
  async revokeAllSessions(accountId: string) { await this.query("DELETE FROM account_sessions WHERE account_id=$1", [accountId]); }

  async createReset(accountId: string, email: string) { const now = new Date(); const token = randomBytes(24).toString("base64url"); const expiresAt = new Date(now.getTime() + RESET_TTL_MS); await this.query("INSERT INTO password_reset_tokens (token, account_id, email, created_at, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id) DO UPDATE SET token=EXCLUDED.token, email=EXCLUDED.email, created_at=EXCLUDED.created_at, expires_at=EXCLUDED.expires_at", [token, accountId, email, now, expiresAt]); return { token, email, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() } satisfies PasswordResetToken; }
  async consumeReset(token: string) { return withTransaction(this.pool, async (db: PoolClient) => { const result = await db.query<Row>("DELETE FROM password_reset_tokens WHERE token=$1 AND expires_at > now() RETURNING token,email,created_at,expires_at", [token]); const row = result.rows[0]; return row ? { token: String(row.token), email: String(row.email), createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString() } satisfies PasswordResetToken : undefined; }); }
  async getMfa(accountId: string) { const result = await this.query("SELECT account_id, secret_ciphertext, confirmed_at, created_at FROM account_mfa_records WHERE account_id=$1", [accountId]); const row = result.rows[0]; return row ? { accountId: String(row.account_id), secret: this.mfaCipher.decrypt(String(row.secret_ciphertext)), confirmedAt: row.confirmed_at ? new Date(String(row.confirmed_at)).toISOString() : undefined, createdAt: new Date(String(row.created_at)).toISOString() } satisfies MfaRecord : undefined; }
  async putMfa(record: MfaRecord) { await this.query("INSERT INTO account_mfa_records (account_id,secret_ciphertext,confirmed_at,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext, confirmed_at=EXCLUDED.confirmed_at, created_at=EXCLUDED.created_at", [record.accountId, this.mfaCipher.encrypt(record.secret), record.confirmedAt ?? null, record.createdAt]); }
  async removeMfa(accountId: string) { return (await this.query("DELETE FROM account_mfa_records WHERE account_id=$1", [accountId])).rowCount === 1; }
  async createMfaChallenge(accountId: string) { const now = new Date(); const value = { token: randomBytes(24).toString("base64url"), accountId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString() }; await this.query("INSERT INTO mfa_challenges (token,account_id,created_at,expires_at) VALUES ($1,$2,$3,$4)", [value.token,value.accountId,value.createdAt,value.expiresAt]); return value satisfies MfaChallenge; }
  async consumeMfaChallenge(token: string) { return withTransaction(this.pool, async (db: PoolClient) => { const result = await db.query<Row>("DELETE FROM mfa_challenges WHERE token=$1 AND expires_at > now() RETURNING token,account_id,created_at,expires_at", [token]); const row = result.rows[0]; return row ? { token: String(row.token), accountId: String(row.account_id), createdAt: new Date(String(row.created_at)).toISOString(), expiresAt: new Date(String(row.expires_at)).toISOString() } satisfies MfaChallenge : undefined; }); }
  async addOAuthNonce(nonce: string, expiresAt = new Date(Date.now() + OAUTH_TTL_MS)) { await this.query("INSERT INTO oauth_nonces (nonce,expires_at) VALUES ($1,$2) ON CONFLICT (nonce) DO UPDATE SET expires_at=EXCLUDED.expires_at", [nonce, expiresAt]); }
  async consumeOAuthNonce(nonce: string) { return (await this.query("DELETE FROM oauth_nonces WHERE nonce=$1 AND expires_at > now()", [nonce])).rowCount === 1; }
}
