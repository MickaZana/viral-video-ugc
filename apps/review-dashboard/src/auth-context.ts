/**
 * Centralized authentication context resolution.
 *
 * Every authenticated route should call getAuthContext(req) instead of
 * manually checking req.accountId and calling resolveRequestOrg.
 *
 * This ensures:
 * - Customer sessions are always tenant-scoped
 * - Operator (Basic Auth) access is explicitly typed
 * - No route can accidentally treat undefined orgId as "all tenants"
 */

import type { Request } from "express";
import type { AccountRole } from "@vvugc/shared-auth";

export type AuthContext =
  | {
      kind: "session";
      accountId: string;
      orgId: string;
      role: AccountRole;
    }
  | {
      kind: "operator";
      username: string;
    };

export interface AuthedRequest extends Request {
  accountId?: string;
  auditActor?: string;
  /** Populated by getAuthContext — cached per request */
  _authContext?: AuthContext;
}

/**
 * Resolves the authentication context for the current request.
 * Must only be called after the auth middleware has run.
 *
 * @param req - The Express request (must have passed auth gate)
 * @param resolveOrg - Function that maps accountId -> orgId (injected to avoid circular deps)
 * @param getRole - Function that maps accountId -> role (injected)
 * @returns AuthContext — always defined after auth gate
 * @throws Error if called without authentication (should never happen after gate)
 */
export function getAuthContext(
  req: AuthedRequest,
  resolveOrg: (accountId: string) => string | undefined,
  getRole?: (accountId: string) => AccountRole | undefined
): AuthContext {
  // Return cached if already resolved this request
  if (req._authContext) return req._authContext;

  if (req.accountId) {
    const orgId = resolveOrg(req.accountId);
    if (!orgId) {
      // Account exists but has no org — treat as operator fallback
      // This shouldn't happen in practice; accounts always have an org
      throw new Error("Authenticated account has no organization — cannot determine tenant scope");
    }
    const role = getRole?.(req.accountId) ?? "viewer";
    const ctx: AuthContext = { kind: "session", accountId: req.accountId, orgId, role };
    req._authContext = ctx;
    return ctx;
  }

  // No accountId means Basic Auth operator passed the gate
  const ctx: AuthContext = { kind: "operator", username: "operator" };
  req._authContext = ctx;
  return ctx;
}

/**
 * Convenience: get the orgId for tenant-scoped queries.
 * Returns the org for session users, undefined for operators (cross-org access).
 */
export function getOrgId(auth: AuthContext): string | undefined {
  return auth.kind === "session" ? auth.orgId : undefined;
}

/**
 * Strict version: requires an orgId. Throws if operator tries to use
 * a customer-only endpoint without specifying an org.
 */
export function requireOrgId(auth: AuthContext): string {
  if (auth.kind === "session") return auth.orgId;
  throw new Error("This endpoint requires a tenant context — operator must specify orgId");
}
