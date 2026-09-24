// Curriculum Mode v2 — the education engine. Domain model only: Zod schemas,
// inferred entity types, create-route input types, and deterministic id/ordering
// helpers. No stores, no LLM, no HTTP, no fs, no React in this package.
//
// Style mirrors @vvugc/shared-schema: `XSchema` + `export type X = z.infer<typeof XSchema>`,
// `z.object` / `z.enum` / `.default(...)`, dates as `z.string().datetime()`.

import { randomUUID } from "node:crypto";
import { z } from "zod";

// ─── Status enums ───────────────────────────────────────────────────────────

/** Lifecycle of a whole course, from first draft to archived. */
export const CurriculumStatusSchema = z.enum([
  "draft",
  "planning",
  "planned",
  "producing",
  "active",
  "completed",
  "archived"
]);
export type CurriculumStatus = z.infer<typeof CurriculumStatusSchema>;

/** Content pipeline state shared by lessons and projects (scripted → published). */
export const ContentStatusSchema = z.enum([
  "draft",
  "approved",
  "scripted",
  "queued",
  "generated",
  "review",
  "published"
]);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

/** Coarser lifecycle for a module (a batch of lessons + its long-form video). */
export const ModuleStatusSchema = z.enum(["draft", "approved", "producing", "completed"]);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;

/** Kind of artifact produced for a course/module/lesson/project. */
export const AssetTypeSchema = z.enum([
  "short_video",
  "long_video",
  "script",
  "thumbnail",
  "caption",
  "quiz",
  "worksheet",
  "code",
  "pdf",
  "ebook_section",
  "newsletter"
]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

/** Generation/review state of a single asset. */
export const AssetStatusSchema = z.enum([
  "planned",
  "scripted",
  "queued",
  "generated",
  "review",
  "approved",
  "published",
  "failed"
]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

// ─── Entities (persisted) ──────────────────────────────────────────────────

/** A course: the top-level unit of Curriculum Mode. `id`/`orgId`/timestamps are
 *  server-managed; `moduleCount`×`lessonsPerModule` bound the planned shape. */
export const CurriculumCourseSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  title: z.string(),
  slug: z.string(),
  topic: z.string(),
  description: z.string().optional(),
  audience: z.string(),
  startingKnowledge: z.array(z.string()).default([]),
  endGoal: z.string(),
  language: z.string().default("en"),
  status: CurriculumStatusSchema.default("draft"),
  moduleCount: z.number().int().min(1),
  lessonsPerModule: z.number().int().min(1),
  shortDurationSec: z.number().int().default(60),
  longFormTargetMin: z.number().int().default(12),
  /** null = no spend cap. */
  maxGenerationSpendUsd: z.number().nullable().default(50),
  /** Points at the locked CurriculumVersion currently in production; null while planning. */
  activeVersion: z.number().int().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CurriculumCourse = z.infer<typeof CurriculumCourseSchema>;

/** A module groups `lessonsPerModule` lessons and owns one long-form video script. */
export const CurriculumModuleSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  courseId: z.string().min(1),
  order: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  goal: z.string(),
  prerequisites: z.array(z.string()).default([]),
  learningObjectives: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([]),
  status: ModuleStatusSchema.default("draft"),
  longFormScript: z.string().optional(),
  longFormScriptStatus: ContentStatusSchema.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CurriculumModule = z.infer<typeof CurriculumModuleSchema>;

/** One ordered step of a module's hands-on project. */
export const CurriculumProjectStepSchema = z.object({
  order: z.number().int(),
  title: z.string(),
  detail: z.string()
});
export type CurriculumProjectStep = z.infer<typeof CurriculumProjectStepSchema>;

/** The capstone project attached to a module. */
export const CurriculumProjectSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  courseId: z.string().min(1),
  moduleId: z.string().min(1),
  title: z.string(),
  objective: z.string(),
  outcome: z.string(),
  requirements: z.array(z.string()).default([]),
  steps: z.array(CurriculumProjectStepSchema).default([]),
  technologies: z.array(z.string()).default([]),
  longFormScript: z.string().optional(),
  status: ContentStatusSchema.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CurriculumProject = z.infer<typeof CurriculumProjectSchema>;

/** A single knowledge-check question on a lesson. `answerIndex` null unless `options` apply. */
export const KnowledgeCheckQuestionSchema = z.object({
  kind: z.enum(["mcq", "concept", "coding"]),
  prompt: z.string(),
  options: z.array(z.string()).default([]),
  answerIndex: z.number().int().nullable().default(null),
  rationale: z.string().optional()
});
export type KnowledgeCheckQuestion = z.infer<typeof KnowledgeCheckQuestionSchema>;

/** A lesson: one short-form video's worth of teaching. `*Order` fields are the
 *  deterministic ordering keys — never rely on array position (see sort helpers). */
export const CurriculumLessonSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  courseId: z.string().min(1),
  moduleId: z.string().min(1),
  moduleOrder: z.number().int().min(1),
  lessonOrder: z.number().int().min(1),
  globalOrder: z.number().int().min(1),
  title: z.string(),
  learningObjective: z.string(),
  prerequisites: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([]),
  explanation: z.string().optional(),
  example: z.string().optional(),
  exercise: z.string().optional(),
  keyTakeaway: z.string().optional(),
  nextLessonHook: z.string().optional(),
  shortScript: z.string().optional(),
  visualPlan: z.string().optional(),
  codeExample: z.string().optional(),
  knowledgeCheck: z.array(KnowledgeCheckQuestionSchema).default([]),
  status: ContentStatusSchema.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CurriculumLesson = z.infer<typeof CurriculumLessonSchema>;

/** A produced (or planned) artifact, linked to at most one of module/lesson/project.
 *  `meta` is a genuine JSON boundary — `z.unknown()` values, never `any`. */
export const CurriculumAssetSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  courseId: z.string().min(1),
  moduleId: z.string().min(1).optional(),
  lessonId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  assetType: AssetTypeSchema,
  status: AssetStatusSchema.default("planned"),
  generationRunId: z.string().optional(),
  reviewItemId: z.string().optional(),
  storagePath: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CurriculumAsset = z.infer<typeof CurriculumAssetSchema>;

/** An immutable snapshot of a course plan taken when a version is locked for production. */
export const CurriculumVersionSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  courseId: z.string().min(1),
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
  createdByAccountId: z.string(),
  reason: z.string(),
  /** JSON snapshot of the whole plan at lock time — opaque here. */
  snapshot: z.unknown()
});
export type CurriculumVersion = z.infer<typeof CurriculumVersionSchema>;

/** A learner finishing a lesson (and, optionally, their knowledge-check score). */
export const LessonCompletionSchema = z.object({
  orgId: z.string().min(1),
  courseId: z.string().min(1),
  lessonId: z.string().min(1),
  accountId: z.string().min(1),
  completedAt: z.string().datetime(),
  knowledgeCheckScore: z.number().optional()
});
export type LessonCompletion = z.infer<typeof LessonCompletionSchema>;

// ─── Plan (LLM output shape) ───────────────────────────────────────────────
// The architect stage returns this; the store expands it into the entities above
// with ids/orgId/timestamps. Not persisted directly.

/** Course-level fields the architect proposes. */
export const CoursePlanSchema = z.object({
  title: z.string(),
  slug: z.string(),
  topic: z.string(),
  audience: z.string(),
  startingKnowledge: z.array(z.string()).default([]),
  endGoal: z.string(),
  language: z.string().default("en"),
  moduleCount: z.number().int().min(1),
  lessonsPerModule: z.number().int().min(1),
  shortDurationSec: z.number().int().default(60),
  longFormTargetMin: z.number().int().default(12)
});
export type CoursePlan = z.infer<typeof CoursePlanSchema>;

/** One planned module (no ids/timestamps yet). */
export const ModulePlanSchema = z.object({
  order: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  goal: z.string(),
  prerequisites: z.array(z.string()).default([]),
  learningObjectives: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([])
});
export type ModulePlan = z.infer<typeof ModulePlanSchema>;

/** One planned lesson, carrying its module/lesson/global ordering keys. */
export const LessonPlanSchema = z.object({
  moduleOrder: z.number().int().min(1),
  lessonOrder: z.number().int().min(1),
  globalOrder: z.number().int().min(1),
  title: z.string(),
  learningObjective: z.string(),
  prerequisites: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([])
});
export type LessonPlan = z.infer<typeof LessonPlanSchema>;

/** One planned capstone project, attached to a module by `moduleOrder`. */
export const ProjectPlanSchema = z.object({
  moduleOrder: z.number().int().min(1),
  title: z.string(),
  objective: z.string(),
  outcome: z.string(),
  requirements: z.array(z.string()).default([]),
  steps: z.array(CurriculumProjectStepSchema).default([]),
  technologies: z.array(z.string()).default([])
});
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

/** The full plan the architect returns for a course. */
export const CurriculumPlanSchema = z.object({
  course: CoursePlanSchema,
  modules: z.array(ModulePlanSchema),
  lessons: z.array(LessonPlanSchema),
  projects: z.array(ProjectPlanSchema)
});
export type CurriculumPlan = z.infer<typeof CurriculumPlanSchema>;

// ─── Plan request + seed (architect input shape) ──────────────────────────
// What a caller hands the curriculum-planning agent. `id`/`orgId` are NEVER
// part of this shape — the create route stamps `orgId` onto the expanded
// course/module/lesson rows later (Phase D), never the model.

/** One pre-titled module in a seed — fixes the module list (and an optional
 *  one-line goal) so the plan follows a known outline instead of inventing one. */
export const CurriculumSeedModuleSchema = z.object({
  title: z.string(),
  goal: z.string().default("")
});
export type CurriculumSeedModule = z.infer<typeof CurriculumSeedModuleSchema>;

/** An optional starting point for a plan request: course meta + a fixed,
 *  ordered module list the architect must reproduce verbatim. */
export const CurriculumSeedSchema = z.object({
  course: CoursePlanSchema.partial().extend({ title: z.string(), topic: z.string() }),
  modules: z.array(CurriculumSeedModuleSchema)
});
export type CurriculumSeed = z.infer<typeof CurriculumSeedSchema>;

/** The request a caller sends to the curriculum-planning agent. Bounds on
 *  `moduleCount`/`lessonsPerModule` keep an accidental 500-lesson plan out of
 *  the generation pipeline. */
export const CurriculumPlanRequestSchema = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  audience: z.string().min(1),
  startingKnowledge: z.array(z.string()).default([]),
  endGoal: z.string().min(1),
  language: z.string().default("en"),
  moduleCount: z.number().int().min(1).max(50).default(20),
  lessonsPerModule: z.number().int().min(1).max(20).default(10),
  shortDurationSec: z.number().int().min(15).max(180).default(60),
  longFormTargetMin: z.number().int().min(3).max(60).default(12),
  seed: CurriculumSeedSchema.optional()
});
export type CurriculumPlanRequest = z.infer<typeof CurriculumPlanRequestSchema>;

/** URL/slug form of a string: lowercase, every run of non-alphanumerics folded
 *  to a single `-`, leading/trailing dashes trimmed. Used by the architect for
 *  `course.slug` and by the create routes. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Create-route input types ─────────────────────────────────────────────
// `Input = Omit<Entity, server-managed fields>`, with `status` made optional
// (stores default it). Mirrors @vvugc/shared-auth's `*Input` pattern.

export type CurriculumCourseInput = Omit<
  CurriculumCourse,
  "id" | "orgId" | "status" | "activeVersion" | "createdAt" | "updatedAt"
> & { status?: CurriculumStatus };

export type CurriculumModuleInput = Omit<
  CurriculumModule,
  "id" | "orgId" | "status" | "createdAt" | "updatedAt"
> & { status?: ModuleStatus };

export type CurriculumProjectInput = Omit<
  CurriculumProject,
  "id" | "orgId" | "status" | "createdAt" | "updatedAt"
> & { status?: ContentStatus };

export type CurriculumLessonInput = Omit<
  CurriculumLesson,
  "id" | "orgId" | "status" | "createdAt" | "updatedAt"
> & { status?: ContentStatus };

export type CurriculumAssetInput = Omit<
  CurriculumAsset,
  "id" | "orgId" | "status" | "createdAt" | "updatedAt"
> & { status?: AssetStatus };

export type CurriculumVersionInput = Omit<CurriculumVersion, "id" | "orgId" | "createdAt">;

export type LessonCompletionInput = Omit<LessonCompletion, "completedAt">;

// ─── Deterministic helpers ────────────────────────────────────────────────

/** Fresh entity id. Used by the stores (which live in a later unit). */
export function newId(): string {
  return randomUUID();
}

/** Stable ascending sort by `order` — never mutates the input. */
export function sortByOrder<T extends { order: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.order - b.order);
}

/** Stable ascending sort by `globalOrder` (lesson sequence across the whole course). */
export function sortByGlobalOrder<T extends { globalOrder: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.globalOrder - b.globalOrder);
}
