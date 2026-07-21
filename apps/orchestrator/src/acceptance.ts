import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunConfig, RunResult } from "@vvugc/shared-schema";
import { listReviewItems } from "@vvugc/review-queue";
import { loadEnv } from "@vvugc/shared-config";
import { runCycle, type RunCycleOptions } from "./conductor.js";

export interface AcceptanceEvidence {
  version: 1;
  mode: "dry-run" | "live";
  startedAt: string;
  completedAt: string;
  passed: boolean;
  config: Pick<RunConfig, "runId" | "orgId" | "clientId" | "platforms" | "videoVendor" | "voiceVendor">;
  result?: RunResult;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  error?: string;
}

export async function runAcceptance(
  config: RunConfig,
  opts: RunCycleOptions = {},
  evidencePath = join(loadEnv().VVUGC_RUNS_DIR, config.runId, "acceptance-evidence.json")
): Promise<AcceptanceEvidence> {
  const startedAt = new Date().toISOString();
  const checks: AcceptanceEvidence["checks"] = [];
  let result: RunResult | undefined;
  let error: string | undefined;
  try {
    result = await runCycle(config, opts);
    checks.push({ name: "pipeline-produced-review-items", passed: result.reviewItemsCreated > 0, detail: `${result.reviewItemsCreated} review item(s)` });
    checks.push({ name: "manifest-persisted", passed: existsSync(result.manifestPath), detail: result.manifestPath });
    checks.push({ name: "cost-ledger-persisted", passed: Boolean(result.costLedgerPath && existsSync(result.costLedgerPath)), detail: result.costLedgerPath ?? "missing" });
    const items = await listReviewItems({ orgId: config.orgId, clientId: config.clientId });
    const runItems = items.filter((item) => item.runId === config.runId);
    checks.push({
      name: "tenant-attribution",
      passed: runItems.length === result.reviewItemsCreated && runItems.every((item) => item.orgId === config.orgId && item.clientId === config.clientId),
      detail: `${runItems.length} attributed item(s)`
    });
    checks.push({
      name: "video-artifacts-nonempty",
      passed: runItems.length > 0 && runItems.every((item) => existsSync(item.videoPath) && statSync(item.videoPath).size > 0),
      detail: runItems.map((item) => item.videoPath).join(", ")
    });
  } catch (caught) {
    error = String(caught);
  }
  const evidence: AcceptanceEvidence = {
    version: 1,
    mode: config.dryRun ? "dry-run" : "live",
    startedAt,
    completedAt: new Date().toISOString(),
    passed: error === undefined && checks.length > 0 && checks.every((check) => check.passed),
    config: {
      runId: config.runId,
      orgId: config.orgId,
      clientId: config.clientId,
      platforms: config.platforms,
      videoVendor: config.videoVendor,
      voiceVendor: config.voiceVendor
    },
    result,
    checks,
    error
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return evidence;
}
