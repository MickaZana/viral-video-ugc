import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";

export interface RunSummary {
  runId: string;
  niche: string;
  platforms: string[];
  candidatesFound: number;
  reviewItemsCreated: number;
  createdAt?: string;
  estimatedCostUsd?: number;
}

/**
 * Each run writes runs/<runId>/manifest.json (and, since the cost-ledger addition,
 * runs/<runId>/cost-ledger.json) — this was previously only viewable by opening those
 * files by hand. Reads them back into a list the dashboard can render as run history.
 */
export function listRuns(): RunSummary[] {
  const { VVUGC_RUNS_DIR } = loadEnv();
  if (!existsSync(VVUGC_RUNS_DIR)) return [];

  const entries = readdirSync(VVUGC_RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  const runs: RunSummary[] = [];

  for (const entry of entries) {
    const manifestPath = join(VVUGC_RUNS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const costLedgerPath = join(VVUGC_RUNS_DIR, entry.name, "cost-ledger.json");
    const estimatedCostUsd = existsSync(costLedgerPath)
      ? JSON.parse(readFileSync(costLedgerPath, "utf-8")).totalUsd
      : undefined;

    runs.push({
      runId: entry.name,
      niche: manifest.config?.niche ?? "unknown",
      platforms: manifest.config?.platforms ?? [],
      candidatesFound: manifest.candidatesFound ?? 0,
      reviewItemsCreated: manifest.reviewItemsCreated ?? 0,
      createdAt: manifest.config?.createdAt,
      estimatedCostUsd
    });
  }

  return runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}
