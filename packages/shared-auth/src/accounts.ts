import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "./passwords.js";

export type AccountRole = "owner" | "member";

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  /** Agency/brand name shown in the dashboard — not used for auth. */
  orgName?: string;
  /** The organization this account belongs to — settings/usage/billing are keyed by
   *  orgId, not accountId, so every member of an org shares one set of each (see
   *  resolveOrgId). A solo signup's orgId is its own account id — there's no separate
   *  "create an org" step, every account is implicitly a one-person org until it
   *  invites someone. */
  orgId: string;
  role: AccountRole;
  createdAt: string;
}

export type PublicAccount = Omit<Account, "passwordHash">;

export function toPublicAccount(account: Account): PublicAccount {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
}

/** The org an account's shared data (settings/usage/billing) is keyed under —
 *  currently always account.orgId, but centralized so call sites don't hardcode
 *  which field that is. */
export function resolveOrgId(account: Pick<Account, "orgId">): string {
  return account.orgId;
}

/**
 * Same exclusive-lockfile pattern as packages/review-queue/src/json-store.ts
 * (see that file's comment for why) — duplicated rather than imported since
 * these are two independently-versioned JSON-file stores with different record
 * shapes, and the lock helper itself is ~15 lines, not worth a cross-package
 * dependency for.
 */
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
        throw new Error(`Timed out waiting for accounts lock at ${lockPath}`);
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

function readAllUnlocked(dbPath: string): Account[] {
  if (!existsSync(dbPath)) return [];
  return JSON.parse(readFileSync(dbPath, "utf-8"));
}

function writeAllUnlocked(dbPath: string, accounts: Account[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify(accounts, null, 2));
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}`);
    this.name = "EmailAlreadyRegisteredError";
  }
}

export interface AccountStore {
  signUp(email: string, password: string, orgName?: string): Account;
  /** Creates an account already linked to an existing org (via an accepted invite) —
   *  role is always "member"; only the original signup that created the org is "owner". */
  signUpAsMember(email: string, password: string, orgId: string): Account;
  /** Returns the account only if the password verifies — never returns a hash to check separately. */
  authenticate(email: string, password: string): Account | undefined;
  findById(id: string): Account | undefined;
  listByOrg(orgId: string): Account[];
}

export function createAccountStore(dbPath: string): AccountStore {
  const normalize = (email: string) => email.trim().toLowerCase();

  function insert(email: string, password: string, extra: Pick<Account, "orgId" | "role" | "orgName">): Account {
    const normalized = normalize(email);
    let created: Account | undefined;
    let conflict = false;

    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const accounts = readAllUnlocked(dbPath);
      if (accounts.some((a) => normalize(a.email) === normalized)) {
        conflict = true;
      } else {
        created = {
          id: randomUUID(),
          email: normalized,
          passwordHash: hashPassword(password),
          createdAt: new Date().toISOString(),
          ...extra
        };
        writeAllUnlocked(dbPath, [...accounts, created]);
      }
    } finally {
      releaseLock(dbPath);
    }

    if (conflict) throw new EmailAlreadyRegisteredError(normalized);
    return created!;
  }

  return {
    signUp(email, password, orgName) {
      // A solo signup's orgId is generated up front (not "self after insert") so it's
      // available to store on the very first record — every account is its own
      // one-person org by default, becoming shared only once it invites someone.
      const orgId = randomUUID();
      return insert(email, password, { orgId, role: "owner", orgName });
    },

    signUpAsMember(email, password, orgId) {
      return insert(email, password, { orgId, role: "member" });
    },

    authenticate(email, password) {
      const normalized = normalize(email);
      const account = readAllUnlocked(dbPath).find((a) => normalize(a.email) === normalized);
      if (!account) return undefined;
      return verifyPassword(password, account.passwordHash) ? account : undefined;
    },

    findById(id) {
      return readAllUnlocked(dbPath).find((a) => a.id === id);
    },

    listByOrg(orgId) {
      return readAllUnlocked(dbPath).filter((a) => a.orgId === orgId);
    }
  };
}
