import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createAgencyClientStore } from "@vvugc/shared-auth";
import { loadEnv } from "@vvugc/shared-config";
import { RunConfigSchema } from "@vvugc/shared-schema";
import type { PipelineJob } from "@vvugc/review-queue";
import { createPipelineJobStore } from "./jobs.js";

export interface SchedulerTickResult {
  claimed: number;
  enqueued: PipelineJob[];
  failed: Array<{ clientId: string; error: string }>;
}

export async function runDueClientSchedules(now = new Date()): Promise<SchedulerTickResult> {
  const { VVUGC_RUNS_DIR } = loadEnv();
  const store = createAgencyClientStore(join(VVUGC_RUNS_DIR, "agency-clients.json"));
  const jobStore = createPipelineJobStore(join(VVUGC_RUNS_DIR, "pipeline-jobs.json"));
  const due = store.claimDue(now);
  const enqueued: PipelineJob[] = [];
  const failed: Array<{ clientId: string; error: string }> = [];

  for (const client of due) {
    try {
      // Hybrid billing: past the tier's included runs, scheduled runs are still
      // enqueued and a consumption-overage charge is recorded at execution time
      // (processNextPipelineJob in jobs.ts) — no hard quota stop at enqueue.
      const config = RunConfigSchema.parse({
        runId: randomUUID(),
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
        // paid execution after live-vendor acceptance has passed.
        dryRun: process.env.SCHEDULED_RUNS_LIVE !== "true",
        createdAt: now.toISOString()
      });
      enqueued.push(await jobStore.enqueue(
        client.orgId,
        client.id,
        config,
        `scheduled:${client.id}:${client.nextRunAt ?? now.toISOString()}`
      ));
    } catch (error) {
      failed.push({ clientId: client.id, error: String(error) });
    }
  }
  return { claimed: due.length, enqueued, failed };
}

export function startClientScheduler(intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runDueClientSchedules().catch((error) => console.error("client scheduler tick failed", error));
  }, intervalMs);
  timer.unref();
  return timer;
}
