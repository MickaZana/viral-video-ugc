/**
 * Job leasing & crash recovery — contract tests.
 *
 * These run against the JSON fallback store today (Postgres is deferred).
 * The `defineJobLeasingContract()` function below takes a harness instead of
 * hardcoding `createPipelineJobStore(path, { forceJson: true })`, so when the
 * Postgres store is wired in, the SAME test bodies can be pointed at it by
 * adding one more `defineJobLeasingContract(postgresHarness())` call at the
 * bottom of this file — no test logic duplicated or rewritten.
 *
 * Two things are deliberately NOT part of the portable contract, because
 * they exercise JSON-store-only internals (the custom file lock) that have
 * no Postgres equivalent — Postgres gets its concurrency safety from
 * `FOR UPDATE SKIP LOCKED` instead, already covered by
 * `packages/review-queue/src/pipeline-jobs.postgres.test.ts`:
 *   - "recovers from a stale lock file left by a crashed writer"
 *   - "ignores a leftover .tmp file from an interrupted write"
 * Those live in their own JSON-only describe block at the bottom.
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPipelineJobStore } from "./jobs.js";
import type { PipelineJobStore } from "@vvugc/review-queue";
import type { RunConfig, RunResult } from "@vvugc/shared-schema";

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

const fakeResult = { candidatesFound: 1, reviewItemsCreated: 1 } as unknown as RunResult;

/**
 * What a test needs from a store implementation to run the shared contract.
 * `forceAvailableNow` exists because `fail()` applies jittered exponential
 * backoff to `availableAt` (see jobs.ts — full-jitter, up to
 * min(300, 2^attempts) seconds). That's correct production behavior, but it
 * means a test can't just call `claim()` again immediately after a failure
 * and expect to see the job — the backoff itself would make the test flaky.
 * Each harness provides its own way to reset `availableAt` to "now" so
 * retry-loop tests stay deterministic. (Postgres equivalent: a plain
 * `UPDATE pipeline_jobs SET available_at = now()`.)
 */
interface JobStoreHarness {
  name: string;
  makeStore(): PipelineJobStore;
  forceAvailableNow(jobId: string): Promise<void> | void;
}

function jsonHarness(dirs: string[]): JobStoreHarness {
  const dir = mkdtempSync(join(tmpdir(), "vvugc-job-leasing-"));
  dirs.push(dir);
  const path = join(dir, "jobs.json");
  return {
    name: "JSON store",
    makeStore: () => createPipelineJobStore(path, { forceJson: true }),
    forceAvailableNow(jobId) {
      const jobs = JSON.parse(readFileSync(path, "utf8"));
      const job = jobs.find((j: { id: string }) => j.id === jobId);
      if (job) job.availableAt = new Date(0).toISOString();
      writeFileSync(path, JSON.stringify(jobs));
    }
  };
}

function defineJobLeasingContract(harnessFactory: (dirs: string[]) => JobStoreHarness) {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  let harness: JobStoreHarness;
  let store: PipelineJobStore;

  function fresh() {
    harness = harnessFactory(dirs);
    store = harness.makeStore();
    return store;
  }

  describe(`job leasing & crash recovery (${harnessFactory(dirs).name})`, () => {
    it("gives a job to exactly one of several workers claiming concurrently", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "race-key");
      // Promise.all, not sequential awaits — sequential claims only prove
      // "the queue is empty on the second call," not that two workers racing
      // for the same row can't both win it.
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.claim(`worker-${i}`))
      );
      const winners = claims.filter((c) => c?.id === job.id);
      expect(winners).toHaveLength(1);
    });

    it("recovers a dead worker's job so a second worker can complete it", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "recover-key");
      // Negative leaseMs = already expired the instant it's claimed, no
      // real wait needed to simulate "time passed while the worker died."
      const claimedByA = await store.claim("worker-A", -1000);
      expect(claimedByA?.id).toBe(job.id);

      expect(await store.recoverExpiredLeases()).toBe(1);
      expect(await store.get("org-1", job.id)).toMatchObject({ status: "queued" });

      const claimedByB = await store.claim("worker-B");
      expect(claimedByB?.id).toBe(job.id);
      expect(await store.complete(job.id, "worker-B", fakeResult)).toBe(true);
      expect(await store.get("org-1", job.id)).toMatchObject({ status: "completed", result: fakeResult });
    });

    it("blocks the zombie (recovered-from) worker from completing after another worker took over", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "zombie-key");
      await store.claim("worker-A", -1000);
      await store.recoverExpiredLeases();
      await store.claim("worker-B");

      // worker-A "wakes up" late and tries to finish work it no longer owns.
      expect(await store.complete(job.id, "worker-A", fakeResult)).toBe(false);
      expect(await store.fail(job.id, "worker-A", "too late")).toBeUndefined();

      expect(await store.complete(job.id, "worker-B", fakeResult)).toBe(true);
      expect(await store.get("org-1", job.id)).toMatchObject({ status: "completed" });
    });

    it("sends an already-exhausted job straight to dead_letter on lease recovery, not back to queued", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "exhausted-key", 1);
      // attempts becomes 1 on claim; maxAttempts is 1 — this was the job's
      // one and only shot, and it died mid-flight.
      await store.claim("worker-A", -1000);
      expect(await store.recoverExpiredLeases()).toBe(1);
      expect(await store.get("org-1", job.id)).toMatchObject({ status: "dead_letter" });
      // A dead-letter job must not be claimable again.
      expect(await store.claim("worker-B")).toBeUndefined();
    });

    it("extends a lease via heartbeat, and rejects heartbeats from a non-owning worker", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "heartbeat-key");
      const claimed = await store.claim("worker-A", 60_000);
      const firstExpiry = claimed!.leaseExpiresAt!;

      expect(await store.heartbeat(job.id, "worker-B", 60_000)).toBe(false); // wrong owner
      expect((await store.get("org-1", job.id))?.leaseExpiresAt).toBe(firstExpiry);

      expect(await store.heartbeat(job.id, "worker-A", 120_000)).toBe(true);
      const afterHeartbeat = await store.get("org-1", job.id);
      expect(Date.parse(afterHeartbeat!.leaseExpiresAt!)).toBeGreaterThan(Date.parse(firstExpiry));
      expect(afterHeartbeat?.status).toBe("running"); // active workers aren't preempted
    });

    it("rejects every mutation on a job that already left the running state", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "terminal-key");
      await store.claim("worker-A");
      expect(await store.complete(job.id, "worker-A", fakeResult)).toBe(true);

      // Once completed, none of these should be able to touch it again —
      // double-complete, fail-after-complete, and heartbeat-after-complete
      // are all the same class of bug (a late/duplicate signal from a
      // worker corrupting a job someone else has already resolved).
      expect(await store.complete(job.id, "worker-A", { candidatesFound: 99, reviewItemsCreated: 99 } as unknown as RunResult)).toBe(false);
      expect(await store.fail(job.id, "worker-A", "late failure")).toBeUndefined();
      expect(await store.heartbeat(job.id, "worker-A")).toBe(false);
      expect(await store.acknowledgeCancelled(job.id, "worker-A")).toBe(false);

      expect(await store.get("org-1", job.id)).toMatchObject({ status: "completed", result: fakeResult });
    });

    it("applies backoff on retryable failure, then dead-letters on the attempt that exhausts maxAttempts", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "retry-key", 2);

      await store.claim("worker-A");
      const beforeFail = Date.now();
      const afterFirstFail = await store.fail(job.id, "worker-A", "vendor-timeout", true);
      expect(afterFirstFail?.status).toBe("queued");
      // Proves jittered backoff was actually applied, not just the status
      // transition — a bug that left availableAt in the past would still
      // pass a test that only checks `status`.
      expect(Date.parse(afterFirstFail!.availableAt)).toBeGreaterThanOrEqual(beforeFail);

      await harness.forceAvailableNow(job.id); // bypass backoff to reclaim deterministically
      await store.claim("worker-A");
      const afterSecondFail = await store.fail(job.id, "worker-A", "vendor-timeout", true);
      expect(afterSecondFail?.status).toBe("dead_letter");
      expect(await store.claim("worker-B")).toBeUndefined(); // dead-letter isn't claimable
    });

    it("dead-letters immediately on a non-retryable failure, ignoring remaining attempts", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "fatal-key", 3);
      await store.claim("worker-A");
      const result = await store.fail(job.id, "worker-A", "auth-revoked", false);
      expect(result).toMatchObject({ status: "dead_letter", attempts: 1 });
    });

    it("cancels a running job without killing the worker, then lets the worker acknowledge it", async () => {
      store = fresh();
      const job = await store.enqueue("org-1", "client-1", config, "cancel-key");
      await store.claim("worker-A");
      expect(await store.cancel("org-1", job.id)).toBe(true);
      expect(await store.get("org-1", job.id)).toMatchObject({ status: "running", cancelRequested: true });

      // A cancel-in-flight must not let the worker complete normally.
      expect(await store.complete(job.id, "worker-A", fakeResult)).toBe(false);
      expect(await store.acknowledgeCancelled(job.id, "worker-A")).toBe(true);
      expect(await store.get("org-1", job.id)).toMatchObject({ status: "cancelled" });
    });

    it("dedupes concurrent enqueue calls with the same idempotency key into one job", async () => {
      store = fresh();
      const [a, b, c] = await Promise.all([
        store.enqueue("org-1", "client-1", config, "dupe-key"),
        store.enqueue("org-1", "client-1", config, "dupe-key"),
        store.enqueue("org-1", "client-1", config, "dupe-key")
      ]);
      expect(a.id).toBe(b.id);
      expect(b.id).toBe(c.id);
      expect((await store.list("org-1")).filter((j) => j.idempotencyKey === "dupe-key")).toHaveLength(1);
    });

    it("keeps every job operation scoped to its own tenant", async () => {
      store = fresh();
      const jobA = await store.enqueue("org-A", "client-1", config, "tenant-key");
      const jobB = await store.enqueue("org-B", "client-1", config, "tenant-key");

      expect((await store.list("org-A")).map((j) => j.id)).toEqual([jobA.id]);
      expect(await store.get("org-A", jobB.id)).toBeUndefined();
      expect(await store.cancel("org-A", jobB.id)).toBe(false);
      expect(await store.replay("org-A", jobB.id)).toBeUndefined();

      expect(await store.deleteOrg("org-A")).toBe(1);
      expect(await store.list("org-A")).toEqual([]);
      expect(await store.list("org-B")).toHaveLength(1); // org-B untouched
    });
  });
}

defineJobLeasingContract(jsonHarness);

// ─── JSON-store-only: the custom file lock itself is a crash-recovery
// primitive with no Postgres equivalent, so these stay outside the portable
// contract above. ───────────────────────────────────────────────────────
describe("job leasing & crash recovery (JSON store internals)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("recovers automatically from a stale lock file left by a crashed writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vvugc-job-leasing-lock-"));
    dirs.push(dir);
    const path = join(dir, "jobs.json");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "");
    // Backdate the lock file's mtime past STALE_LOCK_MS (60s) instead of
    // actually waiting 60s — lock() checks file age, so this is
    // deterministic and instant rather than a slow, flaky real-time test.
    const old = new Date(Date.now() - 61_000);
    utimesSync(lockPath, old, old);

    const store = createPipelineJobStore(path, { forceJson: true });
    const job = await store.enqueue("org-1", "client-1", config, "stale-lock-key");
    expect(job.status).toBe("queued");
  });

  it("ignores a leftover .tmp file from an interrupted write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vvugc-job-leasing-tmp-"));
    dirs.push(dir);
    const path = join(dir, "jobs.json");
    // Simulate a process killed between writeFileSync(tmp) and renameSync —
    // a stray, possibly-garbage tmp file sitting next to the real store.
    writeFileSync(`${path}.orphaned-abc123.tmp`, "{not valid json");

    const store = createPipelineJobStore(path, { forceJson: true });
    const job = await store.enqueue("org-1", "client-1", config, "tmp-key");
    expect(job.status).toBe("queued");
    expect(await store.list("org-1")).toHaveLength(1);
  });
});
