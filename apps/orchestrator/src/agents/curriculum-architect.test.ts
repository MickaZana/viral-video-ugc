import {
  CurriculumCourseSchema,
  CurriculumPlanSchema,
  KnowledgeCheckQuestionSchema,
  expandCurriculumPlan,
  SEED_AGENTIC_AI
} from "@vvugc/curriculum-engine";
import { describe, expect, it } from "vitest";
import {
  buildMockCurriculumPlan,
  buildMockKnowledgeCheck,
  buildMockLessonScript,
  buildMockModuleLongForm,
  generateCurriculumPlan,
  generateKnowledgeCheck,
  generateLessonScript,
  generateModuleLongForm,
  type KnowledgeCheckContext,
  type LessonScriptContext
} from "./curriculum-architect.js";

const NOW = "2026-09-06T00:00:00.000Z";

/** A stub `deps.generate` returning a hand-written response — no network. */
function stubGenerate(payload: unknown) {
  return async () => ({ text: typeof payload === "string" ? payload : JSON.stringify(payload) });
}

function courseFromPlan(plan: ReturnType<typeof buildMockCurriculumPlan>) {
  return CurriculumCourseSchema.parse({
    id: "course",
    orgId: "org",
    ...plan.course,
    createdAt: NOW,
    updatedAt: NOW
  });
}

describe("buildMockCurriculumPlan — seeded (Agentic AI Simplified, 20×10)", () => {
  const req = {
    title: "Agentic AI Simplified",
    topic: "Agentic AI",
    audience: "Beginner-to-intermediate developers",
    startingKnowledge: ["Basic programming"],
    endGoal: "Build and deploy production-grade AI agents",
    moduleCount: 20,
    lessonsPerModule: 10,
    seed: SEED_AGENTIC_AI
  };
  const plan = buildMockCurriculumPlan(req);

  it("produces exactly 20 modules / 200 lessons / 20 projects", () => {
    expect(plan.modules).toHaveLength(20);
    expect(plan.lessons).toHaveLength(200);
    expect(plan.projects).toHaveLength(20);
  });

  it("has a contiguous 1..200 globalOrder run", () => {
    expect(plan.lessons.map((l) => l.globalOrder)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1)
    );
  });

  it("takes module titles verbatim from the seed", () => {
    expect(plan.modules[3].title).toBe("Tools and Function Calling");
    expect(plan.modules[19].title).toBe("Capstone Autonomous Application");
    expect(plan.course.slug).toBe("agentic-ai-simplified");
  });

  it("keeps every lesson's moduleOrder/lessonOrder consistent with its position", () => {
    plan.lessons.forEach((l, i) => {
      expect(l.moduleOrder).toBe(Math.floor(i / 10) + 1);
      expect(l.lessonOrder).toBe((i % 10) + 1);
      expect(l.globalOrder).toBe(i + 1);
    });
  });

  it("re-parses clean against CurriculumPlanSchema", () => {
    expect(() => CurriculumPlanSchema.parse(plan)).not.toThrow();
  });

  it("feeds expandCurriculumPlan (proves it reaches saveApprovedPlan): 20 / 200 / 20", () => {
    const expanded = expandCurriculumPlan("org", "course", courseFromPlan(plan), plan);
    expect(expanded.modules).toHaveLength(20);
    expect(expanded.lessons).toHaveLength(200);
    expect(expanded.projects).toHaveLength(20);
  });
});

describe("buildMockCurriculumPlan — unseeded (2×3)", () => {
  const plan = buildMockCurriculumPlan({
    title: "Tiny Course",
    topic: "Testing",
    audience: "devs",
    endGoal: "ship",
    moduleCount: 2,
    lessonsPerModule: 3
  });

  it("produces 2 modules / 6 lessons / 2 projects with generic titles", () => {
    expect(plan.modules).toHaveLength(2);
    expect(plan.lessons).toHaveLength(6);
    expect(plan.projects).toHaveLength(2);
    expect(plan.modules[0].title).toBe("Module 1");
    expect(plan.lessons[0].title).toBe("Module 1 — Lesson 1");
    expect(plan.lessons.map((l) => l.globalOrder)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("generateCurriculumPlan — LLM path with injected stub", () => {
  const req = {
    title: "Practical AI Prompting",
    topic: "prompt engineering",
    audience: "developers",
    endGoal: "design robust prompt pipelines",
    moduleCount: 2,
    lessonsPerModule: 2
  };

  const looseTwoByTwo = {
    modules: [
      { title: "Foundations", description: "d1", goal: "g1" },
      { title: "Patterns", description: "d2", goal: "g2" }
    ],
    lessons: [
      { moduleIndex: 1, title: "Tokens", learningObjective: "lo1" },
      { moduleIndex: 1, title: "Context windows", learningObjective: "lo2" },
      { moduleIndex: 2, title: "Few-shot", learningObjective: "lo3" },
      { moduleIndex: 2, title: "Chain of thought", learningObjective: "lo4" }
    ],
    projects: [
      { moduleIndex: 1, title: "Token budgeter", objective: "o1", outcome: "out1" },
      { moduleIndex: 2, title: "Prompt router", objective: "o2", outcome: "out2" }
    ]
  };

  it("stamps ordering and returns a strict 2 / 4 / 2 CurriculumPlan", async () => {
    const plan = await generateCurriculumPlan(req, { generate: stubGenerate(looseTwoByTwo) });
    expect(plan.modules.map((m) => m.order)).toEqual([1, 2]);
    expect(plan.lessons.map((l) => l.globalOrder)).toEqual([1, 2, 3, 4]);
    expect(plan.lessons.map((l) => l.lessonOrder)).toEqual([1, 2, 1, 2]);
    expect(plan.lessons.map((l) => l.moduleOrder)).toEqual([1, 1, 2, 2]);
    expect(plan.projects.map((p) => p.moduleOrder)).toEqual([1, 2]);
    expect(plan.modules).toHaveLength(2);
    expect(plan.lessons).toHaveLength(4);
    expect(plan.projects).toHaveLength(2);
    expect(() => CurriculumPlanSchema.parse(plan)).not.toThrow();
  });

  it("throws (returns nothing) when the model returns the wrong module count", async () => {
    const wrong = {
      ...looseTwoByTwo,
      modules: [{ title: "Only one", description: "d", goal: "g" }]
    };
    await expect(
      generateCurriculumPlan(req, { generate: stubGenerate(wrong) })
    ).rejects.toThrow(/EXACTLY 2 modules|module count/i);
  });

  it("throws on non-JSON garbage from the model", async () => {
    await expect(
      generateCurriculumPlan(req, { generate: stubGenerate("sorry, I cannot help with that") })
    ).rejects.toThrow();
  });

  it("throws when a module has the wrong lesson count", async () => {
    const wrong = {
      ...looseTwoByTwo,
      lessons: [
        { moduleIndex: 1, title: "Only lesson in module 1", learningObjective: "lo" },
        { moduleIndex: 2, title: "M2 L1", learningObjective: "lo" },
        { moduleIndex: 2, title: "M2 L2", learningObjective: "lo" }
      ]
    };
    await expect(
      generateCurriculumPlan(req, { generate: stubGenerate(wrong) })
    ).rejects.toThrow(/lessons per module|per-module/i);
  });
});

// ─── D4a: script generation ──────────────────────────────────────────────

describe("buildMockLessonScript — deterministic lesson narration", () => {
  const ctx: LessonScriptContext = {
    courseSummary: "Agentic AI Simplified: Agentic AI for engineers. End goal: ship an agent.",
    moduleSummary: "Module 2 — Tools. Goal: wire tools into an agent.",
    priorLessons: [
      { globalOrder: 3, title: "What is a tool call", keyTakeaway: "a tool is a typed function" },
      { globalOrder: 4, title: "Tool schemas" }
    ],
    nextLessonTitle: "Parallel tool calls",
    shortDurationSec: 60
  };
  const lessonA = {
    title: "Handling tool errors",
    learningObjective: "Recover from a failed tool call without crashing the agent.",
    concepts: ["retries", "error envelopes"],
    keyTakeaway: undefined,
    example: undefined,
    explanation: undefined
  };
  const lessonB = {
    ...lessonA,
    title: "Streaming tool results",
    learningObjective: "Stream partial tool output back into the agent loop."
  };

  it("returns non-empty text with the section markers and the lesson title", () => {
    const s = buildMockLessonScript(lessonA, ctx);
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain("HOOK");
    expect(s).toContain("NEXT");
    expect(s).toContain("Handling tool errors");
  });

  it("varies the opening line between two different lessons (hook is not shared)", () => {
    const a = buildMockLessonScript(lessonA, ctx).split("\n")[0];
    const b = buildMockLessonScript(lessonB, ctx).split("\n")[0];
    expect(a).not.toBe(b);
  });

  it("weaves in continuity context — module summary + next lesson title", () => {
    const s = buildMockLessonScript(lessonA, ctx);
    expect(s).toContain("Module 2 — Tools");
    expect(s).toContain("Parallel tool calls");
  });

  it("scales narration length toward the target spoken duration", () => {
    const short = buildMockLessonScript(lessonA, { ...ctx, shortDurationSec: 20 });
    const long = buildMockLessonScript(lessonA, { ...ctx, shortDurationSec: 120 });
    const words = (t: string) => t.trim().split(/\s+/).length;
    expect(words(long)).toBeGreaterThan(words(short));
  });
});

describe("generateLessonScript — real path with an injected generate stub", () => {
  const ctx: LessonScriptContext = {
    courseSummary: "C",
    moduleSummary: "M",
    priorLessons: [],
    shortDurationSec: 45
  };
  const lesson = {
    title: "T",
    learningObjective: "LO",
    concepts: [],
    keyTakeaway: undefined,
    example: undefined,
    explanation: undefined
  };

  it("returns the trimmed model text", async () => {
    const body = "   A real lesson script body that is comfortably past the minimum length gate.   ";
    const out = await generateLessonScript(lesson, ctx, { generate: stubGenerate(body) });
    expect(out).toBe(body.trim());
  });

  it("throws when the model returns nothing usable", async () => {
    await expect(
      generateLessonScript(lesson, ctx, { generate: stubGenerate("") })
    ).rejects.toThrow();
  });
});

describe("buildMockModuleLongForm — §24 ten-section outline", () => {
  const module = {
    order: 2,
    title: "Tools and Function Calling",
    goal: "Give an agent typed tools it can call safely.",
    concepts: ["tool schemas", "validation", "retries"],
    learningObjectives: ["define a tool", "validate arguments", "handle failures"]
  };
  const lessons = [
    { title: "What is a tool call", keyTakeaway: "a tool is a typed function" },
    { title: "Tool schemas" }
  ];
  const project = {
    title: "Typed Weather Tool",
    objective: "Build and register a validated weather tool.",
    steps: [
      { title: "Define schema", detail: "Zod-describe the inputs." },
      { title: "Register", detail: "Add it to the agent's tool list." }
    ]
  };

  it("contains all ten §24 section headers and the project title", () => {
    const s = buildMockModuleLongForm(module, lessons, project, 12);
    for (const header of [
      "INTRO",
      "PROBLEM",
      "CORE CONCEPTS",
      "ARCHITECTURE",
      "HANDS-ON PROJECT",
      "IMPLEMENTATION",
      "TEST",
      "COMMON MISTAKES",
      "FINISHED RESULT",
      "NEXT MODULE"
    ]) {
      expect(s).toContain(header);
    }
    expect(s).toContain("Typed Weather Tool");
  });

  it("is a real outline, not the lessons' scripts concatenated (references module goal + project)", () => {
    const s = buildMockModuleLongForm(module, lessons, project, 12);
    expect(s).toContain(module.goal);
    expect(s).toContain(project.objective);
  });
});

describe("generateModuleLongForm — real path with an injected generate stub", () => {
  const module = { order: 1, title: "M", goal: "G", concepts: [], learningObjectives: [] };

  it("returns the trimmed model text", async () => {
    const body = "  INTRO — a full ten-section module long-form script well past the length gate.  ";
    const out = await generateModuleLongForm(module, [], null, 10, { generate: stubGenerate(body) });
    expect(out).toBe(body.trim());
  });

  it("throws on empty model output", async () => {
    await expect(
      generateModuleLongForm(module, [], null, 10, { generate: stubGenerate("") })
    ).rejects.toThrow();
  });
});

// ─── F1: knowledge-check generation (Learn Mode §19) ─────────────────────

describe("buildMockKnowledgeCheck — deterministic lesson knowledge check", () => {
  const lesson = {
    title: "Handling tool errors",
    learningObjective: "Recover from a failed tool call without crashing the agent.",
    concepts: ["retries", "error envelopes"]
  };
  const ctx: KnowledgeCheckContext = {
    lessonTitle: lesson.title,
    learningObjective: lesson.learningObjective,
    concepts: lesson.concepts,
    explanation: "A failed call returns an error envelope the agent can branch on.",
    keyTakeaway: "Wrap every tool call so a failure is data, not an exception."
  };

  it("produces exactly `count` questions (default 3, and an explicit 5)", () => {
    expect(buildMockKnowledgeCheck(lesson, ctx)).toHaveLength(3);
    expect(buildMockKnowledgeCheck(lesson, ctx, 5)).toHaveLength(5);
    expect(buildMockKnowledgeCheck(lesson, ctx, 1)).toHaveLength(1);
  });

  it("is deterministic — two calls on the same lesson are identical", () => {
    expect(buildMockKnowledgeCheck(lesson, ctx, 4)).toEqual(buildMockKnowledgeCheck(lesson, ctx, 4));
  });

  it("spreads across the three kinds", () => {
    const kinds = buildMockKnowledgeCheck(lesson, ctx, 3).map((q) => q.kind);
    expect(new Set(kinds)).toEqual(new Set(["mcq", "concept", "coding"]));
  });

  it("every question parses clean against KnowledgeCheckQuestionSchema", () => {
    for (const q of buildMockKnowledgeCheck(lesson, ctx, 6)) {
      expect(() => KnowledgeCheckQuestionSchema.parse(q)).not.toThrow();
    }
  });

  it("mcq questions have a 4-option list and an answerIndex inside its bounds; open kinds are null", () => {
    for (const q of buildMockKnowledgeCheck(lesson, ctx, 6)) {
      if (q.kind === "mcq") {
        expect(q.options).toHaveLength(4);
        expect(q.answerIndex).not.toBeNull();
        expect(q.answerIndex).toBeGreaterThanOrEqual(0);
        expect(q.answerIndex as number).toBeLessThan(q.options.length);
        expect(q.options[q.answerIndex as number]).toContain("central to");
      } else {
        expect(q.options).toEqual([]);
        expect(q.answerIndex).toBeNull();
      }
    }
  });

  it("bases the prompts on the lesson's title / objective / concepts", () => {
    const [mcq, concept] = buildMockKnowledgeCheck(lesson, ctx, 2);
    expect(mcq.prompt).toContain("Handling tool errors");
    expect(concept.prompt).toContain(lesson.learningObjective);
    const joined = buildMockKnowledgeCheck(lesson, ctx, 3)
      .map((q) => q.prompt)
      .join(" ");
    expect(joined).toContain("retries");
  });

  it("works without a context object — falls back to the lesson's own fields", () => {
    const qs = buildMockKnowledgeCheck(lesson, undefined, 3);
    expect(qs).toHaveLength(3);
    expect(qs[0].prompt).toContain("Handling tool errors");
    for (const q of qs) expect(() => KnowledgeCheckQuestionSchema.parse(q)).not.toThrow();
  });
});

describe("generateKnowledgeCheck — real path with an injected generate stub", () => {
  const lesson = { title: "T", learningObjective: "LO", concepts: ["c1"] };
  const ctx: KnowledgeCheckContext = {
    lessonTitle: "T",
    learningObjective: "LO",
    concepts: ["c1"]
  };

  const looseResponse = {
    questions: [
      {
        kind: "mcq",
        prompt: "Which is true?",
        options: ["a", "b", "c"],
        answerIndex: 2,
        rationale: "c is correct"
      },
      { kind: "concept", prompt: "Explain c1.", options: [], answerIndex: null },
      { kind: "coding", prompt: "Write c1.", options: [], answerIndex: null }
    ]
  };

  it("maps the loose response into schema-clean questions and slices to `count`", async () => {
    const qs = await generateKnowledgeCheck(lesson, ctx, { generate: stubGenerate(looseResponse) }, 2);
    expect(qs).toHaveLength(2);
    for (const q of qs) expect(() => KnowledgeCheckQuestionSchema.parse(q)).not.toThrow();
    expect(qs[0].kind).toBe("mcq");
    expect(qs[0].answerIndex).toBe(2);
    expect(qs[1].kind).toBe("concept");
    expect(qs[1].answerIndex).toBeNull();
  });

  it("drops an out-of-bounds mcq answerIndex to null rather than trusting it", async () => {
    const bad = { questions: [{ kind: "mcq", prompt: "Q", options: ["a", "b"], answerIndex: 9 }] };
    const [q] = await generateKnowledgeCheck(lesson, ctx, { generate: stubGenerate(bad) }, 3);
    expect(q.kind).toBe("mcq");
    expect(q.answerIndex).toBeNull();
  });

  it("throws when the model returns no questions", async () => {
    await expect(
      generateKnowledgeCheck(lesson, ctx, { generate: stubGenerate({ questions: [] }) }, 3)
    ).rejects.toThrow(/no questions/i);
  });

  it("throws on non-JSON garbage from the model", async () => {
    await expect(
      generateKnowledgeCheck(lesson, ctx, { generate: stubGenerate("nope") }, 3)
    ).rejects.toThrow();
  });
});
