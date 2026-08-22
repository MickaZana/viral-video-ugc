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
  listByRun(runId: string): Promise<ProviderJob[]>;
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

    async listByRun(runId) {
      return jobs.filter((j) => j.runId === runId);
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

    async listByRun(runId) {
      // Read-only — no lock needed.
      return read().filter((j) => j.runId === runId).map(copy);
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
