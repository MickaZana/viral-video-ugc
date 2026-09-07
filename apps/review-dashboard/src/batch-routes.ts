/**
 * Batch Variation Generation — Atoms C, D, E
 *
 * C: Batch Job Orchestration — POST /plan, POST /enqueue, GET /progress, POST /cancel, GET /variations
 * D: Cost/Quota Controls — checkRunQuota + overage enforcement, maxEstimatedCostUsd hard cap, VVUGC_LLM_LIVE gate
 * E: Review Grouping — batch metadata on ReviewItems, queue-listing filters by batch/product/creator/template
 *
 * Registered by server.ts under the /accounts/batch prefix, behind the auth gate.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Express, Request, RequestHandler, Response } from "express";
import pino from "pino";

import {
  type ProviderJobStore,
  type ProviderJobEnqueueInput,
  createInMemoryProviderJobStore,
  getConfiguredPostgresProviderJobStore,
  listReviewItems,
} from "@vvugc/review-queue";
import {
  BatchRequestSchema,
  type BatchPlan,
  type BatchProgress,
  type BatchRequest,
  type BatchVariation,
  type BatchVariationStatus,
  HARD_LIMITS,
} from "@vvugc/shared-schema";
import { planBatch, type EntityLookup } from "@vvugc/shared-schema";
import {
  aggregateUsage,
} from "@vvugc/shared-auth";
import { createPlanStore } from "@vvugc/shared-billing";
import { loadEnv } from "@vvugc/shared-config";
import { getUgcTemplate, BUILTIN_UGC_TEMPLATES, planBatchFromDescription, type BatchPlannerContext } from "@vvugc/orchestrator";

import { createProductEventStore } from "@vvugc/shared-product-analytics";

import { checkRunQuota } from "./quota.js";
import { createOverageStore } from "./overage.js";
import { isLLMLive, isRealRun } from "./llm-gate.js";
import type { AuthedRequest } from "./accounts.js";
import type { IdentityRepository } from "./accounts.js";
import type { TenantProfileRepository } from "./tenant-profile-postgres.js";

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = pino({ name: "vvugc-batch-routes" });

// ─── asyncHandler (mirrors server.ts pattern) ────────────────────────────────
function asyncHandler<P = Record<string, string>>(
  fn: (req: Request<P>, res: Response) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// ─── In-memory batch state (maps batchId → batch metadata) ───────────────────
// In production this would be backed by Postgres; for now the in-memory map
// mirrors the existing ProviderJobStore pattern (see provider-jobs.ts).
interface BatchRecord {
  batchId: string;
  orgId: string;
  clientId: string;
  plan: BatchPlan;
  request: BatchRequest;
  status: "active" | "cancelled";
  startedAt: string;
  updatedAt: string;
}

const batches = new Map<string, BatchRecord>();

// ─── Provider job store singleton (same pattern as jobs.ts) ──────────────────
let providerJobStore: ProviderJobStore | undefined;
async function getProviderJobStore(): Promise<ProviderJobStore> {
  if (!providerJobStore) {
    // Never let an enabled dashboard route hand memory-resident work to a
    // PostgreSQL worker. Production missing DATABASE_URL rejects here; local
    // development remains intentionally in-memory for this still-disabled UI.
    providerJobStore = await getConfiguredPostgresProviderJobStore()
      ?? createInMemoryProviderJobStore();
  }
  return providerJobStore;
}

/** Startup hook for any deployment that elects to enable batch routes. */
export async function initializeBatchProviderJobStore(): Promise<ProviderJobStore> {
  return getProviderJobStore();
}

/** Allow test/DI override. */
export function setProviderJobStore(store: ProviderJobStore): void {
  providerJobStore = store;
}

// ─── Entity Lookup wired to real stores (Atom C) ─────────────────────────────
function createEntityLookup(orgId: string, profiles: TenantProfileRepository): EntityLookup {
  return {
    async productProfileExists(id: string) {
      return (await profiles.productGet(orgId, id)) !== undefined;
    },
    async creatorProfileExists(id: string) {
      const creator = await profiles.creatorGet(orgId, id);
      return creator !== undefined && creator.active;
    },
    templateExists(id: string) {
      return getUgcTemplate(id) !== undefined;
    },
    visualTreatmentExists(_id: string) {
      // Visual treatments are a future feature — accept all for now.
      return true;
    },
  };
}

// ─── Route Registration ──────────────────────────────────────────────────────
export function registerBatchRoutes(
  app: Express,
  requireSession: RequestHandler,
  deps: { identity: IdentityRepository; tenantProfiles: TenantProfileRepository }
): void {
  // Same product-events file registerAccountRoutes writes to (accounts.ts) —
  // the store is a stateless file-backed wrapper, so a second instance pointed
  // at the same path is safe; see @vvugc/shared-product-analytics.
  const productEvents = createProductEventStore(join(loadEnv().VVUGC_RUNS_DIR, "product-events.json"));

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /accounts/batch/plan-from-description
  // Natural-language front end to the structured planner below: turns a plain-
  // language description ("a week of fitness content for my protein brand,
  // TikTok and Reels") into a DRAFT AiBatchPlanInput for the caller to review
  // and edit in the existing BatchStudio form — it never plans or enqueues
  // anything itself. Same governance gate as every other real-LLM-call route
  // (isRealRun): without VVUGC_LLM_LIVE + an explicit live intent, this runs
  // the deterministic dry-run mock draft instead of a real Claude call.
  // ═══════════════════════════════════════════════════════════════════════════
  app.post(
    "/accounts/batch/plan-from-description",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res) => {
      const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
      if (!description) {
        return res.status(400).json({ error: "'description' (non-empty string) is required" });
      }
      const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;

      const account = await deps.identity.findById(req.accountId!);
      if (!account) return res.status(401).json({ error: "account not found" });
      const orgId = account.orgId;

      const [products, creators] = await Promise.all([
        deps.tenantProfiles.productList(orgId, clientId),
        deps.tenantProfiles.creatorList(orgId, clientId),
      ]);
      const context: BatchPlannerContext = {
        products: products.map((p) => ({ id: p.id, name: p.name })),
        templates: BUILTIN_UGC_TEMPLATES.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name })),
        creators: creators.filter((c) => c.active).map((c) => ({ id: c.id, name: c.displayName })),
      };

      try {
        const draft = await planBatchFromDescription(description, context, { dryRun: !isRealRun(req) });
        logger.info(
          { orgId, dropped: draft.droppedInvalidIds.length, isDryRun: !isRealRun(req) },
          "batch plan drafted from natural-language description"
        );
        res.json(draft);
      } catch (err) {
        logger.error({ orgId, err }, "batch plan-from-description failed");
        res.status(502).json({ error: err instanceof Error ? err.message : "failed to draft a batch plan" });
      }
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /accounts/batch/plan
  // Accepts BatchRequest, validates entities, runs the planner, returns
  // BatchPlan with cost estimate. No money spent. Requires auth.
  // ═══════════════════════════════════════════════════════════════════════════
  app.post(
    "/accounts/batch/plan",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res) => {
      const parsed = BatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid batch request",
          details: parsed.error.issues,
        });
      }

      const request = parsed.data;
      const batchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // P0 FIX: NEVER trust client-supplied orgId. Derive from session.
      const account = await deps.identity.findById((req as AuthedRequest).accountId!);
      if (!account) return res.status(401).json({ error: "account not found" });
      const orgId = account.orgId;

      // Tenant isolation: server-derived orgId is authoritative.
      // The request body may contain orgId for backward compat but it's ignored.
      logger.info({ batchId, orgId, variations: "planning" }, "batch plan requested");

      const lookup = createEntityLookup(orgId, deps.tenantProfiles);
      const plan = await planBatch({ batchId, request, lookup });

      logger.info(
        {
          batchId,
          variationCount: plan.variations.length,
          totalEstimatedCost: plan.totalEstimatedCost,
          warnings: plan.warnings.length,
          rejected: plan.rejected.length,
        },
        "batch plan computed"
      );

      productEvents.record({ orgId, accountId: account.id, eventType: "batch_planned", meta: { variationCount: plan.variations.length } });
      res.json(plan);
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /accounts/batch/enqueue
  // Accepts a confirmed BatchPlan (after user reviews cost), checks quota,
  // enqueues provider jobs, returns batchId. Async — returns immediately.
  // ═══════════════════════════════════════════════════════════════════════════
  app.post(
    "/accounts/batch/enqueue",
    requireSession,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { plan, request } = req.body ?? {};

      // Validate inputs
      if (!plan || typeof plan !== "object" || !plan.batchId || !Array.isArray(plan.variations)) {
        return res.status(400).json({ error: "a valid BatchPlan object is required in request body as 'plan'" });
      }
      const requestParsed = BatchRequestSchema.safeParse(request);
      if (!requestParsed.success) {
        return res.status(400).json({
          error: "the original BatchRequest is required in request body as 'request'",
          details: requestParsed.error.issues,
        });
      }

      const batchPlan = plan as BatchPlan;
      const batchRequest = requestParsed.data;
      const batchId = batchPlan.batchId;
      // P0 FIX: Derive orgId from session, never from request body
      const acct2 = await deps.identity.findById((req as AuthedRequest).accountId!);
      if (!acct2) return res.status(401).json({ error: "account not found" });
      const orgId = acct2.orgId;
      const clientId = batchRequest.clientId;

      // ── Gate: VVUGC_LLM_LIVE / dryRun ──────────────────────────────────
      const isDryRun = batchRequest.dryRun || !isLLMLive();
      if (!isDryRun && !isLLMLive()) {
        return res.status(403).json({
          error: "live batch execution is disabled — VVUGC_LLM_LIVE is not set to true",
        });
      }

      // ── Gate: maxEstimatedCostUsd hard cap ──────────────────────────────
      if (batchPlan.totalEstimatedCost > batchRequest.maxEstimatedCostUsd) {
        return res.status(400).json({
          error: `estimated cost $${batchPlan.totalEstimatedCost.toFixed(2)} exceeds maxEstimatedCostUsd=$${batchRequest.maxEstimatedCostUsd.toFixed(2)}`,
        });
      }
      if (batchPlan.totalEstimatedCost > HARD_LIMITS.MAX_ESTIMATED_SPEND_USD) {
        return res.status(400).json({
          error: `estimated cost $${batchPlan.totalEstimatedCost.toFixed(2)} exceeds absolute hard limit of $${HARD_LIMITS.MAX_ESTIMATED_SPEND_USD}`,
        });
      }

      // ── Gate: Quota check (per-run quota applied per-batch) ─────────────
      const { VVUGC_RUNS_DIR } = loadEnv();
      const planStore = createPlanStore(join(VVUGC_RUNS_DIR, "account-plans.json"));
      const accountPlan = planStore.get(orgId);
      const usage = aggregateUsage(orgId, VVUGC_RUNS_DIR);
      const quotaCheck = checkRunQuota(accountPlan, usage);

      // Quota is hybrid (overage-based) so we never hard-block, but we record
      // overage for billing. The check is here so the caller knows upfront.
      if (quotaCheck.overage && quotaCheck.overagePriceUsdPerRun !== undefined) {
        logger.info(
          { batchId, orgId, overagePriceUsdPerRun: quotaCheck.overagePriceUsdPerRun },
          "batch enqueue will incur overage charges"
        );
      }

      // ── Reject if plan had rejections ───────────────────────────────────
      if (batchPlan.rejected.length > 0) {
        return res.status(400).json({
          error: "plan contains rejections — cannot enqueue",
          rejected: batchPlan.rejected,
        });
      }

      if (batchPlan.variations.length === 0) {
        return res.status(400).json({ error: "plan contains no variations to enqueue" });
      }

      // ── Store batch record ──────────────────────────────────────────────
      const now = new Date().toISOString();
      const batchRecord: BatchRecord = {
        batchId,
        orgId,
        clientId,
        plan: batchPlan,
        request: batchRequest,
        status: "active",
        startedAt: now,
        updatedAt: now,
      };
      batches.set(batchId, batchRecord);

      // ── Enqueue provider jobs (one per variation) ───────────────────────
      const store = await getProviderJobStore();
      const enqueuePromises: Promise<unknown>[] = [];

      for (let i = 0; i < batchPlan.variations.length; i++) {
        const variation = batchPlan.variations[i];
        const input: ProviderJobEnqueueInput = {
          orgId,
          clientId,
          runId: batchId, // batch acts as the "run" for provider jobs
          candidateId: variation.variationId,
          platform: variation.platform,
          scriptSegmentIndex: 0, // batch variations are full clips, not segments
          requestedVendor: variation.vendor,
          fallbackVendors: [], // vendor policy already resolved in planning
          maxAttempts: HARD_LIMITS.MAX_RETRIES_PER_VARIATION,
          idempotencyKey: variation.idempotencyKey,
          estimatedCost: variation.estimatedCost,
          dryRun: isDryRun,
          request: {
            prompt: `Batch variation ${variation.variationLabel} for product ${variation.productProfileId}`,
            durationSec: batchRequest.targetDurationSec,
            aspectRatio: "9:16",
          },
        };
        enqueuePromises.push(store.enqueue(input));
      }

      // Fire-and-forget the enqueue (async — return immediately with batchId)
      Promise.all(enqueuePromises)
        .then(() => {
          logger.info(
            { batchId, variationCount: batchPlan.variations.length, isDryRun },
            "batch variations enqueued successfully"
          );
        })
        .catch((err) => {
          logger.error({ batchId, err }, "batch enqueue partial failure");
        });

      // ── Record overage if applicable ────────────────────────────────────
      if (quotaCheck.overage && quotaCheck.overagePriceUsdPerRun !== undefined) {
        const overageStore = createOverageStore(join(VVUGC_RUNS_DIR, "overage.json"));
        overageStore.record({
          orgId,
          runId: batchId,
          priceUsdPerRun: quotaCheck.overagePriceUsdPerRun,
          estimatedVendorCostUsd: batchPlan.totalEstimatedCost,
          clientId,
        });
      }

      productEvents.record({ orgId, accountId: acct2.id, eventType: "batch_enqueued", meta: { variationCount: batchPlan.variations.length, isDryRun } });

      // Return immediately — async pattern
      res.status(202).json({
        batchId,
        variationCount: batchPlan.variations.length,
        totalEstimatedCost: batchPlan.totalEstimatedCost,
        isDryRun,
        overage: quotaCheck.overage,
        overagePriceUsdPerRun: quotaCheck.overagePriceUsdPerRun,
        message: "batch enqueued — poll GET /accounts/batch/:batchId/progress for status",
      });
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /accounts/batch/:batchId/progress
  // Returns BatchProgress (counts + costs).
  // ═══════════════════════════════════════════════════════════════════════════
  app.get(
    "/accounts/batch/:batchId/progress",
    requireSession,
    asyncHandler<{ batchId: string }>(async (req, res) => {
      const { batchId } = req.params;
      const batch = batches.get(batchId);
      if (!batch) {
        return res.status(404).json({ error: "batch not found" });
      }

      // Aggregate job statuses from the provider job store
      const store = await getProviderJobStore();
      const jobs = await store.listByRun(batch.orgId, batchId);

      const counts: Record<BatchVariationStatus, number> = {
        planned: 0,
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };

      let totalActualCost = 0;

      for (const job of jobs) {
        switch (job.status) {
          case "queued":
            counts.queued++;
            break;
          case "running":
            counts.running++;
            break;
          case "completed":
            counts.completed++;
            totalActualCost += job.actualCost ?? job.estimatedCost ?? 0;
            break;
          case "failed":
          case "dead_letter":
            counts.failed++;
            break;
          case "cancelled":
            counts.cancelled++;
            break;
        }
      }

      // Variations in the plan that haven't been matched to a job yet are "planned"
      counts.planned = Math.max(0, batch.plan.variations.length - jobs.length);

      const progress: BatchProgress = {
        batchId,
        planned: counts.planned,
        queued: counts.queued,
        running: counts.running,
        completed: counts.completed,
        failed: counts.failed,
        cancelled: counts.cancelled,
        totalVariations: batch.plan.variations.length,
        totalEstimatedCost: batch.plan.totalEstimatedCost,
        totalActualCost: Number(totalActualCost.toFixed(4)),
        startedAt: batch.startedAt,
        updatedAt: new Date().toISOString(),
      };

      res.json(progress);
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /accounts/batch/:batchId/cancel
  // Cancels queued variations, requests cancellation for running ones.
  // ═══════════════════════════════════════════════════════════════════════════
  app.post(
    "/accounts/batch/:batchId/cancel",
    requireSession,
    asyncHandler<{ batchId: string }>(async (req, res) => {
      const { batchId } = req.params;
      const batch = batches.get(batchId);
      if (!batch) {
        return res.status(404).json({ error: "batch not found" });
      }

      if (batch.status === "cancelled") {
        return res.status(409).json({ error: "batch is already cancelled" });
      }

      const store = await getProviderJobStore();
      const jobs = await store.listByRun(batch.orgId, batchId);

      let cancelledCount = 0;
      let cancelRequestedCount = 0;

      for (const job of jobs) {
        if (job.status === "queued" || job.status === "running") {
          const cancelled = await store.cancel(job.id);
          if (cancelled) {
            if (job.status === "queued") cancelledCount++;
            else cancelRequestedCount++;
          }
        }
      }

      batch.status = "cancelled";
      batch.updatedAt = new Date().toISOString();

      logger.info(
        { batchId, cancelledCount, cancelRequestedCount },
        "batch cancellation processed"
      );

      res.json({
        batchId,
        cancelledCount,
        cancelRequestedCount,
        message: `Cancelled ${cancelledCount} queued variations, requested cancellation for ${cancelRequestedCount} running variations.`,
      });
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /accounts/batch/:batchId/variations
  // List all variations with status/cost/vendor metadata.
  // ═══════════════════════════════════════════════════════════════════════════
  app.get(
    "/accounts/batch/:batchId/variations",
    requireSession,
    asyncHandler<{ batchId: string }>(async (req, res) => {
      const { batchId } = req.params;
      const batch = batches.get(batchId);
      if (!batch) {
        return res.status(404).json({ error: "batch not found" });
      }

      const store = await getProviderJobStore();
      const jobs = await store.listByRun(batch.orgId, batchId);

      // Build a map of candidateId (variationId) → job for quick lookup
      const jobByVariation = new Map(jobs.map((j) => [j.candidateId, j]));

      const variations = batch.plan.variations.map((v, index) => {
        const job = jobByVariation.get(v.variationId);
        return {
          variationId: v.variationId,
          variationLabel: v.variationLabel,
          batchIndex: index,
          batchTotal: batch.plan.variations.length,
          productProfileId: v.productProfileId,
          creatorProfileId: v.creatorProfileId,
          templateId: v.templateId,
          hookIndex: v.hookIndex,
          scriptIndex: v.scriptIndex,
          visualTreatment: v.visualTreatment,
          captionStyle: v.captionStyle,
          ctaVariant: v.ctaVariant,
          platform: v.platform,
          plannedVendor: v.vendor,
          actualVendor: job?.actualVendor ?? undefined,
          fallbackUsed: job?.actualVendor ? job.actualVendor !== v.vendor : false,
          estimatedCost: v.estimatedCost,
          actualCost: job?.actualCost ?? undefined,
          status: mapJobStatusToVariationStatus(job?.status),
          providerRequestId: job?.providerRequestId,
          lastError: job?.lastError,
          idempotencyKey: v.idempotencyKey,
        };
      });

      res.json({ batchId, variations });
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /queue — extended filters (Atom E: Review Grouping)
  // The existing /queue endpoint in server.ts supports status/platform/niche/dryRun.
  // We add a parallel endpoint that supports batch-specific filters. This is
  // registered as /accounts/batch/queue so it doesn't conflict with the existing
  // /queue route — or the caller can use the existing /queue with additional
  // query params if the review-queue store is extended.
  // ═══════════════════════════════════════════════════════════════════════════
  app.get(
    "/accounts/batch/queue",
    requireSession,
    asyncHandler(async (req, res) => {
      // Fetch all review items and apply batch-metadata filters client-side
      // (the underlying store's ReviewItemFilter doesn't have batch fields yet,
      // so we filter in-memory after fetching — acceptable for the current
      // scale; a Postgres-backed store would push these into SQL).
      const items = await listReviewItems();

      const batchIdFilter = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
      const productProfileIdFilter = typeof req.query.productProfileId === "string" ? req.query.productProfileId : undefined;
      const creatorProfileIdFilter = typeof req.query.creatorProfileId === "string" ? req.query.creatorProfileId : undefined;
      const templateIdFilter = typeof req.query.templateId === "string" ? req.query.templateId : undefined;

      const filtered = items.filter((item) => {
        // Use the batch metadata fields attached during QA completion (Atom E)
        const meta = (item as ReviewItemWithBatchMeta);
        if (batchIdFilter && meta.batchId !== batchIdFilter) return false;
        if (productProfileIdFilter && item.productProfileId !== productProfileIdFilter) return false;
        if (creatorProfileIdFilter && meta.creatorProfileId !== creatorProfileIdFilter) return false;
        if (templateIdFilter && item.templateId !== templateIdFilter) return false;
        return true;
      });

      res.json(filtered);
    })
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Maps the ProviderJob status to BatchVariationStatus for the variations endpoint. */
function mapJobStatusToVariationStatus(
  jobStatus: string | undefined
): BatchVariationStatus {
  switch (jobStatus) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "dead_letter":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "planned";
  }
}

// ─── Batch Metadata on ReviewItems (Atom E: Review Grouping) ─────────────────
// These fields are attached when a variation completes QA and enters the review
// queue. The type extends ReviewItem with batch-specific metadata.

export interface BatchMetadataFields {
  batchId: string;
  variationId: string;
  variationLabel: string;
  productProfileId: string;
  creatorProfileId?: string;
  templateId?: string;
  hookVariant: number;
  visualTreatment?: string;
  ctaVariant?: string;
  plannedVendor: string;
  actualVendor?: string;
  fallbackUsed: boolean;
  batchIndex: number;
  batchTotal: number;
}

/** ReviewItem extended with batch metadata. Use this type in the insertion path
 *  when a batch variation completes QA. */
export type ReviewItemWithBatchMeta = import("@vvugc/shared-schema").ReviewItem & BatchMetadataFields;

/**
 * Build batch metadata to attach to a ReviewItem when a batch variation
 * completes QA and enters the review queue. Call this from the batch worker
 * after QA passes, and spread the result onto the ReviewItem before insertion.
 */
export function buildBatchMetadata(
  batchId: string,
  variation: BatchVariation,
  batchIndex: number,
  batchTotal: number,
  actualVendor?: string,
  fallbackUsed = false
): BatchMetadataFields {
  return {
    batchId,
    variationId: variation.variationId,
    variationLabel: variation.variationLabel,
    productProfileId: variation.productProfileId,
    creatorProfileId: variation.creatorProfileId,
    templateId: variation.templateId,
    hookVariant: variation.hookIndex,
    visualTreatment: variation.visualTreatment,
    ctaVariant: variation.ctaVariant,
    plannedVendor: variation.vendor,
    actualVendor: actualVendor ?? variation.vendor,
    fallbackUsed,
    batchIndex,
    batchTotal,
  };
}
