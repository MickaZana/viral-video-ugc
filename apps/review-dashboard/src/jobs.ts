import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  getConfiguredPostgresPipelineJobStore,
  type PipelineJob,
  type PipelineJobStore
} from "@vvugc/review-queue";
import { runCycle } from "@vvugc/orchestrator";
import { aggregateUsage } from "@vvugc/shared-auth";
import { createPlanStore } from "@vvugc/shared-billing";
import { loadEnv } from "@vvugc/shared-config";
import { checkRunQuota } from "./quota.js";

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 50;
/** If the lock file is older than this, assume the holder crashed and remove it. */
const STALE_LOCK_MS = 60_000;

function lock(path: string): void {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Check for stale locks left by crashed processes
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          rmSync(lockPath, { force: true });
          continue; // Retry immediately after cleaning up stale lock
        }
      } catch { /* lock was removed between our check — retry */ }
      // Brief sleep to avoid burning CPU
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* spin-wait */ }
    }
  }
  // Last resort: force-remove the lock and try once more
  rmSync(lockPath, { force: true });
  try {
    closeSync(openSync(lockPath, "wx"));
    return;
  } catch {
    throw new Error(`Failed to acquire lock on ${path} after ${LOCK_TIMEOUT_MS}ms — another process may be holding it`);
  }
}

/** Local fallback for development. Production selects the PostgreSQL backend. */
function createJsonPipelineJobStore(path: string): PipelineJobStore {
  const read = (): PipelineJob[] => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const mutate = <T>(fn: (jobs: PipelineJob[]) => T): T => {
    mkdirSync(dirname(path), { recursive: true });
    lock(path);
    try {
      const jobs = read();
      const result = fn(jobs);
      writeFileSync(path, JSON.stringify(jobs, null, 2));
      return result;
    } finally {
      rmSync(`${path}.lock`, { force: true });
    }
  };
  return {
    async enqueue(orgId, clientId, config, idempotencyKey, maxAttempts = 3) {
      return mutate((jobs) => {
        const existing = jobs.find((job) => job.orgId === orgId && job.idempotencyKey === idempotencyKey);
        if (existing) return existing;
        const now = new Date().toISOString();
        const job: PipelineJob = {
          id: randomUUID(), idempotencyKey, orgId, clientId, config, status: "queued",
          attempts: 0, maxAttempts, availableAt: now, cancelRequested: false,
          createdAt: now, updatedAt: now
        };
        jobs.push(job);
        return job;
      });
    },
    async list(orgId, clientId) {
      return read().filter((job) => job.orgId === orgId && (!clientId || job.clientId === clientId));
    },
    async get(orgId, id) {
      return read().find((job) => job.orgId === orgId && job.id === id);
    },
    async cancel(orgId, id) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.orgId === orgId && entry.id === id && ["queued", "running"].includes(entry.status));
        if (!job) return false;
        if (job.status === "queued") job.status = "cancelled";
        else job.cancelRequested = true;
        job.updatedAt = new Date().toISOString();
        return true;
      });
    },
    async replay(orgId, id) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.orgId === orgId && entry.id === id && entry.status === "dead_letter");
        if (!job) return undefined;
        Object.assign(job, {
          status: "queued", attempts: 0, lastError: undefined, cancelRequested: false,
          leaseOwner: undefined, leaseExpiresAt: undefined, availableAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return { ...job };
      });
    },
    async recoverExpiredLeases() {
      return mutate((jobs) => {
        let recovered = 0;
        for (const job of jobs) {
          if (job.status !== "running" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) >= Date.now()) continue;
          Object.assign(job, {
            status: job.attempts >= job.maxAttempts ? "dead_letter" : "queued",
            lastError: "Worker lease expired before the job completed",
            leaseOwner: undefined, leaseExpiresAt: undefined, availableAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          recovered++;
        }
        return recovered;
      });
    },
    async deleteOrg(orgId) {
      return mutate((jobs) => {
        const before = jobs.length;
        for (let i = jobs.length - 1; i >= 0; i--) {
          if (jobs[i].orgId === orgId) jobs.splice(i, 1);
        }
        return before - jobs.length;
      });
    },
    async claim(workerId, leaseMs = 60_000) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.status === "queued" && Date.parse(entry.availableAt) <= Date.now());
        if (!job) return undefined;
        Object.assign(job, {
          status: "running", attempts: job.attempts + 1, leaseOwner: workerId,
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
          cancelRequested: false, updatedAt: new Date().toISOString()
        });
        return { ...job };
      });
    },
    async heartbeat(id, workerId, leaseMs = 60_000) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.id === id && entry.status === "running" && entry.leaseOwner === workerId);
        if (!job) return false;
        job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
        job.updatedAt = new Date().toISOString();
        return true;
      });
    },
    async complete(id, workerId, result) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.id === id && entry.status === "running" && entry.leaseOwner === workerId && !entry.cancelRequested);
        if (!job) return false;
        Object.assign(job, { status: "completed", result, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: new Date().toISOString() });
        return true;
      });
    },
    async fail(id, workerId, error, retryable = true) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.id === id && entry.status === "running" && entry.leaseOwner === workerId);
        if (!job) return undefined;
        Object.assign(job, {
          status: !retryable || job.attempts >= job.maxAttempts ? "dead_letter" : "queued",
          // Full jitter prevents a provider recovery from waking every failed
          // worker simultaneously (the classic retry/thundering-herd failure).
          availableAt: new Date(Date.now() + Math.random() * Math.min(300, 2 ** job.attempts) * 1000).toISOString(),
          lastError: error.slice(0, 4000), leaseOwner: undefined, leaseExpiresAt: undefined,
          updatedAt: new Date().toISOString()
        });
        return { ...job };
      });
    },
    async acknowledgeCancelled(id, workerId) {
      return mutate((jobs) => {
        const job = jobs.find((entry) => entry.id === id && entry.status === "running" && entry.leaseOwner === workerId && entry.cancelRequested);
        if (!job) return false;
        Object.assign(job, { status: "cancelled", leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: new Date().toISOString() });
        return true;
      });
    }
  };
}

export function createPipelineJobStore(path: string, options: { forceJson?: boolean } = {}): PipelineJobStore {
  const jsonStore = createJsonPipelineJobStore(path);
  let selected: Promise<PipelineJobStore> | undefined;
  const backend = () => selected ??= options.forceJson
    ? Promise.resolve(jsonStore)
    : getConfiguredPostgresPipelineJobStore().then((store) => store ?? jsonStore);
  return {
    enqueue: async (...args) => (await backend()).enqueue(...args),
    list: async (...args) => (await backend()).list(...args),
    get: async (...args) => (await backend()).get(...args),
    claim: async (...args) => (await backend()).claim(...args),
    heartbeat: async (...args) => (await backend()).heartbeat(...args),
    complete: async (...args) => (await backend()).complete(...args),
    fail: async (...args) => (await backend()).fail(...args),
    cancel: async (...args) => (await backend()).cancel(...args),
    acknowledgeCancelled: async (...args) => (await backend()).acknowledgeCancelled(...args),
    replay: async (...args) => (await backend()).replay(...args),
    recoverExpiredLeases: async (...args) => (await backend()).recoverExpiredLeases(...args),
    deleteOrg: async (...args) => (await backend()).deleteOrg(...args)
  };
}

export async function processNextPipelineJob(
  store: PipelineJobStore,
  workerId = `worker-${randomUUID()}`,
  leaseMs = 60_000
): Promise<PipelineJob | undefined> {
  const job = await store.claim(workerId, leaseMs);
  if (!job) return undefined;
  const heartbeat = setInterval(() => void store.heartbeat(job.id, workerId, leaseMs), Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref();
  try {
    const { VVUGC_RUNS_DIR } = loadEnv();
    const plan = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json")).get(job.orgId);
    const quota = checkRunQuota(plan, aggregateUsage(job.orgId, VVUGC_RUNS_DIR));
    if (!quota.allowed) {
      await store.fail(job.id, workerId, `Quota check failed immediately before execution: ${quota.reason}`, false);
      return store.get(job.orgId, job.id);
    }
    const result = await runCycle(job.config, { onProgress: () => {} });
    const current = await store.get(job.orgId, job.id);
    if (current?.cancelRequested) await store.acknowledgeCancelled(job.id, workerId);
    else await store.complete(job.id, workerId, result);
  } catch (error) {
    await store.fail(job.id, workerId, String(error));
  } finally {
    clearInterval(heartbeat);
  }
  return store.get(job.orgId, job.id);
}

export function startPipelineJobWorker(store: PipelineJobStore, intervalMs = 1_000): NodeJS.Timeout {
  const workerId = `worker-${process.pid}-${randomUUID()}`;
  void store.recoverExpiredLeases();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void processNextPipelineJob(store, workerId).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return timer;
}
