// Curriculum Mode v2 — the file-backed store for every curriculum entity.
//
// Mirrors the @vvugc/shared-auth per-store convention: the tiny
// acquireLock / read / write helpers are DUPLICATED here on purpose (not
// imported), writes are atomic (tmp file + rename), a malformed JSON file is
// quarantined and treated as empty. One JSON file per entity type under `dir`,
// one dir-scoped lock so multi-file writes (plan expansion, cascade delete)
// serialise. Domain types + schemas come from ./schema; nothing else is imported.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CurriculumAssetSchema,
  CurriculumCourseSchema,
  CurriculumLessonSchema,
  CurriculumModuleSchema,
  CurriculumProjectSchema,
  CurriculumVersionSchema,
  LessonCompletionSchema,
  newId,
  sortByGlobalOrder,
  sortByOrder,
  type CurriculumAsset,
  type CurriculumAssetInput,
  type CurriculumCourse,
  type CurriculumCourseInput,
  type CurriculumLesson,
  type CurriculumLessonInput,
  type CurriculumModule,
  type CurriculumModuleInput,
  type CurriculumPlan,
  type CurriculumProject,
  type CurriculumProjectInput,
  type CurriculumVersion,
  type LessonCompletion,
  type LessonCompletionInput
} from "./schema.js";
import { expandCurriculumPlan } from "./plan.js";

// ─── Store interface ───────────────────────────────────────────────────────

/** Filter for {@link CurriculumStore.assetList}. */
export interface CurriculumAssetFilter {
  moduleId?: string;
  lessonId?: string;
  projectId?: string;
  assetType?: CurriculumAsset["assetType"];
  status?: CurriculumAsset["status"];
}

/** Input for {@link CurriculumStore.versionCreate} — a locked plan snapshot. */
export interface CurriculumVersionCreateInput {
  version: number;
  createdByAccountId: string;
  reason: string;
  snapshot: unknown;
}

/** An orgId-scoped, file-backed store for every Curriculum Mode entity.
 *  Every method takes `orgId` first and filters on it — cross-org / cross-course
 *  access yields `undefined` (get), `false` (delete / update-missing) or `[]`
 *  (list), NEVER another org's rows. */
export interface CurriculumStore {
  courseCreate(orgId: string, input: CurriculumCourseInput): CurriculumCourse;
  courseList(orgId: string): CurriculumCourse[];
  courseGet(orgId: string, courseId: string): CurriculumCourse | undefined;
  courseUpdate(
    orgId: string,
    courseId: string,
    patch: Partial<CurriculumCourseInput>
  ): CurriculumCourse | undefined;
  courseDelete(orgId: string, courseId: string): boolean;

  moduleList(orgId: string, courseId: string): CurriculumModule[];
  moduleGet(orgId: string, courseId: string, moduleId: string): CurriculumModule | undefined;
  moduleUpdate(
    orgId: string,
    courseId: string,
    moduleId: string,
    patch: Partial<CurriculumModuleInput>
  ): CurriculumModule | undefined;

  lessonList(orgId: string, courseId: string, moduleId?: string): CurriculumLesson[];
  lessonGet(orgId: string, courseId: string, lessonId: string): CurriculumLesson | undefined;
  lessonUpdate(
    orgId: string,
    courseId: string,
    lessonId: string,
    patch: Partial<CurriculumLessonInput>
  ): CurriculumLesson | undefined;

  projectList(orgId: string, courseId: string): CurriculumProject[];
  projectGet(orgId: string, courseId: string, projectId: string): CurriculumProject | undefined;
  projectGetByModule(
    orgId: string,
    courseId: string,
    moduleId: string
  ): CurriculumProject | undefined;
  projectUpdate(
    orgId: string,
    courseId: string,
    projectId: string,
    patch: Partial<CurriculumProjectInput>
  ): CurriculumProject | undefined;

  assetCreate(orgId: string, input: CurriculumAssetInput): CurriculumAsset;
  assetList(orgId: string, courseId: string, filter?: CurriculumAssetFilter): CurriculumAsset[];
  assetGet(orgId: string, assetId: string): CurriculumAsset | undefined;
  assetUpdate(
    orgId: string,
    assetId: string,
    patch: Partial<CurriculumAssetInput>
  ): CurriculumAsset | undefined;

  versionCreate(
    orgId: string,
    courseId: string,
    input: CurriculumVersionCreateInput
  ): CurriculumVersion;
  versionList(orgId: string, courseId: string): CurriculumVersion[];
  nextVersionNumber(orgId: string, courseId: string): number;

  lessonCompletionUpsert(orgId: string, input: LessonCompletionInput): LessonCompletion;
  lessonCompletionList(orgId: string, courseId: string, accountId?: string): LessonCompletion[];

  /** Expand a validated {@link CurriculumPlan} into persisted module/lesson/project
   *  rows for `courseId`. Atomic (best-effort for a file store): the WHOLE expanded
   *  structure is validated first (schema-parse every row; lessons.length ===
   *  moduleCount*lessonsPerModule; projects.length === moduleCount; globalOrder a
   *  contiguous 1..N run; every lesson/project moduleOrder maps to a module) — on
   *  any failure it THROWS and persists nothing. On success, under one lock, it
   *  REPLACES all modules/lessons/projects for that course (idempotent
   *  regeneration) and adopts plan.course into the course row with status
   *  "planned". Rejects if course.activeVersion != null (production started — a new
   *  version must be cut instead of regenerating in place). */
  saveApprovedPlan(
    orgId: string,
    courseId: string,
    plan: CurriculumPlan
  ): { modules: CurriculumModule[]; lessons: CurriculumLesson[]; projects: CurriculumProject[] };
}

// ─── Shared helpers (duplicated per store, like shared-auth) ────────────────

/** Minimal structural view of a Zod schema's `.safeParse` — avoids ZodType variance. */
type Parser<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
};

function now(): string {
  return new Date().toISOString();
}

/** Field-granular shallow merge: copies only the keys actually present (and not
 *  `undefined`) in `patch`, leaving every other field of `base` untouched. */
function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createCurriculumStore(dir: string): CurriculumStore {
  const paths = {
    courses: join(dir, "curriculum-courses.json"),
    modules: join(dir, "curriculum-modules.json"),
    lessons: join(dir, "curriculum-lessons.json"),
    projects: join(dir, "curriculum-projects.json"),
    assets: join(dir, "curriculum-assets.json"),
    versions: join(dir, "curriculum-versions.json"),
    completions: join(dir, "curriculum-lesson-completions.json")
  } as const;
  const lockPath = join(dir, ".curriculum.lock");

  // -- lock keyed on `dir` so every multi-file write serialises --------------
  function acquireLock(timeoutMs = 5000): void {
    const start = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx"));
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for curriculum lock at ${lockPath}`);
        }
        const until = Date.now() + 20;
        while (Date.now() < until) {
          /* bounded spin */
        }
      }
    }
  }

  function withLock<T>(fn: () => T): T {
    mkdirSync(dir, { recursive: true });
    acquireLock();
    try {
      return fn();
    } finally {
      rmSync(lockPath, { force: true });
    }
  }

  // -- per-file JSON I/O: missing/empty -> [], malformed -> quarantine + [] --
  function readTable<T>(path: string, schema: Parser<T>): T[] {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Quarantine the corrupt file so it is preserved for diagnosis, not lost.
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        /* if the rename fails, don't crash the caller */
      }
      console.error(
        `[CRITICAL] curriculum-engine: corrupted JSON in ${path} — quarantined, returning [].`
      );
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const result = schema.safeParse(value);
      return result.success ? [result.data] : [];
    });
  }

  function writeTable(path: string, rows: unknown[]): void {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, path);
  }

  const readCourses = () => readTable<CurriculumCourse>(paths.courses, CurriculumCourseSchema);
  const readModules = () => readTable<CurriculumModule>(paths.modules, CurriculumModuleSchema);
  const readLessons = () => readTable<CurriculumLesson>(paths.lessons, CurriculumLessonSchema);
  const readProjects = () => readTable<CurriculumProject>(paths.projects, CurriculumProjectSchema);
  const readAssets = () => readTable<CurriculumAsset>(paths.assets, CurriculumAssetSchema);
  const readVersions = () => readTable<CurriculumVersion>(paths.versions, CurriculumVersionSchema);
  const readCompletions = () =>
    readTable<LessonCompletion>(paths.completions, LessonCompletionSchema);

  return {
    // ─── Courses ───────────────────────────────────────────────────────────
    courseCreate(orgId, input) {
      return withLock(() => {
        const rows = readCourses();
        const ts = now();
        const course = CurriculumCourseSchema.parse({
          ...input,
          id: newId(),
          orgId,
          status: input.status ?? "draft",
          activeVersion: null,
          createdAt: ts,
          updatedAt: ts
        });
        rows.push(course);
        writeTable(paths.courses, rows);
        return course;
      });
    },

    courseList(orgId) {
      return readCourses()
        .filter((c) => c.orgId === orgId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    },

    courseGet(orgId, courseId) {
      return readCourses().find((c) => c.orgId === orgId && c.id === courseId);
    },

    courseUpdate(orgId, courseId, patch) {
      return withLock(() => {
        const rows = readCourses();
        const i = rows.findIndex((c) => c.orgId === orgId && c.id === courseId);
        if (i === -1) return undefined;
        rows[i] = CurriculumCourseSchema.parse({
          ...mergeDefined(rows[i], patch),
          id: rows[i].id,
          orgId,
          updatedAt: now()
        });
        writeTable(paths.courses, rows);
        return rows[i];
      });
    },

    courseDelete(orgId, courseId) {
      return withLock(() => {
        const courses = readCourses();
        const i = courses.findIndex((c) => c.orgId === orgId && c.id === courseId);
        if (i === -1) return false; // unknown for this org -> touch nothing
        courses.splice(i, 1);
        const owned = (row: { orgId: string; courseId: string }) =>
          row.orgId === orgId && row.courseId === courseId;
        // CASCADE — every child row for (orgId, courseId); other orgs/courses untouched.
        writeTable(paths.courses, courses);
        writeTable(paths.modules, readModules().filter((m) => !owned(m)));
        writeTable(paths.lessons, readLessons().filter((l) => !owned(l)));
        writeTable(paths.projects, readProjects().filter((p) => !owned(p)));
        writeTable(paths.assets, readAssets().filter((a) => !owned(a)));
        writeTable(paths.versions, readVersions().filter((v) => !owned(v)));
        writeTable(paths.completions, readCompletions().filter((x) => !owned(x)));
        return true;
      });
    },

    // ─── Modules ───────────────────────────────────────────────────────────
    moduleList(orgId, courseId) {
      return sortByOrder(
        readModules().filter((m) => m.orgId === orgId && m.courseId === courseId)
      );
    },

    moduleGet(orgId, courseId, moduleId) {
      return readModules().find(
        (m) => m.orgId === orgId && m.courseId === courseId && m.id === moduleId
      );
    },

    moduleUpdate(orgId, courseId, moduleId, patch) {
      return withLock(() => {
        const rows = readModules();
        const i = rows.findIndex(
          (m) => m.orgId === orgId && m.courseId === courseId && m.id === moduleId
        );
        if (i === -1) return undefined;
        rows[i] = CurriculumModuleSchema.parse({
          ...mergeDefined(rows[i], patch),
          id: rows[i].id,
          orgId,
          courseId,
          updatedAt: now()
        });
        writeTable(paths.modules, rows);
        return rows[i];
      });
    },

    // ─── Lessons ───────────────────────────────────────────────────────────
    lessonList(orgId, courseId, moduleId) {
      const rows = readLessons().filter(
        (l) =>
          l.orgId === orgId &&
          l.courseId === courseId &&
          (moduleId === undefined || l.moduleId === moduleId)
      );
      return sortByGlobalOrder(rows);
    },

    lessonGet(orgId, courseId, lessonId) {
      return readLessons().find(
        (l) => l.orgId === orgId && l.courseId === courseId && l.id === lessonId
      );
    },

    lessonUpdate(orgId, courseId, lessonId, patch) {
      return withLock(() => {
        const rows = readLessons();
        const i = rows.findIndex(
          (l) => l.orgId === orgId && l.courseId === courseId && l.id === lessonId
        );
        if (i === -1) return undefined;
        // Field-granular: only the provided keys change; approved siblings and
        // every other field of this lesson are left exactly as they were.
        rows[i] = CurriculumLessonSchema.parse({
          ...mergeDefined(rows[i], patch),
          id: rows[i].id,
          orgId,
          courseId,
          updatedAt: now()
        });
        writeTable(paths.lessons, rows);
        return rows[i];
      });
    },

    // ─── Projects ──────────────────────────────────────────────────────────
    projectList(orgId, courseId) {
      const orderByModuleId = new Map(
        readModules()
          .filter((m) => m.orgId === orgId && m.courseId === courseId)
          .map((m) => [m.id, m.order] as const)
      );
      return readProjects()
        .filter((p) => p.orgId === orgId && p.courseId === courseId)
        .sort(
          (a, b) =>
            (orderByModuleId.get(a.moduleId) ?? 0) - (orderByModuleId.get(b.moduleId) ?? 0) ||
            a.id.localeCompare(b.id)
        );
    },

    projectGet(orgId, courseId, projectId) {
      return readProjects().find(
        (p) => p.orgId === orgId && p.courseId === courseId && p.id === projectId
      );
    },

    projectGetByModule(orgId, courseId, moduleId) {
      return readProjects().find(
        (p) => p.orgId === orgId && p.courseId === courseId && p.moduleId === moduleId
      );
    },

    projectUpdate(orgId, courseId, projectId, patch) {
      return withLock(() => {
        const rows = readProjects();
        const i = rows.findIndex(
          (p) => p.orgId === orgId && p.courseId === courseId && p.id === projectId
        );
        if (i === -1) return undefined;
        rows[i] = CurriculumProjectSchema.parse({
          ...mergeDefined(rows[i], patch),
          id: rows[i].id,
          orgId,
          courseId,
          updatedAt: now()
        });
        writeTable(paths.projects, rows);
        return rows[i];
      });
    },

    // ─── Assets ────────────────────────────────────────────────────────────
    assetCreate(orgId, input) {
      return withLock(() => {
        const rows = readAssets();
        const ts = now();
        const asset = CurriculumAssetSchema.parse({
          ...input,
          id: newId(),
          orgId,
          status: input.status ?? "planned",
          createdAt: ts,
          updatedAt: ts
        });
        rows.push(asset);
        writeTable(paths.assets, rows);
        return asset;
      });
    },

    assetList(orgId, courseId, filter) {
      return readAssets()
        .filter(
          (a) =>
            a.orgId === orgId &&
            a.courseId === courseId &&
            (!filter?.moduleId || a.moduleId === filter.moduleId) &&
            (!filter?.lessonId || a.lessonId === filter.lessonId) &&
            (!filter?.projectId || a.projectId === filter.projectId) &&
            (!filter?.assetType || a.assetType === filter.assetType) &&
            (!filter?.status || a.status === filter.status)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },

    assetGet(orgId, assetId) {
      return readAssets().find((a) => a.orgId === orgId && a.id === assetId);
    },

    assetUpdate(orgId, assetId, patch) {
      return withLock(() => {
        const rows = readAssets();
        const i = rows.findIndex((a) => a.orgId === orgId && a.id === assetId);
        if (i === -1) return undefined;
        rows[i] = CurriculumAssetSchema.parse({
          ...mergeDefined(rows[i], patch),
          id: rows[i].id,
          orgId,
          updatedAt: now()
        });
        writeTable(paths.assets, rows);
        return rows[i];
      });
    },

    // ─── Versions ──────────────────────────────────────────────────────────
    versionCreate(orgId, courseId, input) {
      return withLock(() => {
        const versions = readVersions();
        const version = CurriculumVersionSchema.parse({
          id: newId(),
          orgId,
          courseId,
          version: input.version,
          createdAt: now(),
          createdByAccountId: input.createdByAccountId,
          reason: input.reason,
          snapshot: input.snapshot
        });
        versions.push(version);
        writeTable(paths.versions, versions);
        // Locking a version is what puts a course "into production": this is the
        // one real path that sets course.activeVersion (courseUpdate's patch type
        // — Partial<CurriculumCourseInput> — cannot express it). saveApprovedPlan
        // then refuses in-place regeneration for this course.
        const courses = readCourses();
        const ci = courses.findIndex((c) => c.orgId === orgId && c.id === courseId);
        if (
          ci !== -1 &&
          (courses[ci].activeVersion === null || version.version > courses[ci].activeVersion)
        ) {
          courses[ci] = CurriculumCourseSchema.parse({
            ...courses[ci],
            activeVersion: version.version,
            updatedAt: now()
          });
          writeTable(paths.courses, courses);
        }
        return version;
      });
    },

    versionList(orgId, courseId) {
      return readVersions()
        .filter((v) => v.orgId === orgId && v.courseId === courseId)
        .sort((a, b) => a.version - b.version);
    },

    nextVersionNumber(orgId, courseId) {
      const mine = readVersions().filter((v) => v.orgId === orgId && v.courseId === courseId);
      return mine.length ? Math.max(...mine.map((v) => v.version)) + 1 : 1;
    },

    // ─── Lesson completions ────────────────────────────────────────────────
    lessonCompletionUpsert(orgId, input) {
      return withLock(() => {
        const rows = readCompletions();
        const row = LessonCompletionSchema.parse({ ...input, orgId, completedAt: now() });
        const i = rows.findIndex(
          (r) =>
            r.orgId === orgId &&
            r.courseId === row.courseId &&
            r.lessonId === row.lessonId &&
            r.accountId === row.accountId
        );
        if (i === -1) rows.push(row);
        else rows[i] = row;
        writeTable(paths.completions, rows);
        return row;
      });
    },

    lessonCompletionList(orgId, courseId, accountId) {
      return readCompletions()
        .filter(
          (r) =>
            r.orgId === orgId &&
            r.courseId === courseId &&
            (accountId === undefined || r.accountId === accountId)
        )
        .sort(
          (a, b) =>
            a.completedAt.localeCompare(b.completedAt) || a.accountId.localeCompare(b.accountId)
        );
    },

    // ─── Plan expansion ────────────────────────────────────────────────────
    saveApprovedPlan(orgId, courseId, plan) {
      return withLock(() => {
        const courses = readCourses();
        const courseIdx = courses.findIndex((c) => c.orgId === orgId && c.id === courseId);
        if (courseIdx === -1) {
          throw new Error(`saveApprovedPlan: course ${courseId} not found for org ${orgId}`);
        }
        const course = courses[courseIdx];
        if (course.activeVersion !== null) {
          throw new Error(
            `saveApprovedPlan: course ${courseId} has an active version (${course.activeVersion}); ` +
              `production has started — cut a new version instead of regenerating the plan in place.`
          );
        }

        // Validate + expand the whole plan (throws on any failure, touches
        // nothing) — shared byte-for-byte with the Postgres tenant-profile store.
        const { course: updatedCourse, modules, lessons, projects } = expandCurriculumPlan(
          orgId,
          courseId,
          course,
          plan
        );

        // Persist: REPLACE this course's module/lesson/project rows wholesale
        // (idempotent regeneration), leaving every other course's rows intact.
        const owned = (row: { orgId: string; courseId: string }) =>
          row.orgId === orgId && row.courseId === courseId;
        writeTable(paths.modules, [...readModules().filter((m) => !owned(m)), ...modules]);
        writeTable(paths.lessons, [...readLessons().filter((l) => !owned(l)), ...lessons]);
        writeTable(paths.projects, [...readProjects().filter((pr) => !owned(pr)), ...projects]);
        courses[courseIdx] = updatedCourse;
        writeTable(paths.courses, courses);

        return { modules, lessons, projects };
      });
    }
  };
}
