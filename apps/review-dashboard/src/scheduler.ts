import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadEnv } from "@vvugc/shared-config";
import { RunConfigSchema } from "@vvugc/shared-schema";
import type { PipelineJob } from "@vvugc/review-queue";
import { createPipelineJobStore } from "./jobs.js";
import { isLLMLive } from "./llm-gate.js";
import type { TenantProfileRepository } from "./tenant-profile-postgres.js";
import { LocalBillingRepository, type BillingRepository } from "./billing-postgres.js";

export interface SchedulerTickResult {
  claimed: number;
  enqueued: PipelineJob[];
  failed: Array<{ clientId: string; error: string }>;
}

/**
 * H-3 FIX: Accept an optional `orgId` parameter.
 * When called from `/scheduler/run-due` with a session-authenticated request,
 * only schedules belonging to that org are processed. When called without orgId
 * (internal timer or operator), all due schedules are processed.
 */
export async function runDueClientSchedules(profiles: TenantProfileRepository, orgId?: string, now = new Date(), billing: BillingRepository = new LocalBillingRepository(loadEnv().VVUGC_RUNS_DIR)): Promise<SchedulerTickResult> {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const jobStore = createPipelineJobStore(join(VVUGC_RUNS_DIR, "pipeline-jobs.json"));
  const due = await profiles.clientClaimDue(now, orgId);
  const enqueued: PipelineJob[] = [];
  const failed: Array<{ clientId: string; error: string }> = [];

  for (const client of due) {
    let reservedRunId: string | undefined;
    try {
      // Hybrid billing: past the tier's included runs, scheduled runs are still
      // enqueued and a consumption-overage charge is recorded at execution time
      // (processNextPipelineJob in jobs.ts) — no hard quota stop at enqueue.
      const idempotencyKey = `scheduled:${client.id}:${client.nextRunAt ?? now.toISOString()}`;
      const config = RunConfigSchema.parse({
        runId: `scheduled-${createHash("sha256").update(`${client.orgId}:${idempotencyKey}`).digest("hex").slice(0, 32)}`,
        orgId: client.orgId,
        accountId: client.orgId,
        clientId: client.id,
        niche: client.niche,
        brandVoice: client.brandVoice,
        brandKit: client.brandKit,
        locale: client.locale,
        platforms: client.platforms,
        targetDurationSec: client.targetDurationSec,
        videoVendor: client.videoVendor,
        voiceVendor: client.voiceVendor,
        // Scheduled runs are safe by default. Production can explicitly opt into
        // paid execution after live-vendor acceptance has passed — which also
        // requires VVUGC_LLM_LIVE=true (two-key lock, see ./llm-gate.ts).
        dryRun: process.env.SCHEDULED_RUNS_LIVE !== "true" || !isLLMLive(),
        createdAt: now.toISOString()
      });
      reservedRunId = config.runId;
      await billing.reserveRun({ orgId: client.orgId, runId: config.runId, clientId: client.id, durationSec: config.targetDurationSec });
      enqueued.push(await jobStore.enqueue(
        client.orgId,
        client.id,
        config,
        idempotencyKey
      ));
    } catch (error) {
      if (reservedRunId) await billing.releaseReservation({ orgId: client.orgId, runId: reservedRunId });
      failed.push({ clientId: client.id, error: String(error) });
    }
  }
  return { claimed: due.length, enqueued, failed };
}

export function startClientScheduler(profiles: TenantProfileRepository, intervalMs = 60_000, billing: BillingRepository = new LocalBillingRepository(loadEnv().VVUGC_RUNS_DIR)): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runDueClientSchedules(profiles, undefined, new Date(), billing).catch((error) => console.error("client scheduler tick failed", error));
  }, intervalMs);
  timer.unref();
  return timer;
}
