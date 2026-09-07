/**
 * Central Authorization — PHASE B.4
 *
 * Typed authorization helpers that replace scattered `if (user.orgId !== item.orgId)`
 * checks throughout handlers.
 *
 * The implementation preserves existing behavior — this is a centralization, not
 * a rewrite. Routes should incrementally adopt these helpers where it materially
 * reduces security risk.
 *
 * Authorization model:
 *   organization boundary + workspace/client boundary + role boundary
 *
 * Future authorization will resemble:
 *   authorize(user, organization, workspace, resource, action)
 */

import type { AccountRole, AccountPermission } from "@vvugc/shared-auth";
import { roleHasPermission } from "@vvugc/shared-auth";
import type { OrgId } from "./organization.js";

// ---------------------------------------------------------------------------
// Actor — who is making the request
// ---------------------------------------------------------------------------

export interface SessionActor {
  kind: "session";
  accountId: string;
  orgId: OrgId;
  role: AccountRole;
}

export interface OperatorActor {
  kind: "operator";
  username: string;
}

export interface ApiKeyActor {
  kind: "api_key";
  credentialId: string;
  orgId: OrgId;
  scopes: string[];
}

export type Actor = SessionActor | OperatorActor | ApiKeyActor;

// ---------------------------------------------------------------------------
// Authorization results
// ---------------------------------------------------------------------------

export interface AuthorizeResult {
  allowed: boolean;
  reason?: string;
}

const ALLOWED: AuthorizeResult = { allowed: true };
function denied(reason: string): AuthorizeResult {
  return { allowed: false, reason };
}

// ---------------------------------------------------------------------------
// Organization access
// ---------------------------------------------------------------------------

/**
 * Verifies that the actor has access to the specified organization.
 * 
 * - Session actors: must belong to the org
 * - Operators: cross-org access allowed (platform admin)
 * - API keys: must be bound to the org
 */
export function authorizeOrganizationAccess(actor: Actor, targetOrgId: string): AuthorizeResult {
  switch (actor.kind) {
    case "session":
      return actor.orgId === targetOrgId
        ? ALLOWED
        : denied("session user does not belong to this organization");
    case "operator":
      return ALLOWED; // Operators have cross-org visibility
    case "api_key":
      return actor.orgId === targetOrgId
        ? ALLOWED
        : denied("API credential is not bound to this organization");
  }
}

// ---------------------------------------------------------------------------
// Workspace access (future — currently passes through to org check)
// ---------------------------------------------------------------------------

/**
 * Verifies that the actor has access to a specific workspace within their org.
 * 
 * Currently: passes through to organization access (all org members see all workspaces).
 * Future: will enforce workspace-level isolation for agency/client workspaces.
 */
export function authorizeWorkspaceAccess(
  actor: Actor,
  targetOrgId: string,
  _targetWorkspaceId: string
): AuthorizeResult {
  // Phase 1: workspace access = org access
  // Phase 2 (agency activation): will check workspace membership
  return authorizeOrganizationAccess(actor, targetOrgId);
}

// ---------------------------------------------------------------------------
// Client access (future — dormant)
// ---------------------------------------------------------------------------

/**
 * Verifies that the actor has access to a specific client within an org.
 * 
 * IMPORTANT: A future agency may have multiple clients. Client A must NEVER
 * access Client B's resources, even within the same org.
 * 
 * Currently: org membership = access to all clients in that org (existing behavior).
 * Future: will enforce client-level isolation based on workspace assignment.
 */
export function authorizeClientAccess(
  actor: Actor,
  targetOrgId: string,
  _targetClientId: string
): AuthorizeResult {
  // Phase 1: client access = org access (preserves existing behavior)
  // Phase 2 (agency activation): will check client/workspace membership
  return authorizeOrganizationAccess(actor, targetOrgId);
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

/**
 * Verifies that the actor has a specific permission.
 * 
 * - Session actors: checked against role-based permissions
 * - Operators: all permissions granted (platform admin)
 * - API keys: checked against credential scopes (mapped to permissions)
 */
export function authorizePermission(actor: Actor, permission: AccountPermission): AuthorizeResult {
  switch (actor.kind) {
    case "session":
      return roleHasPermission(actor.role, permission)
        ? ALLOWED
        : denied(`role "${actor.role}" does not have permission "${permission}"`);
    case "operator":
      return ALLOWED;
    case "api_key":
      // API scope → permission mapping (future)
      return denied("API key permission check not yet implemented");
  }
}

// ---------------------------------------------------------------------------
// Resource access (composite check)
// ---------------------------------------------------------------------------

/**
 * Verifies access to a specific resource. Checks org boundary first,
 * then permission.
 * 
 * This is the recommended single-call authorization function for route handlers:
 *   const result = authorizeResource(actor, resource.orgId, "review.manage");
 *   if (!result.allowed) return res.status(404).json({ error: "not found" });
 * 
 * Returns 404-style denial (not 403) to avoid revealing resource existence.
 */
export function authorizeResource(
  actor: Actor,
  resourceOrgId: string,
  requiredPermission?: AccountPermission
): AuthorizeResult {
  const orgResult = authorizeOrganizationAccess(actor, resourceOrgId);
  if (!orgResult.allowed) return orgResult;

  if (requiredPermission) {
    return authorizePermission(actor, requiredPermission);
  }

  return ALLOWED;
}

// ---------------------------------------------------------------------------
// Platform admin check
// ---------------------------------------------------------------------------

/**
 * Determines if the actor has platform-level administrative capabilities.
 * 
 * Platform admin is SEPARATE from ordinary customer sessions.
 * Only operators (Basic Auth) are platform admins in the current system.
 */
export function isPlatformAdmin(actor: Actor): boolean {
  return actor.kind === "operator";
}

/**
 * Verifies platform admin access. Used for platform-level operations
 * (viewing all orgs, system health, aggregate metrics).
 */
export function authorizePlatformAdmin(actor: Actor): AuthorizeResult {
  return isPlatformAdmin(actor)
    ? ALLOWED
    : denied("platform administration requires operator access");
}
