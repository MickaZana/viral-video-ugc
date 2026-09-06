// Curriculum Mode v2 — pure, deterministic QA for a CurriculumPlan.
//
// `runCurriculumQa(plan)` walks an already-schema-valid CurriculumPlan and
// returns a structured report of structural / pedagogical problems:
//
//   ERRORS (block approval)
//   - count-mismatch                — module / lesson / project counts don't line
//                                     up with course.moduleCount × lessonsPerModule
//   - duplicate-lesson-title        — two lessons with the same normalized title
//   - concept-before-prerequisite   — a lesson lists a prerequisite that names a
//                                     concept nothing has introduced yet
//   - circular-module-prerequisite  — a module prerequisite cycle (or self-ref)
//   - forward-module-prerequisite   — a module requires a LATER module
//
//   WARNINGS (surface, don't block)
//   - near-duplicate-lesson-title   — token-set Jaccard of two titles > 0.8
//   - duplicate-module-concept      — one concept claimed by 2+ modules
//   - module-overlap               — two modules' concept sets, Jaccard > 0.6
//   - difficulty-jump              — a mid/late module claiming no prerequisites
//   - project-unrelated-to-module   — a project sharing no keyword with its module
//   - end-goal-not-covered          — an end-goal keyword in no objective / goal
//   - sparse-lesson-objective       — a learning objective under 5 words
//
// PURE: no fs, no crypto, no network, no LLM, no new dependency. Deterministic:
// same input → byte-identical report. Every scan iterates in a fixed order and
// both issue lists are sorted by a total order before returning.

import type { CurriculumPlan, LessonPlan, ModulePlan } from "./schema.js";

// ─── Public shapes ───────────────────────────────────────────────────────────

export type CurriculumQaSeverity = "error" | "warning";

export interface CurriculumQaIssue {
  /** Stable kebab slug, e.g. "duplicate-lesson-title". */
  code: string;
  severity: CurriculumQaSeverity;
  /** Human-readable; always names the offending module/lesson/project. */
  message: string;
  moduleOrder?: number;
  lessonGlobalOrder?: number;
}

export interface CurriculumQaReport {
  errors: CurriculumQaIssue[];
  warnings: CurriculumQaIssue[];
  /** `errors.length === 0`. */
  ok: boolean;
}

// ─── Tiny pure text helpers (no dependency) ──────────────────────────────────

/** Lowercase, collapse every run of whitespace to one space, trim. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Lowercase alphanumeric tokens; punctuation and empty strings dropped. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Token-set Jaccard: |A∩B| / |A∪B|; 0 when nothing tokenizes on either side. */
function tokenJaccard(a: string, b: string): number {
  return setJaccard(new Set(tokenize(a)), new Set(tokenize(b)));
}

/** Jaccard of two ready-made string sets. */
function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** True when `needle`'s token run appears as a contiguous slice of `haystack`. */
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Common filler words excluded from the end-goal keyword scan (on top of len>4). */
const END_GOAL_STOPWORDS: ReadonlySet<string> = new Set([
  "about", "above", "after", "again", "against", "along", "among", "around",
  "because", "been", "before", "being", "below", "between", "build", "building",
  "could", "deploy", "during", "every", "first", "from", "have", "having",
  "into", "learn", "learning", "make", "making", "must", "onto", "other",
  "over", "production", "result", "should", "some", "such", "than", "that",
  "their", "them", "then", "there", "these", "they", "this", "those", "through",
  "under", "until", "using", "were", "what", "when", "where", "which", "while",
  "with", "within", "without", "would", "your"
]);

// ─── The check ───────────────────────────────────────────────────────────────

/**
 * Pure, deterministic QA pass over a {@link CurriculumPlan}. Never throws, never
 * touches I/O; the returned report is byte-identical for identical input.
 */
export function runCurriculumQa(plan: CurriculumPlan): CurriculumQaReport {
  const { course, modules, lessons, projects } = plan;
  const issues: CurriculumQaIssue[] = [];

  const modulesByOrder = new Map<number, ModulePlan>();
  for (const m of modules) modulesByOrder.set(m.order, m);

  const lessonsByModule = new Map<number, LessonPlan[]>();
  for (const l of lessons) {
    const bucket = lessonsByModule.get(l.moduleOrder);
    if (bucket) bucket.push(l);
    else lessonsByModule.set(l.moduleOrder, [l]);
  }

  const sortedModules = [...modules].sort((a, b) => a.order - b.order);
  const sortedLessons = [...lessons].sort((a, b) => a.globalOrder - b.globalOrder);

  // ── ERROR: count-mismatch ─────────────────────────────────────────────────
  if (modules.length !== course.moduleCount) {
    issues.push({
      code: "count-mismatch",
      severity: "error",
      message: `Plan has ${modules.length} module(s) but course.moduleCount is ${course.moduleCount}.`
    });
  }
  for (const m of sortedModules) {
    const count = (lessonsByModule.get(m.order) ?? []).length;
    if (count !== course.lessonsPerModule) {
      issues.push({
        code: "count-mismatch",
        severity: "error",
        message: `Module ${m.order} ('${m.title}') has ${count} lesson(s) but course.lessonsPerModule is ${course.lessonsPerModule}.`,
        moduleOrder: m.order
      });
    }
  }
  const expectedLessons = course.moduleCount * course.lessonsPerModule;
  if (lessons.length !== expectedLessons) {
    issues.push({
      code: "count-mismatch",
      severity: "error",
      message: `Plan has ${lessons.length} lesson(s) but expects ${expectedLessons} (${course.moduleCount}×${course.lessonsPerModule}).`
    });
  }
  if (projects.length !== course.moduleCount) {
    issues.push({
      code: "count-mismatch",
      severity: "error",
      message: `Plan has ${projects.length} project(s) but expects ${course.moduleCount} (one per module).`
    });
  }

  // ── ERROR: duplicate-lesson-title ─────────────────────────────────────────
  const titleGroups = new Map<string, LessonPlan[]>();
  for (const l of sortedLessons) {
    const key = normalize(l.title);
    const g = titleGroups.get(key);
    if (g) g.push(l);
    else titleGroups.set(key, [l]);
  }
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue;
    const orders = group.map((l) => l.globalOrder).sort((a, b) => a - b);
    issues.push({
      code: "duplicate-lesson-title",
      severity: "error",
      message: `Lessons ${orders.join(", ")} share the title "${group[0].title}" (case/space-insensitive).`,
      moduleOrder: group[0].moduleOrder,
      lessonGlobalOrder: orders[0]
    });
  }

  // ── ERROR: concept-before-prerequisite ───────────────────────────────────
  // normalized concept -> earliest globalOrder that introduces it.
  const conceptFirstIntro = new Map<string, number>();
  const noteIntro = (concept: string, order: number): void => {
    const key = normalize(concept);
    if (key.length === 0) return;
    const prev = conceptFirstIntro.get(key);
    if (prev === undefined || order < prev) conceptFirstIntro.set(key, order);
  };
  for (const l of sortedLessons) {
    for (const c of l.concepts) noteIntro(c, l.globalOrder);
  }
  for (const m of sortedModules) {
    const ls = (lessonsByModule.get(m.order) ?? [])
      .slice()
      .sort((a, b) => a.globalOrder - b.globalOrder);
    const firstOrder = ls.length > 0 ? ls[0].globalOrder : Number.POSITIVE_INFINITY;
    for (const c of m.concepts) noteIntro(c, firstOrder);
  }
  const conceptKeys = [...conceptFirstIntro.keys()].sort();
  for (const l of sortedLessons) {
    for (const pre of l.prerequisites) {
      const preTokens = tokenize(pre);
      if (preTokens.length === 0) continue;
      for (const ck of conceptKeys) {
        const introOrder = conceptFirstIntro.get(ck);
        if (introOrder === undefined) continue;
        if (!containsTokenRun(preTokens, tokenize(ck))) continue;
        if (introOrder >= l.globalOrder) {
          const introWhere = Number.isFinite(introOrder)
            ? `lesson ${introOrder}`
            : "a module with no lessons";
          issues.push({
            code: "concept-before-prerequisite",
            severity: "error",
            message: `Lesson ${l.globalOrder} ('${l.title}') lists prerequisite "${pre}", but the concept "${ck}" it names is not introduced until ${introWhere}.`,
            moduleOrder: l.moduleOrder,
            lessonGlobalOrder: l.globalOrder
          });
          break; // one issue per (lesson, prerequisite)
        }
      }
    }
  }

  // ── ERROR: circular- / forward-module-prerequisite ───────────────────────
  // Build a directed graph moduleOrder -> referenced moduleOrder.
  const graph = new Map<number, Set<number>>();
  for (const m of sortedModules) graph.set(m.order, new Set<number>());
  for (const m of sortedModules) {
    const edges = graph.get(m.order);
    if (!edges) continue;
    for (const pre of m.prerequisites) {
      const preNorm = normalize(pre);
      const preTokens = tokenize(pre);
      for (const other of sortedModules) {
        if (containsTokenRun(preTokens, tokenize(other.title))) edges.add(other.order);
      }
      for (const match of preNorm.matchAll(/module\s+(\d+)/g)) {
        const num = Number.parseInt(match[1], 10);
        if (graph.has(num)) edges.add(num);
      }
    }
  }
  const canReach = (from: number, to: number): boolean => {
    const seen = new Set<number>();
    const stack: number[] = [from];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) break;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of graph.get(cur) ?? []) stack.push(next);
    }
    return false;
  };
  const cycleReported = new Set<string>();
  for (const m of sortedModules) {
    const edges = [...(graph.get(m.order) ?? [])].sort((a, b) => a - b);
    for (const target of edges) {
      if (target === m.order) {
        issues.push({
          code: "circular-module-prerequisite",
          severity: "error",
          message: `Module ${m.order} ('${m.title}') lists itself as a prerequisite.`,
          moduleOrder: m.order
        });
        continue;
      }
      if (canReach(target, m.order)) {
        const lo = Math.min(m.order, target);
        const hi = Math.max(m.order, target);
        const key = `${lo}-${hi}`;
        if (!cycleReported.has(key)) {
          cycleReported.add(key);
          issues.push({
            code: "circular-module-prerequisite",
            severity: "error",
            message: `Modules ${lo} ('${modulesByOrder.get(lo)?.title ?? "?"}') and ${hi} ('${modulesByOrder.get(hi)?.title ?? "?"}') form a prerequisite cycle.`,
            moduleOrder: lo
          });
        }
      }
      if (target > m.order) {
        issues.push({
          code: "forward-module-prerequisite",
          severity: "error",
          message: `Module ${m.order} ('${m.title}') lists a prerequisite pointing forward to module ${target} ('${modulesByOrder.get(target)?.title ?? "?"}').`,
          moduleOrder: m.order
        });
      }
    }
  }

  // ── WARNING: near-duplicate-lesson-title ─────────────────────────────────
  for (let i = 0; i < sortedLessons.length; i++) {
    for (let j = i + 1; j < sortedLessons.length; j++) {
      const a = sortedLessons[i];
      const b = sortedLessons[j];
      if (normalize(a.title) === normalize(b.title)) continue; // already an error
      if (tokenJaccard(a.title, b.title) > 0.8) {
        issues.push({
          code: "near-duplicate-lesson-title",
          severity: "warning",
          message: `Lessons ${a.globalOrder} ('${a.title}') and ${b.globalOrder} ('${b.title}') have near-identical titles.`,
          moduleOrder: a.moduleOrder,
          lessonGlobalOrder: a.globalOrder
        });
      }
    }
  }

  // ── WARNING: duplicate-module-concept ───────────────────────────────────
  const conceptToModules = new Map<string, number[]>();
  for (const m of sortedModules) {
    const seen = new Set<string>();
    for (const c of m.concepts) {
      const key = normalize(c);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const arr = conceptToModules.get(key);
      if (arr) arr.push(m.order);
      else conceptToModules.set(key, [m.order]);
    }
  }
  for (const [concept, mods] of conceptToModules) {
    if (mods.length < 2) continue;
    issues.push({
      code: "duplicate-module-concept",
      severity: "warning",
      message: `Concept "${concept}" appears in the concepts of modules ${mods.join(", ")}.`,
      moduleOrder: mods[0]
    });
  }

  // ── WARNING: module-overlap ─────────────────────────────────────────────
  const conceptSets = new Map<number, Set<string>>();
  for (const m of sortedModules) {
    conceptSets.set(
      m.order,
      new Set(m.concepts.map(normalize).filter((c) => c.length > 0))
    );
  }
  for (let i = 0; i < sortedModules.length; i++) {
    for (let j = i + 1; j < sortedModules.length; j++) {
      const a = sortedModules[i];
      const b = sortedModules[j];
      const sa = conceptSets.get(a.order) ?? new Set<string>();
      const sb = conceptSets.get(b.order) ?? new Set<string>();
      if (sa.size === 0 || sb.size === 0) continue;
      if (setJaccard(sa, sb) > 0.6) {
        issues.push({
          code: "module-overlap",
          severity: "warning",
          message: `Modules ${a.order} ('${a.title}') and ${b.order} ('${b.title}') have heavily overlapping concept sets.`,
          moduleOrder: a.order
        });
      }
    }
  }

  // ── WARNING: difficulty-jump ───────────────────────────────────────────
  const firstThird = Math.ceil(course.moduleCount / 3);
  for (const m of sortedModules) {
    if (m.order > firstThird && m.prerequisites.length === 0) {
      issues.push({
        code: "difficulty-jump",
        severity: "warning",
        message: `Module ${m.order} ('${m.title}') claims no prerequisites but sits past the first third of the course.`,
        moduleOrder: m.order
      });
    }
  }

  // ── WARNING: project-unrelated-to-module ──────────────────────────────
  for (const p of projects) {
    const m = modulesByOrder.get(p.moduleOrder);
    if (!m) continue; // a dangling moduleOrder is not this check's concern
    const significant = new Set<string>();
    for (const c of m.concepts) for (const t of tokenize(c)) significant.add(t);
    for (const t of tokenize(m.title)) if (t.length > 3) significant.add(t);
    if (significant.size === 0) continue; // nothing to relate against
    const haystack = new Set(
      tokenize([p.title, p.objective, p.outcome, ...p.requirements].join(" "))
    );
    let related = false;
    for (const t of significant) {
      if (haystack.has(t)) {
        related = true;
        break;
      }
    }
    if (!related) {
      issues.push({
        code: "project-unrelated-to-module",
        severity: "warning",
        message: `Project '${p.title}' for module ${p.moduleOrder} ('${m.title}') shares no concept or title keyword with its module.`,
        moduleOrder: p.moduleOrder
      });
    }
  }

  // ── WARNING: end-goal-not-covered ────────────────────────────────────
  const covered = new Set<string>();
  for (const l of lessons) for (const t of tokenize(l.learningObjective)) covered.add(t);
  for (const m of modules) for (const t of tokenize(m.goal)) covered.add(t);
  const seenGoalWord = new Set<string>();
  for (const w of tokenize(course.endGoal)) {
    if (w.length <= 4 || END_GOAL_STOPWORDS.has(w) || seenGoalWord.has(w)) continue;
    seenGoalWord.add(w);
    if (!covered.has(w)) {
      issues.push({
        code: "end-goal-not-covered",
        severity: "warning",
        message: `End-goal keyword "${w}" appears in no lesson objective and no module goal.`
      });
    }
  }

  // ── WARNING: sparse-lesson-objective ────────────────────────────────
  for (const l of sortedLessons) {
    const words = l.learningObjective.trim().split(/\s+/).filter((x) => x.length > 0);
    if (words.length < 5) {
      issues.push({
        code: "sparse-lesson-objective",
        severity: "warning",
        message: `Lesson ${l.globalOrder} ('${l.title}') has a ${words.length}-word learning objective (expected at least 5).`,
        moduleOrder: l.moduleOrder,
        lessonGlobalOrder: l.globalOrder
      });
    }
  }

  // ── Deterministic ordering ─────────────────────────────────────────
  const cmp = (a: CurriculumQaIssue, b: CurriculumQaIssue): number =>
    (a.moduleOrder ?? 0) - (b.moduleOrder ?? 0) ||
    (a.lessonGlobalOrder ?? 0) - (b.lessonGlobalOrder ?? 0) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
    (a.message < b.message ? -1 : a.message > b.message ? 1 : 0);

  const errors = issues.filter((i) => i.severity === "error").sort(cmp);
  const warnings = issues.filter((i) => i.severity === "warning").sort(cmp);
  return { errors, warnings, ok: errors.length === 0 };
}
