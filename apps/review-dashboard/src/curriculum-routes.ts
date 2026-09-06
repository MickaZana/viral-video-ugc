/**
 * Curriculum Routes — Curriculum Mode v2 course CRUD
 *
 * GET    /accounts/curricula                         — list the caller's org's courses
 * POST   /accounts/curricula                         — create a draft course
 * GET    /accounts/curricula/:courseId               — one course + child-row counts
 * PUT    /accounts/curricula/:courseId               — edit a course while it's still structurally editable
 * DELETE /accounts/curricula/:courseId               — delete a course (cascades in the store)
 * POST   /accounts/curricula/:courseId/generate-plan — architect a plan (mock by default) + persist it
 * POST   /accounts/curricula/:courseId/approve       — QA the persisted plan, snapshot a version, lock the course
 * GET    /accounts/curricula/:courseId/modules                 — the course's modules + per-module lesson count / project flag
 * GET    /accounts/curricula/:courseId/modules/:moduleId       — one module + its lessons + its project
 * GET    /accounts/curricula/:courseId/lessons/:lessonId       — one lesson
 * PUT    /accounts/curricula/:courseId/modules/:moduleId       — field-granular patch of a module's content
 * PUT    /accounts/curricula/:courseId/lessons/:lessonId       — field-granular patch of a lesson's content (allowed post-lock)
 * POST   /accounts/curricula/:courseId/lessons/:lessonId/script          — generate a lesson's short script (mock by default)
 * POST   /accounts/curricula/:courseId/modules/:moduleId/long-form-script — generate a module's long-form script (mock by default)
 * POST   /accounts/curricula/:courseId/lessons/:lessonId/knowledge-check     — generate a lesson's knowledge-check questions (mock by default), Learn Mode §19
 * POST   /accounts/curricula/:courseId/lessons/:lessonId/produce — hand a lesson's shortScript to the existing VUGC pipeline (dry-run by default) + record a CurriculumAsset (§34/§59)
 * POST   /accounts/curricula/:courseId/modules/:moduleId/produce-long-form — hand a module's longFormScript to the existing VUGC pipeline (dry-run by default, 60s-capped render) + record a long_video CurriculumAsset (§G/§24)
 * POST   /accounts/curricula/:courseId/modules/:moduleId/queue  — batch-produce every scripted, not-yet-produced lesson in a module with bounded concurrency + the course spend cap (§J)
 * POST   /accounts/curricula/:courseId/queue-approved           — batch-produce every scripted, not-yet-produced lesson of an approved course with bounded concurrency + the course spend cap (§J)
 * POST   /accounts/curricula/:courseId/cost-estimate            — pure-arithmetic list-price cost preview for a course/module/lesson (no LLM, no pipeline), with spend-cap visibility (§J)
 * GET    /accounts/curricula/:courseId/assets                    — list the CurriculumAssets produced for a course
 * GET    /accounts/curricula/today                              — the caller's daily learning surface: next uncompleted lesson per active course (Learn Mode §20/§49)
 * POST   /accounts/curricula/:courseId/lessons/:lessonId/complete — the calling learner marks a lesson complete (optionally scoring its knowledge-check) (Learn Mode §48)
 * GET    /accounts/curricula/:courseId/progress                 — the calling learner's per-course learning / production / publishing progress (Learn Mode §49/§50)
 *
 * Structural fields (order / moduleId / *Order) are never patchable — reordering
 * needs a new version.
 * All routes are org-scoped: another org's courseId is invisible (404), never
 * cross-tenant readable.
 */

import { randomUUID } from "node:crypto";
import type { Express, Response, RequestHandler } from "express";
import pino from "pino";
import { z } from "zod";
import { resolveOrgId, roleHasPermission, type AccountPermission, type AccountSettings } from "@vvugc/shared-auth";
import {
  buildMockCurriculumPlan,
  generateCurriculumPlan,
  buildMockLessonScript,
  generateLessonScript,
  buildMockModuleLongForm,
  generateModuleLongForm,
  buildMockKnowledgeCheck,
  generateKnowledgeCheck,
  runCycle,
  type LessonScriptContext,
  type KnowledgeCheckContext
} from "@vvugc/orchestrator";
import { RunConfigSchema } from "@vvugc/shared-schema";
import { listReviewItems } from "@vvugc/review-queue";
import { estimateCostUsd } from "@vvugc/shared-cost";
import { CostCap, CostCapExceededError, FlowLimiter, Semaphore } from "@vvugc/shared-analytics";
import { jaccardSimilarityPct, tokenize } from "@vvugc/shared-originality";
import {
  slugify,
  runCurriculumQa,
  toCurriculumPlan,
  SEED_AGENTIC_AI,
  CurriculumPlanRequestSchema,
  KnowledgeCheckQuestionSchema,
  ModuleStatusSchema,
  ContentStatusSchema,
  AssetTypeSchema,
  AssetStatusSchema,
  type CurriculumAssetFilter,
  type CurriculumAsset,
  type CurriculumCourse,
  type CurriculumCourseInput,
  type CurriculumLesson,
  type CurriculumModule
} from "@vvugc/curriculum-engine";
import type { AuthedRequest } from "./accounts.js";
import type { TenantProfileRepository } from "./tenant-profile-postgres.js";

const logger = pino({ name: "curriculum" });

/**
 * Course-creation input. Mirrors the `SettingsInputSchema` style in accounts.ts
 * (local zod schema, `.trim()` + bounds on every string, `.default(...)` for the
 * optional knobs). The store stamps id/orgId/status/activeVersion/timestamps —
 * they are never part of this shape.
 */
const CurriculumCourseCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topic: z.string().trim().min(1).max(200),
  description: z.string().trim().max(3000).optional(),
  audience: z.string().trim().min(1).max(500),
  startingKnowledge: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  endGoal: z.string().trim().min(1).max(1000),
  language: z.string().trim().min(2).max(35).default("en"),
  moduleCount: z.number().int().min(1).max(50).default(20),
  lessonsPerModule: z.number().int().min(1).max(20).default(10),
  shortDurationSec: z.number().int().min(15).max(180).default(60),
  longFormTargetMin: z.number().int().min(3).max(60).default(12),
  maxGenerationSpendUsd: z.number().min(0).max(100000).nullable().default(50)
});

/** Every field optional — a PUT patches whatever it names and leaves the rest. */
const CurriculumCourseUpdateSchema = CurriculumCourseCreateSchema.partial();

/** Course statuses that still allow structural edits. Anything past this is
 *  locked — a further edit means a new version, not an in-place mutation. */
const EDITABLE_STATUSES: readonly string[] = ["draft", "planning", "planned"];

/** The plan-request knobs a generate-plan call may override, straight off the
 *  architect's own request schema (same bounds) — everything else in the request
 *  is taken verbatim from the course row. */
const PlanOverridesSchema = CurriculumPlanRequestSchema.pick({
  moduleCount: true,
  lessonsPerModule: true,
  shortDurationSec: true,
  longFormTargetMin: true,
  audience: true,
  startingKnowledge: true,
  endGoal: true,
  language: true
}).partial();

/** Body for POST .../generate-plan. `live` only reaches the real LLM when the
 *  server also has VVUGC_LLM_LIVE=true; otherwise the deterministic mock runs. */
const GeneratePlanBodySchema = z.object({
  seed: z.enum(["agentic-ai"]).optional(),
  live: z.boolean().default(false),
  overrides: PlanOverridesSchema.optional()
});

/**
 * Body for PUT .../modules/:moduleId — every field optional, only the named ones
 * change (the store does a field-granular merge). `order` is deliberately absent:
 * it is structural, and reordering modules means a new course version.
 */
const CurriculumModulePatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(3000).optional(),
  goal: z.string().trim().max(2000).optional(),
  prerequisites: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  learningObjectives: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  concepts: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  status: ModuleStatusSchema.optional()
});

/**
 * Body for PUT .../lessons/:lessonId — every field optional, field-granular merge
 * in the store (a patch of just `explanation` never clears `shortScript`).
 * `moduleId` / `globalOrder` / `moduleOrder` / `lessonOrder` are structural and
 * not accepted here. `codeExample` is not trimmed — leading indentation matters.
 */
const CurriculumLessonPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  learningObjective: z.string().trim().min(1).max(2000).optional(),
  prerequisites: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  concepts: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  explanation: z.string().trim().max(20000).optional(),
  example: z.string().trim().max(20000).optional(),
  exercise: z.string().trim().max(20000).optional(),
  keyTakeaway: z.string().trim().max(4000).optional(),
  nextLessonHook: z.string().trim().max(2000).optional(),
  shortScript: z.string().trim().max(20000).optional(),
  visualPlan: z.string().trim().max(10000).optional(),
  codeExample: z.string().max(30000).optional(),
  knowledgeCheck: z.array(KnowledgeCheckQuestionSchema).max(20).optional(),
  status: ContentStatusSchema.optional()
});

/** Body for the two script-generation routes. `live` only reaches the real LLM
 *  when the server also has VVUGC_LLM_LIVE=true; otherwise the deterministic mock
 *  builder runs (same gate as generate-plan). */
const ScriptGenerateBodySchema = z.object({ live: z.boolean().default(false) });

/** Body for POST .../lessons/:lessonId/knowledge-check (Learn Mode §19). Same
 *  live-gate as the script routes; `count` bounds how many questions the
 *  generator emits (mock or live). */
const KnowledgeCheckBodySchema = z.object({
  live: z.boolean().default(false),
  count: z.number().int().min(1).max(10).default(3)
});

/** Body for POST .../lessons/:lessonId/produce. Same live-gate as every other
 *  curriculum route: a real (paid) pipeline run needs `live: true` here AND the
 *  server's VVUGC_LLM_LIVE=true; anything short of both is a dry-run. */
const ProduceBodySchema = z.object({ live: z.boolean().default(false) });

/**
 * Body for the two §J batch-produce queue routes
 * (POST .../modules/:moduleId/queue and POST .../queue-approved). `live` follows
 * the same double-gate as every other curriculum route (needs the server's
 * VVUGC_LLM_LIVE=true too). `maxConcurrent` bounds how many lesson production
 * runs are in flight at once — the whole point of §J: a 200-lesson course must
 * never launch 200 `runCycle` calls simultaneously.
 */
const QueueBodySchema = z.object({
  live: z.boolean().default(false),
  maxConcurrent: z.number().int().min(1).max(8).default(3)
});

/**
 * Body for POST .../cost-estimate (§J). `scope` picks the breadth of the
 * preview; `module`/`lesson` scope each need their own id (a 400 otherwise).
 */
const CostEstimateBodySchema = z.object({
  scope: z.enum(["course", "module", "lesson"]).default("course"),
  moduleId: z.string().trim().min(1).optional(),
  lessonId: z.string().trim().min(1).optional()
});

// ─── §J cost-preview constants — list-price assumptions, all pure arithmetic ──
/** Prompt tokens assumed for one lesson's short-script generation (claude-sonnet-5). */
const SCRIPT_PROMPT_TOKENS = 1500;
/** Output tokens assumed for one lesson's short script (claude-sonnet-5). */
const SCRIPT_OUTPUT_TOKENS = 700;
/** Seconds of finished short-form video assumed per generated clip. */
const SECONDS_PER_CLIP = 5;
/** Narration characters assumed per second of short-form video (voiceover sizing). */
const CHARS_PER_SECOND = 18;
/** Prompt tokens assumed for one module's long-form script generation (claude-sonnet-5). */
const LONGFORM_PROMPT_TOKENS = 4000;
/** Output tokens assumed per minute of long-form narration (claude-sonnet-5). */
const LONGFORM_OUTPUT_TOKENS_PER_MIN = 150;

/** Query filter for GET .../assets — every facet optional, mirrors CurriculumAssetFilter. */
const AssetListQuerySchema = z.object({
  lessonId: z.string().trim().min(1).optional(),
  moduleId: z.string().trim().min(1).optional(),
  assetType: AssetTypeSchema.optional(),
  status: AssetStatusSchema.optional()
});

/** §23 repetition threshold — a generated lesson script above this Jaccard
 *  token-similarity against another scripted lesson in the same course is
 *  flagged for a human (no auto-regenerate loop in v2, just the flag). */
const REPETITION_FLAG_PCT = 55;

/**
 * Body for POST .../lessons/:lessonId/complete (Learn Mode §48). Either an
 * explicit `knowledgeCheckScore` (0..100), or `answers` (one integer choice per
 * knowledge-check question, index-aligned) that the route scores against the
 * lesson's MCQ answer key. An explicit score always wins over a computed one.
 */
const LessonCompleteBodySchema = z.object({
  knowledgeCheckScore: z.number().min(0).max(100).optional(),
  answers: z.array(z.number().int()).max(50).optional()
});

/** §50 "production completion": a lesson counts as scripted once its content
 *  lifecycle has moved past draft/approved. */
const SCRIPTED_LESSON_STATUSES: readonly string[] = [
  "scripted",
  "queued",
  "generated",
  "review",
  "published"
];

/** §50 "production completion": an asset counts as produced once it has reached
 *  a review-or-later state. */
const PRODUCED_ASSET_STATUSES: readonly string[] = ["review", "generated", "approved", "published"];

// ─── §J batch-produce queue — bounded-concurrency, spend-capped mass produce ──
// "Never launch 200 expensive jobs simultaneously." Two module-private helpers
// below are shared by POST .../modules/:moduleId/queue and POST .../queue-approved
// (and by nothing else — the single-lesson produce route is left untouched).

/**
 * Per-lesson list-price estimate for one batch-queue produce run — the exact J1
 * cost-estimate arithmetic (script tokens + video clips + narration characters)
 * folded down to a single lesson, so the §J campaign spend cap can be applied
 * lesson-by-lesson as the batch is planned. Rounded to 4dp like the J1 route.
 */
function estimateLessonProduceUsd(
  course: CurriculumCourse,
  lesson: CurriculumLesson,
  settings: AccountSettings
): number {
  const scriptUsd =
    estimateCostUsd("anthropic", "input_tokens", SCRIPT_PROMPT_TOKENS, "claude-sonnet-5") +
    estimateCostUsd("anthropic", "output_tokens", SCRIPT_OUTPUT_TOKENS, "claude-sonnet-5");
  const clips = Math.max(1, Math.ceil(Math.min(course.shortDurationSec, 60) / SECONDS_PER_CLIP));
  const videoUsd = estimateCostUsd(settings.videoVendor, "clip", clips);
  const voiceChars = lesson.shortScript
    ? lesson.shortScript.length
    : Math.round(course.shortDurationSec * CHARS_PER_SECOND);
  const voiceUsd = settings.voiceVendor
    ? estimateCostUsd(settings.voiceVendor, "character", voiceChars)
    : 0;
  return Number((scriptUsd + videoUsd + voiceUsd).toFixed(4));
}

/**
 * One lesson's produce, lifted verbatim from POST .../lessons/:lessonId/produce
 * so the §J batch-queue routes can run it under bounded concurrency. Same steps
 * as that route — runId, RunConfigSchema.parse, runCycle, review-item match by
 * runId, curriculumAssetCreate, curriculumLessonUpdate — with `meta.queued: true`
 * marking the asset as batch-produced. NOT called by the single-lesson produce
 * route; that route keeps its own inline copy.
 */
async function produceOneLessonForQueue(
  deps: { tenantProfiles: TenantProfileRepository },
  orgId: string,
  course: CurriculumCourse,
  lesson: CurriculumLesson,
  settings: AccountSettings,
  dryRun: boolean
): Promise<{
  lessonId: string;
  assetId: string;
  runId: string;
  reviewItemsCreated: number;
  produced: boolean;
}> {
  const runId = randomUUID();
  const config = RunConfigSchema.parse({
    runId,
    niche: course.topic || course.title,
    platforms: ["youtube_shorts"],
    targetDurationSec: Math.min(course.shortDurationSec, 60),
    videoVendor: settings.videoVendor,
    voiceVendor: settings.voiceVendor,
    accountId: orgId,
    orgId,
    clientId: undefined,
    locale: course.language,
    dryRun,
    sourceTranscript: {
      videoId: lesson.id,
      source: "platform_captions",
      text: lesson.shortScript ?? "",
      segments: []
    },
    createdAt: new Date().toISOString()
  });

  const result = await runCycle(config, {});

  // RunResult carries no review-item ids and ReviewItemFilter has no runId facet —
  // list and match on runId, exactly as the single-lesson produce route does.
  const items = (await listReviewItems()).filter((item) => item.runId === runId);
  const reviewItemId = items[0]?.id;

  const produced = result.reviewItemsCreated > 0;
  const asset = await deps.tenantProfiles.curriculumAssetCreate(orgId, {
    courseId: course.id,
    moduleId: lesson.moduleId,
    lessonId: lesson.id,
    assetType: "short_video",
    status: produced ? "review" : "failed",
    generationRunId: runId,
    reviewItemId,
    meta: { platform: "youtube_shorts", dryRun, manifestPath: result.manifestPath, queued: true }
  });

  await deps.tenantProfiles.curriculumLessonUpdate(orgId, course.id, lesson.id, {
    status: produced ? "review" : "generated"
  });

  return {
    lessonId: lesson.id,
    assetId: asset.id,
    runId,
    reviewItemsCreated: result.reviewItemsCreated,
    produced
  };
}

/** The body both §J queue routes return (each route adds `scope` [+ `moduleId`]). */
interface QueueRunOutcome {
  eligible: number;
  produced: Array<{ lessonId: string; assetId: string; runId: string; reviewItemsCreated: number }>;
  skipped: Array<{
    lessonId: string;
    reason: "no-script" | "already-produced" | "stopped-by-cap" | "error";
    error?: string;
  }>;
  stoppedByCap: boolean;
  estimatedSpendUsd: number;
  maxConcurrent: number;
  cap: { maxGenerationSpendUsd: number | null };
}

/**
 * Plan + run a bounded, spend-capped batch produce over `lessons`. Shared by both
 * §J queue routes so the cap / concurrency / reporting logic lives in exactly one
 * place.
 *  1. partition — a lesson with no `shortScript` is skipped "no-script"; a lesson
 *     that already has a review-or-later `short_video` asset is skipped
 *     "already-produced". `eligible` is what survives.
 *  2. spend cap — walk the survivors in `globalOrder`, reserving each lesson's
 *     list-price estimate against a `CostCap` seeded from
 *     `course.maxGenerationSpendUsd` (a null cap means unlimited). The first
 *     lesson that would breach the cap, and every lesson after it, is skipped
 *     "stopped-by-cap" and never handed to the pipeline.
 *  3. bounded concurrency — the survivors run through `Semaphore(maxConcurrent)`
 *     (the real primitive `executeCapped` / the conductor build on) under a
 *     `FlowLimiter` ceiling on how many jobs this one batch may launch. A
 *     rejected task is reported in `skipped` as "error", never a 500.
 */
async function runBoundedProduceQueue(args: {
  deps: { tenantProfiles: TenantProfileRepository };
  orgId: string;
  course: CurriculumCourse;
  settings: AccountSettings;
  lessons: CurriculumLesson[];
  existingShortVideoAssets: CurriculumAsset[];
  maxConcurrent: number;
  dryRun: boolean;
}): Promise<QueueRunOutcome> {
  const { deps, orgId, course, settings, lessons, existingShortVideoAssets, maxConcurrent, dryRun } =
    args;

  const producedLessonIds = new Set<string>();
  for (const asset of existingShortVideoAssets) {
    if (asset.lessonId && PRODUCED_ASSET_STATUSES.includes(asset.status)) {
      producedLessonIds.add(asset.lessonId);
    }
  }

  const skipped: QueueRunOutcome["skipped"] = [];
  const eligible: CurriculumLesson[] = [];
  for (const lesson of [...lessons].sort((a, b) => a.globalOrder - b.globalOrder)) {
    if (!lesson.shortScript || lesson.shortScript.trim().length === 0) {
      skipped.push({ lessonId: lesson.id, reason: "no-script" });
    } else if (producedLessonIds.has(lesson.id)) {
      skipped.push({ lessonId: lesson.id, reason: "already-produced" });
    } else {
      eligible.push(lesson);
    }
  }

  // §J campaign spend cap — reserve each lesson's estimate in order; the first
  // breach stops the whole batch.
  const cap =
    course.maxGenerationSpendUsd === null ? null : new CostCap(course.maxGenerationSpendUsd);
  const toRun: Array<{ lesson: CurriculumLesson; est: number }> = [];
  let stoppedByCap = false;
  for (let i = 0; i < eligible.length; i++) {
    const lesson = eligible[i];
    const est = estimateLessonProduceUsd(course, lesson, settings);
    if (cap) {
      try {
        cap.record(est);
      } catch (err) {
        if (err instanceof CostCapExceededError) {
          stoppedByCap = true;
          for (const remaining of eligible.slice(i)) {
            skipped.push({ lessonId: remaining.id, reason: "stopped-by-cap" });
          }
          break;
        }
        throw err;
      }
    }
    toRun.push({ lesson, est });
  }

  // Bounded concurrency — the WHOLE POINT of §J. `Semaphore(maxConcurrent)` caps
  // in-flight runCycle calls; `FlowLimiter` is a hard ceiling on how many jobs
  // this single batch can launch. Neither is a hand-rolled Promise.all.
  const limiter = new FlowLimiter(Math.max(toRun.length, 1));
  const sem = new Semaphore(maxConcurrent);
  const settled = await Promise.allSettled(
    toRun.map(({ lesson }) =>
      (async (): Promise<Awaited<ReturnType<typeof produceOneLessonForQueue>>> => {
        await sem.acquire();
        try {
          if (!limiter.canGenerate(lesson.id)) {
            throw new Error("batch job ceiling reached");
          }
          limiter.record(lesson.id);
          return await produceOneLessonForQueue(deps, orgId, course, lesson, settings, dryRun);
        } finally {
          sem.release();
        }
      })()
    )
  );

  const produced: QueueRunOutcome["produced"] = [];
  let estimatedSpendUsd = 0;
  settled.forEach((outcome, idx) => {
    const { lesson, est } = toRun[idx];
    if (outcome.status === "fulfilled") {
      produced.push({
        lessonId: outcome.value.lessonId,
        assetId: outcome.value.assetId,
        runId: outcome.value.runId,
        reviewItemsCreated: outcome.value.reviewItemsCreated
      });
      estimatedSpendUsd += est;
    } else {
      const reason: unknown = outcome.reason;
      skipped.push({
        lessonId: lesson.id,
        reason: "error",
        error: reason instanceof Error ? reason.message : String(reason)
      });
    }
  });

  return {
    eligible: eligible.length,
    produced,
    skipped,
    stoppedByCap,
    estimatedSpendUsd: Number(estimatedSpendUsd.toFixed(4)),
    maxConcurrent,
    cap: { maxGenerationSpendUsd: course.maxGenerationSpendUsd }
  };
}

/**
 * Register curriculum course CRUD. Called from server.ts right after
 * registerSoulIdRoutes. `requireSession` is the same middleware the account
 * routes hand back — it populates req.account, which org resolution needs.
 */
export function registerCurriculumRoutes(
  app: Express,
  deps: { tenantProfiles: TenantProfileRepository },
  requireSession: RequestHandler
): void {
  /**
   * Resolve the caller's org, or write the error response and return undefined.
   * 401 when the session has no account, 403 when the role lacks `permission`
   * (mirrors accounts.ts's own requirePermission — the UI hides what a role
   * can't do, a direct API hit still gets a real 403).
   */
  function authorize(req: AuthedRequest, res: Response, permission: AccountPermission): string | undefined {
    const account = req.account;
    if (!account) {
      res.status(401).json({ error: "not authenticated" });
      return undefined;
    }
    if (!roleHasPermission(account.role, permission)) {
      res.status(403).json({ error: `requires the ${permission} permission` });
      return undefined;
    }
    return resolveOrgId(account);
  }

  const paramId = (raw: string | string[] | undefined): string => (Array.isArray(raw) ? raw[0] : raw ?? "");

  const badRequest = (res: Response, error: z.ZodError): Response =>
    res.status(400).json({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

  app.get("/accounts/curricula", requireSession, async (req: AuthedRequest, res: Response) => {
    try {
      const orgId = authorize(req, res, "curriculum.view");
      if (!orgId) return;
      const courses = await deps.tenantProfiles.curriculumCourseList(orgId);
      return res.json({ courses });
    } catch (err) {
      logger.error({ err }, "curriculum course list failed");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * The calling learner's daily learning surface (Learn Mode §20/§49): for every
   * ACTIVE course in the org, their next uncompleted lesson (first by
   * `globalOrder` not in their completion set) plus a lesson tally. Courses with
   * no lessons, or every lesson complete, still appear with `nextLesson: null`.
   * Registered BEFORE `GET /accounts/curricula/:courseId` so Express never treats
   * "today" as a course id.
   */
  app.get("/accounts/curricula/today", requireSession, async (req: AuthedRequest, res: Response) => {
    try {
      const orgId = authorize(req, res, "curriculum.view");
      if (!orgId) return;
      const accountId = req.account!.id;
      const courses = await deps.tenantProfiles.curriculumCourseList(orgId);
      const items = await Promise.all(
        courses
          .filter((course) => course.status === "active")
          .map(async (course) => {
            const [lessonsRaw, completions] = await Promise.all([
              deps.tenantProfiles.curriculumLessonList(orgId, course.id),
              deps.tenantProfiles.curriculumLessonCompletionList(orgId, course.id, accountId)
            ]);
            const lessons = [...lessonsRaw].sort((a, b) => a.globalOrder - b.globalOrder);
            const completed = new Set(completions.map((c) => c.lessonId));
            const lessonsCompleted = lessons.filter((l) => completed.has(l.id)).length;
            const next = lessons.find((l) => !completed.has(l.id));
            return {
              courseId: course.id,
              courseTitle: course.title,
              courseSlug: course.slug,
              lessonsTotal: lessons.length,
              lessonsCompleted,
              pct: lessons.length ? Math.round((100 * lessonsCompleted) / lessons.length) : 0,
              nextLesson: next
                ? { id: next.id, globalOrder: next.globalOrder, moduleId: next.moduleId, title: next.title }
                : null
            };
          })
      );
      return res.json({ items });
    } catch (err) {
      logger.error({ err }, "curriculum today failed");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.post("/accounts/curricula", requireSession, async (req: AuthedRequest, res: Response) => {
    try {
      const orgId = authorize(req, res, "curriculum.edit");
      if (!orgId) return;
      const parsed = CurriculumCourseCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const input: CurriculumCourseInput = { ...parsed.data, slug: slugify(parsed.data.title) };
      const course = await deps.tenantProfiles.curriculumCourseCreate(orgId, input);
      logger.info({ orgId, courseId: course.id }, "curriculum course created");
      return res.status(201).json({ course });
    } catch (err) {
      logger.error({ err }, "curriculum course create failed");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/accounts/curricula/:courseId", requireSession, async (req: AuthedRequest, res: Response) => {
    try {
      const orgId = authorize(req, res, "curriculum.view");
      if (!orgId) return;
      const courseId = paramId(req.params.courseId);
      const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
      // Undefined here is the tenant-isolation boundary — another org's id looks
      // exactly like a missing one.
      if (!course) return res.status(404).json({ error: "course not found" });
      const [modules, lessons, projects] = await Promise.all([
        deps.tenantProfiles.curriculumModuleList(orgId, courseId),
        deps.tenantProfiles.curriculumLessonList(orgId, courseId),
        deps.tenantProfiles.curriculumProjectList(orgId, courseId)
      ]);
      return res.json({
        course,
        counts: { modules: modules.length, lessons: lessons.length, projects: projects.length }
      });
    } catch (err) {
      logger.error({ err }, "curriculum course get failed");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  app.put("/accounts/curricula/:courseId", requireSession, async (req: AuthedRequest, res: Response) => {
    try {
      const orgId = authorize(req, res, "curriculum.edit");
      if (!orgId) return;
      const courseId = paramId(req.params.courseId);
      const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
      if (!course) return res.status(404).json({ error: "course not found" });
      if (!EDITABLE_STATUSES.includes(course.status)) {
        return res
          .status(409)
          .json({ error: "course is locked for production; structural edits require a new version" });
      }
      const parsed = CurriculumCourseUpdateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const patch: Partial<CurriculumCourseInput> = { ...parsed.data };
      if (parsed.data.title !== undefined && parsed.data.title !== course.title) {
        patch.slug = slugify(parsed.data.title);
      }
      const updated = await deps.tenantProfiles.curriculumCourseUpdate(orgId, courseId, patch);
      if (!updated) return res.status(404).json({ error: "course not found" });
      logger.info({ orgId, courseId }, "curriculum course updated");
      return res.json({ course: updated });
    } catch (err) {
      logger.error({ err }, "curriculum course update failed");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  /**
   * Architect a full module/lesson/project plan for a course and persist it.
   * Deterministic mock generator by default (hermetic); the real LLM path runs
   * only when the request opts in (`live: true`) AND the server allows it
   * (`VVUGC_LLM_LIVE=true`). QA gates persistence — a plan with QA errors is
   * rejected and nothing is written. On success the course moves to "planned".
   */
  app.post(
    "/accounts/curricula/:courseId/generate-plan",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.edit");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        if (course.activeVersion !== null) {
          return res.status(409).json({
            error:
              "course has an approved version; regenerating the plan requires unlocking or a new course"
          });
        }

        const parsed = GeneratePlanBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const body = parsed.data;

        const planRequest = CurriculumPlanRequestSchema.parse({
          title: course.title,
          topic: course.topic,
          audience: course.audience,
          startingKnowledge: course.startingKnowledge,
          endGoal: course.endGoal,
          language: course.language,
          moduleCount: course.moduleCount,
          lessonsPerModule: course.lessonsPerModule,
          shortDurationSec: course.shortDurationSec,
          longFormTargetMin: course.longFormTargetMin,
          ...body.overrides,
          seed: body.seed === "agentic-ai" ? SEED_AGENTIC_AI : undefined
        });

        // Real LLM only behind BOTH an explicit request flag and a server env
        // opt-in — tests never set VVUGC_LLM_LIVE, so this always takes the mock.
        const useLive = body.live === true && process.env.VVUGC_LLM_LIVE === "true";
        let plan;
        try {
          plan = useLive
            ? await generateCurriculumPlan(planRequest)
            : buildMockCurriculumPlan(planRequest);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(502).json({ error: `curriculum plan generation failed: ${msg}` });
        }

        const qa = runCurriculumQa(plan);
        if (qa.errors.length > 0) {
          return res.status(400).json({ error: "generated curriculum failed QA", qa });
        }

        let result;
        try {
          result = await deps.tenantProfiles.curriculumSaveApprovedPlan(orgId, courseId, plan);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(500).json({ error: `persisting curriculum plan failed: ${msg}` });
        }

        const refreshed = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        const counts = {
          modules: result.modules.length,
          lessons: result.lessons.length,
          projects: result.projects.length
        };
        logger.info({ orgId, courseId, counts, live: useLive }, "curriculum plan generated");
        return res.status(200).json({ course: refreshed, counts, qa });
      } catch (err) {
        logger.error({ err }, "curriculum generate-plan failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * Approve a course's persisted plan: re-run QA over the stored rows, snapshot
   * them as an immutable CurriculumVersion (which sets course.activeVersion), and
   * move the course to "active". Requires the course to be in "planned" — i.e. a
   * generate-plan has run and nothing has approved it yet.
   */
  app.post(
    "/accounts/curricula/:courseId/approve",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.approve");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        if (course.status !== "planned") {
          return res.status(409).json({
            error: `course is not ready to approve (status: ${course.status}); generate a plan first`
          });
        }

        const [modules, lessons, projects] = await Promise.all([
          deps.tenantProfiles.curriculumModuleList(orgId, courseId),
          deps.tenantProfiles.curriculumLessonList(orgId, courseId),
          deps.tenantProfiles.curriculumProjectList(orgId, courseId)
        ]);
        if (modules.length === 0 || lessons.length === 0 || projects.length === 0) {
          return res.status(409).json({ error: "course has no persisted plan to approve" });
        }

        const plan = toCurriculumPlan(course, modules, lessons, projects);
        const qa = runCurriculumQa(plan);
        if (qa.errors.length > 0) {
          return res
            .status(409)
            .json({ error: "curriculum has QA errors and cannot be approved", qa });
        }

        const version = await deps.tenantProfiles.curriculumNextVersionNumber(orgId, courseId);
        const created = await deps.tenantProfiles.curriculumVersionCreate(orgId, courseId, {
          version,
          createdByAccountId: req.account!.id,
          reason: "approved",
          snapshot: plan
        });
        await deps.tenantProfiles.curriculumCourseUpdate(orgId, courseId, { status: "active" });

        const refreshed = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        logger.info({ orgId, courseId, version }, "curriculum plan approved");
        return res.status(201).json({ course: refreshed, version: created });
      } catch (err) {
        logger.error({ err }, "curriculum approve failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  // ─── modules / lessons: reads + field-granular content patches ───────────

  /**
   * List a course's modules, each annotated with how many lessons it owns and
   * whether it has a capstone project. Ordering (by `order`) is the store's.
   */
  app.get(
    "/accounts/curricula/:courseId/modules",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const modules = await deps.tenantProfiles.curriculumModuleList(orgId, courseId);
        const withCounts = await Promise.all(
          modules.map(async (module) => {
            const [lessons, project] = await Promise.all([
              deps.tenantProfiles.curriculumLessonList(orgId, courseId, module.id),
              deps.tenantProfiles.curriculumProjectGetByModule(orgId, courseId, module.id)
            ]);
            return { ...module, lessonCount: lessons.length, hasProject: project !== undefined };
          })
        );
        return res.json({ modules: withCounts });
      } catch (err) {
        logger.error({ err }, "curriculum module list failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /** One module with its lessons (store-sorted by `globalOrder`) and its project. */
  app.get(
    "/accounts/curricula/:courseId/modules/:moduleId",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const moduleId = paramId(req.params.moduleId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const module = await deps.tenantProfiles.curriculumModuleGet(orgId, courseId, moduleId);
        if (!module) return res.status(404).json({ error: "module not found" });
        const [lessons, project] = await Promise.all([
          deps.tenantProfiles.curriculumLessonList(orgId, courseId, moduleId),
          deps.tenantProfiles.curriculumProjectGetByModule(orgId, courseId, moduleId)
        ]);
        return res.json({ module, lessons, project: project ?? null });
      } catch (err) {
        logger.error({ err }, "curriculum module get failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /** One lesson by id, tenant-scoped. */
  app.get(
    "/accounts/curricula/:courseId/lessons/:lessonId",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const lessonId = paramId(req.params.lessonId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const lesson = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, lessonId);
        if (!lesson) return res.status(404).json({ error: "lesson not found" });
        return res.json({ lesson });
      } catch (err) {
        logger.error({ err }, "curriculum lesson get failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * Field-granular patch of a module's content. Only the keys the body names
   * change; `order` is structural and not accepted. This is a content edit, not
   * a structural one, so it is not gated on the course lock.
   */
  app.put(
    "/accounts/curricula/:courseId/modules/:moduleId",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.edit");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const moduleId = paramId(req.params.moduleId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const existing = await deps.tenantProfiles.curriculumModuleGet(orgId, courseId, moduleId);
        if (!existing) return res.status(404).json({ error: "module not found" });
        const parsed = CurriculumModulePatchSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed.error);
        const updated = await deps.tenantProfiles.curriculumModuleUpdate(
          orgId,
          courseId,
          moduleId,
          parsed.data
        );
        if (!updated) return res.status(404).json({ error: "module not found" });
        logger.info({ orgId, courseId, moduleId }, "curriculum module updated");
        return res.json({ module: updated });
      } catch (err) {
        logger.error({ err }, "curriculum module update failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * Field-granular patch of a lesson's content. Only the named keys change (a
   * patch of just `explanation` never clears `shortScript`). Structural keys
   * (`moduleId`, `*Order`) are not accepted. Content edits are allowed even when
   * the course is locked (`activeVersion !== null`) — that is the
   * regenerate-one-component flow — so there is no 409 here.
   */
  app.put(
    "/accounts/curricula/:courseId/lessons/:lessonId",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.edit");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const lessonId = paramId(req.params.lessonId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const existing = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, lessonId);
        if (!existing) return res.status(404).json({ error: "lesson not found" });
        const parsed = CurriculumLessonPatchSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed.error);
        const updated = await deps.tenantProfiles.curriculumLessonUpdate(
          orgId,
          courseId,
          lessonId,
          parsed.data
        );
        if (!updated) return res.status(404).json({ error: "lesson not found" });
        logger.info({ orgId, courseId, lessonId }, "curriculum lesson updated");
        return res.json({ lesson: updated });
      } catch (err) {
        logger.error({ err }, "curriculum lesson update failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  // ─── script generation: per-lesson short scripts + per-module long-form ──

  /**
   * Generate (or regenerate) a lesson's short script. Deterministic mock builder
   * by default; the real LLM path runs only when the request opts in
   * (`live: true`) AND the server allows it (`VVUGC_LLM_LIVE=true`) — tests never
   * set the env var, so this is always hermetic under test.
   *
   * §22: the script is built with continuity context assembled here from the
   * persisted rows — the course + module summary, the previous up-to-3 lessons,
   * and the next lesson's title — not the whole course.
   * §23: after generation the script is compared (Jaccard token similarity)
   * against every OTHER already-scripted lesson in the course; the nearest match
   * and whether it crosses the flag threshold are reported. No auto-regenerate.
   */
  app.post(
    "/accounts/curricula/:courseId/lessons/:lessonId/script",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.edit");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const lessonId = paramId(req.params.lessonId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const lesson = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, lessonId);
        if (!lesson) return res.status(404).json({ error: "lesson not found" });

        const parsed = ScriptGenerateBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const body = parsed.data;

        const [module, allLessons] = await Promise.all([
          deps.tenantProfiles.curriculumModuleGet(orgId, courseId, lesson.moduleId),
          deps.tenantProfiles.curriculumLessonList(orgId, courseId)
        ]);

        const ctx: LessonScriptContext = {
          courseSummary: `${course.title}: ${course.topic} for ${course.audience}. End goal: ${course.endGoal}.`,
          moduleSummary: module
            ? `Module ${module.order} — ${module.title}. Goal: ${module.goal}.`
            : `Module ${lesson.moduleOrder}.`,
          priorLessons: allLessons
            .filter((l) => l.globalOrder < lesson.globalOrder)
            .sort((a, b) => a.globalOrder - b.globalOrder)
            .slice(-3)
            .map((l) => ({ globalOrder: l.globalOrder, title: l.title, keyTakeaway: l.keyTakeaway })),
          nextLessonTitle: allLessons.find((l) => l.globalOrder === lesson.globalOrder + 1)?.title,
          shortDurationSec: course.shortDurationSec
        };

        const useLive = body.live === true && process.env.VVUGC_LLM_LIVE === "true";
        let script: string;
        try {
          script = useLive
            ? await generateLessonScript(lesson, ctx)
            : buildMockLessonScript(lesson, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(502).json({ error: `lesson script generation failed: ${msg}` });
        }

        // §23 repetition detection — against every other scripted lesson in the course.
        const scriptTokens = tokenize(script);
        let maxPct = 0;
        let nearestGlobalOrder: number | null = null;
        for (const other of allLessons) {
          if (other.id === lessonId || !other.shortScript) continue;
          const pct = jaccardSimilarityPct(scriptTokens, tokenize(other.shortScript));
          if (pct > maxPct) {
            maxPct = pct;
            nearestGlobalOrder = other.globalOrder;
          }
        }

        const updated = await deps.tenantProfiles.curriculumLessonUpdate(orgId, courseId, lessonId, {
          shortScript: script,
          status: "scripted"
        });
        if (!updated) return res.status(404).json({ error: "lesson not found" });

        logger.info(
          { orgId, courseId, lessonId, maxPct, live: useLive },
          "curriculum lesson script generated"
        );
        return res.status(200).json({
          lesson: updated,
          similarity: {
            maxPct,
            nearestLessonGlobalOrder: nearestGlobalOrder,
            flagged: maxPct > REPETITION_FLAG_PCT
          }
        });
      } catch (err) {
        logger.error({ err }, "curriculum lesson script failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * Generate (or regenerate) a module's long-form script (§24 ten-section
   * structure). Same mock-by-default / live-gated shape as the lesson route.
   * Built from the module's own fields + its lessons' takeaways + its project.
   */
  app.post(
    "/accounts/curricula/:courseId/modules/:moduleId/long-form-script",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.edit");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const moduleId = paramId(req.params.moduleId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const module = await deps.tenantProfiles.curriculumModuleGet(orgId, courseId, moduleId);
        if (!module) return res.status(404).json({ error: "module not found" });

        const parsed = ScriptGenerateBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const body = parsed.data;

        const [moduleLessons, projectRow] = await Promise.all([
          deps.tenantProfiles.curriculumLessonList(orgId, courseId, moduleId),
          deps.tenantProfiles.curriculumProjectGetByModule(orgId, courseId, moduleId)
        ]);
        const lessonSummaries = moduleLessons.map((l) => ({
          title: l.title,
          keyTakeaway: l.keyTakeaway
        }));
        const project = projectRow
          ? { title: projectRow.title, objective: projectRow.objective, steps: projectRow.steps }
          : null;

        const useLive = body.live === true && process.env.VVUGC_LLM_LIVE === "true";
        let script: string;
        try {
          script = useLive
            ? await generateModuleLongForm(
                module,
                lessonSummaries,
                project,
                course.longFormTargetMin
              )
            : buildMockModuleLongForm(module, lessonSummaries, project, course.longFormTargetMin);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res
            .status(502)
            .json({ error: `module long-form script generation failed: ${msg}` });
        }

        const updated = await deps.tenantProfiles.curriculumModuleUpdate(orgId, courseId, moduleId, {
          longFormScript: script,
          longFormScriptStatus: "scripted"
        });
        if (!updated) return res.status(404).json({ error: "module not found" });

        logger.info(
          { orgId, courseId, moduleId, live: useLive },
          "curriculum module long-form script generated"
        );
        return res.status(200).json({ module: updated });
      } catch (err) {
        logger.error({ err }, "curriculum module long-form script failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * Generate (or regenerate) a lesson's knowledge-check questions (Learn Mode
   * §19). Deterministic mock builder by default; the real LLM path runs only when
   * the request opts in (`live: true`) AND the server allows it
   * (`VVUGC_LLM_LIVE=true`) — tests never set the env var, so this is always
   * hermetic under test. Persists the `knowledgeCheck` array on the lesson and
   * deliberately leaves `status` untouched — a knowledge check is metadata on the
   * lesson, not a step in its production lifecycle.
   */
  app.post(
    "/accounts/curricula/:courseId/lessons/:lessonId/knowledge-check",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.edit");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const lessonId = paramId(req.params.lessonId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const lesson = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, lessonId);
        if (!lesson) return res.status(404).json({ error: "lesson not found" });

        const parsed = KnowledgeCheckBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const body = parsed.data;

        const ctx: KnowledgeCheckContext = {
          lessonTitle: lesson.title,
          learningObjective: lesson.learningObjective,
          concepts: lesson.concepts,
          explanation: lesson.explanation,
          keyTakeaway: lesson.keyTakeaway
        };

        const useLive = body.live === true && process.env.VVUGC_LLM_LIVE === "true";
        let knowledgeCheck;
        try {
          knowledgeCheck = useLive
            ? await generateKnowledgeCheck(lesson, ctx, {}, body.count)
            : buildMockKnowledgeCheck(lesson, ctx, body.count);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(502).json({ error: `knowledge-check generation failed: ${msg}` });
        }

        const updated = await deps.tenantProfiles.curriculumLessonUpdate(orgId, courseId, lessonId, {
          knowledgeCheck
        });
        if (!updated) return res.status(404).json({ error: "lesson not found" });

        logger.info(
          { orgId, courseId, lessonId, count: knowledgeCheck.length, live: useLive },
          "curriculum lesson knowledge-check generated"
        );
        return res.status(200).json({ lesson: updated });
      } catch (err) {
        logger.error({ err }, "curriculum lesson knowledge-check failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  // ─── produce: curriculum → script → existing VUGC dry-run → review queue ──

  /**
   * §34/§59 acceptance step — CURRICULUM → SCRIPT → EXISTING VUGC DRY-RUN
   * PRODUCTION → REVIEW QUEUE. Hands the lesson's persisted `shortScript` to the
   * existing VUGC pipeline (`runCycle` from @vvugc/orchestrator) as a
   * remix-style source transcript (discovery is skipped), then records a
   * CurriculumAsset linking whatever review item the run enqueued.
   *
   * Dry-run by default: a live run needs BOTH `live: true` in the body AND the
   * server's VVUGC_LLM_LIVE=true — the same gate every other curriculum route
   * uses. Under dry-run the whole pipeline is hermetic (mock discovery /
   * transcript / vendors) and free.
   *
   * FUTURE (out of scope for Curriculum Mode v2): a LIVE curriculum production
   * run should also pass through billing.reserveRun / settleReservation the way
   * POST /accounts/run does — it spends a real, potentially paid vendor chain.
   * Deliberately left unwired here; dry-run production is free and safe.
   */
  app.post(
    "/accounts/curricula/:courseId/lessons/:lessonId/produce",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.produce");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const lessonId = paramId(req.params.lessonId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const lesson = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, lessonId);
        if (!lesson) return res.status(404).json({ error: "lesson not found" });

        if (!lesson.shortScript || lesson.shortScript.trim().length === 0) {
          return res.status(409).json({ error: "lesson has no script yet — generate one first" });
        }

        const parsed = ProduceBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        // Live needs BOTH the request flag and the server opt-in (mirrors the rest
        // of curriculum-routes). Tests never set VVUGC_LLM_LIVE, so this is
        // always a dry-run under test.
        const dryRun = !(parsed.data.live === true && process.env.VVUGC_LLM_LIVE === "true");

        const settings = await deps.tenantProfiles.settingsGet(orgId);

        const runId = randomUUID();
        // targetDurationSec is clamped to RunConfigSchema's hard 60s Shorts cap —
        // a course's shortDurationSec is allowed up to 180 by the create schema,
        // and an out-of-range value would make RunConfigSchema.parse throw.
        const config = RunConfigSchema.parse({
          runId,
          niche: course.topic || course.title,
          platforms: ["youtube_shorts"],
          targetDurationSec: Math.min(course.shortDurationSec, 60),
          videoVendor: settings.videoVendor,
          voiceVendor: settings.voiceVendor,
          accountId: orgId,
          orgId,
          clientId: undefined,
          locale: course.language,
          dryRun,
          sourceTranscript: {
            videoId: lessonId,
            source: "platform_captions",
            text: lesson.shortScript,
            segments: []
          },
          createdAt: new Date().toISOString()
        });

        let result;
        try {
          result = await runCycle(config, {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(502).json({ error: `production run failed: ${msg}` });
        }

        // RunResult carries no review-item ids and ReviewItemFilter has no runId
        // facet — list and match on runId. A dry-run inserts one review item per
        // target platform (here: youtube_shorts only). Best-effort: a missing
        // link never fails the request.
        const items = (await listReviewItems()).filter((item) => item.runId === runId);
        const reviewItemId = items[0]?.id;

        const produced = result.reviewItemsCreated > 0;
        const asset = await deps.tenantProfiles.curriculumAssetCreate(orgId, {
          courseId,
          moduleId: lesson.moduleId,
          lessonId,
          assetType: "short_video",
          status: produced ? "review" : "failed",
          generationRunId: runId,
          reviewItemId,
          meta: { platform: "youtube_shorts", dryRun, manifestPath: result.manifestPath }
        });

        await deps.tenantProfiles.curriculumLessonUpdate(orgId, courseId, lessonId, {
          status: produced ? "review" : "generated"
        });

        logger.info(
          { orgId, courseId, lessonId, runId, reviewItemsCreated: result.reviewItemsCreated, dryRun },
          "curriculum lesson produced"
        );
        return res.status(202).json({
          asset,
          run: {
            runId,
            reviewItemsCreated: result.reviewItemsCreated,
            manifestPath: result.manifestPath,
            dryRun
          }
        });
      } catch (err) {
        logger.error({ err }, "curriculum lesson produce failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * §G/§24 long-form analogue of POST .../lessons/:lessonId/produce — CURRICULUM
   * MODULE → LONG-FORM SCRIPT → EXISTING VUGC DRY-RUN PRODUCTION → REVIEW QUEUE.
   * Hands the module's persisted `longFormScript` to the existing VUGC pipeline
   * (`runCycle` from @vvugc/orchestrator) as a remix-style source transcript
   * (discovery is skipped), then records a `long_video` CurriculumAsset linking
   * whatever review item the run enqueued.
   *
   * RENDER-DURATION CAP (plainly): the VUGC render pipeline caps a single
   * production at RunConfigSchema's 60-second Shorts limit — `targetDurationSec`
   * is `.min(15).max(60)` — so a 12-minute long-form module video CANNOT be
   * rendered as one clip through this pipeline. In v2 the module's long-form
   * video is therefore rendered as a single 60-second segment; the full
   * multi-minute `longFormScript` is the real deliverable (§24) and is handed
   * off in full as the run's source transcript. A dedicated long-form render
   * pipeline (chaptered multi-segment assembly) is future work.
   *
   * Dry-run by default: a live run needs BOTH `live: true` in the body AND the
   * server's VVUGC_LLM_LIVE=true — the same gate every other curriculum route
   * uses. Under dry-run the whole pipeline is hermetic (mock discovery /
   * transcript / vendors) and free.
   *
   * FUTURE (out of scope for Curriculum Mode v2): a LIVE curriculum production
   * run should also pass through billing.reserveRun / settleReservation the way
   * POST /accounts/run does — it spends a real, potentially paid vendor chain.
   * Deliberately left unwired here; dry-run production is free and safe.
   */
  app.post(
    "/accounts/curricula/:courseId/modules/:moduleId/produce-long-form",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.produce");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const moduleId = paramId(req.params.moduleId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const module = await deps.tenantProfiles.curriculumModuleGet(orgId, courseId, moduleId);
        if (!module) return res.status(404).json({ error: "module not found" });

        if (!module.longFormScript || module.longFormScript.trim().length === 0) {
          return res
            .status(409)
            .json({ error: "module has no long-form script yet — generate one first" });
        }

        const parsed = ProduceBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        // Live needs BOTH the request flag and the server opt-in (mirrors the rest
        // of curriculum-routes). Tests never set VVUGC_LLM_LIVE, so this is
        // always a dry-run under test.
        const dryRun = !(parsed.data.live === true && process.env.VVUGC_LLM_LIVE === "true");

        const settings = await deps.tenantProfiles.settingsGet(orgId);

        const runId = randomUUID();
        // targetDurationSec is HARD-CLAMPED to 60 — RunConfigSchema's `.max(60)`
        // Shorts cap. See the doc comment above: a multi-minute long-form module
        // video cannot render as one clip through this pipeline, so v2 renders a
        // 60-second segment and hands the full longFormScript off as the source
        // transcript. Any other value here would make RunConfigSchema.parse throw.
        const config = RunConfigSchema.parse({
          runId,
          niche: course.topic || course.title,
          platforms: ["youtube_long"],
          targetDurationSec: 60,
          videoVendor: settings.videoVendor,
          voiceVendor: settings.voiceVendor,
          accountId: orgId,
          orgId,
          clientId: undefined,
          locale: course.language,
          dryRun,
          sourceTranscript: {
            videoId: moduleId,
            source: "platform_captions",
            text: module.longFormScript,
            segments: []
          },
          createdAt: new Date().toISOString()
        });

        let result;
        try {
          result = await runCycle(config, {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(502).json({ error: `production run failed: ${msg}` });
        }

        // RunResult carries no review-item ids and ReviewItemFilter has no runId
        // facet — list and match on runId. A dry-run inserts one review item per
        // target platform (here: youtube_long only). Best-effort: a missing link
        // never fails the request.
        const items = (await listReviewItems()).filter((item) => item.runId === runId);
        const reviewItemId = items[0]?.id;

        const produced = result.reviewItemsCreated > 0;
        const asset = await deps.tenantProfiles.curriculumAssetCreate(orgId, {
          courseId,
          moduleId,
          assetType: "long_video",
          status: produced ? "review" : "failed",
          generationRunId: runId,
          reviewItemId,
          meta: {
            platform: "youtube_long",
            dryRun,
            manifestPath: result.manifestPath,
            longFormTargetMin: course.longFormTargetMin,
            renderedDurationCappedSec: 60
          }
        });

        await deps.tenantProfiles.curriculumModuleUpdate(orgId, courseId, moduleId, {
          status: produced ? "completed" : "producing",
          longFormScriptStatus: produced ? "generated" : "scripted"
        });

        logger.info(
          {
            orgId,
            courseId,
            moduleId,
            runId,
            reviewItemsCreated: result.reviewItemsCreated,
            dryRun
          },
          "curriculum module long-form produced"
        );
        return res.status(202).json({
          asset,
          run: {
            runId,
            reviewItemsCreated: result.reviewItemsCreated,
            manifestPath: result.manifestPath,
            dryRun
          }
        });
      } catch (err) {
        logger.error({ err }, "curriculum module long-form produce failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * §J batch-produce every scripted, not-yet-produced lesson in ONE MODULE.
   * Bounded concurrency (`Semaphore(maxConcurrent)` inside runBoundedProduceQueue)
   * + the course spend cap (`CostCap` seeded from `course.maxGenerationSpendUsd`)
   * are what keep a 200-lesson course from launching 200 `runCycle` calls at
   * once. Dry-run by default (same live double-gate as every curriculum route).
   * FUTURE: a LIVE batch must additionally reserve budget via billing.reserveRun,
   * as POST /accounts/run does — deliberately unwired here (dry-run is free/safe).
   */
  app.post(
    "/accounts/curricula/:courseId/modules/:moduleId/queue",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.produce");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const moduleId = paramId(req.params.moduleId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const module = await deps.tenantProfiles.curriculumModuleGet(orgId, courseId, moduleId);
        if (!module) return res.status(404).json({ error: "module not found" });

        const parsed = QueueBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const dryRun = !(parsed.data.live === true && process.env.VVUGC_LLM_LIVE === "true");

        const [settings, lessons, existingShortVideoAssets] = await Promise.all([
          deps.tenantProfiles.settingsGet(orgId),
          deps.tenantProfiles.curriculumLessonList(orgId, courseId, moduleId),
          deps.tenantProfiles.curriculumAssetList(orgId, courseId, { assetType: "short_video" })
        ]);

        const outcome = await runBoundedProduceQueue({
          deps,
          orgId,
          course,
          settings,
          lessons,
          existingShortVideoAssets,
          maxConcurrent: parsed.data.maxConcurrent,
          dryRun
        });

        logger.info(
          {
            orgId,
            courseId,
            moduleId,
            dryRun,
            produced: outcome.produced.length,
            skipped: outcome.skipped.length,
            stoppedByCap: outcome.stoppedByCap
          },
          "curriculum module batch queue"
        );
        return res.status(202).json({ scope: "module", moduleId, dryRun, ...outcome });
      } catch (err) {
        logger.error({ err }, "curriculum module queue failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * §J batch-produce every scripted, not-yet-produced lesson of an APPROVED
   * course (409 unless `course.activeVersion !== null`). Same bounded-concurrency
   * + spend-cap machinery as the per-module queue above.
   */
  app.post(
    "/accounts/curricula/:courseId/queue-approved",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.produce");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        if (course.activeVersion === null) {
          return res
            .status(409)
            .json({ error: "course has no approved version — approve a plan first" });
        }

        const parsed = QueueBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const dryRun = !(parsed.data.live === true && process.env.VVUGC_LLM_LIVE === "true");

        const [settings, lessons, existingShortVideoAssets] = await Promise.all([
          deps.tenantProfiles.settingsGet(orgId),
          deps.tenantProfiles.curriculumLessonList(orgId, courseId),
          deps.tenantProfiles.curriculumAssetList(orgId, courseId, { assetType: "short_video" })
        ]);

        const outcome = await runBoundedProduceQueue({
          deps,
          orgId,
          course,
          settings,
          lessons,
          existingShortVideoAssets,
          maxConcurrent: parsed.data.maxConcurrent,
          dryRun
        });

        logger.info(
          {
            orgId,
            courseId,
            dryRun,
            produced: outcome.produced.length,
            skipped: outcome.skipped.length,
            stoppedByCap: outcome.stoppedByCap
          },
          "curriculum course batch queue"
        );
        return res.status(202).json({ scope: "course", dryRun, ...outcome });
      } catch (err) {
        logger.error({ err }, "curriculum course queue failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * §J cost preview — a PURE-ARITHMETIC, fully hermetic list-price estimate for
   * generating a whole course, one module, or one lesson. No LLM, no runCycle,
   * no store writes: it reads the persisted course/module/lesson rows plus the
   * org's vendor settings and multiplies them by @vvugc/shared-cost's rate
   * tables. Every figure is an ESTIMATE, labelled as such, and the response
   * carries the course's spend cap (`maxGenerationSpendUsd`) with a
   * within-cap / remaining view so the number is actionable, not decorative.
   */
  app.post(
    "/accounts/curricula/:courseId/cost-estimate",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);

        const parsed = CostEstimateBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const body = parsed.data;

        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        // Undefined here is the tenant-isolation boundary — another org's id looks
        // exactly like a missing one.
        if (!course) return res.status(404).json({ error: "course not found" });

        const [settings, modules, lessons] = await Promise.all([
          deps.tenantProfiles.settingsGet(orgId),
          deps.tenantProfiles.curriculumModuleList(orgId, courseId),
          deps.tenantProfiles.curriculumLessonList(orgId, courseId)
        ]);

        // Narrow the in-scope lesson / module sets. `lesson` scope never includes
        // a long-form module line (modulesInScope stays empty).
        let lessonsInScope: CurriculumLesson[];
        let modulesInScope: CurriculumModule[];
        if (body.scope === "module") {
          if (!body.moduleId) {
            return res.status(400).json({ error: "scope 'module' requires a moduleId" });
          }
          const module = await deps.tenantProfiles.curriculumModuleGet(orgId, courseId, body.moduleId);
          if (!module) return res.status(404).json({ error: "module not found" });
          lessonsInScope = lessons.filter((l) => l.moduleId === body.moduleId);
          modulesInScope = [module];
        } else if (body.scope === "lesson") {
          if (!body.lessonId) {
            return res.status(400).json({ error: "scope 'lesson' requires a lessonId" });
          }
          const lesson = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, body.lessonId);
          if (!lesson) return res.status(404).json({ error: "lesson not found" });
          lessonsInScope = [lesson];
          modulesInScope = [];
        } else {
          lessonsInScope = lessons;
          modulesInScope = modules;
        }

        // ── per-unit list-price estimates (uniform across lessons/modules) ──
        const perLessonScriptUsd =
          estimateCostUsd("anthropic", "input_tokens", SCRIPT_PROMPT_TOKENS, "claude-sonnet-5") +
          estimateCostUsd("anthropic", "output_tokens", SCRIPT_OUTPUT_TOKENS, "claude-sonnet-5");

        const clipsPerLesson = Math.max(
          1,
          Math.ceil(Math.min(course.shortDurationSec, 60) / SECONDS_PER_CLIP)
        );
        const perLessonVideoUsd = estimateCostUsd(settings.videoVendor, "clip", clipsPerLesson);

        const defaultVoiceChars = Math.round(course.shortDurationSec * CHARS_PER_SECOND);
        const voiceUsdForChars = (chars: number): number =>
          settings.voiceVendor ? estimateCostUsd(settings.voiceVendor, "character", chars) : 0;

        const longFormOutputTokens = Math.round(
          course.longFormTargetMin * LONGFORM_OUTPUT_TOKENS_PER_MIN
        );
        const perModuleLongFormScriptUsd =
          estimateCostUsd("anthropic", "input_tokens", LONGFORM_PROMPT_TOKENS, "claude-sonnet-5") +
          estimateCostUsd("anthropic", "output_tokens", longFormOutputTokens, "claude-sonnet-5");

        // ── sum across the in-scope sets ──
        let scriptUsd = 0;
        let videoUsd = 0;
        let voiceUsd = 0;
        for (const lesson of lessonsInScope) {
          scriptUsd += perLessonScriptUsd;
          videoUsd += perLessonVideoUsd;
          const voiceChars = lesson.shortScript ? lesson.shortScript.length : defaultVoiceChars;
          voiceUsd += voiceUsdForChars(voiceChars);
        }
        const longFormScriptUsd = perModuleLongFormScriptUsd * modulesInScope.length;

        const perLessonUsd = perLessonScriptUsd + perLessonVideoUsd + voiceUsdForChars(defaultVoiceChars);
        const totalUsd = scriptUsd + videoUsd + voiceUsd + longFormScriptUsd;

        const round4 = (x: number): number => Number(x.toFixed(4));
        const cap = course.maxGenerationSpendUsd;

        logger.info(
          { orgId, courseId, scope: body.scope, lessons: lessonsInScope.length, modules: modulesInScope.length },
          "curriculum cost-estimate computed"
        );
        return res.status(200).json({
          scope: body.scope,
          currency: "USD",
          counts: { lessons: lessonsInScope.length, modules: modulesInScope.length },
          lineItems: {
            scriptUsd: round4(scriptUsd),
            videoUsd: round4(videoUsd),
            voiceUsd: round4(voiceUsd),
            longFormScriptUsd: round4(longFormScriptUsd)
          },
          perLessonUsd: round4(perLessonUsd),
          totalUsd: round4(totalUsd),
          cap: {
            maxGenerationSpendUsd: cap,
            withinCap: cap === null || totalUsd <= cap,
            remainingUsd: cap === null ? null : Number((cap - totalUsd).toFixed(4))
          },
          assumptions: [
            `${clipsPerLesson} video clip(s) per lesson at ${SECONDS_PER_CLIP}s per clip (short-form capped at 60s)`,
            `${CHARS_PER_SECOND} narration characters per second — ${defaultVoiceChars} characters for a ${course.shortDurationSec}s lesson (a lesson's own script length is used once it has one)`,
            `${SCRIPT_PROMPT_TOKENS} prompt + ${SCRIPT_OUTPUT_TOKENS} output tokens per lesson script (claude-sonnet-5 list price)`,
            `${LONGFORM_PROMPT_TOKENS} prompt + ${longFormOutputTokens} output tokens per module long-form script (~${LONGFORM_OUTPUT_TOKENS_PER_MIN} output tokens per minute of a ${course.longFormTargetMin}-minute narration, claude-sonnet-5 list price)`,
            `video vendor: ${settings.videoVendor}`,
            `voice vendor: ${settings.voiceVendor ?? "none selected — voiceover estimated at $0"}`
          ],
          disclaimer:
            "Rough estimate from list-price rate tables — not a quote. Actual spend depends on real vendor pricing, retries, and QA regeneration."
        });
      } catch (err) {
        logger.error({ err }, "curriculum cost-estimate failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * List the CurriculumAssets produced for a course, optionally narrowed by
   * lesson / module / assetType / status. Lets the UI — and the §34/§59
   * acceptance test — see what a produce run created.
   */
  app.get(
    "/accounts/curricula/:courseId/assets",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const parsed = AssetListQuerySchema.safeParse(req.query);
        if (!parsed.success) return badRequest(res, parsed.error);
        const filter: CurriculumAssetFilter = parsed.data;
        const assets = await deps.tenantProfiles.curriculumAssetList(orgId, courseId, filter);
        return res.json({ assets });
      } catch (err) {
        logger.error({ err }, "curriculum asset list failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  // ─── learn mode: per-learner progress (Learn Mode §20/§48/§49/§50) ───────

  /**
   * The calling learner marks a lesson complete (Learn Mode §48). Idempotent:
   * the store upserts on (org, course, lesson, account), so a second call for the
   * same learner+lesson refreshes the row rather than adding one. The learner is
   * always `req.account` — an `accountId` in the body is ignored. `answers`, when
   * given alongside a lesson that has a knowledge-check, are scored against the
   * MCQ answer key; an explicit `knowledgeCheckScore` in the body wins.
   */
  app.post(
    "/accounts/curricula/:courseId/lessons/:lessonId/complete",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const lessonId = paramId(req.params.lessonId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });
        const lesson = await deps.tenantProfiles.curriculumLessonGet(orgId, courseId, lessonId);
        if (!lesson) return res.status(404).json({ error: "lesson not found" });

        const parsed = LessonCompleteBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, parsed.error);
        const body = parsed.data;

        let knowledgeCheckScore = body.knowledgeCheckScore;
        if (knowledgeCheckScore === undefined && body.answers && lesson.knowledgeCheck.length > 0) {
          const answers = body.answers;
          const gradable = lesson.knowledgeCheck.filter(
            (kc) => kc.kind === "mcq" && kc.answerIndex !== null
          ).length;
          const correct = lesson.knowledgeCheck.filter(
            (kc, i) => kc.kind === "mcq" && kc.answerIndex === answers[i]
          ).length;
          knowledgeCheckScore = gradable > 0 ? Math.round((100 * correct) / gradable) : undefined;
        }

        const completion = await deps.tenantProfiles.curriculumLessonCompletionUpsert(orgId, {
          orgId,
          courseId,
          lessonId,
          accountId: req.account!.id,
          knowledgeCheckScore
        });

        logger.info({ orgId, courseId, lessonId, accountId: req.account!.id }, "curriculum lesson completed");
        return res.status(200).json({ completion });
      } catch (err) {
        logger.error({ err }, "curriculum lesson complete failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  /**
   * The calling learner's progress for one course (Learn Mode §49/§50). Three
   * distinct facets: `learning` (lessons this learner has completed, per module
   * and overall, plus their next lesson), `production` (how much of the course
   * has been scripted / produced — course-wide, not per-learner), and
   * `publishing` (how many produced assets are live). Only the caller's own
   * completions are ever read — the store list is filtered by `req.account.id`.
   */
  app.get(
    "/accounts/curricula/:courseId/progress",
    requireSession,
    async (req: AuthedRequest, res: Response) => {
      try {
        const orgId = authorize(req, res, "curriculum.view");
        if (!orgId) return;
        const courseId = paramId(req.params.courseId);
        const course = await deps.tenantProfiles.curriculumCourseGet(orgId, courseId);
        if (!course) return res.status(404).json({ error: "course not found" });

        const [modulesRaw, lessonsRaw, completions, assets] = await Promise.all([
          deps.tenantProfiles.curriculumModuleList(orgId, courseId),
          deps.tenantProfiles.curriculumLessonList(orgId, courseId),
          deps.tenantProfiles.curriculumLessonCompletionList(orgId, courseId, req.account!.id),
          deps.tenantProfiles.curriculumAssetList(orgId, courseId)
        ]);
        const modules = [...modulesRaw].sort((a, b) => a.order - b.order);
        const lessons = [...lessonsRaw].sort((a, b) => a.globalOrder - b.globalOrder);
        const completed = new Set(completions.map((c) => c.lessonId));

        const lessonsTotal = lessons.length;
        const lessonsCompleted = lessons.filter((l) => completed.has(l.id)).length;
        const nextLesson = lessons.find((l) => !completed.has(l.id));

        const moduleRows = modules.map((module) => {
          const own = lessons.filter((l) => l.moduleId === module.id);
          const done = own.filter((l) => completed.has(l.id)).length;
          return {
            moduleId: module.id,
            order: module.order,
            title: module.title,
            lessonsTotal: own.length,
            lessonsCompleted: done,
            pct: own.length ? Math.round((100 * done) / own.length) : 0
          };
        });

        const producedLessonIds = new Set<string>();
        for (const asset of assets) {
          if (asset.lessonId && PRODUCED_ASSET_STATUSES.includes(asset.status)) {
            producedLessonIds.add(asset.lessonId);
          }
        }

        return res.json({
          learning: {
            lessonsTotal,
            lessonsCompleted,
            pct: lessonsTotal ? Math.round((100 * lessonsCompleted) / lessonsTotal) : 0,
            modules: moduleRows,
            nextLesson: nextLesson
              ? {
                  id: nextLesson.id,
                  globalOrder: nextLesson.globalOrder,
                  moduleId: nextLesson.moduleId,
                  title: nextLesson.title
                }
              : null
          },
          production: {
            lessonsScripted: lessons.filter((l) => SCRIPTED_LESSON_STATUSES.includes(l.status)).length,
            lessonsProduced: producedLessonIds.size,
            assetsTotal: assets.length
          },
          publishing: {
            assetsPublished: assets.filter((a) => a.status === "published").length
          }
        });
      } catch (err) {
        logger.error({ err }, "curriculum progress failed");
        return res.status(500).json({ error: "Internal error" });
      }
    }
  );

  app.delete("/accounts/curricula/:courseId", requireSession, async (req: AuthedRequest, res: Response) => {
    try {
      const orgId = authorize(req, res, "curriculum.delete");
      if (!orgId) return;
      const courseId = paramId(req.params.courseId);
      const deleted = await deps.tenantProfiles.curriculumCourseDelete(orgId, courseId);
      if (!deleted) return res.status(404).json({ deleted: false });
      logger.info({ orgId, courseId }, "curriculum course deleted");
      return res.json({ deleted: true });
    } catch (err) {
      logger.error({ err }, "curriculum course delete failed");
      return res.status(500).json({ error: "Internal error" });
    }
  });
}
