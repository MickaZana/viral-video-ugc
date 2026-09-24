import { describe, expect, it } from "vitest";
import {
  AssetStatusSchema,
  AssetTypeSchema,
  ContentStatusSchema,
  CoursePlanSchema,
  CurriculumAssetSchema,
  CurriculumCourseSchema,
  CurriculumLessonSchema,
  CurriculumModuleSchema,
  CurriculumPlanSchema,
  CurriculumProjectSchema,
  CurriculumProjectStepSchema,
  CurriculumStatusSchema,
  CurriculumVersionSchema,
  KnowledgeCheckQuestionSchema,
  LessonCompletionSchema,
  LessonPlanSchema,
  ModulePlanSchema,
  ModuleStatusSchema,
  ProjectPlanSchema,
  newId,
  sortByGlobalOrder,
  sortByOrder
} from "./index.js";

const NOW = "2026-09-06T00:00:00.000Z";

describe("status enums", () => {
  it("accept a valid member and reject an unknown one", () => {
    for (const s of [
      CurriculumStatusSchema,
      ContentStatusSchema,
      ModuleStatusSchema,
      AssetTypeSchema,
      AssetStatusSchema
    ]) {
      expect(s.parse(s.options[0])).toBe(s.options[0]);
      expect(s.safeParse("definitely-not-a-member").success).toBe(false);
    }
  });
});

describe("CurriculumCourseSchema", () => {
  const minimal = {
    id: "c1",
    orgId: "o1",
    title: "Intro to X",
    slug: "intro-to-x",
    topic: "X",
    audience: "beginners",
    endGoal: "ship a project",
    moduleCount: 3,
    lessonsPerModule: 4,
    createdAt: NOW,
    updatedAt: NOW
  };

  it("parses a minimal course and applies defaults", () => {
    const course = CurriculumCourseSchema.parse(minimal);
    expect(course.status).toBe("draft");
    expect(course.language).toBe("en");
    expect(course.startingKnowledge).toEqual([]);
    expect(course.shortDurationSec).toBe(60);
    expect(course.longFormTargetMin).toBe(12);
    expect(course.maxGenerationSpendUsd).toBe(50);
    expect(course.activeVersion).toBeNull();
  });

  it("allows a null spend cap", () => {
    expect(CurriculumCourseSchema.parse({ ...minimal, maxGenerationSpendUsd: null }).maxGenerationSpendUsd).toBeNull();
  });

  it("rejects moduleCount < 1", () => {
    expect(CurriculumCourseSchema.safeParse({ ...minimal, moduleCount: 0 }).success).toBe(false);
  });
});

describe("CurriculumModuleSchema", () => {
  const minimal = {
    id: "m1",
    orgId: "o1",
    courseId: "c1",
    order: 1,
    title: "Module 1",
    description: "d",
    goal: "g",
    createdAt: NOW,
    updatedAt: NOW
  };

  it("parses a minimal module with defaults", () => {
    const mod = CurriculumModuleSchema.parse(minimal);
    expect(mod.status).toBe("draft");
    expect(mod.longFormScriptStatus).toBe("draft");
    expect(mod.concepts).toEqual([]);
  });

  it("rejects order < 1", () => {
    expect(CurriculumModuleSchema.safeParse({ ...minimal, order: 0 }).success).toBe(false);
  });
});

describe("CurriculumProjectStepSchema", () => {
  it("parses a valid step and rejects a non-integer order", () => {
    expect(CurriculumProjectStepSchema.parse({ order: 2, title: "t", detail: "d" }).order).toBe(2);
    expect(CurriculumProjectStepSchema.safeParse({ order: 1.5, title: "t", detail: "d" }).success).toBe(false);
  });
});

describe("CurriculumProjectSchema", () => {
  const minimal = {
    id: "p1",
    orgId: "o1",
    courseId: "c1",
    moduleId: "m1",
    title: "Build it",
    objective: "obj",
    outcome: "out",
    createdAt: NOW,
    updatedAt: NOW
  };

  it("parses a minimal project with defaults", () => {
    const proj = CurriculumProjectSchema.parse(minimal);
    expect(proj.status).toBe("draft");
    expect(proj.steps).toEqual([]);
    expect(proj.technologies).toEqual([]);
  });

  it("rejects a missing objective", () => {
    const bad = { ...minimal, objective: undefined };
    expect(CurriculumProjectSchema.safeParse(bad).success).toBe(false);
  });
});

describe("KnowledgeCheckQuestionSchema", () => {
  it("parses a minimal question and rejects a bad kind", () => {
    const q = KnowledgeCheckQuestionSchema.parse({ kind: "concept", prompt: "why?" });
    expect(q.options).toEqual([]);
    expect(q.answerIndex).toBeNull();
    expect(KnowledgeCheckQuestionSchema.safeParse({ kind: "essay", prompt: "why?" }).success).toBe(false);
  });
});

describe("CurriculumLessonSchema", () => {
  const minimal = {
    id: "l1",
    orgId: "o1",
    courseId: "c1",
    moduleId: "m1",
    moduleOrder: 1,
    lessonOrder: 1,
    globalOrder: 1,
    title: "Lesson 1",
    learningObjective: "learn",
    createdAt: NOW,
    updatedAt: NOW
  };

  it("parses a minimal lesson with defaults", () => {
    const lesson = CurriculumLessonSchema.parse(minimal);
    expect(lesson.status).toBe("draft");
    expect(lesson.knowledgeCheck).toEqual([]);
    expect(lesson.concepts).toEqual([]);
  });

  it("rejects globalOrder < 1", () => {
    expect(CurriculumLessonSchema.safeParse({ ...minimal, globalOrder: 0 }).success).toBe(false);
  });
});

describe("CurriculumAssetSchema", () => {
  const minimal = {
    id: "a1",
    orgId: "o1",
    courseId: "c1",
    assetType: "short_video",
    createdAt: NOW,
    updatedAt: NOW
  };

  it("parses a minimal asset with defaults", () => {
    const asset = CurriculumAssetSchema.parse(minimal);
    expect(asset.status).toBe("planned");
    expect(asset.meta).toEqual({});
  });

  it("rejects an unknown assetType", () => {
    expect(CurriculumAssetSchema.safeParse({ ...minimal, assetType: "hologram" }).success).toBe(false);
  });
});

describe("CurriculumVersionSchema", () => {
  const minimal = {
    id: "v1",
    orgId: "o1",
    courseId: "c1",
    version: 1,
    createdAt: NOW,
    createdByAccountId: "acc1",
    reason: "lock for production",
    snapshot: { anything: true }
  };

  it("parses a minimal version", () => {
    expect(CurriculumVersionSchema.parse(minimal).version).toBe(1);
  });

  it("rejects version < 1", () => {
    expect(CurriculumVersionSchema.safeParse({ ...minimal, version: 0 }).success).toBe(false);
  });
});

describe("LessonCompletionSchema", () => {
  const minimal = {
    orgId: "o1",
    courseId: "c1",
    lessonId: "l1",
    accountId: "acc1",
    completedAt: NOW
  };

  it("parses a minimal completion", () => {
    expect(LessonCompletionSchema.parse(minimal).accountId).toBe("acc1");
  });

  it("rejects a non-datetime completedAt", () => {
    expect(LessonCompletionSchema.safeParse({ ...minimal, completedAt: "yesterday" }).success).toBe(false);
  });
});

describe("plan sub-schemas", () => {
  it("CoursePlanSchema parses and rejects bad input", () => {
    const plan = CoursePlanSchema.parse({
      title: "T",
      slug: "t",
      topic: "T",
      audience: "a",
      endGoal: "e",
      moduleCount: 2,
      lessonsPerModule: 2
    });
    expect(plan.language).toBe("en");
    expect(CoursePlanSchema.safeParse({ title: "T" }).success).toBe(false);
  });

  it("ModulePlanSchema / LessonPlanSchema / ProjectPlanSchema parse and reject", () => {
    expect(
      ModulePlanSchema.parse({ order: 1, title: "M", description: "d", goal: "g" }).prerequisites
    ).toEqual([]);
    expect(ModulePlanSchema.safeParse({ order: 0, title: "M", description: "d", goal: "g" }).success).toBe(false);

    expect(
      LessonPlanSchema.parse({
        moduleOrder: 1,
        lessonOrder: 1,
        globalOrder: 1,
        title: "L",
        learningObjective: "lo"
      }).concepts
    ).toEqual([]);
    expect(
      LessonPlanSchema.safeParse({ moduleOrder: 1, lessonOrder: 1, globalOrder: 1, title: "L" }).success
    ).toBe(false);

    expect(
      ProjectPlanSchema.parse({ moduleOrder: 1, title: "P", objective: "o", outcome: "out" }).steps
    ).toEqual([]);
    expect(ProjectPlanSchema.safeParse({ moduleOrder: 1, title: "P" }).success).toBe(false);
  });
});

describe("CurriculumPlanSchema", () => {
  it("accepts a hand-built plan of 2 modules x 2 lessons + 2 projects", () => {
    const plan = {
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
        shortDurationSec: 60,
        longFormTargetMin: 12
      },
      modules: [
        { order: 1, title: "Foundations", description: "d1", goal: "g1", learningObjectives: ["lo"], concepts: ["tokens"] },
        { order: 2, title: "Patterns", description: "d2", goal: "g2" }
      ],
      lessons: [
        { moduleOrder: 1, lessonOrder: 1, globalOrder: 1, title: "What is a token", learningObjective: "lo1" },
        { moduleOrder: 1, lessonOrder: 2, globalOrder: 2, title: "Context windows", learningObjective: "lo2" },
        { moduleOrder: 2, lessonOrder: 1, globalOrder: 3, title: "Few-shot", learningObjective: "lo3" },
        { moduleOrder: 2, lessonOrder: 2, globalOrder: 4, title: "Chain of thought", learningObjective: "lo4" }
      ],
      projects: [
        {
          moduleOrder: 1,
          title: "Token budgeter",
          objective: "o1",
          outcome: "out1",
          steps: [{ order: 1, title: "s1", detail: "d" }],
          technologies: ["ts"]
        },
        { moduleOrder: 2, title: "Prompt router", objective: "o2", outcome: "out2" }
      ]
    };
    const parsed = CurriculumPlanSchema.parse(plan);
    expect(parsed.modules).toHaveLength(2);
    expect(parsed.lessons).toHaveLength(4);
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[1].steps).toEqual([]);
  });

  it("rejects a plan missing the course block", () => {
    expect(CurriculumPlanSchema.safeParse({ modules: [], lessons: [], projects: [] }).success).toBe(false);
  });
});

describe("ordering helpers", () => {
  it("sortByGlobalOrder sorts ascending without mutating", () => {
    const input = [{ globalOrder: 3 }, { globalOrder: 1 }, { globalOrder: 2 }];
    const sorted = sortByGlobalOrder(input);
    expect(sorted.map((x) => x.globalOrder)).toEqual([1, 2, 3]);
    expect(input.map((x) => x.globalOrder)).toEqual([3, 1, 2]);
  });

  it("sortByOrder sorts ascending", () => {
    expect(sortByOrder([{ order: 2 }, { order: 0 }, { order: 1 }]).map((x) => x.order)).toEqual([0, 1, 2]);
  });
});

describe("newId", () => {
  it("returns distinct UUIDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
