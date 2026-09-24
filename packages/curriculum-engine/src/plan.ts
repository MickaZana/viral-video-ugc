// Curriculum Mode v2 — pure validate-and-expand for an approved plan.
//
// This is the logic that used to live inline in store.ts's `saveApprovedPlan`,
// lifted out verbatim so the file store AND the Postgres tenant-profile store
// share ONE implementation of "turn an approved CurriculumPlan into the
// module/lesson/project rows for a course, or throw". No fs, no SQL, no I/O of
// any kind — callers own the pre-checks (course exists, no active version) and
// all persistence.

import {
  CurriculumCourseSchema,
  CurriculumLessonSchema,
  CurriculumModuleSchema,
  CurriculumPlanSchema,
  CurriculumProjectSchema,
  newId,
  sortByGlobalOrder,
  sortByOrder,
  type CurriculumCourse,
  type CurriculumLesson,
  type CurriculumModule,
  type CurriculumPlan,
  type CurriculumProject
} from "./schema.js";

function now(): string {
  return new Date().toISOString();
}

/** The fully-expanded, persist-ready result of {@link expandCurriculumPlan}. */
export interface ExpandedCurriculumPlan {
  /** `course` with `plan.course` folded in and `status` set to `"planned"`. */
  course: CurriculumCourse;
  modules: CurriculumModule[];
  lessons: CurriculumLesson[];
  projects: CurriculumProject[];
}

/**
 * Pure validate-and-expand for an approved {@link CurriculumPlan}.
 *
 * Re-parses `plan`, expands it into fully-formed module/lesson/project rows for
 * `(orgId, courseId)` ({@link newId} ids + timestamps, every row schema-parsed),
 * runs the whole-structure assertions — exact module/lesson/project counts
 * against `plan.course.moduleCount`×`plan.course.lessonsPerModule`, a contiguous
 * `1..N` `globalOrder` run, every lesson/project `moduleOrder` resolving to a
 * module — and folds `plan.course` into `course` with `status: "planned"`.
 * Throws on any failure and touches no storage. Returned rows are sorted exactly
 * the way both stores return them from `saveApprovedPlan`.
 */
export function expandCurriculumPlan(
  orgId: string,
  courseId: string,
  course: CurriculumCourse,
  plan: CurriculumPlan
): ExpandedCurriculumPlan {
  // 1. Re-validate the entire plan — trust nothing that reaches the store.
  const p = CurriculumPlanSchema.parse(plan);
  const ts = now();

  // 2. Expand modules first so lessons/projects can resolve their owner.
  const modules: CurriculumModule[] = p.modules.map((m) =>
    CurriculumModuleSchema.parse({
      id: newId(),
      orgId,
      courseId,
      order: m.order,
      title: m.title,
      description: m.description,
      goal: m.goal,
      prerequisites: m.prerequisites,
      learningObjectives: m.learningObjectives,
      concepts: m.concepts,
      createdAt: ts,
      updatedAt: ts
    })
  );
  const moduleIdByOrder = new Map<number, string>();
  for (const m of modules) moduleIdByOrder.set(m.order, m.id);

  const lessons: CurriculumLesson[] = p.lessons.map((l) => {
    const moduleId = moduleIdByOrder.get(l.moduleOrder);
    if (!moduleId) {
      throw new Error(
        `saveApprovedPlan: lesson "${l.title}" references unknown moduleOrder ${l.moduleOrder}`
      );
    }
    return CurriculumLessonSchema.parse({
      id: newId(),
      orgId,
      courseId,
      moduleId,
      moduleOrder: l.moduleOrder,
      lessonOrder: l.lessonOrder,
      globalOrder: l.globalOrder,
      title: l.title,
      learningObjective: l.learningObjective,
      prerequisites: l.prerequisites,
      concepts: l.concepts,
      createdAt: ts,
      updatedAt: ts
    });
  });

  const projects: CurriculumProject[] = p.projects.map((pr) => {
    const moduleId = moduleIdByOrder.get(pr.moduleOrder);
    if (!moduleId) {
      throw new Error(
        `saveApprovedPlan: project "${pr.title}" references unknown moduleOrder ${pr.moduleOrder}`
      );
    }
    return CurriculumProjectSchema.parse({
      id: newId(),
      orgId,
      courseId,
      moduleId,
      title: pr.title,
      objective: pr.objective,
      outcome: pr.outcome,
      requirements: pr.requirements,
      steps: pr.steps,
      technologies: pr.technologies,
      createdAt: ts,
      updatedAt: ts
    });
  });

  // 3. Whole-structure assertions — any failure throws BEFORE any write.
  const expectedLessons = p.course.moduleCount * p.course.lessonsPerModule;
  if (modules.length !== p.course.moduleCount) {
    throw new Error(
      `saveApprovedPlan: expected ${p.course.moduleCount} modules, got ${modules.length}`
    );
  }
  if (projects.length !== p.course.moduleCount) {
    throw new Error(
      `saveApprovedPlan: expected ${p.course.moduleCount} projects, got ${projects.length}`
    );
  }
  if (lessons.length !== expectedLessons) {
    throw new Error(
      `saveApprovedPlan: expected ${expectedLessons} lessons ` +
        `(${p.course.moduleCount}×${p.course.lessonsPerModule}), got ${lessons.length}`
    );
  }
  const globalOrders = lessons.map((l) => l.globalOrder).sort((a, b) => a - b);
  for (let i = 0; i < globalOrders.length; i++) {
    if (globalOrders[i] !== i + 1) {
      throw new Error(
        `saveApprovedPlan: globalOrder must be a contiguous 1..${globalOrders.length} run`
      );
    }
  }

  // 4. Build the updated course row (may throw) before any persistence.
  const updatedCourse = CurriculumCourseSchema.parse({
    ...course,
    title: p.course.title,
    slug: p.course.slug,
    topic: p.course.topic,
    audience: p.course.audience,
    startingKnowledge: p.course.startingKnowledge,
    endGoal: p.course.endGoal,
    language: p.course.language,
    moduleCount: p.course.moduleCount,
    lessonsPerModule: p.course.lessonsPerModule,
    shortDurationSec: p.course.shortDurationSec,
    longFormTargetMin: p.course.longFormTargetMin,
    status: "planned",
    updatedAt: now()
  });

  const orderByModuleId = new Map(modules.map((m) => [m.id, m.order] as const));
  return {
    course: updatedCourse,
    modules: sortByOrder(modules),
    lessons: sortByGlobalOrder(lessons),
    projects: [...projects].sort(
      (a, b) =>
        (orderByModuleId.get(a.moduleId) ?? 0) - (orderByModuleId.get(b.moduleId) ?? 0) ||
        a.id.localeCompare(b.id)
    )
  };
}

/** Rebuild a CurriculumPlan (the LLM-output shape) from persisted rows — used to
 *  re-run QA on a stored plan and to snapshot a version. Inverse of expandCurriculumPlan:
 *  drop ids/orgId/timestamps/status, keep ordering keys. */
export function toCurriculumPlan(
  course: CurriculumCourse,
  modules: CurriculumModule[],
  lessons: CurriculumLesson[],
  projects: CurriculumProject[]
): CurriculumPlan {
  const orderByModuleId = new Map(modules.map((m) => [m.id, m.order] as const));

  const coursePlan = {
    title: course.title,
    slug: course.slug,
    topic: course.topic,
    audience: course.audience,
    startingKnowledge: course.startingKnowledge,
    endGoal: course.endGoal,
    language: course.language,
    moduleCount: course.moduleCount,
    lessonsPerModule: course.lessonsPerModule,
    shortDurationSec: course.shortDurationSec,
    longFormTargetMin: course.longFormTargetMin
  };

  const modulePlans = sortByOrder(modules).map((m) => ({
    order: m.order,
    title: m.title,
    description: m.description,
    goal: m.goal,
    prerequisites: m.prerequisites,
    learningObjectives: m.learningObjectives,
    concepts: m.concepts
  }));

  const lessonPlans = sortByGlobalOrder(lessons).map((l) => ({
    moduleOrder: l.moduleOrder,
    lessonOrder: l.lessonOrder,
    globalOrder: l.globalOrder,
    title: l.title,
    learningObjective: l.learningObjective,
    prerequisites: l.prerequisites,
    concepts: l.concepts
  }));

  const projectPlans = [...projects]
    .map((p) => ({
      moduleOrder: orderByModuleId.get(p.moduleId) ?? 0,
      title: p.title,
      objective: p.objective,
      outcome: p.outcome,
      requirements: p.requirements,
      steps: p.steps,
      technologies: p.technologies
    }))
    .sort((a, b) => a.moduleOrder - b.moduleOrder);

  return CurriculumPlanSchema.parse({
    course: coursePlan,
    modules: modulePlans,
    lessons: lessonPlans,
    projects: projectPlans
  });
}
