import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCurriculumStore } from "./store.js";
import type { CurriculumCourseInput, CurriculumPlan } from "./schema.js";

// ─── fixtures ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function courseInput(over: Partial<CurriculumCourseInput> = {}): CurriculumCourseInput {
  return {
    title: "Practical AI Prompting",
    slug: "practical-ai-prompting",
    topic: "prompt engineering",
    audience: "developers",
    startingKnowledge: ["basic programming"],
    endGoal: "design robust prompt pipelines",
    language: "en",
    moduleCount: 1,
    lessonsPerModule: 1,
    shortDurationSec: 60,
    longFormTargetMin: 12,
    maxGenerationSpendUsd: 50,
    ...over
  };
}

/** A hand-built plan: `moduleCount` modules × `lessonsPerModule` lessons + one
 *  project per module. `lessonCount` overrides the lesson total (for the
 *  atomic-reject test) while leaving plan.course untouched. */
function buildPlan(opts: { moduleCount?: number; lessonsPerModule?: number; lessonCount?: number } = {}): CurriculumPlan {
  const moduleCount = opts.moduleCount ?? 20;
  const lessonsPerModule = opts.lessonsPerModule ?? 10;
  const lessonCount = opts.lessonCount ?? moduleCount * lessonsPerModule;

  const modules = Array.from({ length: moduleCount }, (_, i) => ({
    order: i + 1,
    title: `Module ${i + 1}`,
    description: `description ${i + 1}`,
    goal: `goal ${i + 1}`,
    prerequisites: [],
    learningObjectives: [`objective ${i + 1}`],
    concepts: [`concept ${i + 1}`]
  }));

  const slots: { mo: number; lo: number }[] = [];
  for (let mo = 1; mo <= moduleCount; mo++) {
    for (let lo = 1; lo <= lessonsPerModule; lo++) slots.push({ mo, lo });
  }
  const lessons = slots.slice(0, lessonCount).map((s, i) => ({
    moduleOrder: s.mo,
    lessonOrder: s.lo,
    globalOrder: i + 1,
    title: `Lesson ${s.mo}.${s.lo}`,
    learningObjective: `learn ${s.mo}.${s.lo}`,
    prerequisites: [],
    concepts: []
  }));

  const projects = Array.from({ length: moduleCount }, (_, i) => ({
    moduleOrder: i + 1,
    title: `Project ${i + 1}`,
    objective: `objective ${i + 1}`,
    outcome: `outcome ${i + 1}`,
    requirements: [],
    steps: [],
    technologies: []
  }));

  return {
    course: {
      title: "Practical AI Prompting",
      slug: "practical-ai-prompting",
      topic: "prompt engineering",
      audience: "developers",
      startingKnowledge: ["basic programming"],
      endGoal: "design robust prompt pipelines",
      language: "en",
      moduleCount,
      lessonsPerModule,
      shortDurationSec: 45,
      longFormTargetMin: 15
    },
    modules,
    lessons,
    projects
  };
}

// ─── harness ───────────────────────────────────────────────────────────────

describe("createCurriculumStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "curriculum-"));
    return createCurriculumStore(dir);
  }

  // ─── courses ─────────────────────────────────────────────────────────────

  it("courseCreate assigns id/orgId, defaults status 'draft' + activeVersion null, sets timestamps", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    expect(course.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(course.orgId).toBe("orgA");
    expect(course.status).toBe("draft");
    expect(course.activeVersion).toBeNull();
    expect(typeof course.createdAt).toBe("string");
    expect(course.updatedAt).toBe(course.createdAt);
  });

  it("courseGet round-trips the created course and is org-scoped", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    expect(store.courseGet("orgA", course.id)).toEqual(course);
    expect(store.courseGet("orgB", course.id)).toBeUndefined();
  });

  it("courseList returns newest-updated first, scoped to the org", async () => {
    const store = freshStore();
    const a = store.courseCreate("orgA", courseInput());
    await sleep(3);
    const b = store.courseCreate("orgA", courseInput());
    await sleep(3);
    const c = store.courseCreate("orgA", courseInput());
    expect(store.courseList("orgA").map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(store.courseList("orgB")).toEqual([]);
  });

  it("courseUpdate shallow-merges and bumps updatedAt; cross-org update is undefined", async () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    await sleep(3);
    const updated = store.courseUpdate("orgA", course.id, { title: "Renamed" });
    expect(updated?.title).toBe("Renamed");
    expect(updated?.slug).toBe(course.slug); // untouched
    expect((updated?.updatedAt ?? "") > course.updatedAt).toBe(true);
    expect(store.courseUpdate("orgB", course.id, { title: "hijack" })).toBeUndefined();
    expect(store.courseGet("orgA", course.id)?.title).toBe("Renamed");
  });

  // ─── saveApprovedPlan ────────────────────────────────────────────────────

  it("saveApprovedPlan expands a 20×10 + 20-project plan into persisted rows", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    const result = store.saveApprovedPlan("orgA", course.id, buildPlan());

    const modules = store.moduleList("orgA", course.id);
    const lessons = store.lessonList("orgA", course.id);
    const projects = store.projectList("orgA", course.id);

    expect(modules.length).toBe(20);
    expect(lessons.length).toBe(200);
    expect(projects.length).toBe(20);

    expect(modules.map((m) => m.order)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(lessons.map((l) => l.globalOrder)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(lessons[0].moduleOrder).toBe(1);
    expect(lessons[199].moduleOrder).toBe(20);
    expect(projects.map((p) => p.moduleId)).toEqual(modules.map((m) => m.id));

    for (const m of modules) {
      expect(m.orgId).toBe("orgA");
      expect(m.courseId).toBe(course.id);
    }
    for (const l of lessons) {
      expect(l.orgId).toBe("orgA");
      expect(l.courseId).toBe(course.id);
    }
    for (const p of projects) {
      expect(p.orgId).toBe("orgA");
      expect(p.courseId).toBe(course.id);
    }

    const after = store.courseGet("orgA", course.id);
    expect(after?.status).toBe("planned");
    expect(after?.moduleCount).toBe(20);
    expect(after?.lessonsPerModule).toBe(10);

    expect(result.modules.length).toBe(20);
    expect(result.lessons.length).toBe(200);
    expect(result.projects.length).toBe(20);
  });

  it("saveApprovedPlan exact counts: 20 modules / 200 lessons / 20 projects", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    expect(store.moduleList("orgA", course.id).length).toBe(20);
    expect(store.lessonList("orgA", course.id).length).toBe(200);
    expect(store.projectList("orgA", course.id).length).toBe(20);
  });

  it("saveApprovedPlan is idempotent — a second call regenerates, it does not duplicate", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    expect(store.moduleList("orgA", course.id).length).toBe(20);
    expect(store.lessonList("orgA", course.id).length).toBe(200);
    expect(store.projectList("orgA", course.id).length).toBe(20);
  });

  it("saveApprovedPlan is atomic — a 199-lesson plan throws and persists nothing", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    expect(store.moduleList("orgA", course.id)).toEqual([]);

    expect(() => store.saveApprovedPlan("orgA", course.id, buildPlan({ lessonCount: 199 }))).toThrow(
      /199|lessons/i
    );

    expect(store.moduleList("orgA", course.id)).toEqual([]);
    expect(store.lessonList("orgA", course.id)).toEqual([]);
    expect(store.projectList("orgA", course.id)).toEqual([]);
    expect(store.courseGet("orgA", course.id)?.status).toBe("draft");
  });

  it("saveApprovedPlan lesson<->module mapping stays consistent per module", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    const modules = store.moduleList("orgA", course.id);
    for (const m of modules) {
      const lessons = store.lessonList("orgA", course.id, m.id);
      expect(lessons.length).toBe(10);
      expect(lessons.every((l) => l.moduleOrder === m.order && l.moduleId === m.id)).toBe(true);
    }
  });

  // The ONLY real path that sets course.activeVersion is versionCreate (locking a
  // plan snapshot into production). courseUpdate's patch type
  // (Partial<CurriculumCourseInput>) structurally cannot express activeVersion, so
  // this test drives the guard through that real path — no test-only backdoor.
  it("saveApprovedPlan rejects once the course has an active version (set via versionCreate)", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    expect(store.courseGet("orgA", course.id)?.activeVersion).toBeNull();

    const version = store.versionCreate("orgA", course.id, {
      version: store.nextVersionNumber("orgA", course.id),
      createdByAccountId: "acc-1",
      reason: "lock for production",
      snapshot: { locked: true }
    });
    expect(version.version).toBe(1);
    expect(store.courseGet("orgA", course.id)?.activeVersion).toBe(1);

    expect(() => store.saveApprovedPlan("orgA", course.id, buildPlan())).toThrow(/active version/i);
    // still the original 20/200/20 — nothing was wiped by the rejected call
    expect(store.moduleList("orgA", course.id).length).toBe(20);
    expect(store.lessonList("orgA", course.id).length).toBe(200);
  });

  // ─── lessonUpdate field-granularity ──────────────────────────────────────

  it("lessonUpdate merges only provided keys and leaves siblings intact", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    const lessons = store.lessonList("orgA", course.id);
    const l5 = lessons.find((l) => l.globalOrder === 5)!;
    const l6 = lessons.find((l) => l.globalOrder === 6)!;

    store.lessonUpdate("orgA", course.id, l5.id, { explanation: "explains the idea" });
    store.lessonUpdate("orgA", course.id, l5.id, { shortScript: "hook / point / cta" });

    const after5 = store.lessonGet("orgA", course.id, l5.id);
    expect(after5?.explanation).toBe("explains the idea");
    expect(after5?.shortScript).toBe("hook / point / cta");
    expect(after5?.title).toBe(l5.title); // untouched

    const after6 = store.lessonGet("orgA", course.id, l6.id);
    expect(after6?.explanation).toBeUndefined();
    expect(after6?.shortScript).toBeUndefined();
  });

  // ─── modules / projects ─────────────────────────────────────────────────

  it("moduleUpdate / projectUpdate merge fields; projectGetByModule resolves the owner", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());
    const m = store.moduleList("orgA", course.id)[0];

    const mu = store.moduleUpdate("orgA", course.id, m.id, { title: "Renamed Module" });
    expect(mu?.title).toBe("Renamed Module");
    expect(mu?.goal).toBe(m.goal);
    expect(store.moduleUpdate("orgB", course.id, m.id, { title: "x" })).toBeUndefined();

    const p = store.projectGetByModule("orgA", course.id, m.id);
    expect(p?.moduleId).toBe(m.id);
    const pu = store.projectUpdate("orgA", course.id, p!.id, { objective: "sharper objective" });
    expect(pu?.objective).toBe("sharper objective");
    expect(pu?.outcome).toBe(p?.outcome);
    expect(store.projectGet("orgA", course.id, p!.id)?.objective).toBe("sharper objective");
  });

  // ─── cascade delete ─────────────────────────────────────────────────────

  it("courseDelete cascades every child row and leaves a second course fully intact", () => {
    const store = freshStore();
    const cA = store.courseCreate("orgA", courseInput());
    const cB = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", cA.id, buildPlan());
    store.saveApprovedPlan("orgA", cB.id, buildPlan());

    store.assetCreate("orgA", { courseId: cA.id, assetType: "script", meta: {} });
    store.versionCreate("orgA", cA.id, {
      version: 1,
      createdByAccountId: "acc-1",
      reason: "lock",
      snapshot: {}
    });
    store.lessonCompletionUpsert("orgA", {
      orgId: "orgA",
      courseId: cA.id,
      lessonId: store.lessonList("orgA", cA.id)[0].id,
      accountId: "acc-1"
    });

    expect(store.courseDelete("orgA", cA.id)).toBe(true);
    expect(store.courseGet("orgA", cA.id)).toBeUndefined();
    expect(store.moduleList("orgA", cA.id)).toEqual([]);
    expect(store.lessonList("orgA", cA.id)).toEqual([]);
    expect(store.projectList("orgA", cA.id)).toEqual([]);
    expect(store.assetList("orgA", cA.id)).toEqual([]);
    expect(store.versionList("orgA", cA.id)).toEqual([]);
    expect(store.lessonCompletionList("orgA", cA.id)).toEqual([]);

    expect(store.moduleList("orgA", cB.id).length).toBe(20);
    expect(store.lessonList("orgA", cB.id).length).toBe(200);
    expect(store.projectList("orgA", cB.id).length).toBe(20);

    expect(store.courseDelete("orgA", cA.id)).toBe(false); // already gone
  });

  // ─── tenant isolation ───────────────────────────────────────────────────

  it("cross-org reads/writes never touch another org's curriculum", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    store.saveApprovedPlan("orgA", course.id, buildPlan());

    expect(store.moduleList("orgB", course.id)).toEqual([]);
    expect(store.lessonList("orgB", course.id)).toEqual([]);
    expect(store.projectList("orgB", course.id)).toEqual([]);

    expect(store.courseDelete("orgB", course.id)).toBe(false);
    expect(store.moduleList("orgA", course.id).length).toBe(20);

    const lesson = store.lessonList("orgA", course.id)[0];
    expect(store.lessonUpdate("orgB", course.id, lesson.id, { explanation: "hacked" })).toBeUndefined();
    expect(store.lessonGet("orgA", course.id, lesson.id)?.explanation).toBeUndefined();
  });

  // ─── versions ───────────────────────────────────────────────────────────

  it("nextVersionNumber is 1, then 2 after a version is created; versionList ascends", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    expect(store.nextVersionNumber("orgA", course.id)).toBe(1);

    store.versionCreate("orgA", course.id, {
      version: 1,
      createdByAccountId: "acc-1",
      reason: "first lock",
      snapshot: { a: 1 }
    });
    expect(store.nextVersionNumber("orgA", course.id)).toBe(2);

    store.versionCreate("orgA", course.id, {
      version: 2,
      createdByAccountId: "acc-1",
      reason: "second lock",
      snapshot: null
    });
    expect(store.versionList("orgA", course.id).map((v) => v.version)).toEqual([1, 2]);
    expect(store.versionList("orgB", course.id)).toEqual([]);
  });

  // ─── assets ─────────────────────────────────────────────────────────────

  it("assetCreate/assetList filter by lessonId (and other facets); assetGet is org-scoped", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());
    const a1 = store.assetCreate("orgA", {
      courseId: course.id,
      lessonId: "lesson-1",
      assetType: "script",
      meta: {}
    });
    const a2 = store.assetCreate("orgA", {
      courseId: course.id,
      lessonId: "lesson-2",
      assetType: "short_video",
      meta: {}
    });

    expect(store.assetList("orgA", course.id).map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(store.assetList("orgA", course.id, { lessonId: "lesson-1" }).map((a) => a.id)).toEqual([a1.id]);
    expect(store.assetList("orgA", course.id, { assetType: "short_video" }).map((a) => a.id)).toEqual([a2.id]);
    expect(store.assetList("orgB", course.id)).toEqual([]);

    expect(store.assetGet("orgA", a1.id)?.id).toBe(a1.id);
    expect(store.assetGet("orgB", a1.id)).toBeUndefined();

    const updated = store.assetUpdate("orgA", a1.id, { status: "approved", storagePath: "/x/y" });
    expect(updated?.status).toBe("approved");
    expect(updated?.lessonId).toBe("lesson-1"); // untouched
    expect(store.assetUpdate("orgB", a1.id, { status: "failed" })).toBeUndefined();
  });

  // ─── lesson completions ─────────────────────────────────────────────────

  it("lessonCompletionUpsert keeps one row per (org,course,lesson,account) and refreshes it", () => {
    const store = freshStore();
    const course = store.courseCreate("orgA", courseInput());

    store.lessonCompletionUpsert("orgA", {
      orgId: "orgA",
      courseId: course.id,
      lessonId: "lesson-1",
      accountId: "acc-1"
    });
    const second = store.lessonCompletionUpsert("orgA", {
      orgId: "orgA",
      courseId: course.id,
      lessonId: "lesson-1",
      accountId: "acc-1",
      knowledgeCheckScore: 0.9
    });

    const forAcc1 = store.lessonCompletionList("orgA", course.id, "acc-1");
    expect(forAcc1.length).toBe(1);
    expect(forAcc1[0].knowledgeCheckScore).toBe(0.9);
    expect(forAcc1[0].completedAt).toBe(second.completedAt);

    store.lessonCompletionUpsert("orgA", {
      orgId: "orgA",
      courseId: course.id,
      lessonId: "lesson-1",
      accountId: "acc-2"
    });
    expect(store.lessonCompletionList("orgA", course.id).length).toBe(2);
    expect(store.lessonCompletionList("orgA", course.id, "acc-2").length).toBe(1);
    expect(store.lessonCompletionList("orgB", course.id)).toEqual([]);
  });

  // ─── persistence + corruption ───────────────────────────────────────────

  it("data persists across separate createCurriculumStore(dir) instances on the same dir", () => {
    const first = freshStore();
    const course = first.courseCreate("orgA", courseInput());
    first.saveApprovedPlan("orgA", course.id, buildPlan());

    const second = createCurriculumStore(dir);
    expect(second.courseGet("orgA", course.id)?.id).toBe(course.id);
    expect(second.moduleList("orgA", course.id).length).toBe(20);
    expect(second.lessonList("orgA", course.id).length).toBe(200);
    expect(second.projectList("orgA", course.id).length).toBe(20);
  });

  it("a malformed entity file is quarantined and read as an empty list", () => {
    const store = freshStore();
    store.courseCreate("orgA", courseInput());
    writeFileSync(join(dir, "curriculum-courses.json"), "{ not valid json");
    expect(store.courseList("orgA")).toEqual([]);
    const quarantined = readdirSync(dir).filter((f) => f.startsWith("curriculum-courses.json.corrupt-"));
    expect(quarantined.length).toBe(1);
  });
});
