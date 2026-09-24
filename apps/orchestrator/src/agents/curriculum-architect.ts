import type { CostLedger } from "@vvugc/shared-cost";
import {
  CurriculumPlanRequestSchema,
  CurriculumPlanSchema,
  CurriculumProjectStepSchema,
  KnowledgeCheckQuestionSchema,
  slugify,
  type CurriculumLesson,
  type CurriculumModule,
  type CurriculumPlan,
  type CurriculumPlanRequest,
  type KnowledgeCheckQuestion,
  type LessonPlan,
  type ModulePlan,
  type ProjectPlan
} from "@vvugc/curriculum-engine";
import { z } from "zod";
import { generateWithFailover, type LlmFailoverOptions } from "./llm-failover.js";

/** The request a caller hands this agent. The pre-parse (input) shape — fields
 *  with schema defaults (`language`, `moduleCount`, …) may be omitted and are
 *  filled by `CurriculumPlanRequestSchema.parse` on the first line of each
 *  entry point. `CurriculumPlanRequest` (the post-parse type) is a subtype. */
type CurriculumPlanRequestInput = z.input<typeof CurriculumPlanRequestSchema>;

/**
 * Curriculum Architect Agent: "describe a course, get a full module/lesson/
 * project plan" — the planning front end to @vvugc/curriculum-engine's
 * expand-and-persist machinery (expandCurriculumPlan / the file + Postgres
 * stores' saveApprovedPlan). This agent returns a CurriculumPlan for a human to
 * review; it never persists anything and nothing it returns runs on its own.
 *
 * Safety design (same shape as batch-planner-agent.ts, for the same reasons):
 * 1. `id` and `orgId` are NEVER produced by the model and never appear in the
 *    prompt or in the response schema the model's output is parsed against. The
 *    create route stamps `orgId` onto the expanded course/module/lesson/project
 *    rows server-side later (Phase D), the same way every other route in this
 *    app derives tenant identity from the authenticated request context.
 * 2. Ordering is never trusted from the model. The loose response the model
 *    returns carries only a 1-based `moduleIndex` on lessons/projects; this
 *    agent STAMPS `order` / `lessonOrder` / `globalOrder` / `moduleOrder`
 *    deterministically from array position, so the ordering keys are correct by
 *    construction regardless of what the model emitted.
 * 3. The plan's shape is asserted exactly — EXACTLY `moduleCount` modules,
 *    EXACTLY `lessonsPerModule` lessons in every module, EXACTLY `moduleCount`
 *    projects (one per module). A wrong count throws; this function is atomic
 *    and never returns a partial plan.
 * 4. Whatever this returns still goes through the caller's own re-validation and
 *    `saveApprovedPlan` (which re-parses the whole plan and re-checks every
 *    count before a single row is written) — this agent's output is a draft,
 *    not an executable instruction.
 *
 * `buildMockCurriculumPlan` is the deterministic, no-LLM path that drives every
 * test and the §59 acceptance run — count-exact by construction, never calls a
 * provider.
 */

export interface CurriculumArchitectDeps {
  /** Injectable for tests — defaults to the real generateWithFailover. */
  generate?: (opts: LlmFailoverOptions) => Promise<{ text: string }>;
  costLedger?: CostLedger;
}

// ─── Deterministic mock (no LLM) ──────────────────────────────────────────

/**
 * DETERMINISTIC, no LLM. Count-exact by construction. Used by every test + the
 * §59 acceptance run. If `req.seed` is present, module titles/goals come from
 * it; otherwise generic "Module N" / "Module N — Lesson M".
 */
export function buildMockCurriculumPlan(req: CurriculumPlanRequestInput): CurriculumPlan {
  const r = CurriculumPlanRequestSchema.parse(req);
  const { moduleCount, lessonsPerModule } = r;

  const course = {
    title: r.title,
    slug: slugify(r.title),
    topic: r.topic,
    audience: r.audience,
    startingKnowledge: r.startingKnowledge,
    endGoal: r.endGoal,
    language: r.language,
    moduleCount,
    lessonsPerModule,
    shortDurationSec: r.shortDurationSec,
    longFormTargetMin: r.longFormTargetMin
  };

  const modules: ModulePlan[] = [];
  const lessons: LessonPlan[] = [];
  const projects: ProjectPlan[] = [];

  for (let m = 1; m <= moduleCount; m++) {
    const seedModule = r.seed?.modules[m - 1];
    const moduleTitle = seedModule?.title ?? `Module ${m}`;

    modules.push({
      order: m,
      title: moduleTitle,
      description: `Module ${m} of ${moduleCount}: ${moduleTitle}.`,
      goal: seedModule?.goal || `Understand and apply the core ideas of module ${m}.`,
      prerequisites: m === 1 ? [] : [`Module ${m - 1} concepts`],
      learningObjectives: [
        `Explain the core ideas of ${moduleTitle}.`,
        `Apply ${moduleTitle} to a concrete task.`,
        `Evaluate the results of applying ${moduleTitle}.`
      ],
      concepts: [`concept-${m}-a`, `concept-${m}-b`]
    });

    for (let l = 1; l <= lessonsPerModule; l++) {
      lessons.push({
        moduleOrder: m,
        lessonOrder: l,
        globalOrder: (m - 1) * lessonsPerModule + l,
        title: `${moduleTitle} — Lesson ${l}`,
        learningObjective: `Learn part ${l} of ${moduleTitle}.`,
        prerequisites: l === 1 ? [] : [`${moduleTitle} — Lesson ${l - 1}`],
        concepts: [`concept-${m}-${l}`]
      });
    }

    projects.push({
      moduleOrder: m,
      title: `${moduleTitle} — Project`,
      objective: `Build a small project that exercises ${moduleTitle}.`,
      outcome: `A working artifact that demonstrates ${moduleTitle}.`,
      requirements: [
        `Completion of the ${moduleTitle} lessons`,
        "A working local development environment"
      ],
      steps: [
        { order: 1, title: "Plan", detail: `Outline how you will apply ${moduleTitle}.` },
        { order: 2, title: "Build", detail: `Implement the project for ${moduleTitle}.` },
        { order: 3, title: "Review", detail: "Test the result and write down what you learned." }
      ],
      technologies: []
    });
  }

  // Count-exact by construction; the parse is the belt-and-braces check.
  return CurriculumPlanSchema.parse({ course, modules, lessons, projects });
}

// ─── Real LLM path ───────────────────────────────────────────────────────

/** LOOSE shape the model is asked to return — no ordering integers at all.
 *  Lessons and projects point at their module by a 1-based `moduleIndex`; this
 *  agent derives every real ordering key itself (see the stamping below). No
 *  `id` / `orgId` field exists here by design. */
const LlmModuleSchema = z.object({
  title: z.string(),
  description: z.string().default(""),
  goal: z.string().default(""),
  prerequisites: z.array(z.string()).default([]),
  learningObjectives: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([])
});

const LlmLessonSchema = z.object({
  moduleIndex: z.number().int().min(1),
  title: z.string(),
  learningObjective: z.string().default(""),
  prerequisites: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([])
});

const LlmProjectSchema = z.object({
  moduleIndex: z.number().int().min(1),
  title: z.string(),
  objective: z.string().default(""),
  outcome: z.string().default(""),
  requirements: z.array(z.string()).default([]),
  steps: z.array(CurriculumProjectStepSchema).default([]),
  technologies: z.array(z.string()).default([])
});

const LlmCurriculumResponseSchema = z.object({
  modules: z.array(LlmModuleSchema),
  lessons: z.array(LlmLessonSchema),
  projects: z.array(LlmProjectSchema)
});

const SYSTEM_PROMPT = `You are a curriculum architect. Given a course brief, design the full course
structure: its modules, the lessons inside each module, and one hands-on project per module.

Every lesson is one short-form teaching video. Every module also owns one long-form video and
one capstone project. Keep titles concrete and specific; make each module build on the last.

Respond with ONLY a JSON object — no prose, no markdown fences — matching exactly:
{"modules":[{"title":string,"description":string,"goal":string,"prerequisites":string[],
  "learningObjectives":string[],"concepts":string[]}],
 "lessons":[{"moduleIndex":number,"title":string,"learningObjective":string,
  "prerequisites":string[],"concepts":string[]}],
 "projects":[{"moduleIndex":number,"title":string,"objective":string,"outcome":string,
  "requirements":string[],"steps":[{"order":number,"title":string,"detail":string}],
  "technologies":string[]}]}

"moduleIndex" is the 1-based position of the module a lesson or project belongs to (the first
module is 1). Do NOT emit any id fields, database fields, or ordering integers other than
"moduleIndex" and a step's "order". The modules array order IS the module order.`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in curriculum architect response: ${text}`);
  }
  return text.slice(start, end + 1);
}

function buildUserPrompt(r: CurriculumPlanRequest): string {
  const total = r.moduleCount * r.lessonsPerModule;
  const seedList = r.seed
    ? `\n\nThe modules MUST be exactly these ${r.seed.modules.length}, in this order (reproduce the titles verbatim):\n` +
      r.seed.modules
        .map((m, i) => `${i + 1}. ${m.title}${m.goal ? ` — ${m.goal}` : ""}`)
        .join("\n")
    : "";

  return `Design a full course curriculum.

Title: ${r.title}
Topic: ${r.topic}
Audience: ${r.audience}
Starting knowledge: ${r.startingKnowledge.join("; ") || "none stated"}
End goal: ${r.endGoal}
Language: ${r.language}
Short lesson video length: ${r.shortDurationSec}s
Long-form module video length: ${r.longFormTargetMin} min

Return EXACTLY ${r.moduleCount} modules; EXACTLY ${r.lessonsPerModule} lessons per module ` +
    `(${total} lessons total); EXACTLY ${r.moduleCount} projects (one per module).${seedList}`;
}

/**
 * Real path: prompt -> generateWithFailover -> extractJson -> parse a LOOSE LLM
 * response -> STAMP deterministic ordering -> assert exact counts -> return a
 * strict CurriculumPlan. Atomic: throws (never returns a partial) if the model
 * returns the wrong number of modules / lessons / projects.
 */
export async function generateCurriculumPlan(
  req: CurriculumPlanRequestInput,
  deps: CurriculumArchitectDeps = {}
): Promise<CurriculumPlan> {
  const r = CurriculumPlanRequestSchema.parse(req);
  const { moduleCount, lessonsPerModule } = r;

  // Sonnet 5: this is a structural judgment/synthesis call with real downstream
  // consequences (the plan shapes an entire course's production cost and
  // sequencing) but it is NOT the creative bottleneck that script-agent owns —
  // it emits a skeleton of titles/objectives, not the teaching scripts. Same
  // gatekeeping tier as batch-planner-agent and qa-agent. See CLAUDE.md's
  // "Model selection" section.
  const model = "claude-sonnet-5";
  const generate = deps.generate ?? generateWithFailover;
  const { text } = await generate({
    system: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(r),
    // A 20×10 plan is ~200 lesson objects; give the model real headroom.
    maxTokens: 32_000,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "curriculum_plan",
    costLedger: deps.costLedger
  });

  const parsed = LlmCurriculumResponseSchema.parse(JSON.parse(extractJson(text)));

  // ── STAMP deterministic ordering ──────────────────────────────────────
  const modules: ModulePlan[] = parsed.modules.map((mod, i) => ({
    order: i + 1,
    title: mod.title,
    description: mod.description || `Module ${i + 1}: ${mod.title}.`,
    goal: mod.goal || `Understand and apply the core ideas of module ${i + 1}.`,
    prerequisites: mod.prerequisites,
    learningObjectives: mod.learningObjectives,
    concepts: mod.concepts
  }));

  const lessonsByModule = new Map<number, typeof parsed.lessons>();
  for (const les of parsed.lessons) {
    const bucket = lessonsByModule.get(les.moduleIndex);
    if (bucket) bucket.push(les);
    else lessonsByModule.set(les.moduleIndex, [les]);
  }

  const lessons: LessonPlan[] = [];
  let globalOrder = 0;
  for (let m = 1; m <= modules.length; m++) {
    const bucket = lessonsByModule.get(m) ?? [];
    bucket.forEach((les, idx) => {
      globalOrder += 1;
      lessons.push({
        moduleOrder: m,
        lessonOrder: idx + 1,
        globalOrder,
        title: les.title,
        learningObjective: les.learningObjective || `Lesson ${idx + 1} of module ${m}.`,
        prerequisites: les.prerequisites,
        concepts: les.concepts
      });
    });
  }

  const projects: ProjectPlan[] = parsed.projects.map((pr) => ({
    moduleOrder: pr.moduleIndex,
    title: pr.title,
    objective: pr.objective || `Project for module ${pr.moduleIndex}.`,
    outcome: pr.outcome || `A working artifact for module ${pr.moduleIndex}.`,
    requirements: pr.requirements,
    steps: pr.steps,
    technologies: pr.technologies
  }));

  // ── Assert the exact shape — any failure throws BEFORE returning ──────
  if (modules.length !== moduleCount) {
    throw new Error(
      `Curriculum architect: model returned ${modules.length} modules, expected EXACTLY ${moduleCount} modules.`
    );
  }
  for (let m = 1; m <= moduleCount; m++) {
    const count = lessons.filter((l) => l.moduleOrder === m).length;
    if (count !== lessonsPerModule) {
      throw new Error(
        `Curriculum architect: module ${m} has ${count} lessons, expected EXACTLY ${lessonsPerModule} lessons per module.`
      );
    }
  }
  if (lessons.length !== moduleCount * lessonsPerModule) {
    throw new Error(
      `Curriculum architect: model returned ${lessons.length} lessons, expected EXACTLY ` +
        `${moduleCount * lessonsPerModule} (${lessonsPerModule} per module).`
    );
  }
  if (projects.length !== moduleCount) {
    throw new Error(
      `Curriculum architect: model returned ${projects.length} projects, expected EXACTLY ${moduleCount} projects (one per module).`
    );
  }
  const seenModuleIndex = new Set<number>();
  for (const pr of projects) {
    if (pr.moduleOrder < 1 || pr.moduleOrder > moduleCount) {
      throw new Error(
        `Curriculum architect: a project references module ${pr.moduleOrder}, outside 1..${moduleCount}.`
      );
    }
    if (seenModuleIndex.has(pr.moduleOrder)) {
      throw new Error(
        `Curriculum architect: more than one project references module ${pr.moduleOrder}; expected one project per module.`
      );
    }
    seenModuleIndex.add(pr.moduleOrder);
  }

  const course = {
    title: r.title,
    slug: slugify(r.title),
    topic: r.topic,
    audience: r.audience,
    startingKnowledge: r.startingKnowledge,
    endGoal: r.endGoal,
    language: r.language,
    moduleCount,
    lessonsPerModule,
    shortDurationSec: r.shortDurationSec,
    longFormTargetMin: r.longFormTargetMin
  };

  return CurriculumPlanSchema.parse({ course, modules, lessons, projects });
}

// ─── Script generation (§22 continuity context, §24 long-form structure) ──
//
// Two levels: per-lesson short scripts (buildMockLessonScript / generateLessonScript)
// and per-module long-form scripts (buildMockModuleLongForm / generateModuleLongForm).
// The mock builders are deterministic and never call a provider — they drive every
// test and any hermetic acceptance run. The `generate*` functions are the real
// path: they emit PROSE (not JSON), so there is no schema parse — just a trim and a
// sanity length check.

/**
 * Compact continuity context for scripting one lesson (§22). Built by the ROUTE
 * from persisted rows — the course + module summary, the previous 2-3 lessons
 * (title + keyTakeaway) and the next lesson's title — NOT the whole 200-lesson
 * set. Keeps each script prompt aware of what came just before it without
 * dragging the entire course through the model.
 */
export interface LessonScriptContext {
  /** "<title>: <topic> for <audience>. End goal: <endGoal>." */
  courseSummary: string;
  /** "Module <order> — <title>. Goal: <goal>." */
  moduleSummary: string;
  /** Up to 3, ascending by globalOrder. */
  priorLessons: { globalOrder: number; title: string; keyTakeaway?: string }[];
  nextLessonTitle?: string;
  shortDurationSec: number;
}

/** FNV-1a — a tiny deterministic string hash, used only to vary the mock hook
 *  opener by lesson title so 200 generated scripts don't all share one line. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Distinct openers picked deterministically per lesson title — the hook must not
 *  be a generic line a hundred other lessons could share. */
const LESSON_HOOK_OPENERS = [
  "Here's the part nobody explains about",
  "Stop — before you skip ahead, look at",
  "The fastest way to actually get",
  "Most people quietly get this wrong:",
  "Ninety seconds from now you'll understand",
  "There's exactly one idea holding up",
  "Ever get stuck on",
  "Let's kill the confusion around"
] as const;

/**
 * DETERMINISTIC. No LLM. The spoken narration for one short lesson video, in five
 * beats — HOOK / CONCEPT / EXAMPLE / TAKEAWAY / NEXT-BRIDGE — derived from the
 * lesson's own fields plus the continuity context. Padded toward `shortDurationSec`
 * of narration (~2.4 spoken words/sec) from the lesson's concepts, so length
 * tracks the target duration without making every script identical. The hook line
 * varies with the lesson title.
 */
export function buildMockLessonScript(
  lesson: Pick<
    CurriculumLesson,
    "title" | "learningObjective" | "concepts" | "keyTakeaway" | "example" | "explanation"
  >,
  ctx: LessonScriptContext
): string {
  const opener = LESSON_HOOK_OPENERS[hashString(lesson.title) % LESSON_HOOK_OPENERS.length];
  const concepts = lesson.concepts.length ? lesson.concepts.join(", ") : lesson.title.toLowerCase();
  const priorRecap = ctx.priorLessons.length
    ? ctx.priorLessons.map((p) => p.title).join(" → ")
    : "this is where the course begins";
  const explanation =
    lesson.explanation?.trim() ||
    `${lesson.learningObjective} We keep it concrete: what ${concepts} is, why it exists, and where it breaks.`;
  const example =
    lesson.example?.trim() ||
    `Picture the smallest real case where ${concepts} matters, and walk it end to end.`;
  const takeaway =
    lesson.keyTakeaway?.trim() ||
    `${lesson.title} comes down to one move: ${lesson.learningObjective.replace(/\.$/, "")}.`;
  const bridge = ctx.nextLessonTitle
    ? `Next up — "${ctx.nextLessonTitle}" — builds straight on this.`
    : "Next, we push this one step further.";

  const lines = [
    `HOOK: ${opener} ${lesson.title}?`,
    "",
    `CONTEXT: ${ctx.courseSummary} ${ctx.moduleSummary} So far: ${priorRecap}.`,
    "",
    `CONCEPT: ${explanation}`,
    "",
    `EXAMPLE: ${example}`,
    "",
    `TAKEAWAY: ${takeaway}`,
    "",
    `NEXT-BRIDGE: ${bridge}`
  ];

  let text = lines.join("\n");
  const targetWords = Math.max(60, Math.round(ctx.shortDurationSec * 2.4));
  const conceptList = lesson.concepts.length ? lesson.concepts : [lesson.title];
  for (let i = 0; countWords(text) < targetWords && i < 200; i++) {
    const c = conceptList[i % conceptList.length];
    text += `\nBEAT: Say it plainly — ${c} only earns its keep once you can spot it in your own work.`;
  }
  return text;
}

const LESSON_SCRIPT_SYSTEM_PROMPT = `You are a short-form teaching-video scriptwriter. Given one lesson's facts and
its place in a course, write the spoken narration for a single short video.

Structure it as five labelled beats, in order: HOOK, CONCEPT, EXAMPLE, TAKEAWAY, NEXT-BRIDGE.
The HOOK must be specific to THIS lesson's title — not a generic opener a hundred other lessons
could share. Stay close to the target spoken duration. Do not repeat the previous lessons'
scripts; build on them. Respond with the script text only — no JSON, no markdown fences, no preamble.`;

function buildLessonScriptPrompt(
  lesson: Pick<
    CurriculumLesson,
    "title" | "learningObjective" | "concepts" | "keyTakeaway" | "example" | "explanation"
  >,
  ctx: LessonScriptContext
): string {
  const prior = ctx.priorLessons.length
    ? ctx.priorLessons
        .map(
          (p) =>
            `  - #${p.globalOrder} ${p.title}${p.keyTakeaway ? ` (takeaway: ${p.keyTakeaway})` : ""}`
        )
        .join("\n")
    : "  (this is the first lesson)";
  const extras =
    (lesson.explanation ? `Explanation: ${lesson.explanation}\n` : "") +
    (lesson.example ? `Example: ${lesson.example}\n` : "") +
    (lesson.keyTakeaway ? `Key takeaway: ${lesson.keyTakeaway}\n` : "");
  return `Course: ${ctx.courseSummary}
${ctx.moduleSummary}

Previous lessons (for continuity — do not repeat their scripts):
${prior}
Next lesson: ${ctx.nextLessonTitle ?? "(none — this is the last lesson)"}

This lesson:
Title: ${lesson.title}
Learning objective: ${lesson.learningObjective}
Concepts: ${lesson.concepts.join(", ") || "(none listed)"}
${extras}Target spoken duration: ${ctx.shortDurationSec} seconds.
Write the HOOK / CONCEPT / EXAMPLE / TAKEAWAY / NEXT-BRIDGE narration now.`;
}

/**
 * Real path for a per-lesson short script. Builds a prompt from the lesson's
 * fields + continuity context, runs it through the failover chain, and returns
 * plain trimmed prose — no schema parse (the output is narration, not JSON),
 * just a non-empty / sane-length assertion.
 *
 * Model: `claude-sonnet-5` — the balanced default, the same tier as the plan
 * stage and qa-agent. The per-lesson script is the closest thing in Curriculum
 * Mode to script-agent's "creative bottleneck", but v2 deliberately keeps it on
 * the default model to avoid a cost surprise across a 200-lesson course; a later
 * pass can move it to `claude-fable-5` if quality demands. See CLAUDE.md's
 * "Model selection" section.
 */
export async function generateLessonScript(
  lesson: Pick<
    CurriculumLesson,
    "title" | "learningObjective" | "concepts" | "keyTakeaway" | "example" | "explanation"
  >,
  ctx: LessonScriptContext,
  deps: CurriculumArchitectDeps = {}
): Promise<string> {
  const model = "claude-sonnet-5";
  const generate = deps.generate ?? generateWithFailover;
  const { text } = await generate({
    system: LESSON_SCRIPT_SYSTEM_PROMPT,
    userPrompt: buildLessonScriptPrompt(lesson, ctx),
    maxTokens: 2_000,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "curriculum_lesson_script",
    costLedger: deps.costLedger
  });
  const out = text.trim();
  if (out.length < 40) {
    throw new Error("curriculum lesson script generation returned too little text");
  }
  return out;
}

/** The ten §24 long-form sections, in order. */
const MODULE_LONG_FORM_SECTIONS = [
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
] as const;

/**
 * DETERMINISTIC. No LLM. A module's long-form outline+script following the §24
 * ten-section structure ({@link MODULE_LONG_FORM_SECTIONS}). Built from the
 * module's goal + concepts + objectives, its lessons' takeaways, and the module
 * project — this is ONE coherent lesson that teaches the module goal and walks
 * through building its project, NOT a concatenation of the short lesson scripts.
 */
export function buildMockModuleLongForm(
  module: Pick<CurriculumModule, "order" | "title" | "goal" | "concepts" | "learningObjectives">,
  lessons: { title: string; keyTakeaway?: string }[],
  project: { title: string; objective: string; steps: { title: string; detail: string }[] } | null,
  targetMin: number
): string {
  const concepts = module.concepts.length ? module.concepts.join(", ") : module.title.toLowerCase();
  const objectives = module.learningObjectives.length
    ? module.learningObjectives.join("; ")
    : `apply ${module.title}`;
  const lessonList = lessons.length
    ? lessons
        .map((l, i) => `${i + 1}. ${l.title}${l.keyTakeaway ? ` — ${l.keyTakeaway}` : ""}`)
        .join("\n")
    : "(no lessons in this module yet)";
  const projectTitle = project ? project.title : `${module.title} capstone`;
  const projectObjective = project ? project.objective : `Demonstrate ${module.title} end to end.`;
  const projectSteps =
    project && project.steps.length
      ? project.steps.map((s, i) => `  ${i + 1}. ${s.title}: ${s.detail}`).join("\n")
      : "  1. Plan  2. Build  3. Review";

  return [
    `# Module ${module.order}: ${module.title} — long-form (${targetMin} min target)`,
    "",
    `INTRO: The module-level video for "${module.title}". Module goal: ${module.goal} We cover ${concepts} in one sitting, then build the project.`,
    "",
    `PROBLEM: Why ${module.title} matters — the failure mode you hit without it, and what "${module.goal}" actually unlocks.`,
    "",
    `CORE CONCEPTS: ${concepts}. Target objectives: ${objectives}. Drawn from the lessons:\n${lessonList}`,
    "",
    `ARCHITECTURE: How the pieces of ${module.title} fit together — the shape of the system before any code, mapped onto ${concepts}.`,
    "",
    `HANDS-ON PROJECT: "${projectTitle}". ${projectObjective}`,
    "",
    `IMPLEMENTATION: Build "${projectTitle}" step by step:\n${projectSteps}`,
    "",
    `TEST: Verify "${projectTitle}" does what the module goal promised — walk each objective: ${objectives}.`,
    "",
    `COMMON MISTAKES: The usual ways ${concepts} goes wrong, and the quick tell for each.`,
    "",
    `FINISHED RESULT: What "${projectTitle}" looks like once it works, tied back to the module goal: ${module.goal}`,
    "",
    `NEXT MODULE: You can now ${objectives}. The next module builds directly on ${module.title}.`
  ].join("\n");
}

const MODULE_LONG_FORM_SYSTEM_PROMPT = `You are a curriculum scriptwriter producing a module-level long-form teaching video.
Write a full outline+script with exactly these ten labelled sections, in order:
${MODULE_LONG_FORM_SECTIONS.join(", ")}.
This is ONE coherent lesson that teaches the module's goal and walks through building its
project — NOT a concatenation of the module's short lesson scripts. Respond with the script
text only: no JSON, no markdown fences.`;

function buildModuleLongFormPrompt(
  module: Pick<CurriculumModule, "order" | "title" | "goal" | "concepts" | "learningObjectives">,
  lessons: { title: string; keyTakeaway?: string }[],
  project: { title: string; objective: string; steps: { title: string; detail: string }[] } | null,
  targetMin: number
): string {
  const lessonList = lessons.length
    ? lessons
        .map((l, i) => `  ${i + 1}. ${l.title}${l.keyTakeaway ? ` — ${l.keyTakeaway}` : ""}`)
        .join("\n")
    : "  (no lessons yet)";
  const projectBlock = project
    ? `Project: ${project.title}\nObjective: ${project.objective}\nSteps:\n${project.steps
        .map((s, i) => `  ${i + 1}. ${s.title}: ${s.detail}`)
        .join("\n")}`
    : "Project: (none attached to this module)";
  return `Module ${module.order}: ${module.title}
Goal: ${module.goal}
Concepts: ${module.concepts.join(", ") || "(none listed)"}
Learning objectives: ${module.learningObjectives.join("; ") || "(none listed)"}
Target duration: ${targetMin} minutes

Lessons in this module:
${lessonList}

${projectBlock}

Write the ten-section long-form script now.`;
}

/**
 * Real path for a module long-form script. Prompt (module fields + lessons +
 * project) -> failover chain -> plain trimmed prose. No schema parse.
 *
 * Model: `claude-sonnet-5` — same reasoning as {@link generateLessonScript} and
 * the plan stage. See CLAUDE.md's "Model selection" section.
 */
export async function generateModuleLongForm(
  module: Pick<CurriculumModule, "order" | "title" | "goal" | "concepts" | "learningObjectives">,
  lessons: { title: string; keyTakeaway?: string }[],
  project: { title: string; objective: string; steps: { title: string; detail: string }[] } | null,
  targetMin: number,
  deps: CurriculumArchitectDeps = {}
): Promise<string> {
  const model = "claude-sonnet-5";
  const generate = deps.generate ?? generateWithFailover;
  const { text } = await generate({
    system: MODULE_LONG_FORM_SYSTEM_PROMPT,
    userPrompt: buildModuleLongFormPrompt(module, lessons, project, targetMin),
    maxTokens: 8_000,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "curriculum_module_long_form",
    costLedger: deps.costLedger
  });
  const out = text.trim();
  if (out.length < 40) {
    throw new Error("curriculum module long-form script generation returned too little text");
  }
  return out;
}

// ─── Knowledge-check generation (Learn Mode §19) ─────────────────────────
//
// Structured data, not prose — so this follows the JSON+Zod shape of
// generateCurriculumPlan (loose LLM response -> map -> KnowledgeCheckQuestionSchema.parse
// each), NOT the trim-only shape of the script functions. buildMockKnowledgeCheck is
// the deterministic, no-LLM path that drives every test: it derives each question's
// choice/answerIndex from a hash of the lesson title + question index, so two calls
// on the same lesson return byte-identical arrays.

/** Compact context for writing one lesson's knowledge check — assembled by the
 *  ROUTE from the persisted lesson row, not the whole course. */
export interface KnowledgeCheckContext {
  lessonTitle: string;
  learningObjective: string;
  concepts: string[];
  explanation?: string;
  keyTakeaway?: string;
}

const KNOWLEDGE_CHECK_KINDS = ["mcq", "concept", "coding"] as const;

/**
 * DETERMINISTIC. No LLM. Exactly `count` knowledge-check questions for one lesson,
 * cycling through the three kinds (mcq / concept / coding) so a check is a spread,
 * not three of a kind. The mcq's four options and its `answerIndex` come from
 * {@link hashString} of the lesson title + question index — no RNG — so the array
 * is stable across calls. Every question is round-tripped through
 * `KnowledgeCheckQuestionSchema.parse`, so the return value is always schema-clean.
 */
export function buildMockKnowledgeCheck(
  lesson: Pick<CurriculumLesson, "title" | "learningObjective" | "concepts">,
  ctx?: KnowledgeCheckContext,
  count = 3
): KnowledgeCheckQuestion[] {
  const title = ctx?.lessonTitle?.trim() || lesson.title;
  const objective = ctx?.learningObjective?.trim() || lesson.learningObjective;
  const ctxConcepts = ctx?.concepts?.length ? ctx.concepts : lesson.concepts;
  const conceptList = ctxConcepts.length ? ctxConcepts : [title.toLowerCase()];
  const explanation = ctx?.explanation?.trim();
  const takeaway = ctx?.keyTakeaway?.trim();

  const questions: KnowledgeCheckQuestion[] = [];
  for (let i = 0; i < count; i++) {
    const kind = KNOWLEDGE_CHECK_KINDS[i % KNOWLEDGE_CHECK_KINDS.length];
    const concept = conceptList[i % conceptList.length];
    if (kind === "mcq") {
      const options = [
        `${concept} is central to ${title.toLowerCase()}`,
        `${concept} is unrelated to ${title.toLowerCase()}`,
        `${concept} only matters once the course is finished`,
        `${concept} is just another name for the lesson title`
      ];
      // Deterministic: the correct choice is index 0 conceptually, rotated into a
      // stable position by the title+index hash so the answer key isn't always 0.
      const shift = hashString(`${title}#${i}`) % options.length;
      const rotated = options.map((_, j) => options[(j - shift + options.length) % options.length]);
      const answerIndex = shift;
      questions.push(
        KnowledgeCheckQuestionSchema.parse({
          kind,
          prompt: `In "${title}", which statement about ${concept} is correct?`,
          options: rotated,
          answerIndex,
          rationale: explanation
            ? `${objective} ${explanation}`
            : `${objective} ${concept} is a core idea of this lesson, not a tangent.`
        })
      );
    } else if (kind === "concept") {
      questions.push(
        KnowledgeCheckQuestionSchema.parse({
          kind,
          prompt: `In your own words, explain how ${concept} serves this goal: ${objective}`,
          options: [],
          answerIndex: null,
          rationale: takeaway
            ? `A strong answer lands on: ${takeaway}`
            : `A strong answer ties ${concept} back to "${title}".`
        })
      );
    } else {
      questions.push(
        KnowledgeCheckQuestionSchema.parse({
          kind,
          prompt: `Write a short snippet that puts ${concept} to work, as taught in "${title}".`,
          options: [],
          answerIndex: null,
          rationale: `A working snippet should exercise ${concept} directly rather than describe it.`
        })
      );
    }
  }
  return questions;
}

/** LOOSE shape the model is asked to return for a knowledge check — every field
 *  defaulted so a sparse question object still parses; the strict
 *  KnowledgeCheckQuestionSchema.parse below is the real gate. */
const LlmKnowledgeCheckQuestionSchema = z.object({
  kind: z.string().default("concept"),
  prompt: z.string().default(""),
  options: z.array(z.string()).default([]),
  answerIndex: z.number().int().nullable().default(null),
  rationale: z.string().optional()
});

const LlmKnowledgeCheckResponseSchema = z.object({
  questions: z.array(LlmKnowledgeCheckQuestionSchema).default([])
});

const KNOWLEDGE_CHECK_SYSTEM_PROMPT = `You are a curriculum assessment writer. Given one lesson's facts, write a short
knowledge check that tests whether a learner met the lesson's learning objective.

Each question is one of three kinds:
- "mcq": multiple choice — 3-5 plausible "options" and a 0-based "answerIndex" pointing
  at the correct one, plus a one-sentence "rationale".
- "concept": an open "explain it back" question — "options" empty, "answerIndex" null.
- "coding": an open "write a snippet" question — "options" empty, "answerIndex" null.

Cover a spread of the kinds — do not return three of the same kind. Respond with ONLY a
JSON object — no prose, no markdown fences — matching exactly:
{"questions":[{"kind":"mcq"|"concept"|"coding","prompt":string,"options":string[],
  "answerIndex":number|null,"rationale":string}]}`;

function buildKnowledgeCheckPrompt(
  lesson: Pick<CurriculumLesson, "title" | "learningObjective" | "concepts">,
  ctx: KnowledgeCheckContext,
  count: number
): string {
  const concepts =
    (ctx.concepts.length ? ctx.concepts : lesson.concepts).join(", ") || "(none listed)";
  const extras =
    (ctx.explanation ? `Explanation: ${ctx.explanation}\n` : "") +
    (ctx.keyTakeaway ? `Key takeaway: ${ctx.keyTakeaway}\n` : "");
  return `Lesson: ${ctx.lessonTitle || lesson.title}
Learning objective: ${ctx.learningObjective || lesson.learningObjective}
Concepts: ${concepts}
${extras}Write EXACTLY ${count} knowledge-check questions covering a spread of the kinds above.`;
}

/**
 * Real path: prompt -> generateWithFailover -> extractJson -> parse a LOOSE
 * response -> normalise each question's kind/options/answerIndex -> round-trip
 * through KnowledgeCheckQuestionSchema.parse -> assert at least one -> slice to
 * `count`. Throws (never returns a partial) if the model returns no questions.
 *
 * Model: `claude-sonnet-5` — this is a mechanical, bounded transform of an
 * already-written lesson into a handful of check questions, the same "already in
 * ANTHROPIC_RATE_TABLE" balanced default the sibling curriculum stages use. See
 * CLAUDE.md's "Model selection" section.
 */
export async function generateKnowledgeCheck(
  lesson: Pick<CurriculumLesson, "title" | "learningObjective" | "concepts">,
  ctx: KnowledgeCheckContext,
  deps: CurriculumArchitectDeps = {},
  count = 3
): Promise<KnowledgeCheckQuestion[]> {
  const model = "claude-sonnet-5";
  const generate = deps.generate ?? generateWithFailover;
  const { text } = await generate({
    system: KNOWLEDGE_CHECK_SYSTEM_PROMPT,
    userPrompt: buildKnowledgeCheckPrompt(lesson, ctx, count),
    maxTokens: 2_000,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "curriculum_knowledge_check",
    costLedger: deps.costLedger
  });

  const parsed = LlmKnowledgeCheckResponseSchema.parse(JSON.parse(extractJson(text)));
  const knownKinds = new Set<string>(KNOWLEDGE_CHECK_KINDS);
  const questions = parsed.questions.map((q) => {
    const kind = knownKinds.has(q.kind) ? (q.kind as KnowledgeCheckQuestion["kind"]) : "concept";
    const isMcq = kind === "mcq";
    const options = isMcq ? q.options : [];
    const answerIndex =
      isMcq && q.answerIndex !== null && q.answerIndex >= 0 && q.answerIndex < options.length
        ? q.answerIndex
        : null;
    return KnowledgeCheckQuestionSchema.parse({
      kind,
      prompt: q.prompt,
      options,
      answerIndex,
      rationale: q.rationale
    });
  });
  if (questions.length < 1) {
    throw new Error("curriculum knowledge-check generation returned no questions");
  }
  return questions.slice(0, count);
}
