import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPipelineJobStore } from "./jobs.js";
import type { RunConfig } from "@vvugc/shared-schema";

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
