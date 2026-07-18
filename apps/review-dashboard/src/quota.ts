import type { AccountUsage } from "@vvugc/shared-auth";
import type { AccountPlan } from "@vvugc/shared-billing";
import { getTier } from "@vvugc/shared-billing";

/**
 * Shared by billing.ts (display) and accounts.ts (enforcement) so the number a
 * user sees on their billing panel and the number that actually blocks a run
 * can never drift apart into two different definitions of "this month."
 */
export function runsUsedThisMonth(usage: AccountUsage): number {
  const thisMonth = new Date().toISOString().slice(0, 7);
  return usage.runs.filter((r) => r.createdAt.slice(0, 7) === thisMonth).length;
}

export interface QuotaCheck {
  allowed: boolean;
  /** Present only when allowed === false — the tier name and limit that was hit. */
  reason?: string;
}

/**
 * An account with no active paid plan (status !== "active") is unrestricted —
 * billing hasn't been asked to gate anything until a real subscription exists.
 * A plan pointing at an unrecognized tierId (shouldn't happen, but Stripe
 * webhooks are external input) fails open the same way, rather than blocking
 * a paying customer over a data-integrity issue that isn't their fault.
 *
 * Scope: only `POST /accounts/run` (accounts.ts) calls this. The CLI's own
 * `runCycle` invocation (apps/orchestrator/src/cli.ts, the operator/cron path)
 * has no accountId/billing concept and is not metered by this check — correct
 * today since the CLI isn't customer-facing, but if CLI/cron access is ever
 * exposed directly to paying customers, that path would need its own call into
 * checkRunQuota (or a shared enforcement point above both callers) to avoid
 * silently reintroducing the same "display vs. enforce" gap this function was
 * built to close for the HTTP path.
 */
export function checkRunQuota(plan: AccountPlan, usage: AccountUsage): QuotaCheck {
  if (plan.status !== "active" || !plan.tierId) return { allowed: true };
  const tier = getTier(plan.tierId);
  if (!tier) return { allowed: true };

  const used = runsUsedThisMonth(usage);
  if (used >= tier.monthlyRunLimit) {
    return {
      allowed: false,
      reason: `monthly run limit reached (${tier.monthlyRunLimit} runs on the ${tier.name} plan) — upgrade your plan or wait until next month`
    };
  }
  return { allowed: true };
}
