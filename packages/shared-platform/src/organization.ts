/**
 * Organization Ownership — PHASE B.1
 *
 * Canonical organization/tenant identity for the VUGC platform.
 * 
 * The existing system uses `orgId` as the tenant boundary (confirmed by Phase A discovery).
 * This module:
 *   1. Declares a branded OrgId type for compile-time safety
 *   2. Provides authoritative org resolution from authenticated sessions
 *   3. Defines organization types for future expansion (dormant)
 *   4. NEVER accepts orgId from untrusted sources (request body, query params, etc.)
 */

// ---------------------------------------------------------------------------
// Branded OrgId type — prevents accidental mixing of accountId/orgId/clientId
// ---------------------------------------------------------------------------

/** Branded type alias for organization identifiers. At runtime it's a string,
 *  but TypeScript's structural typing prevents accidental assignment from
 *  other string-typed IDs. */
export type OrgId = string & { readonly __brand: "OrgId" };

/** Cast a verified orgId string to the branded type. Only call this after
 *  the value has been derived from an authenticated session — NEVER from
 *  user-supplied input. */
export function toOrgId(verified: string): OrgId {
  return verified as OrgId;
}

// ---------------------------------------------------------------------------
// Organization type classification (DORMANT — not exposed publicly)
// ---------------------------------------------------------------------------

/**
 * Future organization type classification.
 * 
 * Currently all public organizations default to "individual".
 * Agency, enterprise, and platform_partner are dormant capabilities —
 * they exist in the type system only and are NOT exposed in the public UI.
 */
export type OrganizationType =
  | "individual"
  | "business"
  | "agency"
  | "enterprise"
  | "platform_partner";

/** Default type for all public signups. */
export const DEFAULT_ORGANIZATION_TYPE: OrganizationType = "individual";

// ---------------------------------------------------------------------------
// Organization metadata (future-compatible extension of existing Account model)
// ---------------------------------------------------------------------------

/**
 * Extended organization metadata. This is additive — does not replace
 * the existing Account model, but can be stored alongside it when the
 * organization type system is activated.
 */
export interface OrganizationMeta {
  orgId: OrgId;
  type: OrganizationType;
  /** Human-readable org name (mirrors existing Account.orgName). */
  displayName?: string;
  /** Platform-level flags (internal use only). */
  flags?: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Canonical org resolution from authenticated context
// ---------------------------------------------------------------------------

/**
 * Resolves the calling user's orgId from their authenticated account.
 * This is the ONLY sanctioned way to determine tenant scope.
 *
 * NEVER accept orgId from:
 *   - request body
 *   - query parameter
 *   - hidden frontend field
 *   - URL parameter
 *   - localStorage
 *   - client-provided metadata
 *
 * @param account - The authenticated account (from session verification)
 * @returns The branded OrgId for the account's organization
 */
export function resolveOrganizationFromAccount(account: { orgId: string }): OrgId {
  if (!account.orgId) {
    throw new Error("Authenticated account has no organization — cannot determine tenant scope");
  }
  return toOrgId(account.orgId);
}

/**
 * Type guard: validates that a value looks like a valid orgId format.
 * Does NOT verify ownership — use resolveOrganizationFromAccount for that.
 * This is only for format validation in admin/internal contexts.
 */
export function isValidOrgIdFormat(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 50;
}
