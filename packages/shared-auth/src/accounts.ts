import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "./passwords.js";

/**
 * Fine-grained org roles — Owner/Admin/Editor/Reviewer/Viewer (docs/remaining-p0-execution-plan.md
 * Phase 7). Legacy on-disk accounts created before this model carried role "member"; that value is
 * treated as editor-equivalent everywhere (see roleHasPermission) so no existing account is locked
 * out or silently elevated — it just behaves like an editor until the owner re-roles them.
 */
export type AccountRole = "owner" | "admin" | "editor" | "reviewer" | "viewer";

export const ACCOUNT_ROLES: readonly AccountRole[] = ["owner", "admin", "editor", "reviewer", "viewer"];

/** Every granular action a route can gate on. Kept coarse-grained (one action per route group,
 *  not per endpoint) so the map stays readable; split further only when a real product need
 *  demands it. */
export type AccountPermission =
  | "billing.manage"
  | "team.manage"
  | "settings.manage"
  | "clients.manage"
  | "social.manage"
  | "pipeline.run"
  | "pipeline.run.live"
  | "jobs.manage"
  | "review.manage"
  | "view";

const ROLE_PERMISSIONS: Record<AccountRole, readonly AccountPermission[]> = {
  owner: [
    "billing.manage",
    "team.manage",
    "settings.manage",
    "clients.manage",
    "social.manage",
    "pipeline.run",
    "pipeline.run.live",
    "jobs.manage",
    "review.manage",
    "view"
  ],
  admin: [
    "team.manage",
    "settings.manage",
    "clients.manage",
    "social.manage",
    "pipeline.run",
    "jobs.manage",
    "review.manage",
    "view"
  ],
  editor: [
    "settings.manage",
    "clients.manage",
    "social.manage",
    "pipeline.run",
    "jobs.manage",
    "review.manage",
    "view"
  ],
  reviewer: ["review.manage", "view"],
  viewer: ["view"]
};

/** True if the role may perform `permission`. Accepts the legacy "member" role (maps to editor)
 *  and any unknown string (fails safe to no permissions rather than guessing up). */
export function roleHasPermission(role: string | undefined | null, permission: AccountPermission): boolean {
  if (!role) return false;
  const normalized: AccountRole = role === "member" ? "editor" : (role as AccountRole);
  return ROLE_PERMISSIONS[normalized]?.includes(permission) ?? false;
}

/** Human-readable labels for the account page's member list and role picker. */
export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  reviewer: "Reviewer",
  viewer: "Viewer",
  member: "Editor" // legacy role shown with its effective label
};

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
  role: AccountRole | "member";
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
  { const _atomicTmp = `${dbPath}.${randomUUID()}.tmp`; writeFileSync(_atomicTmp, JSON.stringify(accounts, null, 2)); renameSync(_atomicTmp, dbPath); };
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}`);
    this.name = "EmailAlreadyRegisteredError";
  }
}

export interface AccountStore {
  signUp(email: string, password: string, orgName?: string): Account;
  /** Creates an account already linked to an existing org (via an accepted invite).
   *  The invite carries the role the owner chose (default "editor" — see invites.ts);
   *  only the original signup that created the org is "owner". */
  signUpAsMember(email: string, password: string, orgId: string, role?: AccountRole): Account;
  /** Returns the account only if the password verifies — never returns a hash to check separately. */
  authenticate(email: string, password: string): Account | undefined;
  findById(id: string): Account | undefined;
  /** Email lookup used by the password-recovery flow (normalized the same way as
   *  authenticate/signUp so casing doesn't matter). Returns undefined when absent. */
  findByEmail(email: string): Account | undefined;
  listByOrg(orgId: string): Account[];
  /** Re-hashes and persists a new password. Returns false if the account doesn't exist. */
  updatePassword(accountId: string, newPassword: string): boolean;
  /** Reassigns a member's role. Returns undefined if the target isn't in the org or is the
   *  org's owner (the owner role is not reassignable through this store — see setRole). */
  setRole(orgId: string, accountId: string, role: AccountRole): Account | undefined;
  /** Removes a member account from the org. Returns false if the target isn't in the org
   *  or is the org's owner (an org must keep its owner; deleting an owner is org deletion,
   *  a separate concern). */
  removeMember(orgId: string, accountId: string): boolean;
  /** Hard-deletes a single account regardless of role — used by self-service account
   *  deletion, where a member removes only their own record (and their sessions/invites
   *  are handled by the caller). The org's owner is handled by deleteOrg, never here:
   *  an owner deleting their account means deleting the whole org, which is a separate,
   *  deliberate operation. */
  deleteAccount(accountId: string): boolean;
  /** Hard-deletes every account in the org — the account-deletion path for the org's
   *  owner, which removes the entire organization (members, settings, clients, runs...)
   *  rather than leaving a headless org behind. */
  deleteOrg(orgId: string): boolean;
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

  function mutate<T>(fn: (accounts: Account[]) => T): T {
    mkdirSync(dirname(dbPath), { recursive: true });
    acquireLock(dbPath);
    try {
      const accounts = readAllUnlocked(dbPath);
      const result = fn(accounts);
      writeAllUnlocked(dbPath, accounts);
      return result;
    } finally {
      releaseLock(dbPath);
    }
  }

  return {
    signUp(email, password, orgName) {
      // A solo signup's orgId is generated up front (not "self after insert") so it's
      // available to store on the very first record — every account is its own
      // one-person org by default, becoming shared only once it invites someone.
      const orgId = randomUUID();
      return insert(email, password, { orgId, role: "owner", orgName });
    },

    signUpAsMember(email, password, orgId, role = "editor") {
      return insert(email, password, { orgId, role });
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

    findByEmail(email) {
      const normalized = normalize(email);
      return readAllUnlocked(dbPath).find((a) => normalize(a.email) === normalized);
    },

    listByOrg(orgId) {
      return readAllUnlocked(dbPath).filter((a) => a.orgId === orgId);
    },

    updatePassword(accountId, newPassword) {
      let updated = false;
      mutate((accounts) => {
        const account = accounts.find((a) => a.id === accountId);
        if (account) {
          account.passwordHash = hashPassword(newPassword);
          updated = true;
        }
      });
      return updated;
    },

    setRole(orgId, accountId, role) {
      let result: Account | undefined;
      mutate((accounts) => {
        const account = accounts.find((a) => a.id === accountId && a.orgId === orgId);
        // The owner is the org's anchor — demoting or transferring ownership is org
        // restructuring, not a member edit; refuse here and let a future dedicated
        // "transfer ownership" flow handle it deliberately.
        if (account && account.role !== "owner") {
          account.role = role;
          result = { ...account };
        }
      });
      return result;
    },

    removeMember(orgId, accountId) {
      let removed = false;
      mutate((accounts) => {
        const index = accounts.findIndex((a) => a.id === accountId && a.orgId === orgId);
        if (index !== -1 && accounts[index].role !== "owner") {
          accounts.splice(index, 1);
          removed = true;
        }
      });
      return removed;
    },

    deleteAccount(accountId) {
      let removed = false;
      mutate((accounts) => {
        const index = accounts.findIndex((a) => a.id === accountId);
        if (index !== -1) {
          accounts.splice(index, 1);
          removed = true;
        }
      });
      return removed;
    },

    deleteOrg(orgId) {
      let removed = false;
      mutate((accounts) => {
        const before = accounts.length;
        for (let i = accounts.length - 1; i >= 0; i--) {
          if (accounts[i].orgId === orgId) accounts.splice(i, 1);
        }
        removed = accounts.length < before;
      });
      return removed;
    }
  };
}
