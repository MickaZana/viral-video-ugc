/**
 * Platform Roles — PHASE C.4
 *
 * Extended role system that builds on the existing AccountRole.
 * These roles are DORMANT — not exposed in the public UI.
 *
 * Existing roles (from shared-auth/accounts.ts):
 *   owner, admin, editor, reviewer, viewer
 *
 * Future platform roles (added here):
 *   agency_manager   — manages agency client relationships
 *   client_manager   — manages assigned client workspace
 *   client_viewer    — read/review limited content (client portal)
 *
 * A client user must NEVER automatically inherit access to the entire
 * agency organization. These roles enforce workspace-level boundaries.
 */

// ---------------------------------------------------------------------------
// Extended role definitions
// ---------------------------------------------------------------------------

/**
 * The full role hierarchy including future roles.
 * Maintains backward compatibility with existing AccountRole.
 */
export type PlatformRole =
  | "owner"
  | "admin"
  | "editor"
  | "reviewer"
  | "viewer"
  // Future agency/client roles (DORMANT)
  | "agency_manager"
  | "client_manager"
  | "client_viewer";

/**
 * Extended permission set including future agency/client permissions.
 */
export type PlatformPermission =
  // Existing permissions (from shared-auth)
  | "billing.manage"
  | "team.manage"
  | "settings.manage"
  | "clients.manage"
  | "social.manage"
  | "pipeline.run"
  | "pipeline.run.live"
  | "jobs.manage"
  | "review.manage"
  | "view"
  // Future agency/client permissions (DORMANT)
  | "agency.manage"
  | "client.workspace.manage"
  | "client.workspace.view"
  | "client.approve"
  // Future API permissions (DORMANT)
  | "api.credentials.manage"
  | "api.webhooks.manage";

/**
 * Complete permission matrix including future roles.
 * Existing roles have IDENTICAL permissions to those in shared-auth — 
 * no behavioral change for current users.
 */
export const PLATFORM_ROLES: Record<PlatformRole, readonly PlatformPermission[]> = {
  // Existing roles (unchanged behavior)
  owner: [
    "billing.manage", "team.manage", "settings.manage", "clients.manage",
    "social.manage", "pipeline.run", "pipeline.run.live", "jobs.manage",
    "review.manage", "view",
    "agency.manage", "client.workspace.manage", "client.workspace.view",
    "client.approve", "api.credentials.manage", "api.webhooks.manage"
  ],
  admin: [
    "team.manage", "settings.manage", "clients.manage", "social.manage",
    "pipeline.run", "jobs.manage", "review.manage", "view",
    "agency.manage", "client.workspace.manage", "client.workspace.view",
    "client.approve", "api.credentials.manage", "api.webhooks.manage"
  ],
  editor: [
    "settings.manage", "clients.manage", "social.manage",
    "pipeline.run", "jobs.manage", "review.manage", "view",
    "client.workspace.manage", "client.workspace.view", "client.approve"
  ],
  reviewer: ["review.manage", "view", "client.workspace.view", "client.approve"],
  viewer: ["view", "client.workspace.view"],

  // Future agency/client roles (DORMANT)
  agency_manager: [
    "clients.manage", "social.manage", "pipeline.run", "jobs.manage",
    "review.manage", "view",
    "agency.manage", "client.workspace.manage", "client.workspace.view",
    "client.approve"
  ],
  client_manager: [
    "pipeline.run", "jobs.manage", "review.manage", "view",
    "client.workspace.manage", "client.workspace.view", "client.approve"
  ],
  client_viewer: [
    "view", "client.workspace.view", "client.approve"
  ]
};

/**
 * Checks if a platform role has a specific permission.
 * Falls through to existing roleHasPermission for standard AccountRoles.
 */
export function platformRoleHasPermission(role: string | undefined | null, permission: PlatformPermission): boolean {
  if (!role) return false;
  // Handle legacy "member" role mapping
  const normalized: PlatformRole = role === "member" ? "editor" : (role as PlatformRole);
  return PLATFORM_ROLES[normalized]?.includes(permission) ?? false;
}
