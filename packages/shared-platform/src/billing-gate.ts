/**
 * Billing Gate — Phase E (Section 36)
 *
 * Ensures ALL run creation paths (dashboard, API, future client runs)
 * flow through the same billing/quota enforcement.
 *
 * This is NOT a new billing system — it's a contract that any code path
 * triggering a paid run MUST call before proceeding.
 *
 * The actual quota logic lives in:
 *   apps/review-dashboard/src/quota.ts → checkRunQuota()
 *
 * This module documents the shared contract and provides a type-safe
 * wrapper for future API route handlers.
 */

// ---------------------------------------------------------------------------
// Billing gate contract
// ---------------------------------------------------------------------------

/**
 * The result of a billing gate check.
 * Mirrors the existing QuotaCheck from quota.ts — kept compatible.
 */
export interface BillingGateResult {
  /** Whether the run is allowed to proceed. Always true in hybrid billing. */
  allowed: boolean;
  /** Whether this run exceeds the monthly allowance (billed as overage). */
  overage: boolean;
  /** Per-run overage price when overage=true. */
  overagePriceUsdPerRun?: number;
  /** Human-readable explanation. */
  reason?: string;
}

/**
 * Contract: before creating ANY paid run (dashboard, API, or client),
 * the handler MUST call a function matching this signature.
 *
 * The actual implementation is checkRunQuota() in quota.ts.
 * This type exists so future API handlers reference the same contract.
 *
 * Usage in a future /v1/runs handler:
 *   const gate: RunBillingGate = (orgId) => checkRunQuota(planStore.get(orgId), aggregateUsage(orgId, runsDir));
 *   const result = gate(orgId);
 *   if (!result.allowed) return res.status(402).json(apiError("quota_exceeded", result.reason!, requestId));
 */
export type RunBillingGate = (orgId: string) => BillingGateResult;

/**
 * Validates that the billing gate was consulted before a run.
 * Use in tests to assert the billing path is not bypassed.
 */
export function assertBillingGateConsulted(result: BillingGateResult | undefined): void {
  if (result === undefined) {
    throw new Error(
      "BILLING VIOLATION: Run was created without consulting the billing gate. " +
      "All run creation paths (dashboard, API, client) MUST call checkRunQuota() " +
      "before triggering paid generation. See packages/shared-platform/src/billing-gate.ts."
    );
  }
}

/**
 * Documents which paths must enforce the billing gate.
 * This is a compile-time reference — not runtime enforcement.
 */
export const BILLING_ENFORCED_PATHS = [
  "POST /accounts/run",           // Dashboard run (existing — already enforced)
  "POST /accounts/jobs",          // Job queue run (existing — already enforced)
  "POST /v1/runs",                // Future API run (MUST enforce when implemented)
  "scheduler.runDueClientSchedules" // Scheduled run (existing — already enforced)
] as const;
