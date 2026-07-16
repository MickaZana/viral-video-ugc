import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "@vvugc/shared-schema";

export interface AccountUsage {
  accountId: string;
  totalUsd: number;
  totalRuns: number;
  totalReviewItemsCreated: number;
  totalsByVendor: Record<string, number>;
  runs: Array<{ runId: string; niche: string; completedAt: string; estimatedCostUsd: number }>;
}

interface CostLedgerJson {
  totalUsd: number;
  totalsByVendor: Record<string, number>;
}

/**
 * Reads every run's manifest.json (a serialized RunResult — see conductor.ts)
 * under `runsDir`, filters to the ones tagged with `accountId` (set via
 * RunConfig.accountId when the run was started — see conductor.ts), and sums
 * their cost-ledger.json spend. This scans the filesystem rather than
 * maintaining a separate running total, matching review-dashboard's runs.ts
 * (which does the same for run history) — `runs/` is already the source of
 * truth for what happened, not something to duplicate into another store.
 */
export function aggregateUsage(accountId: string, runsDir: string): AccountUsage {
  const usage: AccountUsage = {
    accountId,
    totalUsd: 0,
    totalRuns: 0,
    totalReviewItemsCreated: 0,
    totalsByVendor: {},
    runs: []
  };

  if (!existsSync(runsDir)) return usage;

  for (const runId of readdirSync(runsDir)) {
    const manifestPath = join(runsDir, runId, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let result: RunResult;
    try {
      result = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue; // malformed/partial manifest (e.g. a run that crashed mid-write) — skip, don't fail the whole aggregation
    }
    if (result.accountId !== accountId) continue;

    usage.totalRuns += 1;
    usage.totalReviewItemsCreated += result.reviewItemsCreated;
    usage.runs.push({
      runId: result.runId,
      niche: result.niche,
      completedAt: result.completedAt,
      estimatedCostUsd: result.estimatedCostUsd ?? 0
    });

    if (result.costLedgerPath && existsSync(result.costLedgerPath)) {
      try {
        const ledger: CostLedgerJson = JSON.parse(readFileSync(result.costLedgerPath, "utf-8"));
        usage.totalUsd += ledger.totalUsd;
        for (const [vendor, amount] of Object.entries(ledger.totalsByVendor)) {
          usage.totalsByVendor[vendor] = (usage.totalsByVendor[vendor] ?? 0) + amount;
        }
      } catch {
        // cost-ledger.json missing/malformed — the run's own estimatedCostUsd (added above) still counts.
      }
    }
  }

  usage.runs.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  usage.totalUsd = Number(usage.totalUsd.toFixed(6));
  return usage;
}
