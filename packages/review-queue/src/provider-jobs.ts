/**
 * Provider-level Job Contract — Atom A
 *
 * Per-clip video generation jobs with fallback chain tracking.
 * Integrates with the existing PipelineJobStore lease model at run-level.
 * This layer tracks individual provider calls (one per script segment per vendor attempt).
 *
 * H-2 FIX: Added file-based locking (acquireLock/releaseLock) to all mutating operations
 * in `createFileProviderJobStore` to prevent race conditions when the dashboard and worker
 * processes read-modify-write the same JSON file concurrently.
 */

import { randomUUID } from "node:crypto";
import type { Pool as PgPool } from "pg";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RawClip, SegmentType } from "@vvugc/shared-schema";
import { loadEnv } from "@vvugc/shared-config";
import { runMigrations } from "./migrations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "dead_letter"
  | "cancelled";

export interface ProviderJob {
  id: string;
  orgId: string;
  clientId: string;
  runId: string;
  candidateId: string;
  platform: string;
  scriptSegmentIndex: number;
  requestedVendor: RawClip["vendor"];
  fallbackVendors: RawClip["vendor"][];
  attempt: number;
  maxAttempts: number;
  status: ProviderJobStatus;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  cancelRequested: boolean;
  idempotencyKey: string;
  estimatedCost?: number;
  actualCost?: number;
  actualVendor?: RawClip["vendor"];
  providerRequestId?: string;
  lastError?: string;
  fallbackReason?: string;
  createdAt: string;
  updatedAt: string;
  /** Full generation request payload (prompt, aspect ratio, duration, etc.) */
  request: ProviderJobRequest;
  /** Result clip on success */
  result?: RawClip;
  /** Smart routing: which vendor was selected and why. */
  routingDecision?: { routedVendor: string; routingReason: string; segmentType?: string; resolvedChain: string[] };
}

export interface ProviderJobRequest {
  prompt: string;
  durationSec: number;
  aspectRatio: "9:16" | "1:1" | "16:9";
  referenceImageUrl?: string;
  referenceImageDataUri?: string;
  creatorProfile?: Record<string, unknown>;
  /** Soul ID: persistent face identity reference resolved from the creator profile at enqueue time. */
  identityRef?: {
    primaryImageUrl: string;
    additionalImageUrls: string[];
    mode: "reference_images" | "vendor_avatar";
  };
  /** Smart routing: content type classification for this segment. */
  segmentType?: SegmentType;
}

export interface ProviderJobEnqueueInput {
  orgId: string;
  clientId: string;
  runId: string;
  candidateId: string;
  platform: string;
  scriptSegmentIndex: number;
  requestedVendor: RawClip["vendor"];
  fallbackVendors: RawClip["vendor"][];
  maxAttempts?: number;
  idempotencyKey: string;
  estimatedCost?: number;
  request: ProviderJobRequest;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

export interface ProviderJobStore {
  enqueue(input: ProviderJobEnqueueInput): Promise<ProviderJob>;
  get(id: string): Promise<ProviderJob | undefined>;
  getByIdempotencyKey(orgId: string, key: string): Promise<ProviderJob | undefined>;
  /** Tenant-scoped read; run identifiers are not authorization credentials. */
  listByRun(orgId: string, runId: string): Promise<ProviderJob[]>;
  claim(workerId: string, leaseMs?: number): Promise<ProviderJob | undefined>;
  heartbeat(id: string, workerId: string, leaseMs?: number): Promise<boolean>;
  complete(id: string, workerId: string, result: RawClip, actualVendor: RawClip["vendor"], actualCost: number, providerRequestId?: string): Promise<boolean>;
  fail(id: string, workerId: string, error: string, retryable: boolean, fallbackReason?: string): Promise<ProviderJob | undefined>;
  cancel(id: string): Promise<boolean>;
  acknowledgeCancelled(id: string, workerId: string): Promise<boolean>;
  recoverExpiredLeases(): Promise<number>;
  replay(id: string): Promise<ProviderJob | undefined>;
  /** Metrics queries */
  countByStatus(): Promise<Record<ProviderJobStatus, number>>;
  deadLetterList(orgId: string, limit?: number): Promise<ProviderJob[]>;
}

// ---------------------------------------------------------------------------
// PostgreSQL store (the production source of truth)
// ---------------------------------------------------------------------------

type ProviderJobRow = {
  id: string; org_id: string; client_id: string; run_id: string; candidate_id: string;
  platform: string; script_segment_index: number; requested_vendor: RawClip["vendor"];
  fallback_vendors: RawClip["vendor"][]; attempt: number; max_attempts: number;
  status: ProviderJobStatus; available_at: Date | string; lease_owner: string | null;
  lease_expires_at: Date | string | null; cancel_requested: boolean; idempotency_key: string;
  estimated_cost: number | null; actual_cost: number | null; actual_vendor: RawClip["vendor"] | null;
  provider_request_id: string | null; last_error: string | null; fallback_reason: string | null;
  request: ProviderJobRequest; result: RawClip | null;
  routing_decision: ProviderJob["routingDecision"] | null; created_at: Date | string; updated_at: Date | string;
};

const toIso = (value: Date | string): string => new Date(value).toISOString();
function rowToProviderJob(row: ProviderJobRow): ProviderJob {
  return {
    id: row.id, orgId: row.org_id, clientId: row.client_id, runId: row.run_id,
    candidateId: row.candidate_id, platform: row.platform,
    scriptSegmentIndex: row.script_segment_index, requestedVendor: row.requested_vendor,
    fallbackVendors: row.fallback_vendors, attempt: row.attempt, maxAttempts: row.max_attempts,
    status: row.status, availableAt: toIso(row.available_at), leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? toIso(row.lease_expires_at) : undefined,
    cancelRequested: row.cancel_requested, idempotencyKey: row.idempotency_key,
    estimatedCost: row.estimated_cost ?? undefined, actualCost: row.actual_cost ?? undefined,
    actualVendor: row.actual_vendor ?? undefined, providerRequestId: row.provider_request_id ?? undefined,
    lastError: row.last_error ?? undefined, fallbackReason: row.fallback_reason ?? undefined,
    request: row.request, result: row.result ?? undefined, routingDecision: row.routing_decision ?? undefined,
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at)
  };
}

/**
 * Durable multi-worker store. Every state-changing operation qualifies the lease
 * owner where applicable; a stale worker therefore cannot overwrite the result
 * of a reclaimed job. Claiming uses SKIP LOCKED so concurrent workers receive
 * distinct rows without serializing the whole queue.
 */
export function createPostgresProviderJobStore(pool: PgPool): ProviderJobStore {
  let ready: Promise<void> | undefined;
  const ensureSchema = () => ready ??= runMigrations(pool).catch((error) => {
    ready = undefined;
    throw error;
  });

  return {
    async enqueue(input) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        `INSERT INTO provider_jobs
          (id, org_id, client_id, run_id, candidate_id, platform, script_segment_index,
           requested_vendor, fallback_vendors, max_attempts, idempotency_key, estimated_cost, request)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (org_id, idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING *`,
        [randomUUID(), input.orgId, input.clientId, input.runId, input.candidateId, input.platform,
          input.scriptSegmentIndex, input.requestedVendor, JSON.stringify(input.fallbackVendors), input.maxAttempts ?? 3,
          input.idempotencyKey, input.estimatedCost ?? null, JSON.stringify(input.request)]
      );
      return rowToProviderJob(rows[0]);
    },

    async get(id) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>("SELECT * FROM provider_jobs WHERE id=$1", [id]);
      return rows[0] ? rowToProviderJob(rows[0]) : undefined;
    },

    async getByIdempotencyKey(orgId, key) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE org_id=$1 AND idempotency_key=$2", [orgId, key]
      );
      return rows[0] ? rowToProviderJob(rows[0]) : undefined;
    },

    async listByRun(orgId, runId) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE org_id=$1 AND run_id=$2 ORDER BY script_segment_index, created_at", [orgId, runId]
      );
      return rows.map(rowToProviderJob);
    },

    async claim(workerId, leaseMs = 60_000) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        `WITH candidate AS (
           SELECT id FROM provider_jobs
           WHERE status='queued' AND available_at <= now()
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE provider_jobs j SET status='running', attempt=attempt+1, lease_owner=$1,
           lease_expires_at=now() + ($2 * interval '1 millisecond'), cancel_requested=false, updated_at=now()
         FROM candidate WHERE j.id=candidate.id RETURNING j.*`, [workerId, leaseMs]
      );
      return rows[0] ? rowToProviderJob(rows[0]) : undefined;
    },

    async heartbeat(id, workerId, leaseMs = 60_000) {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE provider_jobs SET lease_expires_at=now() + ($3 * interval '1 millisecond'), updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2 AND cancel_requested=false`, [id, workerId, leaseMs]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async complete(id, workerId, result, actualVendor, actualCost, providerRequestId) {
      await ensureSchema();
      const updated = await pool.query(
        `UPDATE provider_jobs SET status='completed', result=$3, actual_vendor=$4, actual_cost=$5,
           provider_request_id=$6, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2 AND cancel_requested=false`,
        [id, workerId, JSON.stringify(result), actualVendor, actualCost, providerRequestId ?? null]
      );
      return (updated.rowCount ?? 0) === 1;
    },

    async fail(id, workerId, error, retryable, fallbackReason) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        `UPDATE provider_jobs
         SET status=CASE WHEN $4=false OR attempt >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
             available_at=CASE WHEN $4=false OR attempt >= max_attempts THEN available_at
               ELSE now() + (random() * LEAST(300, power(2, attempt)::int) * interval '1 second') END,
             last_error=$3, fallback_reason=COALESCE($5, fallback_reason), lease_owner=NULL,
             lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING *`,
        [id, workerId, error.slice(0, 4000), retryable, fallbackReason ?? null]
      );
      return rows[0] ? rowToProviderJob(rows[0]) : undefined;
    },

    async cancel(id) {
      await ensureSchema();
      const updated = await pool.query(
        `UPDATE provider_jobs
         SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
             cancel_requested=CASE WHEN status='running' THEN true ELSE cancel_requested END, updated_at=now()
         WHERE id=$1 AND status IN ('queued','running')`, [id]
      );
      return (updated.rowCount ?? 0) === 1;
    },

    async acknowledgeCancelled(id, workerId) {
      await ensureSchema();
      const updated = await pool.query(
        `UPDATE provider_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2 AND cancel_requested=true`, [id, workerId]
      );
      return (updated.rowCount ?? 0) === 1;
    },

    async recoverExpiredLeases() {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE provider_jobs SET status=CASE WHEN attempt >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
           available_at=now(), last_error='Worker lease expired before the job completed', lease_owner=NULL,
           lease_expires_at=NULL, updated_at=now() WHERE status='running' AND lease_expires_at < now()`
      );
      return result.rowCount ?? 0;
    },

    async replay(id) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        `UPDATE provider_jobs SET status='queued', attempt=0, available_at=now(), last_error=NULL,
           fallback_reason=NULL, cancel_requested=false, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='dead_letter' RETURNING *`, [id]
      );
      return rows[0] ? rowToProviderJob(rows[0]) : undefined;
    },

    async countByStatus() {
      await ensureSchema();
      const counts: Record<ProviderJobStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, dead_letter: 0, cancelled: 0 };
      const { rows } = await pool.query<{ status: ProviderJobStatus; count: string }>(
        "SELECT status, count(*)::text AS count FROM provider_jobs GROUP BY status"
      );
      for (const row of rows) counts[row.status] = Number(row.count);
      return counts;
    },

    async deadLetterList(orgId, limit = 50) {
      await ensureSchema();
      const { rows } = await pool.query<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE org_id=$1 AND status='dead_letter' ORDER BY updated_at DESC LIMIT $2", [orgId, limit]
      );
      return rows.map(rowToProviderJob);
    }
  };
}

let configuredPostgresStore: { url: string; store: ProviderJobStore } | undefined;

/** Selects PostgreSQL whenever DATABASE_URL is configured; production cannot use a file queue. */
export async function getConfiguredPostgresProviderJobStore(): Promise<ProviderJobStore | undefined> {
  const { DATABASE_URL } = loadEnv();
  if (!DATABASE_URL) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production — refusing file provider-job persistence.");
    }
    return undefined;
  }
  if (configuredPostgresStore?.url === DATABASE_URL) return configuredPostgresStore.store;
  const { Pool } = await import("pg");
  const store = createPostgresProviderJobStore(new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("supabase.") ? { rejectUnauthorized: false } : undefined
  }));
  configuredPostgresStore = { url: DATABASE_URL, store };
  return store;
}

// ---------------------------------------------------------------------------
// In-Memory Store (for testing and dev without Postgres)
// ---------------------------------------------------------------------------

export function createInMemoryProviderJobStore(): ProviderJobStore {
  const jobs: ProviderJob[] = [];

  return {
    async enqueue(input) {
      const existing = jobs.find(
        (j) => j.orgId === input.orgId && j.idempotencyKey === input.idempotencyKey
      );
      if (existing) return existing;

      const now = new Date().toISOString();
      const job: ProviderJob = {
        id: randomUUID(),
        orgId: input.orgId,
        clientId: input.clientId,
        runId: input.runId,
        candidateId: input.candidateId,
        platform: input.platform,
        scriptSegmentIndex: input.scriptSegmentIndex,
        requestedVendor: input.requestedVendor,
        fallbackVendors: input.fallbackVendors,
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 3,
        status: "queued",
        availableAt: now,
        cancelRequested: false,
        idempotencyKey: input.idempotencyKey,
        estimatedCost: input.estimatedCost,
        request: input.request,
        createdAt: now,
        updatedAt: now,
      };
      jobs.push(job);
      return job;
    },

    async get(id) {
      return jobs.find((j) => j.id === id);
    },

    async getByIdempotencyKey(orgId, key) {
      return jobs.find((j) => j.orgId === orgId && j.idempotencyKey === key);
    },

    async listByRun(orgId, runId) {
      return jobs.filter((j) => j.orgId === orgId && j.runId === runId);
    },

    async claim(workerId, leaseMs = 60_000) {
      const job = jobs.find(
        (j) => j.status === "queued" && Date.parse(j.availableAt) <= Date.now()
      );
      if (!job) return undefined;
      Object.assign(job, {
        status: "running",
        attempt: job.attempt + 1,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        cancelRequested: false,
        updatedAt: new Date().toISOString(),
      });
      return { ...job };
    },

    async heartbeat(id, workerId, leaseMs = 60_000) {
      const job = jobs.find(
        (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId
      );
      if (!job) return false;
      job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async complete(id, workerId, result, actualVendor, actualCost, providerRequestId) {
      const job = jobs.find(
        (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId && !j.cancelRequested
      );
      if (!job) return false;
      Object.assign(job, {
        status: "completed",
        result,
        actualVendor,
        actualCost,
        providerRequestId,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      return true;
    },

    async fail(id, workerId, error, retryable, fallbackReason) {
      const job = jobs.find(
        (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId
      );
      if (!job) return undefined;
      const dead = !retryable || job.attempt >= job.maxAttempts;
      Object.assign(job, {
        status: dead ? "dead_letter" : "queued",
        availableAt: dead
          ? job.availableAt
          : new Date(
              Date.now() + Math.random() * Math.min(300, 2 ** job.attempt) * 1000
            ).toISOString(),
        lastError: error.slice(0, 4000),
        fallbackReason: fallbackReason ?? job.fallbackReason,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      return { ...job };
    },

    async cancel(id) {
      const job = jobs.find(
        (j) => j.id === id && ["queued", "running"].includes(j.status)
      );
      if (!job) return false;
      if (job.status === "queued") job.status = "cancelled";
      else job.cancelRequested = true;
      job.updatedAt = new Date().toISOString();
      return true;
    },

    async acknowledgeCancelled(id, workerId) {
      const job = jobs.find(
        (j) =>
          j.id === id &&
          j.status === "running" &&
          j.leaseOwner === workerId &&
          j.cancelRequested
      );
      if (!job) return false;
      Object.assign(job, {
        status: "cancelled",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      return true;
    },

    async recoverExpiredLeases() {
      let recovered = 0;
      for (const job of jobs) {
        if (
          job.status !== "running" ||
          !job.leaseExpiresAt ||
          Date.parse(job.leaseExpiresAt) >= Date.now()
        )
          continue;
        Object.assign(job, {
          status: job.attempt >= job.maxAttempts ? "dead_letter" : "queued",
          lastError: "Worker lease expired before the job completed",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          availableAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        recovered++;
      }
      return recovered;
    },

    async replay(id) {
      const job = jobs.find((j) => j.id === id && j.status === "dead_letter");
      if (!job) return undefined;
      Object.assign(job, {
        status: "queued",
        attempt: 0,
        availableAt: new Date().toISOString(),
        lastError: undefined,
        fallbackReason: undefined,
        cancelRequested: false,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      return { ...job };
    },

    async countByStatus() {
      const counts: Record<ProviderJobStatus, number> = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dead_letter: 0,
        cancelled: 0,
      };
      for (const job of jobs) {
        counts[job.status]++;
      }
      return counts;
    },

    async deadLetterList(orgId, limit = 50) {
      return jobs
        .filter((j) => j.orgId === orgId && j.status === "dead_letter")
        .slice(0, limit);
    },
  };
}

// ---------------------------------------------------------------------------
// File-based Locking (ported from json-store.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Acquires an exclusive lockfile using atomic O_CREAT|O_EXCL semantics.
 * Spins with a short busy-wait (appropriate for the synchronous single-machine
 * deployment this store targets). Times out after `timeoutMs` to prevent deadlock
 * from stale locks (e.g. crashed process that never released).
 */
function acquireLock(filePath: string, timeoutMs = 5000): void {
  const lockPath = `${filePath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for provider-jobs lock at ${lockPath}`);
      }
      // Busy-wait synchronously — same strategy as json-store.ts.
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

function releaseLock(filePath: string): void {
  rmSync(`${filePath}.lock`, { force: true });
}

/**
 * A small durable store for installations that share VVUGC_RUNS_DIR between the
 * dashboard and worker (including the supplied Docker compose file).  This is
 * deliberately file-backed rather than process-local: provider work must never
 * disappear merely because the dashboard and worker are different processes.
 *
 * H-2 FIX: All mutating operations (enqueue, claim, heartbeat, complete, fail,
 * cancel, acknowledgeCancelled, recoverExpiredLeases, replay) now hold an exclusive
 * file lock during their read-modify-write cycle. This prevents the race condition
 * where concurrent processes (dashboard + worker) read the same state, compute
 * conflicting updates, and the last writer silently overwrites the first's changes.
 *
 * The file is replaced atomically via rename, so readers observe either the previous
 * or next complete queue. The lock serializes writers. It is intended for the
 * single-dashboard/single-worker deployment topology; horizontally scaled writers
 * should use Postgres.
 */
export function createFileProviderJobStore(filePath: string): ProviderJobStore {
  mkdirSync(dirname(filePath), { recursive: true });

  const read = (): ProviderJob[] => {
    if (!existsSync(filePath)) return [];
    try { return JSON.parse(readFileSync(filePath, "utf8")) as ProviderJob[]; } catch { return []; }
  };

  const write = (jobs: ProviderJob[]) => {
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(jobs), { mode: 0o600 });
    renameSync(temporary, filePath);
  };

  /**
   * H-2 FIX: `update` now acquires the file lock before read and releases after
   * write, ensuring atomicity of the full read-modify-write cycle across processes.
   */
  const update = <T>(fn: (jobs: ProviderJob[]) => T): T => {
    acquireLock(filePath);
    try {
      const jobs = read();
      const result = fn(jobs);
      write(jobs);
      return result;
    } finally {
      releaseLock(filePath);
    }
  };

  const copy = <T>(value: T): T => structuredClone(value);
  const now = () => new Date().toISOString();

  return {
    async enqueue(input) {
      return update((jobs) => {
        const existing = jobs.find(
          (j) => j.orgId === input.orgId && j.idempotencyKey === input.idempotencyKey
        );
        if (existing) return copy(existing);
        const at = now();
        const job: ProviderJob = {
          id: randomUUID(),
          orgId: input.orgId,
          clientId: input.clientId,
          runId: input.runId,
          candidateId: input.candidateId,
          platform: input.platform,
          scriptSegmentIndex: input.scriptSegmentIndex,
          requestedVendor: input.requestedVendor,
          fallbackVendors: input.fallbackVendors,
          attempt: 0,
          maxAttempts: input.maxAttempts ?? 3,
          status: "queued",
          availableAt: at,
          cancelRequested: false,
          idempotencyKey: input.idempotencyKey,
          estimatedCost: input.estimatedCost,
          request: input.request,
          createdAt: at,
          updatedAt: at,
        };
        jobs.push(job);
        return copy(job);
      });
    },

    async get(id) {
      // Read-only — no lock needed (atomic rename guarantees consistent reads).
      const job = read().find((j) => j.id === id);
      return job && copy(job);
    },

    async getByIdempotencyKey(orgId, key) {
      // Read-only — no lock needed.
      const job = read().find((j) => j.orgId === orgId && j.idempotencyKey === key);
      return job && copy(job);
    },

    async listByRun(orgId, runId) {
      // Read-only — no lock needed.
      return read().filter((j) => j.orgId === orgId && j.runId === runId).map(copy);
    },

    async claim(workerId, leaseMs = 60_000) {
      return update((jobs) => {
        const job = jobs.find(
          (j) => j.status === "queued" && Date.parse(j.availableAt) <= Date.now()
        );
        if (!job) return undefined;
        Object.assign(job, {
          status: "running",
          attempt: job.attempt + 1,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
          cancelRequested: false,
          updatedAt: now(),
        });
        return copy(job);
      });
    },

    async heartbeat(id, workerId, leaseMs = 60_000) {
      return update((jobs) => {
        const job = jobs.find(
          (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId
        );
        if (!job) return false;
        job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
        job.updatedAt = now();
        return true;
      });
    },

    async complete(id, workerId, result, actualVendor, actualCost, providerRequestId) {
      return update((jobs) => {
        const job = jobs.find(
          (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId && !j.cancelRequested
        );
        if (!job) return false;
        Object.assign(job, {
          status: "completed",
          result,
          actualVendor,
          actualCost,
          providerRequestId,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now(),
        });
        return true;
      });
    },

    async fail(id, workerId, error, retryable, fallbackReason) {
      return update((jobs) => {
        const job = jobs.find(
          (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId
        );
        if (!job) return undefined;
        const dead = !retryable || job.attempt >= job.maxAttempts;
        Object.assign(job, {
          status: dead ? "dead_letter" : "queued",
          availableAt: dead
            ? job.availableAt
            : new Date(
                Date.now() + Math.random() * Math.min(300, 2 ** job.attempt) * 1000
              ).toISOString(),
          lastError: error.slice(0, 4000),
          fallbackReason: fallbackReason ?? job.fallbackReason,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now(),
        });
        return copy(job);
      });
    },

    async cancel(id) {
      return update((jobs) => {
        const job = jobs.find(
          (j) => j.id === id && (j.status === "queued" || j.status === "running")
        );
        if (!job) return false;
        if (job.status === "queued") job.status = "cancelled";
        else job.cancelRequested = true;
        job.updatedAt = now();
        return true;
      });
    },

    async acknowledgeCancelled(id, workerId) {
      return update((jobs) => {
        const job = jobs.find(
          (j) => j.id === id && j.status === "running" && j.leaseOwner === workerId && j.cancelRequested
        );
        if (!job) return false;
        Object.assign(job, {
          status: "cancelled",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now(),
        });
        return true;
      });
    },

    async recoverExpiredLeases() {
      return update((jobs) => {
        let recovered = 0;
        for (const job of jobs) {
          if (
            job.status === "running" &&
            job.leaseExpiresAt &&
            Date.parse(job.leaseExpiresAt) < Date.now()
          ) {
            Object.assign(job, {
              status: job.attempt >= job.maxAttempts ? "dead_letter" : "queued",
              lastError: "Worker lease expired before the job completed",
              leaseOwner: undefined,
              leaseExpiresAt: undefined,
              availableAt: now(),
              updatedAt: now(),
            });
            recovered++;
          }
        }
        return recovered;
      });
    },

    async replay(id) {
      return update((jobs) => {
        const job = jobs.find((j) => j.id === id && j.status === "dead_letter");
        if (!job) return undefined;
        Object.assign(job, {
          status: "queued",
          attempt: 0,
          availableAt: now(),
          lastError: undefined,
          fallbackReason: undefined,
          cancelRequested: false,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now(),
        });
        return copy(job);
      });
    },

    async countByStatus() {
      // Read-only — no lock needed.
      const counts: Record<ProviderJobStatus, number> = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dead_letter: 0,
        cancelled: 0,
      };
      for (const job of read()) counts[job.status]++;
      return counts;
    },

    async deadLetterList(orgId, limit = 50) {
      // Read-only — no lock needed.
      return read()
        .filter((j) => j.orgId === orgId && j.status === "dead_letter")
        .slice(0, limit)
        .map(copy);
    },
  };
}
