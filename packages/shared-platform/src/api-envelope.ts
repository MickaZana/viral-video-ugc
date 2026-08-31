/**
 * API Response Envelope — PHASE D.5, D.1 (partial)
 *
 * Consistent response format for future /v1 API routes.
 * Does NOT change current dashboard APIs — only applies to future versioned routes.
 *
 * Success:
 *   { "data": {...}, "requestId": "...", "meta": {...} }
 *
 * Error:
 *   { "error": { "code": "...", "message": "...", "requestId": "..." } }
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Request ID generation
// ---------------------------------------------------------------------------

/**
 * Generates a unique request ID for observability.
 * Format: req_<UUID> — prefixed so it's identifiable in logs.
 */
export function generateRequestId(): string {
  return `req_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export interface ApiSuccessResponse<T = unknown> {
  data: T;
  requestId: string;
  meta?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/**
 * Wraps a successful response in the standard API envelope.
 */
export function apiSuccess<T>(data: T, requestId: string, meta?: Record<string, unknown>): ApiSuccessResponse<T> {
  const response: ApiSuccessResponse<T> = { data, requestId };
  if (meta) response.meta = meta;
  return response;
}

/**
 * Wraps an error response in the standard API envelope.
 */
export function apiError(code: string, message: string, requestId: string): ApiErrorResponse {
  return {
    error: { code, message, requestId }
  };
}

/**
 * Standard API error codes for the /v1 namespace.
 */
export const API_ERROR_CODES = {
  AUTHENTICATION_REQUIRED: "authentication_required",
  INVALID_CREDENTIALS: "invalid_credentials",
  INSUFFICIENT_SCOPE: "insufficient_scope",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXCEEDED: "quota_exceeded",
  VALIDATION_ERROR: "validation_error",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  INTERNAL_ERROR: "internal_error",
  FEATURE_DISABLED: "feature_disabled"
} as const;

/**
 * Placeholder constant for documentation. The actual envelope implementation
 * lives in apiSuccess/apiError above.
 */
export const API_RESPONSE_ENVELOPE = {
  successFormat: "{ data, requestId, meta? }",
  errorFormat: "{ error: { code, message, requestId } }"
} as const;
