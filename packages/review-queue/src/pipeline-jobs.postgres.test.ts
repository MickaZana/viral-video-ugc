import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunConfig, RunResult } from "@vvugc/shared-schema";
import { createPostgresPipelineJobStore, type PipelineJobStore } from "./pipeline-jobs.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `vvugc_jobs_${randomUUID().replaceAll("-", "")}`;
const ssl = TEST_DATABASE_URL?.includes("supabase.") ? { rejectUnauthorized: false } : undefined;
const admin = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL, ssl }) : undefined;
const pool = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL, ssl, options: `-c search_path=${schema}` }) : undefined;

const config = {
  runId: "run-1", orgId: "org-1", accountId: "org-1", clientId: "client-1",
  niche: "fitness", platforms: ["youtube_shorts"], brandVoice: "direct",
  targetDurationSec: 25, videoVendor: "replicate", dryRun: true
} as RunConfig;
const result = { runId: "run-1", items: [], manifestPath: "/tmp/manifest.json" } as unknown as RunResult;

describe.skipIf(!TEST_DATABASE_URL)("Postgres pipeline jobs", () => {
  let store: PipelineJobStore;

  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA ${schema}`);
    store = createPostgresPipelineJobStore(pool!);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("deduplicates enqueue by tenant and idempotency key", async () => {
    const [first, second] = await Promise.all([
      store.enqueue("org-idem", "client-1", config, "same-key"),
      store.enqueue("org-idem", "client-1", config, "same-key")
    ]);
    expect(second.id).toBe(first.id);
  });

  it("atomically gives a queued job to only one competing worker", async () => {
    const job = await store.enqueue("org-claim", "client-1", config, "claim-key");
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claim(`worker-${i}`, 30_000)));
    expect(claims.filter((claim) => claim?.id === job.id)).toHaveLength(1);
  });

  it("requires the lease owner to heartbeat and complete", async () => {
    const job = await store.enqueue("org-owner", "client-1", config, "owner-key");
    const claimed = await store.claim("owner", 30_000);
    expect(claimed?.id).toBe(job.id);
    expect(await store.heartbeat(job.id, "intruder")).toBe(false);
    expect(await store.complete(job.id, "intruder", result)).toBe(false);
    expect(await store.complete(job.id, "owner", result)).toBe(true);
    expect((await store.get("org-owner", job.id))?.status).toBe("completed");
  });

  it("recovers an expired lease and dead-letters after the final attempt", async () => {
    const job = await store.enqueue("org-recover", "client-1", config, "recover-key", 1);
    await store.claim("crashed-worker", -1);
    expect(await store.recoverExpiredLeases()).toBeGreaterThanOrEqual(1);
    expect(await store.get("org-recover", job.id)).toMatchObject({
      status: "dead_letter",
      lastError: "Worker lease expired before the job completed"
    });
  });

  it("supports tenant-scoped cancellation and dead-letter replay", async () => {
    const cancellable = await store.enqueue("org-actions", "client-1", config, "cancel-key");
    expect(await store.cancel("other-org", cancellable.id)).toBe(false);
    expect(await store.cancel("org-actions", cancellable.id)).toBe(true);
    expect((await store.get("org-actions", cancellable.id))?.status).toBe("cancelled");

    const replayable = await store.enqueue("org-actions", "client-1", config, "replay-key", 1);
    await store.claim("worker", 30_000);
    await store.fail(replayable.id, "worker", "vendor unavailable");
    expect((await store.get("org-actions", replayable.id))?.status).toBe("dead_letter");
    expect(await store.replay("other-org", replayable.id)).toBeUndefined();
    expect(await store.replay("org-actions", replayable.id)).toMatchObject({ status: "queued", attempts: 0 });
  });
});
