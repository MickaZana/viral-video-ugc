/**
 * Atom F — Worker Metrics and Observability
 *
 * Prometheus metrics for:
 * - queue depth, active jobs
 * - provider latency, success rate, fallback rate
 * - retry count, dead-letter count
 * - cost per provider
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export interface WorkerMetrics {
  registry: Registry;
  /** Jobs currently being processed by this worker. */
  activeJobs: Gauge;
  /** Total jobs claimed. */
  jobsClaimed: Counter;
  /** Total jobs completed successfully. */
  jobsCompleted: Counter;
  /** Total jobs failed (retryable or not). */
  jobsFailed: Counter;
  /** Total jobs sent to dead-letter. */
  jobsDeadLettered: Counter;
  /** Total fallback events (vendor switch). */
  fallbackEvents: Counter;
  /** Total retry events. */
  retryEvents: Counter;
  /** Provider call duration (seconds). */
  providerDuration: Histogram;
  /** Actual cost per provider call (USD). */
  providerCost: Counter;
  /** Queue depth (set by periodic check). */
  queueDepth: Gauge;
  /** Expired lease recoveries. */
  leaseRecoveries: Counter;
  /** MCP session state (1=connected, 0=disconnected). */
  mcpSessionHealthy: Gauge;
}

export function createWorkerMetrics(): WorkerMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "video-worker" });
  collectDefaultMetrics({ register: registry });

  const activeJobs = new Gauge({
    name: "vvugc_worker_active_jobs",
    help: "Number of jobs currently being processed",
    registers: [registry],
  });

  const jobsClaimed = new Counter({
    name: "vvugc_worker_jobs_claimed_total",
    help: "Total provider jobs claimed",
    labelNames: ["vendor"] as const,
    registers: [registry],
  });

  const jobsCompleted = new Counter({
    name: "vvugc_worker_jobs_completed_total",
    help: "Total provider jobs completed successfully",
    labelNames: ["vendor", "was_fallback"] as const,
    registers: [registry],
  });

  const jobsFailed = new Counter({
    name: "vvugc_worker_jobs_failed_total",
    help: "Total provider jobs failed",
    labelNames: ["vendor", "error_category"] as const,
    registers: [registry],
  });

  const jobsDeadLettered = new Counter({
    name: "vvugc_worker_jobs_dead_lettered_total",
    help: "Total jobs sent to dead-letter queue",
    labelNames: ["vendor"] as const,
    registers: [registry],
  });

  const fallbackEvents = new Counter({
    name: "vvugc_worker_fallback_events_total",
    help: "Total vendor fallback events",
    labelNames: ["from_vendor", "to_vendor", "reason"] as const,
    registers: [registry],
  });

  const retryEvents = new Counter({
    name: "vvugc_worker_retry_events_total",
    help: "Total retry events",
    labelNames: ["vendor", "error_category"] as const,
    registers: [registry],
  });

  const providerDuration = new Histogram({
    name: "vvugc_worker_provider_duration_seconds",
    help: "Provider call duration in seconds",
    labelNames: ["vendor", "status"] as const,
    buckets: [1, 5, 10, 30, 60, 120, 300, 600],
    registers: [registry],
  });

  const providerCost = new Counter({
    name: "vvugc_worker_provider_cost_usd",
    help: "Actual cost in USD per provider call",
    labelNames: ["vendor"] as const,
    registers: [registry],
  });

  const queueDepth = new Gauge({
    name: "vvugc_worker_queue_depth",
    help: "Number of queued provider jobs",
    registers: [registry],
  });

  const leaseRecoveries = new Counter({
    name: "vvugc_worker_lease_recoveries_total",
    help: "Total expired lease recoveries",
    registers: [registry],
  });

  const mcpSessionHealthy = new Gauge({
    name: "vvugc_worker_mcp_session_healthy",
    help: "MCP session health (1=connected, 0=disconnected/unhealthy)",
    registers: [registry],
  });

  return {
    registry,
    activeJobs,
    jobsClaimed,
    jobsCompleted,
    jobsFailed,
    jobsDeadLettered,
    fallbackEvents,
    retryEvents,
    providerDuration,
    providerCost,
    queueDepth,
    leaseRecoveries,
    mcpSessionHealthy,
  };
}
