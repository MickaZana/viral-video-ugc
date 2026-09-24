import { describe, expect, it } from "vitest";
import type { CurriculumPlan, LessonPlan, ModulePlan, ProjectPlan } from "./schema.js";
import { runCurriculumQa, type CurriculumQaIssue } from "./qa.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A small, clean 2×2 plan: no errors, `ok: true`. Tests mutate a copy of this. */
function cleanPlan(): CurriculumPlan {
  return {
    course: {
      title: "Practical TypeScript",
      slug: "practical-typescript",
      topic: "typescript",
      audience: "developers",
      startingKnowledge: ["javascript"],
      endGoal: "Ship typed applications confidently",
      language: "en",
      moduleCount: 2,
      lessonsPerModule: 2,
      shortDurationSec: 60,
      longFormTargetMin: 12
    },
    modules: [
      {
        order: 1,
        title: "Types Fundamentals",
        description: "Intro to the type system.",
        goal: "Understand how typed applications model data with primitive and object types.",
        prerequisites: [],
        learningObjectives: ["Explain primitive types clearly and completely."],
        concepts: ["primitive types", "type inference"]
      },
      {
        order: 2,
        title: "Generics And Narrowing",
        description: "Reusable typed code.",
        goal: "Ship reusable functions using generics and control flow narrowing confidently.",
        prerequisites: ["Module 1"],
        learningObjectives: ["Write a generic function that preserves the argument type."],
        concepts: ["generic functions", "control flow narrowing"]
      }
    ],
    lessons: [
      {
        moduleOrder: 1,
        lessonOrder: 1,
        globalOrder: 1,
        title: "Primitive types in practice",
        learningObjective: "Identify string number and boolean primitive types in real code.",
        prerequisites: [],
        concepts: ["primitive types"]
      },
      {
        moduleOrder: 1,
        lessonOrder: 2,
        globalOrder: 2,
        title: "How type inference works",
        learningObjective: "Predict what type inference assigns to an untyped variable here.",
        prerequisites: ["Primitive types in practice"],
        concepts: ["type inference"]
      },
      {
        moduleOrder: 2,
        lessonOrder: 1,
        globalOrder: 3,
        title: "Writing generic functions",
        learningObjective: "Author a generic function that works for many argument types.",
        prerequisites: ["type inference"],
        concepts: ["generic functions"]
      },
      {
        moduleOrder: 2,
        lessonOrder: 2,
        globalOrder: 4,
        title: "Control flow narrowing basics",
        learningObjective: "Use conditionals to narrow a union type to one member.",
        prerequisites: ["generic functions"],
        concepts: ["control flow narrowing"]
      }
    ],
    projects: [
      {
        moduleOrder: 1,
        title: "Primitive type explorer",
        objective: "Build a script that reports the primitive types of its inputs.",
        outcome: "A tool that prints inference results for primitive types.",
        requirements: ["Use type inference"],
        steps: [],
        technologies: ["typescript"]
      },
      {
        moduleOrder: 2,
        title: "Generic narrowing toolkit",
        objective: "Build helpers that combine generic functions with control flow narrowing.",
        outcome: "A library of generic narrowing utilities.",
        requirements: ["Use generic functions"],
        steps: [],
        technologies: ["typescript"]
      }
    ]
  };
}

const WORDS = [
  "signal", "buffer", "vector", "kernel", "lattice", "cipher", "harbor", "meadow",
  "quartz", "pixel", "ledger", "cascade", "orbit", "prism", "delta", "ember",
  "granite", "helix", "ionic", "jasper", "koala", "lumen", "marble", "nimbus",
  "onyx", "pylon", "quill", "ripple", "sable", "tundra", "umber", "vellum",
  "willow", "xenon", "yarrow", "zephyr", "amber", "basil", "cobalt", "dune"
];
const word = (n: number): string => WORDS[((n % WORDS.length) + WORDS.length) % WORDS.length];

/** A 20-module × 10-lesson + 20-project plan in the "Agentic AI" shape. */
function agenticShapePlan(): CurriculumPlan {
  const moduleCount = 20;
  const lessonsPerModule = 10;
  const modules: ModulePlan[] = [];
  const lessons: LessonPlan[] = [];
  const projects: ProjectPlan[] = [];

  for (let m = 1; m <= moduleCount; m++) {
    modules.push({
      order: m,
      title: `Module ${m} Topic ${m}`,
      description: `Description for module ${m}.`,
      goal: `Learners evaluate module ${m} agentic systems and skills in real depth.`,
      prerequisites: m === 1 ? [] : [`Module ${m - 1}`],
      learningObjectives: [`Understand the central ideas of module ${m} thoroughly and clearly.`],
      concepts: [`concept ${m} alpha`, `concept ${m} beta`]
    });
    for (let l = 1; l <= lessonsPerModule; l++) {
      const globalOrder = (m - 1) * lessonsPerModule + l;
      lessons.push({
        moduleOrder: m,
        lessonOrder: l,
        globalOrder,
        title: `${word(globalOrder)} ${word(globalOrder * 13)} ${word(globalOrder * 29)} ${globalOrder}`,
        learningObjective: `Learner can explain and apply lesson ${l} of module ${m} correctly today.`,
        prerequisites: globalOrder === 1 ? [] : [`lesson concept ${globalOrder - 1}`],
        concepts: [`lesson concept ${globalOrder}`]
      });
    }
    projects.push({
      moduleOrder: m,
      title: `Module ${m} capstone project`,
      objective: `Build a project that exercises module ${m} concept ${m} alpha thoroughly.`,
      outcome: `A working artifact demonstrating module ${m} concept ${m} skills.`,
      requirements: [`Finish the module ${m} lessons`],
      steps: [],
      technologies: []
    });
  }

  return {
    course: {
      title: "Agentic Shape",
      slug: "agentic-shape",
      topic: "agentic ai",
      audience: "developers",
      startingKnowledge: [],
      endGoal: "Learners evaluate agentic systems skills",
      language: "en",
      moduleCount,
      lessonsPerModule,
      shortDurationSec: 60,
      longFormTargetMin: 15
    },
    modules,
    lessons,
    projects
  };
}

const codes = (issues: CurriculumQaIssue[]): string[] => issues.map((i) => i.code);
const has = (issues: CurriculumQaIssue[], code: string): boolean =>
  issues.some((i) => i.code === code);

// ─── Clean baseline ──────────────────────────────────────────────────────────

describe("runCurriculumQa — clean plans", () => {
  it("a clean 2x2 plan yields no errors and ok:true", () => {
    const report = runCurriculumQa(cleanPlan());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("an Agentic-AI-shaped plan (20x10 + 20 projects) yields no errors", () => {
    const report = runCurriculumQa(agenticShapePlan());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ─── One test per ERROR check ────────────────────────────────────────────────

describe("runCurriculumQa — error checks", () => {
  it("count-mismatch: flags module/lesson/project counts that disagree with the course", () => {
    const plan = cleanPlan();
    plan.course.moduleCount = 3; // now 2 modules, 4 lessons (want 6), 2 projects (want 3)
    const report = runCurriculumQa(plan);
    expect(has(report.errors, "count-mismatch")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("duplicate-lesson-title: flags two lessons with the same normalized title", () => {
    const plan = cleanPlan();
    plan.lessons[2].title = "  Primitive Types In Practice  "; // == lessons[0] normalized
    const report = runCurriculumQa(plan);
    const issue = report.errors.find((i) => i.code === "duplicate-lesson-title");
    expect(issue?.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  it("concept-before-prerequisite: flags a lesson requiring a concept taught later", () => {
    const plan = cleanPlan();
    plan.lessons[0].prerequisites = ["control flow narrowing"]; // introduced at lesson 3/4
    const report = runCurriculumQa(plan);
    const issue = report.errors.find((i) => i.code === "concept-before-prerequisite");
    expect(issue?.severity).toBe("error");
    expect(issue?.lessonGlobalOrder).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("circular-module-prerequisite: flags a two-module prerequisite cycle", () => {
    const plan = cleanPlan();
    plan.modules[0].prerequisites = ["Module 2"]; // module 2 already requires Module 1
    const report = runCurriculumQa(plan);
    expect(has(report.errors, "circular-module-prerequisite")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("forward-module-prerequisite: flags a module requiring a later module", () => {
    const plan = cleanPlan();
    plan.modules[0].prerequisites = ["Module 2"];
    plan.modules[1].prerequisites = []; // break the back-edge so it is forward-only
    const report = runCurriculumQa(plan);
    expect(has(report.errors, "forward-module-prerequisite")).toBe(true);
    expect(has(report.errors, "circular-module-prerequisite")).toBe(false);
    expect(report.ok).toBe(false);
  });
});

// ─── One test per WARNING check ──────────────────────────────────────────────

describe("runCurriculumQa — warning checks", () => {
  it("near-duplicate-lesson-title: flags titles with token Jaccard > 0.8", () => {
    const plan = cleanPlan();
    plan.lessons[0].title = "Working with primitive value types";
    plan.lessons[1].title = "Working with primitive value types today"; // 5/6 tokens shared
    const report = runCurriculumQa(plan);
    const issue = report.warnings.find((i) => i.code === "near-duplicate-lesson-title");
    expect(issue?.severity).toBe("warning");
    expect(report.ok).toBe(true);
  });

  it("duplicate-module-concept: flags a concept shared by two modules", () => {
    const plan = cleanPlan();
    plan.modules[1].concepts = ["generic functions", "primitive types"]; // "primitive types" also in module 1
    const report = runCurriculumQa(plan);
    expect(has(report.warnings, "duplicate-module-concept")).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("module-overlap: flags two modules whose concept sets have Jaccard > 0.6", () => {
    const plan = cleanPlan();
    plan.modules[1].concepts = ["primitive types", "type inference"]; // identical to module 1
    const report = runCurriculumQa(plan);
    expect(has(report.warnings, "module-overlap")).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("difficulty-jump: flags a mid/late module claiming no prerequisites", () => {
    const plan = cleanPlan();
    plan.modules[1].prerequisites = []; // module 2, past ceil(2/3) = 1
    const report = runCurriculumQa(plan);
    const issue = report.warnings.find((i) => i.code === "difficulty-jump");
    expect(issue?.moduleOrder).toBe(2);
    expect(report.ok).toBe(true);
  });

  it("project-unrelated-to-module: flags a project sharing no keyword with its module", () => {
    const plan = cleanPlan();
    plan.projects[0] = {
      moduleOrder: 1,
      title: "Weather dashboard",
      objective: "Build a small widget that shows sunshine.",
      outcome: "A colorful gadget on screen.",
      requirements: ["Use a browser"],
      steps: [],
      technologies: []
    };
    const report = runCurriculumQa(plan);
    const issue = report.warnings.find((i) => i.code === "project-unrelated-to-module");
    expect(issue?.moduleOrder).toBe(1);
    expect(report.ok).toBe(true);
  });

  it("end-goal-not-covered: flags an end-goal keyword absent from all objectives and goals", () => {
    const plan = cleanPlan();
    plan.course.endGoal = "Master quantum teleportation techniques";
    const report = runCurriculumQa(plan);
    expect(has(report.warnings, "end-goal-not-covered")).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("sparse-lesson-objective: flags a learning objective under 5 words", () => {
    const plan = cleanPlan();
    plan.lessons[0].learningObjective = "Learn types.";
    const report = runCurriculumQa(plan);
    const issue = report.warnings.find((i) => i.code === "sparse-lesson-objective");
    expect(issue?.lessonGlobalOrder).toBe(1);
    expect(report.ok).toBe(true);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("runCurriculumQa — determinism", () => {
  it("returns deeply-equal reports when called twice on the same plan", () => {
    const plan = cleanPlan();
    plan.course.moduleCount = 5; // count-mismatch
    plan.lessons[3].title = "primitive types in practice"; // duplicate-lesson-title
    plan.lessons[0].learningObjective = "Too short"; // sparse-lesson-objective
    plan.modules[0].prerequisites = ["Module 2"]; // circular + forward
    plan.course.endGoal = "Master quantum teleportation techniques"; // end-goal-not-covered
    const a = runCurriculumQa(plan);
    const b = runCurriculumQa(plan);
    expect(a).toEqual(b);
    expect(a.errors.length).toBeGreaterThan(0);
    expect(a.warnings.length).toBeGreaterThan(0);
  });

  it("sorts errors and warnings by (moduleOrder, lessonGlobalOrder, code)", () => {
    const plan = cleanPlan();
    plan.lessons[3].title = "primitive types in practice"; // duplicate at globalOrder 1 & 4
    plan.lessons[2].learningObjective = "Too few words"; // sparse at globalOrder 3
    plan.lessons[0].learningObjective = "Also too few"; // sparse at globalOrder 1
    const report = runCurriculumQa(plan);
    const rank = (i: CurriculumQaIssue, j: CurriculumQaIssue): number =>
      (i.moduleOrder ?? 0) - (j.moduleOrder ?? 0) ||
      (i.lessonGlobalOrder ?? 0) - (j.lessonGlobalOrder ?? 0) ||
      (i.code < j.code ? -1 : i.code > j.code ? 1 : 0) ||
      (i.message < j.message ? -1 : i.message > j.message ? 1 : 0);
    for (const list of [report.errors, report.warnings]) {
      for (let k = 1; k < list.length; k++) {
        expect(rank(list[k - 1], list[k]) <= 0).toBe(true);
      }
    }
    expect(codes(report.warnings).length).toBeGreaterThan(0);
    expect(codes(report.errors).length).toBeGreaterThan(0);
  });
});
