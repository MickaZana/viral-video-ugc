/**
 * Atom D — Retry Classification and Backoff Policy
 *
 * Classifies provider errors into retry categories and computes backoff.
 * Never retries after a successful provider request unless result retrieval
 * is definitively incomplete.
 */

export type ErrorCategory =
  | "retryable_timeout"
  | "retryable_5xx"
  | "retryable_rate_limit"
  | "non_retryable_invalid_request"
  | "non_retryable_auth"
  | "non_retryable_cancelled"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  /** Suggested minimum wait before retry (ms). Only meaningful if retryable. */
  backoffMs: number;
  /** Whether to fall back to the next vendor in chain (vs. retry same vendor). */
  shouldFallback: boolean;
  /** Sanitized error message (no secrets). */
  message: string;
}

/**
 * Classify an error from a video generation provider call.
 */
export function classifyProviderError(error: unknown, attempt: number): ClassifiedError {
  const message = sanitizeErrorMessage(error);
  const lower = message.toLowerCase();

  // Cancellation
  if (lower.includes("cancel")) {
    return {
      category: "non_retryable_cancelled",
      retryable: false,
      backoffMs: 0,
      shouldFallback: false,
      message,
    };
  }

  // Auth / configuration failures — never retry, never fallback to same vendor
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication") ||
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("credential") ||
    lower.includes("requires a callmcptool") ||
    lower.includes("requireenvvar")
  ) {
    return {
      category: "non_retryable_auth",
      retryable: false,
      backoffMs: 0,
      shouldFallback: true, // try next vendor
      message,
    };
  }

  // Invalid request — never retry with same params, don't fallback (request itself is bad)
  if (
    lower.includes("400") ||
    lower.includes("422") ||
    lower.includes("invalid") ||
    lower.includes("validation") ||
    lower.includes("malformed") ||
    lower.includes("bad request")
  ) {
    return {
      category: "non_retryable_invalid_request",
      retryable: false,
      backoffMs: 0,
      shouldFallback: false, // request is bad for ALL vendors
      message,
    };
  }

  // Rate limiting — retry with longer backoff
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota exceeded")
  ) {
    return {
      category: "retryable_rate_limit",
      retryable: true,
      backoffMs: computeBackoff(attempt, 10_000), // higher base for rate limits
      shouldFallback: false,
      message,
    };
  }

  // Timeout
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnaborted")
  ) {
    return {
      category: "retryable_timeout",
      retryable: true,
      backoffMs: computeBackoff(attempt, 5_000),
      shouldFallback: false,
      message,
    };
  }

  // Server errors (5xx)
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("internal server error") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway")
  ) {
    return {
      category: "retryable_5xx",
      retryable: true,
      backoffMs: computeBackoff(attempt, 3_000),
      shouldFallback: false,
      message,
    };
  }

  // MCP-specific unavailability — fallback
  if (
    lower.includes("mcp") ||
    lower.includes("session") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused")
  ) {
    return {
      category: "retryable_5xx",
      retryable: true,
      backoffMs: computeBackoff(attempt, 5_000),
      shouldFallback: true, // MCP down → try REST vendor
      message,
    };
  }

  // Unknown — conservatively retryable once
  return {
    category: "unknown",
    retryable: attempt < 1,
    backoffMs: computeBackoff(attempt, 3_000),
    shouldFallback: false,
    message,
  };
}

/**
 * Exponential backoff with full jitter.
 * Formula: random(0, min(cap, base * 2^attempt))
 * Cap: 300 seconds (5 minutes).
 */
export function computeBackoff(attempt: number, baseMs: number = 2_000): number {
  const cap = 300_000; // 5 minutes
  const exponential = baseMs * 2 ** attempt;
  const bounded = Math.min(cap, exponential);
  return Math.random() * bounded;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/key[=:]\s*\S+/gi, "key=[REDACTED]")
    .slice(0, 4000);
}
