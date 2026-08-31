import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresProviderJobStore,
  type ProviderJobEnqueueInput,
  type ProviderJobStore
} from "./provider-jobs.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const schema = `vvugc_provider_${randomUUID().replaceAll("-", "")}`;
const ssl = TEST_DATABASE_URL?.includes("supabase.") ? { rejectUnauthorized: false } : undefined;
const admin = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL, ssl }) : undefined;
const pool = TEST_DATABASE_URL ? new Pool({ connectionString: TEST_DATABASE_URL, ssl, options: `-c search_path=${schema}` }) : undefined;

function input(overrides: Partial<ProviderJobEnqueueInput> = {}): ProviderJobEnqueueInput {
  return {
    orgId: "org-a", clientId: "client-a", runId: "run-a", candidateId: randomUUID(), platform: "tiktok",
    scriptSegmentIndex: 0, requestedVendor: "replicate", fallbackVendors: [], idempotencyKey: randomUUID(),
    request: { prompt: "safe dry run", durationSec: 5, aspectRatio: "9:16" }, ...overrides
  };
}

describe.skipIf(!TEST_DATABASE_URL)("Postgres provider jobs", () => {
  let store: ProviderJobStore;

  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA ${schema}`);
    store = createPostgresProviderJobStore(pool!);
    // Run migrations through the store, then seed FK parents in this isolated schema.
    await store.countByStatus();
    await pool!.query("INSERT INTO organizations (id, name) VALUES ('org-a', 'A'), ('org-b', 'B')");
    await pool!.query("INSERT INTO agency_clients (id, org_id, payload) VALUES ('client-a', 'org-a', '{}'), ('client-b', 'org-b', '{}')");
  });

  beforeEach(async () => {
    await pool!.query("DELETE FROM provider_jobs");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("is idempotent per tenant and permits the same key in another tenant", async () => {
    const key = "same-key";
    const [first, duplicate, otherTenant] = await Promise.all([
      store.enqueue(input({ idempotencyKey: key })),
      store.enqueue(input({ idempotencyKey: key })),
      store.enqueue(input({ orgId: "org-b", clientId: "client-b", idempotencyKey: key }))
    ]);
    expect(duplicate.id).toBe(first.id);
    expect(otherTenant.id).not.toBe(first.id);
    expect((await store.getByIdempotencyKey("org-b", key))?.orgId).toBe("org-b");
  });

  it("atomically assigns one queued job to only one of many workers", async () => {
    const job = await store.enqueue(input());
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => store.claim(`worker-${i}`, 30_000)));
    expect(claims.filter((claim) => claim?.id === job.id)).toHaveLength(1);
    const winner = claims.find((claim) => claim?.id === job.id)!;
    expect(await store.heartbeat(job.id, "intruder")).toBe(false);
    expect(await store.heartbeat(job.id, winner.leaseOwner!)).toBe(true);
  });

  it("reclaims expired work, retries, dead-letters and cancels safely", async () => {
    const expired = await store.enqueue(input({ maxAttempts: 2 }));
    expect((await store.claim("crashed-worker", -1))?.id).toBe(expired.id);
    expect(await store.recoverExpiredLeases()).toBeGreaterThanOrEqual(1);
    expect((await store.get(expired.id))?.status).toBe("queued");
    const reclaimed = await store.claim("reclaimer", 30_000);
    expect(reclaimed?.id).toBe(expired.id);
    expect((await store.fail(expired.id, "reclaimer", "vendor unavailable", true))?.status).toBe("dead_letter");
    expect((await store.replay(expired.id))?.status).toBe("queued");
    // claim() is FIFO (ORDER BY available_at, created_at) so a real worker
    // never starves an older job — replayed `expired` is still the oldest
    // queued row at this point and would otherwise be claimed ahead of the
    // fresh jobs the rest of this test enqueues below. Retire it explicitly
    // so the scenarios that follow are actually testing what they claim to.
    expect(await store.cancel(expired.id)).toBe(true);

    const queued = await store.enqueue(input());
    expect(await store.cancel(queued.id)).toBe(true);
    expect((await store.get(queued.id))?.status).toBe("cancelled");
    const running = await store.enqueue(input());
    const claimed = await store.claim("cancel-owner", 30_000);
    expect(claimed?.id).toBe(running.id);
    expect(await store.cancel(running.id)).toBe(true);
    expect(await store.complete(running.id, "cancel-owner", {} as never, "replicate", 0)).toBe(false);
    expect(await store.acknowledgeCancelled(running.id, "cancel-owner")).toBe(true);
  });

  it("does not expose tenant B jobs through tenant A run/idempotency queries", async () => {
    const foreign = await store.enqueue(input({ orgId: "org-b", clientId: "client-b", runId: "run-b", idempotencyKey: "tenant-b-only" }));
    expect(await store.getByIdempotencyKey("org-a", "tenant-b-only")).toBeUndefined();
    expect(await store.listByRun("org-a", "run-b")).not.toContainEqual(expect.objectContaining({ id: foreign.id }));
    expect(await store.deadLetterList("org-a")).not.toContainEqual(expect.objectContaining({ id: foreign.id }));
  });
});
