import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipelineJobStore, processNextPipelineJob } from "./jobs.js";
import type { RunConfig } from "@vvugc/shared-schema";
import type { BillingRepository } from "./billing-postgres.js";

const dirs: string[] = [];
const config = {
  runId: "run-1",
  orgId: "org-1",
  accountId: "org-1",
  clientId: "client-1",
  niche: "fitness",
  platforms: ["youtube_shorts"],
  brandVoice: "direct",
  targetDurationSec: 25,
  videoVendor: "replicate",
  dryRun: true
} as RunConfig;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vvugc-jobs-"));
  dirs.push(dir);
  const path = join(dir, "jobs.json");
  return { path, store: createPipelineJobStore(path, { forceJson: true }) };
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("pipeline job recovery", () => {
  it("injects and closes Higgsfield MCP for an explicitly configured live fallback", async () => {
    const { store } = fixture();
    const liveConfig = { ...config, videoVendor: "wan", videoVendorFallbacks: ["replicate", "higgsfield"], dryRun: false } as RunConfig;
    await store.enqueue("org-1", "client-1", liveConfig, "higgsfield-fallback");
    const callMcpTool = vi.fn(async () => ({ ok: true }));
    const close = vi.fn(async () => undefined);
    const billing = {
      reserveRun: vi.fn(async () => ({ kind: "included" })),
      settleReservation: vi.fn(async () => undefined)
    } as unknown as BillingRepository;
    const runCycle = vi.fn(async (received: RunConfig, options?: { callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      expect(received.videoVendor).toBe("wan");
      expect(received.videoVendorFallbacks).toEqual(["replicate", "higgsfield"]);
      expect(options?.callMcpTool).toBeDefined();
      await options!.callMcpTool!("generate_video", { prompt: "fallback test" });
      return { runId: received.runId, niche: received.niche, candidatesFound: 0, reviewItemsCreated: 0, estimatedCostUsd: 0 } as Awaited<ReturnType<typeof import("@vvugc/orchestrator").runCycle>>;
    });

    const result = await processNextPipelineJob(store, "test-worker", 60_000, billing, {
      connectHiggsfield: async () => ({ callMcpTool, close }),
      runCycle
    });

    expect(callMcpTool).toHaveBeenCalledWith("generate_video", { prompt: "fallback test" });
    expect(close).toHaveBeenCalledOnce();
    expect(result?.status).toBe("completed");
  });

  it("replays only dead-letter jobs and resets their retry state", async () => {
    const { path, store } = fixture();
    const job = await store.enqueue("org-1", "client-1", config, "key-1");
    for (let attempt = 0; attempt < 3; attempt++) {
      await store.claim("worker");
      await store.fail(job.id, "worker", `failure-${attempt}`);
      if (attempt < 2) {
        const jobs = JSON.parse(readFileSync(path, "utf8"));
        jobs[0].availableAt = new Date(0).toISOString();
        writeFileSync(path, JSON.stringify(jobs));
      }
    }
    expect((await store.get("org-1", job.id))?.status).toBe("dead_letter");
    expect(await store.replay("other-org", job.id)).toBeUndefined();
    expect(await store.replay("org-1", job.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("recovers stale running jobs after a worker restart", async () => {
    const { path, store } = fixture();
    const job = await store.enqueue("org-1", "client-1", config, "key-2");
    await store.claim("worker", 1);
    const jobs = JSON.parse(readFileSync(path, "utf8"));
    jobs[0].leaseExpiresAt = new Date(0).toISOString();
    writeFileSync(path, JSON.stringify(jobs));
    expect(await store.recoverExpiredLeases()).toBe(1);
    expect(await store.get("org-1", job.id)).toMatchObject({ status: "queued", lastError: "Worker lease expired before the job completed" });
  });
});
