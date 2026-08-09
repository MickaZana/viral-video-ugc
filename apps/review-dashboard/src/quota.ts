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
  /** Always true — runs past the limit are allowed as consumption overage rather
   *  than hard-blocked (see `overage`). `allowed` is kept for callers that only
   *  need to know "may I run?" without caring about overage. */
  allowed: boolean;
  /** True when this run is *over* the tier's included monthly allowance and will
   *  therefore be billed at overagePriceUsdPerRun. False when within the allowance
   *  (or when the account has no active paid plan). */
  overage: boolean;
  /** The per-run overage price when overage === true, else undefined. */
  overagePriceUsdPerRun?: number;
  /** Present when the account is over the allowance — a human-readable note. */
  reason?: string;
}

/**
 * An account with no active paid plan (status !== "active") is unrestricted —
 * billing hasn't been asked to gate anything until a real subscription exists,
 * and overage can't be charged against a plan that isn't being billed.
 * A plan pointing at an unrecognized tierId (shouldn't happen, but Stripe
 * webhooks are external input) fails open the same way.
 *
 * Hybrid billing model: the subscription includes a monthly run allowance; runs
 * beyond it are NOT blocked — they're billed as consumption overage at the
 * tier's overagePriceUsdPerRun. This turns a hard quota stop into revenue on
 * heavy users while keeping a predictable anchor for everyone else.
 *
 * Scope: only `POST /accounts/run` and `POST /accounts/jobs` (accounts.ts) and
 * the pipeline job worker (jobs.ts) call this. The CLI's own `runCycle`
 * invocation (apps/orchestrator/src/cli.ts, the operator/cron path) has no
 * accountId/billing concept and is not metered by this check — correct today
 * since the CLI isn't customer-facing, but if CLI/cron access is ever exposed
 * directly to paying customers, that path would need its own call into
 * checkRunQuota (or a shared enforcement point above both callers).
 */
export function checkRunQuota(plan: AccountPlan, usage: AccountUsage): QuotaCheck {
  if (plan.status !== "active" || !plan.tierId) return { allowed: true, overage: false };
  const tier = getTier(plan.tierId);
  if (!tier) return { allowed: true, overage: false };

  const used = runsUsedThisMonth(usage);
  if (used >= tier.monthlyRunLimit) {
    return {
      allowed: true,
      overage: true,
      overagePriceUsdPerRun: tier.overagePriceUsdPerRun,
      reason: `over the ${tier.name} plan's ${tier.monthlyRunLimit} included runs this month — this run will be billed at overage ($${tier.overagePriceUsdPerRun.toFixed(2)}/run)`
    };
  }
  return { allowed: true, overage: false };
}
