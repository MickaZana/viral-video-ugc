import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AccountUsage {
  accountId: string;
  totalUsd: number;
  totalRuns: number;
  totalReviewItemsCreated: number;
  totalsByVendor: Record<string, number>;
  runs: Array<{ runId: string; niche: string; createdAt: string; estimatedCostUsd: number }>;
}

interface CostLedgerJson {
  totalUsd: number;
  totalsByVendor: Record<string, number>;
}

/** The real on-disk shape conductor.ts writes to runs/<runId>/manifest.json — note this
 *  is NOT the flat RunResult shape runCycle() returns to its caller; accountId/niche/
 *  createdAt live under `config`, and cost data is a sibling cost-ledger.json file, read
 *  by directory name rather than a path stored inside the manifest. Mirrors
 *  apps/review-dashboard/src/runs.ts's listRuns(), which reads the same files the same way. */
interface RunManifestJson {
  config?: { accountId?: string; niche?: string; createdAt?: string };
  reviewItemsCreated?: number;
}

/**
 * Reads every run's manifest.json under `runsDir`, filters to the ones tagged with
 * `accountId` (set via RunConfig.accountId when the run was started — see
 * conductor.ts), and sums each matching run's sibling cost-ledger.json spend. Scans
 * the filesystem rather than maintaining a separate running total — `runs/` is
 * already the source of truth for what happened.
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

  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // runsDir also holds accounts.json/sessions.json/etc, not just run subdirectories
    const runId = entry.name;
    const manifestPath = join(runsDir, runId, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: RunManifestJson;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue; // malformed/partial manifest (e.g. a run that crashed mid-write) — skip, don't fail the whole aggregation
    }
    if (manifest.config?.accountId !== accountId) continue;

    let estimatedCostUsd = 0;
    const costLedgerPath = join(runsDir, runId, "cost-ledger.json");
    if (existsSync(costLedgerPath)) {
      try {
        const ledger: CostLedgerJson = JSON.parse(readFileSync(costLedgerPath, "utf-8"));
        estimatedCostUsd = ledger.totalUsd;
        usage.totalUsd += ledger.totalUsd;
        for (const [vendor, amount] of Object.entries(ledger.totalsByVendor)) {
          usage.totalsByVendor[vendor] = (usage.totalsByVendor[vendor] ?? 0) + amount;
        }
      } catch {
        // cost-ledger.json missing/malformed — this run just contributes 0 to totalUsd.
      }
    }

    usage.totalRuns += 1;
    usage.totalReviewItemsCreated += manifest.reviewItemsCreated ?? 0;
    usage.runs.push({
      runId,
      niche: manifest.config?.niche ?? "unknown",
      createdAt: manifest.config?.createdAt ?? "",
      estimatedCostUsd
    });
  }

  usage.runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  usage.totalUsd = Number(usage.totalUsd.toFixed(6));
  return usage;
}
