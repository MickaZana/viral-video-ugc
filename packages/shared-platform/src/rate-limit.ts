/**
 * API Rate Limiting Configuration — Section 21
 *
 * Rate limit definitions for future API routes.
 * The actual middleware lives in review-dashboard (where Express is),
 * but the configuration and logic lives here for reusability.
 *
 * Rate limiting must prevent a leaked API key from creating unlimited paid generation.
 * API usage must feed the same cost/quota controls as dashboard-generated runs.
 */

// ---------------------------------------------------------------------------
// Rate limit configuration
// ---------------------------------------------------------------------------

export interface ApiRateLimitConfig {
  /** Time window in milliseconds. */
  windowMs: number;
  /** Maximum requests per window. */
  limit: number;
  /** What to key the rate limit on. */
  keyBy: "ip" | "credential" | "org";
  /** Human-readable description for error messages. */
  description: string;
}

/**
 * Predefined rate limits for API endpoints.
 * Applied per-organization or per-credential depending on the endpoint's sensitivity.
 *
 * Rationale:
 *   - runs:create is expensive (triggers paid generation) → aggressive limit
 *   - publish is irreversible (posts to social media) → aggressive limit
 *   - reads are cheap → generous limit
 */
export const API_RATE_LIMITS: Record<string, ApiRateLimitConfig> = {
  /** Default for most read endpoints. */
  default: {
    windowMs: 60_000,
    limit: 60,
    keyBy: "credential",
    description: "60 requests per minute per credential"
  },
  /** Creating runs triggers paid video generation. */
  runs_create: {
    windowMs: 60_000,
    limit: 10,
    keyBy: "org",
    description: "10 run creations per minute per organization"
  },
  /** Publishing posts to social media — irreversible. */
  publish: {
    windowMs: 60_000,
    limit: 5,
    keyBy: "org",
    description: "5 publish operations per minute per organization"
  },
  /** Script generation uses LLM tokens. */
  scripts_create: {
    windowMs: 60_000,
    limit: 20,
    keyBy: "org",
    description: "20 script generations per minute per organization"
  }
};

/**
 * Resolves the rate limit key for a given request context.
 * Used by the middleware in review-dashboard to derive the limiter key.
 */
export function resolveRateLimitKey(
  keyBy: ApiRateLimitConfig["keyBy"],
  context: { ip?: string; credentialId?: string; orgId?: string }
): string {
  switch (keyBy) {
    case "ip":
      return `ip:${context.ip ?? "unknown"}`;
    case "credential":
      return `cred:${context.credentialId ?? context.orgId ?? "unknown"}`;
    case "org":
      return `org:${context.orgId ?? "unknown"}`;
  }
}
