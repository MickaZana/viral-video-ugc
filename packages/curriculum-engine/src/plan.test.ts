import { describe, expect, it } from "vitest";
import { expandCurriculumPlan, toCurriculumPlan } from "./plan.js";
import { CurriculumCourseSchema, type CurriculumCourse, type CurriculumPlan } from "./schema.js";

// A hand-built 2×2 plan (2 modules × 2 lessons + one project per module), shaped
// exactly like the architect's mock output. Same style as store.test.ts's buildPlan.
function build2x2Plan(): CurriculumPlan {
  return {
    course: {
      title: "Practical AI Prompting",
      slug: "practical-ai-prompting",
      topic: "prompt engineering",
      audience: "developers",
      startingKnowledge: ["basic programming"],
      endGoal: "design robust prompt pipelines",
      language: "en",
      moduleCount: 2,
      lessonsPerModule: 2,
      shortDurationSec: 45,
      longFormTargetMin: 15
    },
    modules: [
      {
        order: 1,
        title: "Module 1",
        description: "description 1",
        goal: "goal 1",
        prerequisites: [],
        learningObjectives: ["objective 1"],
        concepts: ["concept-1"]
      },
      {
        order: 2,
        title: "Module 2",
        description: "description 2",
        goal: "goal 2",
        prerequisites: ["Module 1 concepts"],
        learningObjectives: ["objective 2"],
        concepts: ["concept-2"]
      }
    ],
    lessons: [
      { moduleOrder: 1, lessonOrder: 1, globalOrder: 1, title: "Lesson 1.1", learningObjective: "learn 1.1", prerequisites: [], concepts: [] },
      { moduleOrder: 1, lessonOrder: 2, globalOrder: 2, title: "Lesson 1.2", learningObjective: "learn 1.2", prerequisites: [], concepts: [] },
      { moduleOrder: 2, lessonOrder: 1, globalOrder: 3, title: "Lesson 2.1", learningObjective: "learn 2.1", prerequisites: [], concepts: [] },
      { moduleOrder: 2, lessonOrder: 2, globalOrder: 4, title: "Lesson 2.2", learningObjective: "learn 2.2", prerequisites: [], concepts: [] }
    ],
    projects: [
      { moduleOrder: 1, title: "Project 1", objective: "objective 1", outcome: "outcome 1", requirements: [], steps: [], technologies: [] },
      { moduleOrder: 2, title: "Project 2", objective: "objective 2", outcome: "outcome 2", requirements: [], steps: [], technologies: [] }
    ]
  };
}

function courseRow(over: Partial<CurriculumCourse> = {}): CurriculumCourse {
  const ts = new Date().toISOString();
  return CurriculumCourseSchema.parse({
    id: "course-1",
    orgId: "orgA",
    title: "Practical AI Prompting",
    slug: "practical-ai-prompting",
    topic: "prompt engineering",
    audience: "developers",
    startingKnowledge: ["basic programming"],
    endGoal: "design robust prompt pipelines",
    language: "en",
    status: "draft",
    moduleCount: 2,
    lessonsPerModule: 2,
    shortDurationSec: 60,
    longFormTargetMin: 12,
    maxGenerationSpendUsd: 50,
    activeVersion: null,
    createdAt: ts,
    updatedAt: ts,
    ...over
  });
}

describe("toCurriculumPlan", () => {
  it("round-trips: expandCurriculumPlan rows -> toCurriculumPlan === the original plan", () => {
    const plan = build2x2Plan();
    const expanded = expandCurriculumPlan("orgA", "course-1", courseRow(), plan);

    const rebuilt = toCurriculumPlan(
      expanded.course,
      expanded.modules,
      expanded.lessons,
      expanded.projects
    );

    // Structural fields: counts, orders, titles.
    expect(rebuilt.modules).toHaveLength(2);
    expect(rebuilt.lessons).toHaveLength(4);
    expect(rebuilt.projects).toHaveLength(2);
    expect(rebuilt.modules.map((m) => m.order)).toEqual([1, 2]);
    expect(rebuilt.modules.map((m) => m.title)).toEqual(["Module 1", "Module 2"]);
    expect(rebuilt.lessons.map((l) => l.globalOrder)).toEqual([1, 2, 3, 4]);
    expect(rebuilt.lessons.map((l) => [l.moduleOrder, l.lessonOrder])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2]
    ]);
    expect(rebuilt.lessons.map((l) => l.title)).toEqual([
      "Lesson 1.1",
      "Lesson 1.2",
      "Lesson 2.1",
      "Lesson 2.2"
    ]);
    expect(rebuilt.projects.map((p) => p.moduleOrder)).toEqual([1, 2]);
    expect(rebuilt.projects.map((p) => p.title)).toEqual(["Project 1", "Project 2"]);

    // And the whole plan is byte-identical to the schema-parsed original.
    expect(rebuilt).toEqual(plan);
  });

  it("orders modules by `order` and lessons by `globalOrder` regardless of row array order", () => {
    const plan = build2x2Plan();
    const expanded = expandCurriculumPlan("orgA", "course-1", courseRow(), plan);

    const shuffledModules = [...expanded.modules].reverse();
    const shuffledLessons = [...expanded.lessons].reverse();
    const shuffledProjects = [...expanded.projects].reverse();

    const rebuilt = toCurriculumPlan(
      expanded.course,
      shuffledModules,
      shuffledLessons,
      shuffledProjects
    );

    expect(rebuilt.modules.map((m) => m.order)).toEqual([1, 2]);
    expect(rebuilt.lessons.map((l) => l.globalOrder)).toEqual([1, 2, 3, 4]);
    expect(rebuilt.projects.map((p) => p.moduleOrder)).toEqual([1, 2]);
    expect(rebuilt).toEqual(plan);
  });
});
