/**
 * Feature Flags — PHASE B.5
 *
 * Server-side authoritative feature flags.
 * 
 * CRITICAL SECURITY RULE:
 *   Feature flags MUST be evaluated server-side for protected operations.
 *   Frontend feature flags are UX controls only.
 *   Server-side flags are authorization gates.
 *
 * Never trust:
 *   - localStorage
 *   - window variables
 *   - query parameters
 *   - hidden fields
 *   for security decisions.
 *
 * Default production values:
 *   VVUGC_AGENCY_CLIENTS_ENABLED = false
 *   VVUGC_API_ENABLED = false
 *
 * Development/test environments can enable dormant features via env vars.
 */

// ---------------------------------------------------------------------------
// Flag definitions
// ---------------------------------------------------------------------------

export interface FeatureFlagConfig {
  /** Unique identifier for this flag. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Environment variable that controls this flag. */
  envVar: string;
  /** Default value when env var is not set. */
  defaultValue: boolean;
}

/**
 * All platform feature flags. Centralized here so:
 *   1. There's one place to see what's gated
 *   2. Default values are explicit and auditable
 *   3. New flags can't be added without documenting them
 */
export const FEATURE_FLAGS: Record<string, FeatureFlagConfig> = {
  AGENCY_CLIENTS: {
    id: "agency_clients",
    description: "Agency/client management UI and API routes",
    envVar: "VVUGC_AGENCY_CLIENTS_ENABLED",
    defaultValue: false
  },
  API_PLATFORM: {
    id: "api_platform",
    description: "Public API v1 routes and developer credentials",
    envVar: "VVUGC_API_ENABLED",
    defaultValue: false
  },
  PLATFORM_ADMIN: {
    id: "platform_admin",
    description: "Platform-level administration dashboard",
    envVar: "VVUGC_PLATFORM_ADMIN_ENABLED",
    defaultValue: false
  },
  WEBHOOKS: {
    id: "webhooks",
    description: "Webhook endpoint management for organizations",
    envVar: "VVUGC_WEBHOOKS_ENABLED",
    defaultValue: false
  }
} as const;

// ---------------------------------------------------------------------------
// Flag evaluation (server-side authoritative)
// ---------------------------------------------------------------------------

/**
 * Evaluates a feature flag from the server-side environment.
 * 
 * This is the ONLY function that should determine whether a feature is enabled.
 * Route handlers call this to gate access to dormant functionality.
 *
 * Accepted truthy values: "true", "1", "yes", "on" (case-insensitive)
 * Everything else (including undefined/empty) → uses the flag's defaultValue.
 */
export function isFeatureEnabled(flagKey: keyof typeof FEATURE_FLAGS): boolean {
  const config = FEATURE_FLAGS[flagKey];
  if (!config) return false;

  const envValue = process.env[config.envVar];
  if (envValue === undefined || envValue === "") {
    return config.defaultValue;
  }

  return ["true", "1", "yes", "on"].includes(envValue.toLowerCase());
}

/**
 * Returns all flag states for internal diagnostics / health check.
 * NEVER expose this to unauthenticated users — it reveals what
 * capabilities exist (even if disabled).
 */
export function getAllFlagStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const [key, config] of Object.entries(FEATURE_FLAGS)) {
    states[config.id] = isFeatureEnabled(key as keyof typeof FEATURE_FLAGS);
  }
  return states;
}

// ---------------------------------------------------------------------------
// Route guard middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express-compatible middleware that gates a route behind a feature flag.
 * Returns 404 when the feature is disabled (not 403 — avoids revealing the feature exists).
 *
 * Usage:
 *   app.use("/v1", requireFeature("API_PLATFORM"), apiRouter);
 *   app.use("/accounts/agency", requireFeature("AGENCY_CLIENTS"), agencyRouter);
 */
export function requireFeature(flagKey: keyof typeof FEATURE_FLAGS) {
  return (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => unknown } }, next: () => void) => {
    if (isFeatureEnabled(flagKey)) {
      return next();
    }
    // Return 404, not 403 — feature-gated routes should be indistinguishable
    // from non-existent routes to prevent route discovery.
    return res.status(404).json({ error: "not found" });
  };
}

/**
 * Inline check for use within a handler (not middleware).
 * Returns false when the feature is disabled — the handler should respond with 404.
 *
 * Usage:
 *   if (!assertFeatureEnabled("AGENCY_CLIENTS")) {
 *     return res.status(404).json({ error: "not found" });
 *   }
 */
export function assertFeatureEnabled(flagKey: keyof typeof FEATURE_FLAGS): boolean {
  return isFeatureEnabled(flagKey);
}
