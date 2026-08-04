import { randomUUID } from "node:crypto";
import type { Pool as PgPool } from "pg";
import type { RunConfig, RunResult } from "@vvugc/shared-schema";
import { loadEnv } from "@vvugc/shared-config";
import { runMigrations } from "./migrations.js";

export type PipelineJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "dead_letter";

export interface PipelineJob {
  id: string;
  idempotencyKey: string;
  orgId: string;
  clientId: string;
  config: RunConfig;
  status: PipelineJobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  result?: RunResult;
  lastError?: string;
}

export interface PipelineJobStore {
  enqueue(orgId: string, clientId: string, config: RunConfig, idempotencyKey: string, maxAttempts?: number): Promise<PipelineJob>;
  list(orgId: string, clientId?: string): Promise<PipelineJob[]>;
  get(orgId: string, id: string): Promise<PipelineJob | undefined>;
  claim(workerId: string, leaseMs?: number): Promise<PipelineJob | undefined>;
  heartbeat(id: string, workerId: string, leaseMs?: number): Promise<boolean>;
  complete(id: string, workerId: string, result: RunResult): Promise<boolean>;
  fail(id: string, workerId: string, error: string, retryable?: boolean): Promise<PipelineJob | undefined>;
  cancel(orgId: string, id: string): Promise<boolean>;
  acknowledgeCancelled(id: string, workerId: string): Promise<boolean>;
  replay(orgId: string, id: string): Promise<PipelineJob | undefined>;
  recoverExpiredLeases(): Promise<number>;
  /** Hard-deletes every job belonging to an org (org owner's account deletion).
   *  Returns how many were removed. */
  deleteOrg(orgId: string): Promise<number>;
}

type JobRow = {
  id: string; idempotency_key: string; org_id: string; client_id: string;
  config: RunConfig; status: PipelineJobStatus; attempts: number; max_attempts: number;
  available_at: Date | string; lease_owner: string | null; lease_expires_at: Date | string | null;
  cancel_requested: boolean; result: RunResult | null; last_error: string | null;
  created_at: Date | string; updated_at: Date | string;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
function rowToJob(row: JobRow): PipelineJob {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    orgId: row.org_id,
    clientId: row.client_id,
    config: row.config,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: iso(row.available_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : undefined,
    cancelRequested: row.cancel_requested,
    result: row.result ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function createPostgresPipelineJobStore(pool: PgPool): PipelineJobStore {
  let ready: Promise<void> | undefined;
  const ensureSchema = () => ready ??= runMigrations(pool).catch((error) => {
    ready = undefined;
    throw error;
  });

  return {
    async enqueue(orgId, clientId, config, idempotencyKey, maxAttempts = 3) {
      await ensureSchema();
      const id = randomUUID();
      const { rows } = await pool.query<JobRow>(
        `INSERT INTO pipeline_jobs
           (id, idempotency_key, org_id, client_id, config, status, max_attempts)
         VALUES ($1, $2, $3, $4, $5, 'queued', $6)
         ON CONFLICT (org_id, idempotency_key)
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING *`,
        [id, idempotencyKey, orgId, clientId, JSON.stringify(config), maxAttempts]
      );
      return rowToJob(rows[0]);
    },

    async list(orgId, clientId) {
      await ensureSchema();
      const { rows } = clientId
        ? await pool.query<JobRow>("SELECT * FROM pipeline_jobs WHERE org_id=$1 AND client_id=$2 ORDER BY created_at DESC", [orgId, clientId])
        : await pool.query<JobRow>("SELECT * FROM pipeline_jobs WHERE org_id=$1 ORDER BY created_at DESC", [orgId]);
      return rows.map(rowToJob);
    },

    async get(orgId, id) {
      await ensureSchema();
      const { rows } = await pool.query<JobRow>("SELECT * FROM pipeline_jobs WHERE org_id=$1 AND id=$2", [orgId, id]);
      return rows[0] ? rowToJob(rows[0]) : undefined;
    },

    async claim(workerId, leaseMs = 60_000) {
      await ensureSchema();
      const { rows } = await pool.query<JobRow>(
        `WITH candidate AS (
           SELECT id FROM pipeline_jobs
           WHERE status='queued' AND available_at <= now()
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE pipeline_jobs j
         SET status='running', attempts=attempts+1, lease_owner=$1,
             lease_expires_at=now() + ($2 * interval '1 millisecond'),
             cancel_requested=false, updated_at=now()
         FROM candidate
         WHERE j.id=candidate.id
         RETURNING j.*`,
        [workerId, leaseMs]
      );
      return rows[0] ? rowToJob(rows[0]) : undefined;
    },

    async heartbeat(id, workerId, leaseMs = 60_000) {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE pipeline_jobs SET lease_expires_at=now() + ($3 * interval '1 millisecond'), updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2`,
        [id, workerId, leaseMs]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async complete(id, workerId, result) {
      await ensureSchema();
      const updated = await pool.query(
        `UPDATE pipeline_jobs
         SET status='completed', result=$3, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2 AND cancel_requested=false`,
        [id, workerId, JSON.stringify(result)]
      );
      return (updated.rowCount ?? 0) === 1;
    },

    async fail(id, workerId, error, retryable = true) {
      await ensureSchema();
      const { rows } = await pool.query<JobRow>(
        `UPDATE pipeline_jobs
         SET status=CASE WHEN $4=false OR attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
             available_at=CASE WHEN $4=false OR attempts >= max_attempts THEN available_at
                           ELSE now() + (random() * LEAST(300, power(2, attempts)::int) * interval '1 second') END,
             last_error=$3, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2
         RETURNING *`,
        [id, workerId, error.slice(0, 4000), retryable]
      );
      return rows[0] ? rowToJob(rows[0]) : undefined;
    },

    async cancel(orgId, id) {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE pipeline_jobs
         SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
             cancel_requested=CASE WHEN status='running' THEN true ELSE cancel_requested END,
             updated_at=now()
         WHERE org_id=$1 AND id=$2 AND status IN ('queued','running')`,
        [orgId, id]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async acknowledgeCancelled(id, workerId) {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE pipeline_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='running' AND lease_owner=$2 AND cancel_requested=true`,
        [id, workerId]
      );
      return (result.rowCount ?? 0) === 1;
    },

    async replay(orgId, id) {
      await ensureSchema();
      const { rows } = await pool.query<JobRow>(
        `UPDATE pipeline_jobs
         SET status='queued', attempts=0, available_at=now(), last_error=NULL,
             cancel_requested=false, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE org_id=$1 AND id=$2 AND status='dead_letter'
         RETURNING *`,
        [orgId, id]
      );
      return rows[0] ? rowToJob(rows[0]) : undefined;
    },

    async recoverExpiredLeases() {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE pipeline_jobs
         SET status=CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
             available_at=now(), last_error='Worker lease expired before the job completed',
             lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE status='running' AND lease_expires_at < now()`
      );
      return result.rowCount ?? 0;
    },

    async deleteOrg(orgId) {
      await ensureSchema();
      const result = await pool.query(`DELETE FROM pipeline_jobs WHERE org_id = $1`, [orgId]);
      return result.rowCount ?? 0;
    }
  };
}

let configuredStore: { url: string; store: PipelineJobStore } | undefined;

/** Returns the shared Postgres job store when a database is configured. */
export async function getConfiguredPostgresPipelineJobStore(): Promise<PipelineJobStore | undefined> {
  const { DATABASE_URL } = loadEnv();
  if (!DATABASE_URL) return undefined;
  if (configuredStore?.url === DATABASE_URL) return configuredStore.store;
  const { Pool } = await import("pg");
  const store = createPostgresPipelineJobStore(new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("supabase.") ? { rejectUnauthorized: false } : undefined
  }));
  configuredStore = { url: DATABASE_URL, store };
  return store;
}
