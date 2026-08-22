import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";

export interface RunFailure {
  candidateId: string;
  platform?: string;
  reason: string;
}

export interface RunSummary {
  runId: string;
  niche: string;
  platforms: string[];
  candidatesFound: number;
  reviewItemsCreated: number;
  createdAt?: string;
  estimatedCostUsd?: number;
  candidatesFailed?: number;
  platformsFailed?: number;
  /** Why each failed candidate/platform failed — previously only in structured
   *  logs/CLI output, never reachable from the dashboard. See conductor.ts. */
  failures?: RunFailure[];
  /** The operator's riffed discovery brief, when the run was kicked off from the
   *  Spy panel's "Start a run from this brief". Surfaced so the Studio run page can
   *  show "your brief" even after a hard refresh (it lives on the run manifest). */
  discoveryBrief?: unknown;
}

/**
 * Each run writes runs/<runId>/manifest.json (and, since the cost-ledger addition,
 * runs/<runId>/cost-ledger.json) — this was previously only viewable by opening those
 * files by hand. Reads them back into a list the dashboard can render as run history.
 */
/**
 * Lists run summaries. When orgId is provided, only runs belonging to that
 * organization are returned (tenant isolation). When omitted (operator context),
 * all runs are returned.
 */
export function listRuns(orgId?: string): RunSummary[] {
  const { VVUGC_RUNS_DIR } = loadEnv();
  if (!existsSync(VVUGC_RUNS_DIR)) return [];

  const entries = readdirSync(VVUGC_RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  const runs: RunSummary[] = [];

  for (const entry of entries) {
    const manifestPath = join(VVUGC_RUNS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue; // malformed manifest — skip
    }

    // Tenant isolation: skip runs that don't belong to the requesting org
    const config = manifest.config as Record<string, unknown> | undefined;
    if (orgId && config?.accountId !== orgId) continue;

    const costLedgerPath = join(VVUGC_RUNS_DIR, entry.name, "cost-ledger.json");
    let estimatedCostUsd: number | undefined;
    try {
      estimatedCostUsd = existsSync(costLedgerPath)
        ? JSON.parse(readFileSync(costLedgerPath, "utf-8")).totalUsd
        : undefined;
    } catch {
      estimatedCostUsd = undefined;
    }

    runs.push({
      runId: entry.name,
      niche: (config?.niche as string) ?? "unknown",
      platforms: (config?.platforms as string[]) ?? [],
      candidatesFound: (manifest.candidatesFound as number) ?? 0,
      reviewItemsCreated: (manifest.reviewItemsCreated as number) ?? 0,
      createdAt: config?.createdAt as string | undefined,
      estimatedCostUsd,
      candidatesFailed: manifest.candidatesFailed as number | undefined,
      platformsFailed: manifest.platformsFailed as number | undefined,
      failures: manifest.failures as RunFailure[] | undefined,
      discoveryBrief: config?.discoveryBrief ?? null
    });
  }

  return runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Hard-deletes every run directory whose manifest is tagged with the org (org
 * owner's account deletion). Run directories hold the actual produced videos,
 * manifests, cost ledgers and acceptance evidence — a "delete my account"
 * request that left those behind would be a leak of the customer's finished
 * content, so this physically removes them. Returns how many run dirs were
 * removed. Best-effort: an unreadable manifest is skipped, never fatal.
 */
export function purgeOrgRuns(orgId: string): number {
  const { VVUGC_RUNS_DIR } = loadEnv();
  if (!existsSync(VVUGC_RUNS_DIR)) return 0;
  let removed = 0;
  for (const entry of readdirSync(VVUGC_RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(VVUGC_RUNS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { config?: { accountId?: string } };
      if (manifest.config?.accountId === orgId) {
        rmSync(join(VVUGC_RUNS_DIR, entry.name), { recursive: true, force: true });
        removed++;
      }
    } catch {
      // malformed manifest — skip this run dir rather than aborting the purge
    }
  }
  return removed;
}
