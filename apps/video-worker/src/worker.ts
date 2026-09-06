/**
 * Atom B — Persistent Video-Generation Worker
 *
 * Core loop:
 * 1. Claim a provider job from the store
 * 2. Heartbeat the lease while working
 * 3. Resolve the vendor (original or fallback)
 * 4. Execute video generation
 * 5. Complete or fail the job with proper classification
 * 6. Respect cancellation, shutdown, and dry-run constraints
 */

import { randomUUID } from "node:crypto";
import pino from "pino";
import { getVideoGenAdapter, type VideoGenAdapter } from "@vvugc/mcp-video-gen";
import type { ProviderJob, ProviderJobStore } from "@vvugc/review-queue";
import type { McpSession } from "./mcp-session.js";
import { classifyProviderError, type ClassifiedError } from "./retry-policy.js";
import { resolveChain, type FallbackChainConfig, type VideoVendor } from "./fallback-chain.js";
import { smartRoute, detectAvailableVendors, type SmartRoutingInput } from "./smart-router.js";
import type { WorkerMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  /** Worker instance ID (auto-generated if not provided). */
  workerId?: string;
  /** Max concurrent job executions. Default: 2 */
  concurrency?: number;
  /** Poll interval when no jobs are available (ms). Default: 5_000 */
  pollIntervalMs?: number;
  /** Lease duration (ms). Default: 120_000 (2 minutes — video gen can be slow) */
  leaseMs?: number;
  /** Heartbeat interval (ms). Default: 30_000 */
  heartbeatIntervalMs?: number;
  /** How often to recover expired leases (ms). Default: 60_000 */
  leaseRecoveryIntervalMs?: number;
  /** Output directory for generated clips. */
  outDir: string;
  /** If true, all generation uses mock adapters. */
  dryRun: boolean;
  /** Fallback chain configuration (per-account overrides applied at enqueue time). */
  fallbackConfig?: FallbackChainConfig;
  /** Provider-specific timeout overrides (ms). */
  providerTimeouts?: Partial<Record<VideoVendor, number>>;
  /** Pre-detected list of vendors with configured credentials. */
  availableVendors?: VideoVendor[];
  /** Testable/provider-specific adapter injection; production uses the default resolver. */
  adapterFactory?: (vendor: VideoVendor, logger: pino.Logger) => VideoGenAdapter | undefined;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface VideoWorker {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createVideoWorker(
  store: ProviderJobStore,
  mcpSession: McpSession,
  metrics: WorkerMetrics,
  config: WorkerConfig
): VideoWorker {
  const logger = pino({ name: "video-worker" });
  const workerId = config.workerId ?? `vw-${randomUUID().slice(0, 8)}`;
  const concurrency = config.concurrency ?? 2;
  const pollIntervalMs = config.pollIntervalMs ?? 5_000;
  const leaseMs = config.leaseMs ?? 120_000;
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
  const leaseRecoveryIntervalMs = config.leaseRecoveryIntervalMs ?? 60_000;

  let running = false;
  let activeCount = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let shutdownResolve: (() => void) | undefined;

  function start() {
    if (running) return;
    running = true;
    logger.info({ workerId, concurrency, dryRun: config.dryRun }, "Video worker starting");

    // Start lease recovery interval
    recoveryTimer = setInterval(async () => {
      try {
        const recovered = await store.recoverExpiredLeases();
        if (recovered > 0) {
          metrics.leaseRecoveries.inc(recovered);
          logger.info({ recovered }, "Recovered expired leases");
        }
      } catch (err) {
        logger.error({ err }, "Lease recovery failed");
      }
    }, leaseRecoveryIntervalMs);

    // Start polling
    poll();
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;
    logger.info({ workerId, activeCount }, "Video worker stopping — waiting for active jobs");

    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = undefined;
    }

    // Wait for active jobs to complete
    if (activeCount > 0) {
      await new Promise<void>((resolve) => {
        shutdownResolve = resolve;
      });
    }

    mcpSession.disconnect();
    logger.info({ workerId }, "Video worker stopped");
  }

  function isRunning() {
    return running;
  }

  async function poll() {
    if (!running) return;

    while (running && activeCount < concurrency) {
      try {
        const job = await store.claim(workerId, leaseMs);
        if (!job) break; // No more jobs available

        activeCount++;
        metrics.activeJobs.set(activeCount);
        metrics.jobsClaimed.inc({ vendor: job.requestedVendor });

        // Execute in background (don't await — allows concurrency)
        void executeJob(job).finally(() => {
          activeCount--;
          metrics.activeJobs.set(activeCount);
          if (!running && activeCount === 0 && shutdownResolve) {
            shutdownResolve();
          }
        });
      } catch (err) {
        logger.error({ err }, "Error claiming job");
        break;
      }
    }

    // Schedule next poll
    if (running) {
      pollTimer = setTimeout(poll, pollIntervalMs);
    }
  }

  async function executeJob(job: ProviderJob): Promise<void> {
    const jobLogger = logger.child({ jobId: job.id, runId: job.runId, vendor: job.requestedVendor });

    // Start heartbeat
    const heartbeatTimer = setInterval(async () => {
      try {
        const ok = await store.heartbeat(job.id, workerId, leaseMs);
        if (!ok) {
          jobLogger.warn("Heartbeat failed — lease may have been stolen");
        }
      } catch (err) {
        jobLogger.error({ err }, "Heartbeat error");
      }
    }, heartbeatIntervalMs);

    try {
      // Check for pre-cancellation
      const fresh = await store.get(job.id);
      if (fresh?.cancelRequested) {
        await store.acknowledgeCancelled(job.id, workerId);
        jobLogger.info("Job cancelled before execution");
        return;
      }

      // -----------------------------------------------------------------------
      // Smart Routing: determine optimal vendor chain for this segment
      // -----------------------------------------------------------------------
      const routingInput: SmartRoutingInput = {
        segmentType: job.request.segmentType,
        creatorPreferredVendor: (job.request.creatorProfile as Record<string, unknown> | undefined)?.preferredVideoVendor as VideoVendor | undefined,
        creatorCompatibleVendors: (job.request.creatorProfile as Record<string, unknown> | undefined)?.compatibleVendors as VideoVendor[] | undefined,
        vendorPolicy: undefined, // TODO: pass from batch config when available on the job
        availableVendors: config.availableVendors ?? detectAvailableVendors(process.env as Record<string, string | undefined>),
        hasIdentityRef: !!job.request.identityRef,
      };

      const routingResult = smartRoute(routingInput);
      const chain = routingResult.chain.length > 0
        ? routingResult.chain
        : resolveChain(job.requestedVendor, config.fallbackConfig);

      // Log routing decision (persisted on the job's routingDecision field at enqueue time;
      // here we log it for observability)
      jobLogger.info({
        routedVendor: routingResult.primaryVendor,
        routingReason: routingResult.routingReason,
        chainLength: chain.length,
      }, "Smart routing resolved");

      let currentVendorIndex = 0;
      let currentVendor: VideoVendor = chain[0] ?? job.requestedVendor;
      let lastClassifiedError: ClassifiedError | undefined;

      // Try each vendor in the chain
      while (currentVendorIndex < chain.length) {
        currentVendor = chain[currentVendorIndex];

        // Check cancellation between vendor attempts
        const check = await store.get(job.id);
        if (check?.cancelRequested) {
          await store.acknowledgeCancelled(job.id, workerId);
          jobLogger.info({ vendor: currentVendor }, "Job cancelled during fallback");
          return;
        }

        // Dry-run gate: never call real providers
        if (config.dryRun) {
          const adapter = getVideoGenAdapter(currentVendor, {
            outDir: config.outDir,
            dryRun: true,
          });
          const clip = await adapter.generate({
            idempotencyKey: job.idempotencyKey,
            scriptSegmentIndex: job.scriptSegmentIndex,
            prompt: job.request.prompt,
            durationSec: job.request.durationSec,
            aspectRatio: job.request.aspectRatio,
            referenceImageUrl: job.request.referenceImageUrl,
            referenceImageDataUri: job.request.referenceImageDataUri,
            identityRef: job.request.identityRef,
          });
          if (!(await settleCompletion(job, clip, currentVendor, 0))) return;
          metrics.jobsCompleted.inc({ vendor: currentVendor, was_fallback: String(currentVendorIndex > 0) });
          jobLogger.info({ vendor: currentVendor, dryRun: true }, "Job completed (dry-run)");
          return;
        }

        // Get the adapter for the current vendor
        const adapter = getAdapterForVendor(currentVendor, jobLogger);
        if (!adapter) {
          // Vendor unavailable (e.g., MCP session down, no credentials)
          jobLogger.warn({ vendor: currentVendor }, "Vendor unavailable, trying fallback");
          metrics.fallbackEvents.inc({
            from_vendor: currentVendor,
            to_vendor: chain[currentVendorIndex + 1] ?? "none",
            reason: "vendor_unavailable",
          });
          currentVendorIndex++;
          continue;
        }

        // Execute generation with timing
        const startTime = Date.now();
        try {
          const clip = await adapter.generate({
            idempotencyKey: job.idempotencyKey,
            scriptSegmentIndex: job.scriptSegmentIndex,
            prompt: job.request.prompt,
            durationSec: job.request.durationSec,
            aspectRatio: job.request.aspectRatio,
            referenceImageUrl: job.request.referenceImageUrl,
            referenceImageDataUri: job.request.referenceImageDataUri,
            identityRef: job.request.identityRef,
          });

          const durationSec = (Date.now() - startTime) / 1000;
          metrics.providerDuration.observe({ vendor: currentVendor, status: "success" }, durationSec);

          // Estimate actual cost (provider-specific pricing)
          const actualCost = estimateCost(currentVendor, job.request.durationSec);
          metrics.providerCost.inc({ vendor: currentVendor }, actualCost);

          if (!(await settleCompletion(
            job,
            clip,
            currentVendor,
            actualCost,
            clip.id
          ))) return;

          const wasFallback = currentVendorIndex > 0;
          metrics.jobsCompleted.inc({ vendor: currentVendor, was_fallback: String(wasFallback) });
          jobLogger.info({
            vendor: currentVendor,
            wasFallback,
            durationSec: durationSec.toFixed(1),
            cost: actualCost,
          }, "Job completed");
          return;
        } catch (err) {
          const durationSec = (Date.now() - startTime) / 1000;
          metrics.providerDuration.observe({ vendor: currentVendor, status: "error" }, durationSec);

          lastClassifiedError = classifyProviderError(err, job.attempt);
          metrics.jobsFailed.inc({ vendor: currentVendor, error_category: lastClassifiedError.category });

          jobLogger.warn({
            vendor: currentVendor,
            category: lastClassifiedError.category,
            retryable: lastClassifiedError.retryable,
            shouldFallback: lastClassifiedError.shouldFallback,
            message: lastClassifiedError.message.slice(0, 200),
          }, "Provider call failed");

          // Non-retryable invalid request — don't try any other vendor either
          if (lastClassifiedError.category === "non_retryable_invalid_request") {
            await store.fail(job.id, workerId, lastClassifiedError.message, false);
            metrics.jobsDeadLettered.inc({ vendor: currentVendor });
            return;
          }

          // Should fallback to next vendor?
          if (lastClassifiedError.shouldFallback && currentVendorIndex < chain.length - 1) {
            metrics.fallbackEvents.inc({
              from_vendor: currentVendor,
              to_vendor: chain[currentVendorIndex + 1],
              reason: lastClassifiedError.category,
            });
            currentVendorIndex++;
            continue;
          }

          // Retryable within same vendor? (only if not at max attempts)
          if (lastClassifiedError.retryable) {
            // Let the store handle retry scheduling
            const updated = await store.fail(job.id, workerId, lastClassifiedError.message, true);
            if (updated?.status === "dead_letter") {
              metrics.jobsDeadLettered.inc({ vendor: currentVendor });
            } else {
              metrics.retryEvents.inc({ vendor: currentVendor, error_category: lastClassifiedError.category });
            }
            return;
          }

          // Non-retryable, try next vendor as fallback
          if (currentVendorIndex < chain.length - 1) {
            metrics.fallbackEvents.inc({
              from_vendor: currentVendor,
              to_vendor: chain[currentVendorIndex + 1],
              reason: lastClassifiedError.category,
            });
            currentVendorIndex++;
            continue;
          }

          // All vendors exhausted
          break;
        }
      }

      // All vendors failed
      const errorMsg = lastClassifiedError?.message ?? "All vendors in fallback chain exhausted";
      await store.fail(job.id, workerId, errorMsg, false, "all_vendors_exhausted");
      metrics.jobsDeadLettered.inc({ vendor: job.requestedVendor });
      jobLogger.error({ chain }, "All vendors exhausted — job dead-lettered");
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  function getAdapterForVendor(vendor: VideoVendor, jobLogger: pino.Logger): VideoGenAdapter | undefined {
    const injected = config.adapterFactory?.(vendor, jobLogger);
    if (injected) return injected;
    try {
      if (vendor === "higgsfield") {
        const caller = mcpSession.getToolCaller();
        if (!caller) {
          jobLogger.warn("MCP session not available for Higgsfield");
          metrics.mcpSessionHealthy.set(0);
          return undefined;
        }
        metrics.mcpSessionHealthy.set(1);
        return getVideoGenAdapter(vendor, {
          outDir: config.outDir,
          dryRun: false,
          callMcpTool: caller,
        });
      }

      return getVideoGenAdapter(vendor, {
        outDir: config.outDir,
        dryRun: false,
      });
    } catch (err) {
      // Missing env vars, etc.
      jobLogger.warn({ vendor, err: (err as Error).message?.slice(0, 200) }, "Cannot create adapter");
      return undefined;
    }
  }

  /**
   * A provider can finish after an operator cancelled the running lease. In
   * that case complete() deliberately returns false; immediately acknowledge
   * the cancellation while we still own the lease so recovery never requeues
   * the already-paid generation. A lost lease is left to its current owner.
   */
  async function settleCompletion(
    job: ProviderJob,
    clip: import("@vvugc/shared-schema").RawClip,
    vendor: VideoVendor,
    actualCost: number,
    providerRequestId?: string
  ): Promise<boolean> {
    const completed = await store.complete(job.id, workerId, clip, vendor, actualCost, providerRequestId);
    if (completed) return true;
    const current = await store.get(job.id);
    if (current?.status === "running" && current.leaseOwner === workerId && current.cancelRequested) {
      await store.acknowledgeCancelled(job.id, workerId);
      jobLoggerFor(job).info("Provider completed after cancellation; cancellation acknowledged without retry");
    }
    return false;
  }

  function jobLoggerFor(job: ProviderJob) {
    return logger.child({ jobId: job.id, runId: job.runId, vendor: job.requestedVendor });
  }

  return { start, stop, isRunning };
}

// ---------------------------------------------------------------------------
// Cost Estimation (per-vendor, rough — actual cost is recorded by the cost ledger)
// ---------------------------------------------------------------------------

function estimateCost(vendor: VideoVendor, durationSec: number): number {
  // These are approximate per-clip costs for budgeting/alerting.
  // The real cost ledger (packages/shared-cost) tracks actual API spend.
  const rates: Record<VideoVendor, number> = {
    seedance: 0.02 * durationSec,    // ~$0.022/sec (fal.ai Fast 480p)
    grok_video: 0.05 * durationSec,  // ~$0.05/sec (xAI API)
    kling: 0.08 * durationSec,       // ~$0.08/sec (720p, no audio)
    higgsfield: 1.20,                // ~$1.20/clip (credit-based aggregator)
    replicate: 0.12 * durationSec,   // ~$0.12/sec (varies by model)
    runway: 0.05 * durationSec,      // ~$0.05/sec (Gen-4 Turbo)
    pika: 0.05 * durationSec,        // ~$0.05/sec via fal.ai
    gemini: 0.04,                    // still image only (flat per image)
    wan: 0.10 * durationSec,         // ~$0.10/sec at 720p (Replicate alibaba/wan-3)
    nvidia: 0.10 * durationSec,  // ~rough estimate; NVIDIA NIM cost depends on hosted-credit vs self-hosted-GPU deployment
  };
  return rates[vendor] ?? 0.10;
}
