import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each case re-imports server.js under vi.resetModules() and runs a bcrypt
// signup; the first cold import + transform of the large server module alone can
// exceed the 5s default. Same "these are real end-to-end server tests" headroom
// settings-routes.test.ts gives its heavy case.
vi.setConfig({ testTimeout: 20_000 });

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

async function signUpAndGetCookie(email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie returned from signup");
  return setCookie.split(";")[0];
}

const VALID_BODY = {
  title: "Agentic AI Simplified",
  topic: "Agentic AI systems",
  audience: "Working software engineers new to LLM agents",
  endGoal: "Ship a small production agent with tools, memory, and guardrails"
};

async function createCourse(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/accounts/curricula`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_BODY, ...overrides })
  });
  return res;
}

describe("curriculum course CRUD routes", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-test-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("POST /accounts/curricula creates a draft course with a slugified title", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("author@example.com");

    const res = await createCourse(cookie);
    expect(res.status).toBe(201);
    const { course } = await res.json();
    expect(typeof course.id).toBe("string");
    expect(course.id.length).toBeGreaterThan(0);
    expect(course.status).toBe("draft");
    expect(course.slug).toBe("agentic-ai-simplified");
    expect(course.orgId).toBeTruthy();
  });

  it("POST /accounts/curricula with a missing title is a 400", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("no-title@example.com");
    const res = await fetch(`${baseUrl}/accounts/curricula`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, title: undefined })
    });
    expect(res.status).toBe(400);
  });

  it("GET /accounts/curricula lists the org's courses and isolates other orgs", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("owner-list@example.com");
    const created = await (await createCourse(cookie)).json();

    const listRes = await fetch(`${baseUrl}/accounts/curricula`, { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const { courses } = await listRes.json();
    expect(Array.isArray(courses)).toBe(true);
    expect(courses.map((c: { id: string }) => c.id)).toContain(created.course.id);

    const otherCookie = await signUpAndGetCookie("stranger-list@example.com");
    const otherList = await (await fetch(`${baseUrl}/accounts/curricula`, { headers: { Cookie: otherCookie } })).json();
    expect(otherList.courses).toEqual([]);
  });

  it("GET /accounts/curricula/:id returns the course with zeroed child counts", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("detail@example.com");
    const { course } = await (await createCourse(cookie)).json();

    const res = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course.id).toBe(course.id);
    expect(body.counts).toEqual({ modules: 0, lessons: 0, projects: 0 });
  });

  it("GET /accounts/curricula/:id is 404 for an unknown id and for another org's course", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("owner-404@example.com");
    const { course } = await (await createCourse(cookie)).json();

    const unknown = await fetch(`${baseUrl}/accounts/curricula/${randomUUID()}`, { headers: { Cookie: cookie } });
    expect(unknown.status).toBe(404);

    const otherCookie = await signUpAndGetCookie("stranger-404@example.com");
    const crossOrg = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { headers: { Cookie: otherCookie } });
    expect(crossOrg.status).toBe(404);
  });

  it("PUT /accounts/curricula/:id patches a field and a follow-up GET reflects it", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("editor-put@example.com");
    const { course } = await (await createCourse(cookie)).json();

    const put = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ endGoal: "Ship a multi-agent workflow with human review gates" })
    });
    expect(put.status).toBe(200);
    expect((await put.json()).course.endGoal).toBe("Ship a multi-agent workflow with human review gates");

    const after = await (await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { headers: { Cookie: cookie } })).json();
    expect(after.course.endGoal).toBe("Ship a multi-agent workflow with human review gates");
  });

  it("PUT /accounts/curricula/:id on another org's course is a 404", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("owner-put404@example.com");
    const { course } = await (await createCourse(cookie)).json();

    const otherCookie = await signUpAndGetCookie("stranger-put404@example.com");
    const put = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, {
      method: "PUT",
      headers: { Cookie: otherCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ endGoal: "hijack" })
    });
    expect(put.status).toBe(404);
  });

  it("DELETE /accounts/curricula/:id deletes once, then 404s, and never touches another org", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("owner-del@example.com");
    const { course } = await (await createCourse(cookie)).json();

    const otherCookie = await signUpAndGetCookie("stranger-del@example.com");
    const otherCreated = await (await createCourse(otherCookie)).json();

    const crossOrgDelete = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, {
      method: "DELETE",
      headers: { Cookie: otherCookie }
    });
    expect(crossOrgDelete.status).toBe(404);
    expect((await crossOrgDelete.json()).deleted).toBe(false);
    // the stranger's own course is still there, and so is the owner's
    expect(
      (await fetch(`${baseUrl}/accounts/curricula/${otherCreated.course.id}`, { headers: { Cookie: otherCookie } })).status
    ).toBe(200);
    expect((await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { headers: { Cookie: cookie } })).status).toBe(200);

    const del = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);

    const gone = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { headers: { Cookie: cookie } });
    expect(gone.status).toBe(404);

    const delAgain = await fetch(`${baseUrl}/accounts/curricula/${course.id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(delAgain.status).toBe(404);
    expect((await delAgain.json()).deleted).toBe(false);
  });

  it("GET /accounts/curricula without a session cookie is a 401", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/curricula`);
    expect(res.status).toBe(401);
  });

  // ─── plan generation + approval ─────────────────────────────────────────
  // The mock architect runs for every case below — VVUGC_LLM_LIVE is never set
  // and `live` defaults false, so no test ever reaches a real LLM.

  const generatePlan = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/generate-plan`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const approve = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }
    });

  const getCourse = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}`, { headers: { Cookie: cookie } });

  /** Invite a teammate at `role` through the real invite flow and return their session cookie. */
  async function inviteMemberCookie(ownerCookie: string, email: string, role: string): Promise<string> {
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const setCookie = accept.headers.get("set-cookie");
    if (!setCookie) throw new Error("no session cookie returned from invite accept");
    return setCookie.split(";")[0];
  }

  const SEEDED_COURSE = { topic: "Agentic AI", moduleCount: 20, lessonsPerModule: 10 };

  it("POST .../generate-plan with the agentic-ai seed persists a 20×10 plan and moves the course to planned", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("plan-seed@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();

    const res = await generatePlan(cookie, course.id, { seed: "agentic-ai" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ modules: 20, lessons: 200, projects: 20 });
    expect(body.qa.errors).toEqual([]);
    expect(body.course.status).toBe("planned");

    const after = await (await getCourse(cookie, course.id)).json();
    expect(after.counts).toEqual({ modules: 20, lessons: 200, projects: 20 });
    expect(after.course.status).toBe("planned");
  });

  it("POST .../generate-plan with count overrides and no seed persists the overridden shape", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("plan-overrides@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();

    const res = await generatePlan(cookie, course.id, { overrides: { moduleCount: 3, lessonsPerModule: 2 } });
    expect(res.status).toBe(200);
    expect((await res.json()).counts).toEqual({ modules: 3, lessons: 6, projects: 3 });
  });

  it("POST .../generate-plan twice regenerates in place (idempotent — counts do not double)", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("plan-idem@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();

    expect((await generatePlan(cookie, course.id, { seed: "agentic-ai" })).status).toBe(200);
    const second = await generatePlan(cookie, course.id, { seed: "agentic-ai" });
    expect(second.status).toBe(200);
    expect((await second.json()).counts).toEqual({ modules: 20, lessons: 200, projects: 20 });

    const after = await (await getCourse(cookie, course.id)).json();
    expect(after.counts).toEqual({ modules: 20, lessons: 200, projects: 20 });
  });

  it("POST .../generate-plan on another org's course is a 404", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("plan-owner-404@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();

    const otherCookie = await signUpAndGetCookie("plan-stranger-404@example.com");
    const res = await generatePlan(otherCookie, course.id, { seed: "agentic-ai" });
    expect(res.status).toBe(404);
  });

  it("POST .../generate-plan as a viewer-role member is a real 403", async () => {
    await startServer();
    const ownerCookie = await signUpAndGetCookie("plan-owner-403@example.com");
    const { course } = await (await createCourse(ownerCookie, SEEDED_COURSE)).json();

    const viewerCookie = await inviteMemberCookie(ownerCookie, "plan-viewer-403@example.com", "viewer");
    const res = await generatePlan(viewerCookie, course.id, { seed: "agentic-ai" });
    expect(res.status).toBe(403);
  });

  it("POST .../approve after a successful generate-plan is a 201 and locks the course at version 1", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("approve-ok@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();
    expect((await generatePlan(cookie, course.id, { seed: "agentic-ai" })).status).toBe(200);

    const res = await approve(cookie, course.id);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.version.version).toBe(1);

    const after = await (await getCourse(cookie, course.id)).json();
    expect(after.course.status).toBe("active");
    expect(after.course.activeVersion).toBe(1);
  });

  it("POST .../approve before any generate-plan is a 409", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("approve-early@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();

    const res = await approve(cookie, course.id);
    expect(res.status).toBe(409);
  });

  it("POST .../approve twice is a 409 the second time (status is now active, not planned)", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("approve-twice@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();
    expect((await generatePlan(cookie, course.id, { seed: "agentic-ai" })).status).toBe(200);
    expect((await approve(cookie, course.id)).status).toBe(201);

    const res = await approve(cookie, course.id);
    expect(res.status).toBe(409);
  });

  it("POST .../generate-plan after approve is a 409 (an approved version is set)", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("regen-after-approve@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();
    expect((await generatePlan(cookie, course.id, { seed: "agentic-ai" })).status).toBe(200);
    expect((await approve(cookie, course.id)).status).toBe(201);

    const res = await generatePlan(cookie, course.id, { seed: "agentic-ai" });
    expect(res.status).toBe(409);
  });

  it("POST .../approve on another org's course is a 404 (tenant isolation)", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("approve-owner-iso@example.com");
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();
    expect((await generatePlan(cookie, course.id, { seed: "agentic-ai" })).status).toBe(200);

    const otherCookie = await signUpAndGetCookie("approve-stranger-iso@example.com");
    const res = await approve(otherCookie, course.id);
    expect(res.status).toBe(404);
  });

  // ─── module / lesson reads + field-granular content patches (D3) ─────────
  // Every case builds a small real course: a 3×2 plan via the mock architect,
  // then GET .../modules to grab real module/lesson ids.

  const PLAN_3x2 = { overrides: { moduleCount: 3, lessonsPerModule: 2 } };

  async function courseWithPlan(email: string) {
    const cookie = await signUpAndGetCookie(email);
    const { course } = await (await createCourse(cookie, SEEDED_COURSE)).json();
    const gen = await generatePlan(cookie, course.id, PLAN_3x2);
    if (gen.status !== 200) throw new Error(`generate-plan failed: ${gen.status}`);
    const listed = await fetch(`${baseUrl}/accounts/curricula/${course.id}/modules`, {
      headers: { Cookie: cookie }
    });
    const { modules } = await listed.json();
    return { cookie, courseId: course.id as string, modules };
  }

  const getModule = (cookie: string, courseId: string, moduleId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}`, {
      headers: { Cookie: cookie }
    }).then((r) => r.json());

  const getLesson = (cookie: string, courseId: string, lessonId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}`, {
      headers: { Cookie: cookie }
    });

  const putLesson = (cookie: string, courseId: string, lessonId: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const putModule = (cookie: string, courseId: string, moduleId: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  it("GET .../modules returns every module with lessonCount, hasProject, ordered by order", async () => {
    await startServer();
    const { cookie, courseId } = await courseWithPlan("d3-modules@example.com");

    const res = await fetch(`${baseUrl}/accounts/curricula/${courseId}/modules`, {
      headers: { Cookie: cookie }
    });
    expect(res.status).toBe(200);
    const { modules } = await res.json();
    expect(modules).toHaveLength(3);
    expect(modules.map((m: { order: number }) => m.order)).toEqual([1, 2, 3]);
    for (const m of modules) {
      expect(m.lessonCount).toBe(2);
      expect(m.hasProject).toBe(true);
      expect(typeof m.id).toBe("string");
    }
  });

  it("GET .../modules/:moduleId returns the module, its lessons sorted by globalOrder, and its project", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-module-detail@example.com");
    const target = modules[1];

    const res = await fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${target.id}`, {
      headers: { Cookie: cookie }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.module.id).toBe(target.id);
    expect(body.lessons).toHaveLength(2);
    const orders = body.lessons.map((l: { globalOrder: number }) => l.globalOrder);
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b));
    expect(orders[0]).toBeLessThan(orders[1]);
    expect(body.project).not.toBeNull();
    expect(body.project.moduleId).toBe(target.id);
  });

  it("GET .../modules/:moduleId is 404 for an unknown id and for another org's real module", async () => {
    await startServer();
    const { cookie, courseId } = await courseWithPlan("d3-module-404@example.com");
    const other = await courseWithPlan("d3-module-404-other@example.com");

    const unknown = await fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${randomUUID()}`, {
      headers: { Cookie: cookie }
    });
    expect(unknown.status).toBe(404);

    const crossOrg = await fetch(
      `${baseUrl}/accounts/curricula/${courseId}/modules/${other.modules[0].id}`,
      { headers: { Cookie: cookie } }
    );
    expect(crossOrg.status).toBe(404);
  });

  it("GET .../lessons/:lessonId returns the lesson; 404 for an unknown id and another org's lesson", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-lesson-get@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    const ok = await getLesson(cookie, courseId, lessonId);
    expect(ok.status).toBe(200);
    expect((await ok.json()).lesson.id).toBe(lessonId);

    const unknown = await getLesson(cookie, courseId, randomUUID());
    expect(unknown.status).toBe(404);

    const other = await courseWithPlan("d3-lesson-get-other@example.com");
    const otherDetail = await getModule(other.cookie, other.courseId, other.modules[0].id);
    const crossOrg = await getLesson(cookie, courseId, otherDetail.lessons[0].id);
    expect(crossOrg.status).toBe(404);
  });

  it("PUT .../lessons/:lessonId merges fields — a later patch never clears an earlier one", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-lesson-merge@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;
    const siblingId = detail.lessons[1].id;

    expect((await putLesson(cookie, courseId, lessonId, { explanation: "E1" })).status).toBe(200);
    expect((await (await getLesson(cookie, courseId, lessonId)).json()).lesson.explanation).toBe("E1");

    expect((await putLesson(cookie, courseId, lessonId, { shortScript: "S1" })).status).toBe(200);
    const after = (await (await getLesson(cookie, courseId, lessonId)).json()).lesson;
    expect(after.explanation).toBe("E1");
    expect(after.shortScript).toBe("S1");

    const sibling = (await (await getLesson(cookie, courseId, siblingId)).json()).lesson;
    expect(sibling.explanation).toBeUndefined();
  });

  it("PUT .../lessons/:lessonId rejects a bad status and accepts a knowledgeCheck array", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-lesson-kc@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    expect((await putLesson(cookie, courseId, lessonId, { status: "not_a_status" })).status).toBe(400);

    const knowledgeCheck = [{ kind: "mcq", prompt: "Q?", options: ["a", "b"], answerIndex: 0 }];
    expect((await putLesson(cookie, courseId, lessonId, { knowledgeCheck })).status).toBe(200);
    const after = (await (await getLesson(cookie, courseId, lessonId)).json()).lesson;
    expect(after.knowledgeCheck).toHaveLength(1);
    expect(after.knowledgeCheck[0].prompt).toBe("Q?");
    expect(after.knowledgeCheck[0].answerIndex).toBe(0);
  });

  it("PUT .../lessons/:lessonId on another org's lesson is a 404 and leaves the lesson unchanged", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-lesson-iso@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;
    expect((await putLesson(cookie, courseId, lessonId, { explanation: "OWNER" })).status).toBe(200);

    const strangerCookie = await signUpAndGetCookie("d3-lesson-iso-stranger@example.com");
    const hijack = await putLesson(strangerCookie, courseId, lessonId, { explanation: "HIJACK" });
    expect(hijack.status).toBe(404);

    const still = (await (await getLesson(cookie, courseId, lessonId)).json()).lesson;
    expect(still.explanation).toBe("OWNER");
  });

  it("PUT .../modules/:moduleId patches goal + concepts and leaves other module fields intact", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-module-put@example.com");
    const target = modules[0];
    const before = await getModule(cookie, courseId, target.id);

    const res = await putModule(cookie, courseId, target.id, { goal: "new goal", concepts: ["x", "y"] });
    expect(res.status).toBe(200);
    expect((await res.json()).module.goal).toBe("new goal");

    const after = await getModule(cookie, courseId, target.id);
    expect(after.module.goal).toBe("new goal");
    expect(after.module.concepts).toEqual(["x", "y"]);
    expect(after.module.title).toBe(before.module.title);
    expect(after.module.description).toBe(before.module.description);
    expect(after.module.order).toBe(before.module.order);
  });

  it("PUT .../lessons/:lessonId content edit is still allowed after POST .../approve locks the course", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d3-postlock@example.com");
    expect((await approve(cookie, courseId)).status).toBe(201);
    const locked = await (await getCourse(cookie, courseId)).json();
    expect(locked.course.activeVersion).toBe(1);

    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    const res = await putLesson(cookie, courseId, lessonId, { explanation: "post-lock edit" });
    expect(res.status).toBe(200);
    expect((await (await getLesson(cookie, courseId, lessonId)).json()).lesson.explanation).toBe(
      "post-lock edit"
    );
  });

  it("GET .../modules without a session cookie is a 401", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/curricula/${randomUUID()}/modules`);
    expect(res.status).toBe(401);
  });

  // ─── D4a: script generation (per-lesson short + per-module long-form) ─────
  // Mock builders only — VVUGC_LLM_LIVE is never set and `live` defaults false,
  // so no case here reaches a real LLM or the network.

  const genLessonScript = (
    cookie: string,
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}/script`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const genModuleLongForm = (
    cookie: string,
    courseId: string,
    moduleId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}/long-form-script`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  it("POST .../lessons/:lessonId/script persists shortScript, sets status scripted, reports an unflagged similarity", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d4a-script-one@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    const res = await genLessonScript(cookie, courseId, lessonId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.lesson.shortScript).toBe("string");
    expect(body.lesson.shortScript.length).toBeGreaterThan(0);
    expect(body.lesson.status).toBe("scripted");
    expect(typeof body.similarity.maxPct).toBe("number");
    expect(body.similarity.flagged).toBe(false);
    expect(body.similarity.nearestLessonGlobalOrder).toBeNull();

    const after = await (await getLesson(cookie, courseId, lessonId)).json();
    expect(after.lesson.shortScript).toBe(body.lesson.shortScript);
  });

  it("POST .../lessons/:lessonId/script on two lessons: scripts differ and lesson 2's similarity is measured against lesson 1", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d4a-script-two@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const [l1, l2] = detail.lessons;

    const r1 = await genLessonScript(cookie, courseId, l1.id);
    expect(r1.status).toBe(200);
    const s1 = (await r1.json()).lesson.shortScript;

    const r2 = await genLessonScript(cookie, courseId, l2.id);
    expect(r2.status).toBe(200);
    const b2 = await r2.json();

    expect(s1).not.toBe(b2.lesson.shortScript);
    expect(typeof b2.similarity.maxPct).toBe("number");
    expect(b2.similarity.maxPct).toBeGreaterThanOrEqual(0);
    expect(b2.similarity.maxPct).toBeLessThanOrEqual(100);
    expect(b2.similarity.nearestLessonGlobalOrder).toBe(l1.globalOrder);
  });

  it("POST .../lessons/:lessonId/script on another org's lesson is a 404", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d4a-script-iso@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    const strangerCookie = await signUpAndGetCookie("d4a-script-stranger@example.com");
    const res = await genLessonScript(strangerCookie, courseId, lessonId);
    expect(res.status).toBe(404);
  });

  it("POST .../lessons/:lessonId/script as a viewer-role member is a real 403", async () => {
    await startServer();
    const { cookie: ownerCookie, courseId, modules } = await courseWithPlan("d4a-script-403@example.com");
    const detail = await getModule(ownerCookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    const viewerCookie = await inviteMemberCookie(
      ownerCookie,
      "d4a-script-viewer-403@example.com",
      "viewer"
    );
    const res = await genLessonScript(viewerCookie, courseId, lessonId);
    expect(res.status).toBe(403);
  });

  it("POST .../modules/:moduleId/long-form-script persists a §24 long-form script and sets its status scripted", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d4a-longform@example.com");
    const moduleId = modules[0].id;

    const res = await genModuleLongForm(cookie, courseId, moduleId);
    expect(res.status).toBe(200);
    expect((await res.json()).module.longFormScriptStatus).toBe("scripted");

    const after = await getModule(cookie, courseId, moduleId);
    expect(typeof after.module.longFormScript).toBe("string");
    expect(after.module.longFormScript.length).toBeGreaterThan(0);
    expect(after.module.longFormScript).toContain("INTRO");
    expect(after.module.longFormScript).toContain("NEXT MODULE");
    expect(after.module.longFormScriptStatus).toBe("scripted");
  });

  it("POST .../modules/:moduleId/long-form-script on another org's module is a 404", async () => {
    await startServer();
    const { courseId, modules } = await courseWithPlan("d4a-longform-iso@example.com");
    const moduleId = modules[0].id;

    const strangerCookie = await signUpAndGetCookie("d4a-longform-stranger@example.com");
    const res = await genModuleLongForm(strangerCookie, courseId, moduleId);
    expect(res.status).toBe(404);
  });

  // ─── D4b: produce (curriculum → script → existing VUGC dry-run → review) ──
  // VVUGC_LLM_LIVE is never set, so every produce here is a dry-run: the whole
  // VUGC pipeline runs against mock discovery/transcript/vendors, no network.

  const produce = (
    cookie: string,
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}/produce`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getAssets = (cookie: string, courseId: string, query = "") =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/assets${query}`, {
      headers: { Cookie: cookie }
    });

  /** Build a course with a 3×2 plan and give its first lesson a real shortScript. */
  async function courseWithScriptedLesson(email: string) {
    const { cookie, courseId, modules } = await courseWithPlan(email);
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id as string;
    const scripted = await genLessonScript(cookie, courseId, lessonId);
    if (scripted.status !== 200) throw new Error(`script generation failed: ${scripted.status}`);
    return { cookie, courseId, lessonId, moduleId: modules[0].id as string, modules };
  }

  it(
    "POST .../lessons/:lessonId/produce runs the existing VUGC dry-run pipeline, records a short_video asset in review, and a real review item lands in the queue",
    async () => {
      await startServer();
      const { cookie, courseId, lessonId } = await courseWithScriptedLesson("d4b-accept@example.com");

      const res = await produce(cookie, courseId, lessonId);
      expect(res.status).toBe(202);
      const { asset, run } = await res.json();

      expect(run.dryRun).toBe(true);
      expect(run.reviewItemsCreated).toBeGreaterThanOrEqual(1);
      expect(typeof run.runId).toBe("string");

      expect(asset.assetType).toBe("short_video");
      expect(asset.status).toBe("review");
      expect(asset.generationRunId).toBe(run.runId);
      expect(asset.lessonId).toBe(lessonId);
      expect(asset.courseId).toBe(courseId);
      expect(typeof asset.reviewItemId).toBe("string");
      expect(asset.reviewItemId.length).toBeGreaterThan(0);

      // GET .../assets surfaces the produced asset.
      const listed = await getAssets(cookie, courseId);
      expect(listed.status).toBe(200);
      const { assets } = await listed.json();
      expect(assets.map((a: { id: string }) => a.id)).toContain(asset.id);

      // The lesson moved to "review".
      const lessonAfter = await (await getLesson(cookie, courseId, lessonId)).json();
      expect(lessonAfter.lesson.status).toBe("review");

      // A genuine review-queue row exists for this run (the test controls VVUGC_DB_PATH,
      // so the queue module reads the same store the pipeline just wrote to).
      const { listReviewItems } = await import("@vvugc/review-queue");
      const items = await listReviewItems();
      const forRun = items.filter((i) => i.runId === run.runId);
      expect(forRun.length).toBeGreaterThanOrEqual(1);
      expect(forRun[0].id).toBe(asset.reviewItemId);
      expect(forRun[0].dryRun).toBe(true);
    },
    30_000
  );

  it("POST .../lessons/:lessonId/produce on a lesson with no script is a 409", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d4b-noscript@example.com");
    const detail = await getModule(cookie, courseId, modules[0].id);
    const lessonId = detail.lessons[0].id;

    const res = await produce(cookie, courseId, lessonId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no script/i);
  });

  it("POST .../lessons/:lessonId/produce on another org's lesson is a 404 and runs nothing", async () => {
    await startServer();
    const { courseId, lessonId } = await courseWithScriptedLesson("d4b-iso-owner@example.com");

    const strangerCookie = await signUpAndGetCookie("d4b-iso-stranger@example.com");
    const res = await produce(strangerCookie, courseId, lessonId);
    expect(res.status).toBe(404);

    const { listReviewItems } = await import("@vvugc/review-queue");
    expect(await listReviewItems()).toHaveLength(0);
  });

  it("POST .../lessons/:lessonId/produce as a viewer-role member is a real 403", async () => {
    await startServer();
    const { cookie: ownerCookie, courseId, lessonId } = await courseWithScriptedLesson(
      "d4b-viewer-403@example.com"
    );

    const viewerCookie = await inviteMemberCookie(
      ownerCookie,
      "d4b-viewer-403-member@example.com",
      "viewer"
    );
    const res = await produce(viewerCookie, courseId, lessonId);
    expect(res.status).toBe(403);
  });

  it(
    "POST .../lessons/:lessonId/produce as an editor-role member (has curriculum.produce) is a 202",
    async () => {
      await startServer();
      const { cookie: ownerCookie, courseId, lessonId } = await courseWithScriptedLesson(
        "d4b-editor-202@example.com"
      );

      const editorCookie = await inviteMemberCookie(
        ownerCookie,
        "d4b-editor-202-member@example.com",
        "editor"
      );
      const res = await produce(editorCookie, courseId, lessonId);
      expect(res.status).toBe(202);
      expect((await res.json()).run.dryRun).toBe(true);
    },
    30_000
  );

  it("GET .../assets?lessonId=<other> is an empty list when nothing was produced for that lesson", async () => {
    await startServer();
    const { cookie, courseId, modules } = await courseWithPlan("d4b-assets-empty@example.com");
    const otherModuleDetail = await getModule(cookie, courseId, modules[1].id);
    const otherLessonId = otherModuleDetail.lessons[0].id;

    const res = await getAssets(cookie, courseId, `?lessonId=${otherLessonId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).assets).toEqual([]);
  });
});

// ─── D5: consolidated, exhaustive tenant-isolation sweep (mission §35) ──────
// One server, one DB file, two real tenants built once. Every curriculum route,
// hit as Org B holding Org A's ids, must 404 (never 200, never 500) and must not
// mutate Org A; and a client-submitted org id must never override the caller's
// real org. Overlaps some of the scattered checks above by design — this is the
// single place that proves the whole surface at once.
describe("curriculum tenant isolation — §35 (comprehensive)", () => {
  const ISO_SEEDED = { topic: "Agentic AI", moduleCount: 20, lessonsPerModule: 10 };

  let isoDir: string;
  let cookieA: string;
  let cookieB: string;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let courseBId: string;
  let moduleA1Id: string;
  let lessonA1Id: string;
  let runIdA: string;
  let reviewItemCountBefore: number;
  let reviewItemCountForRunA: number;
  let snapshotCourseA: unknown;
  let snapshotModuleA1: unknown;
  let snapshotLessonA1: unknown;
  let snapshotAssetsA: unknown;

  const asA = (method: string, path: string, body?: Record<string, unknown>) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Cookie: cookieA, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  const asB = (method: string, path: string, body?: Record<string, unknown>) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Cookie: cookieB, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  beforeAll(async () => {
    isoDir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-iso-"));
    process.env.VVUGC_DB_PATH = join(isoDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(isoDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
    await startServer();

    // ─── Org A — a fully built tenant: course → 20×10 plan → module/lesson ids
    //     → lesson short script → one dry-run produce (asset + review item).
    cookieA = await signUpAndGetCookie("iso-owner-a@example.com");
    const courseACreate = await createCourse(cookieA, ISO_SEEDED);
    if (courseACreate.status !== 201) throw new Error(`setup: Org A course create ${courseACreate.status}`);
    const courseA = (await courseACreate.json()).course;
    courseAId = courseA.id;
    orgAId = courseA.orgId;
    if (!orgAId) throw new Error("setup: Org A course row carried no orgId");

    const planA = await asA("POST", `/accounts/curricula/${courseAId}/generate-plan`, { seed: "agentic-ai" });
    if (planA.status !== 200) throw new Error(`setup: Org A generate-plan ${planA.status}`);
    if ((await planA.json()).counts.lessons !== 200) throw new Error("setup: Org A plan is not 20×10");

    const modulesA = (await (await asA("GET", `/accounts/curricula/${courseAId}/modules`)).json()).modules;
    moduleA1Id = modulesA[0].id;
    const moduleA1Detail = await (
      await asA("GET", `/accounts/curricula/${courseAId}/modules/${moduleA1Id}`)
    ).json();
    lessonA1Id = moduleA1Detail.lessons[0].id;

    const scriptA = await asA("POST", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}/script`, {});
    if (scriptA.status !== 200) throw new Error(`setup: Org A lesson script ${scriptA.status}`);

    const produceA = await asA("POST", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}/produce`, {});
    if (produceA.status !== 202) throw new Error(`setup: Org A produce ${produceA.status}`);
    runIdA = (await produceA.json()).run.runId;
    if (!runIdA) throw new Error("setup: Org A produce returned no runId");

    // ─── Org B — a real, separate tenant with its own course and nothing else.
    cookieB = await signUpAndGetCookie("iso-owner-b@example.com");
    const courseBCreate = await createCourse(cookieB);
    if (courseBCreate.status !== 201) throw new Error(`setup: Org B course create ${courseBCreate.status}`);
    const courseB = (await courseBCreate.json()).course;
    courseBId = courseB.id;
    orgBId = courseB.orgId;
    if (!orgBId || orgBId === orgAId) throw new Error("setup: Org B did not get its own distinct orgId");

    // ─── Snapshots of every piece of Org A state a mutating probe must not touch.
    snapshotCourseA = await (await asA("GET", `/accounts/curricula/${courseAId}`)).json();
    snapshotModuleA1 = await (
      await asA("GET", `/accounts/curricula/${courseAId}/modules/${moduleA1Id}`)
    ).json();
    snapshotLessonA1 = await (
      await asA("GET", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}`)
    ).json();
    snapshotAssetsA = await (await asA("GET", `/accounts/curricula/${courseAId}/assets`)).json();

    const { listReviewItems } = await import("@vvugc/review-queue");
    const itemsBefore = await listReviewItems();
    reviewItemCountBefore = itemsBefore.length;
    reviewItemCountForRunA = itemsBefore.filter((i) => i.runId === runIdA).length;
    if (reviewItemCountForRunA < 1) throw new Error("setup: Org A produce enqueued no review item");
  }, 60_000);

  afterAll(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (isoDir && existsSync(isoDir)) rmSync(isoDir, { recursive: true, force: true });
    server?.close();
  });

  // ─── Org B holding Org A's ids: every route 404s, every mutator is inert ───

  it("1. GET /accounts/curricula/:courseA as Org B is a 404", async () => {
    expect((await asB("GET", `/accounts/curricula/${courseAId}`)).status).toBe(404);
  });

  it("2. PUT /accounts/curricula/:courseA as Org B is a 404 and Org A's course keeps its title", async () => {
    const res = await asB("PUT", `/accounts/curricula/${courseAId}`, { title: "hijacked" });
    expect(res.status).toBe(404);
    const after = await asA("GET", `/accounts/curricula/${courseAId}`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(snapshotCourseA);
  });

  it("3. DELETE /accounts/curricula/:courseA as Org B is a 404 and the course still exists for Org A", async () => {
    const res = await asB("DELETE", `/accounts/curricula/${courseAId}`);
    expect(res.status).toBe(404);
    expect((await res.json()).deleted).toBe(false);
    expect((await asA("GET", `/accounts/curricula/${courseAId}`)).status).toBe(200);
  });

  it("4. POST /accounts/curricula/:courseA/generate-plan as Org B is a 404", async () => {
    const res = await asB("POST", `/accounts/curricula/${courseAId}/generate-plan`, { seed: "agentic-ai" });
    expect(res.status).toBe(404);
  });

  it("5. POST /accounts/curricula/:courseA/approve as Org B is a 404", async () => {
    expect((await asB("POST", `/accounts/curricula/${courseAId}/approve`)).status).toBe(404);
  });

  it("6. GET /accounts/curricula/:courseA/modules as Org B is a 404 (course not owned)", async () => {
    expect((await asB("GET", `/accounts/curricula/${courseAId}/modules`)).status).toBe(404);
  });

  it("7. GET /accounts/curricula/:courseA/modules/:moduleA1 as Org B is a 404", async () => {
    expect((await asB("GET", `/accounts/curricula/${courseAId}/modules/${moduleA1Id}`)).status).toBe(404);
  });

  it("8. GET /accounts/curricula/:courseA/lessons/:lessonA1 as Org B is a 404", async () => {
    expect((await asB("GET", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}`)).status).toBe(404);
  });

  it("9. PUT /accounts/curricula/:courseA/modules/:moduleA1 as Org B is a 404 and the module is unchanged", async () => {
    const res = await asB("PUT", `/accounts/curricula/${courseAId}/modules/${moduleA1Id}`, { goal: "hijacked" });
    expect(res.status).toBe(404);
    const after = await asA("GET", `/accounts/curricula/${courseAId}/modules/${moduleA1Id}`);
    expect(await after.json()).toEqual(snapshotModuleA1);
  });

  it("10. PUT /accounts/curricula/:courseA/lessons/:lessonA1 as Org B is a 404 and the lesson is unchanged", async () => {
    const res = await asB("PUT", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}`, {
      explanation: "hijacked"
    });
    expect(res.status).toBe(404);
    const after = await asA("GET", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}`);
    expect(await after.json()).toEqual(snapshotLessonA1);
  });

  it("11. POST /accounts/curricula/:courseA/lessons/:lessonA1/script as Org B is a 404", async () => {
    const res = await asB("POST", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}/script`, {});
    expect(res.status).toBe(404);
  });

  it("12. POST /accounts/curricula/:courseA/modules/:moduleA1/long-form-script as Org B is a 404", async () => {
    const res = await asB("POST", `/accounts/curricula/${courseAId}/modules/${moduleA1Id}/long-form-script`, {});
    expect(res.status).toBe(404);
  });

  it(
    "13. POST /accounts/curricula/:courseA/lessons/:lessonA1/produce as Org B is a 404 and enqueues nothing for Org A",
    async () => {
      const res = await asB("POST", `/accounts/curricula/${courseAId}/lessons/${lessonA1Id}/produce`, {});
      expect(res.status).toBe(404);

      const { listReviewItems } = await import("@vvugc/review-queue");
      const itemsAfter = await listReviewItems();
      // Not one new review item, and the count tied to Org A's real produce run
      // is exactly what it was before Org B's probe.
      expect(itemsAfter.length).toBe(reviewItemCountBefore);
      expect(itemsAfter.filter((i) => i.runId === runIdA).length).toBe(reviewItemCountForRunA);
      // Org A's is the only produce run this suite ever made — so every queued
      // item still belongs to it; nothing references lessonA1 via a second run.
      expect(itemsAfter.every((i) => i.runId === runIdA)).toBe(true);
    },
    30_000
  );

  it("14. GET /accounts/curricula/:courseA/assets as Org B is a 404 and Org A's assets are unchanged", async () => {
    const res = await asB("GET", `/accounts/curricula/${courseAId}/assets`);
    expect(res.status).toBe(404);
    const after = await asA("GET", `/accounts/curricula/${courseAId}/assets`);
    expect(await after.json()).toEqual(snapshotAssetsA);
  });

  it("15. GET /accounts/curricula/:courseA/assets?lessonId=<lessonA1> as Org B is a 404", async () => {
    const res = await asB("GET", `/accounts/curricula/${courseAId}/assets?lessonId=${lessonA1Id}`);
    expect(res.status).toBe(404);
  });

  // ─── cross-visibility: each org's list is exactly its own ─────────────────

  it("GET /accounts/curricula returns only the calling org's own courses", async () => {
    const listB = await (await asB("GET", `/accounts/curricula`)).json();
    const bIds = listB.courses.map((c: { id: string }) => c.id);
    expect(bIds).toContain(courseBId);
    expect(bIds).not.toContain(courseAId);

    const listA = await (await asA("GET", `/accounts/curricula`)).json();
    const aIds = listA.courses.map((c: { id: string }) => c.id);
    expect(aIds).toContain(courseAId);
    expect(aIds).not.toContain(courseBId);
  });

  // ─── client-submitted org ids are never trusted ──────────────────────────

  it("POST /accounts/curricula ignores a client-submitted orgId and stamps the caller's real org", async () => {
    const res = await createCourse(cookieA, {
      title: "Org A injection probe",
      orgId: orgBId,
      org_id: orgBId,
      ownerOrgId: orgBId
    });
    expect(res.status).toBe(201);
    const created = (await res.json()).course;
    expect(created.orgId).toBe(orgAId);
    expect(created.orgId).not.toBe(orgBId);

    // Org B still cannot see it — not by id, not in its list.
    expect((await asB("GET", `/accounts/curricula/${created.id}`)).status).toBe(404);
    const listB = await (await asB("GET", `/accounts/curricula`)).json();
    expect(listB.courses.map((c: { id: string }) => c.id)).not.toContain(created.id);
  });

  it("GET /accounts/curricula ignores a client-submitted orgId query param", async () => {
    const res = await asA("GET", `/accounts/curricula?orgId=${orgBId}`);
    expect(res.status).toBe(200);
    const ids = (await res.json()).courses.map((c: { id: string }) => c.id);
    expect(ids).toContain(courseAId);
    expect(ids).not.toContain(courseBId);
  });
});

// ─── F1: curriculum knowledge-check generation (Learn Mode §19) ────────────
// Mock builder only — VVUGC_LLM_LIVE is never set and `live` defaults false, so
// no case here reaches a real LLM or the network.
describe("curriculum knowledge-check (F1)", () => {
  const KC_SEEDED = { topic: "Agentic AI", moduleCount: 20, lessonsPerModule: 10 };
  const KC_PLAN_3x2 = { overrides: { moduleCount: 3, lessonsPerModule: 2 } };

  let kcDir: string;

  beforeEach(() => {
    kcDir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-kc-"));
    process.env.VVUGC_DB_PATH = join(kcDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(kcDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (kcDir && existsSync(kcDir)) rmSync(kcDir, { recursive: true, force: true });
    server?.close();
  });

  const generatePlan = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/generate-plan`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getLesson = (cookie: string, courseId: string, lessonId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}`, {
      headers: { Cookie: cookie }
    });

  const genKnowledgeCheck = (
    cookie: string,
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}/knowledge-check`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  /** Invite a teammate at `role` through the real invite flow and return their session cookie. */
  async function inviteMemberCookie(ownerCookie: string, email: string, role: string): Promise<string> {
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const setCookie = accept.headers.get("set-cookie");
    if (!setCookie) throw new Error("no session cookie returned from invite accept");
    return setCookie.split(";")[0];
  }

  /** Build a course with a 3×2 mock plan and return the first lesson's id. */
  async function courseWithLesson(email: string) {
    const cookie = await signUpAndGetCookie(email);
    const { course } = await (await createCourse(cookie, KC_SEEDED)).json();
    const gen = await generatePlan(cookie, course.id, KC_PLAN_3x2);
    if (gen.status !== 200) throw new Error(`generate-plan failed: ${gen.status}`);
    const { modules } = await (
      await fetch(`${baseUrl}/accounts/curricula/${course.id}/modules`, { headers: { Cookie: cookie } })
    ).json();
    const detail = await (
      await fetch(`${baseUrl}/accounts/curricula/${course.id}/modules/${modules[0].id}`, {
        headers: { Cookie: cookie }
      })
    ).json();
    return { cookie, courseId: course.id as string, lessonId: detail.lessons[0].id as string };
  }

  type KcQuestion = {
    kind: string;
    prompt: string;
    options: string[];
    answerIndex: number | null;
    rationale?: string;
  };

  function expectValidQuestion(q: KcQuestion) {
    expect(["mcq", "concept", "coding"]).toContain(q.kind);
    expect(typeof q.prompt).toBe("string");
    expect(q.prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(q.options)).toBe(true);
    if (q.kind === "mcq") {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(Number.isInteger(q.answerIndex)).toBe(true);
      expect(q.answerIndex as number).toBeGreaterThanOrEqual(0);
      expect(q.answerIndex as number).toBeLessThan(q.options.length);
    } else {
      expect(q.options).toEqual([]);
      expect(q.answerIndex).toBeNull();
    }
  }

  it("generates the default 3 questions, persists them, and a follow-up GET returns the same array", async () => {
    await startServer();
    const { cookie, courseId, lessonId } = await courseWithLesson("f1-default@example.com");

    const res = await genKnowledgeCheck(cookie, courseId, lessonId);
    expect(res.status).toBe(200);
    const { lesson } = await res.json();
    expect(lesson.knowledgeCheck).toHaveLength(3);
    for (const q of lesson.knowledgeCheck as KcQuestion[]) expectValidQuestion(q);

    const after = await (await getLesson(cookie, courseId, lessonId)).json();
    expect(after.lesson.knowledgeCheck).toEqual(lesson.knowledgeCheck);
  });

  it("honours count: 5 — persists exactly 5 questions", async () => {
    await startServer();
    const { cookie, courseId, lessonId } = await courseWithLesson("f1-count5@example.com");

    const res = await genKnowledgeCheck(cookie, courseId, lessonId, { count: 5 });
    expect(res.status).toBe(200);
    const { lesson } = await res.json();
    expect(lesson.knowledgeCheck).toHaveLength(5);
    for (const q of lesson.knowledgeCheck as KcQuestion[]) expectValidQuestion(q);
  });

  it("is deterministic — two calls on the same lesson persist an identical knowledgeCheck", async () => {
    await startServer();
    const { cookie, courseId, lessonId } = await courseWithLesson("f1-deterministic@example.com");

    const first = (await (await genKnowledgeCheck(cookie, courseId, lessonId)).json()).lesson
      .knowledgeCheck;
    const second = (await (await genKnowledgeCheck(cookie, courseId, lessonId)).json()).lesson
      .knowledgeCheck;
    expect(second).toEqual(first);
  });

  it("does not alter the lesson's status", async () => {
    await startServer();
    const { cookie, courseId, lessonId } = await courseWithLesson("f1-status@example.com");
    const before = (await (await getLesson(cookie, courseId, lessonId)).json()).lesson.status;
    expect(before).toBe("draft");

    expect((await genKnowledgeCheck(cookie, courseId, lessonId)).status).toBe(200);

    const after = (await (await getLesson(cookie, courseId, lessonId)).json()).lesson.status;
    expect(after).toBe(before);
  });

  it("on another org's lesson is a 404 (tenant isolation)", async () => {
    await startServer();
    const { courseId, lessonId } = await courseWithLesson("f1-iso-owner@example.com");

    const strangerCookie = await signUpAndGetCookie("f1-iso-stranger@example.com");
    const res = await genKnowledgeCheck(strangerCookie, courseId, lessonId);
    expect(res.status).toBe(404);
  });

  it("as a viewer-role member is a real 403", async () => {
    await startServer();
    const { cookie: ownerCookie, courseId, lessonId } = await courseWithLesson("f1-viewer-403@example.com");

    const viewerCookie = await inviteMemberCookie(ownerCookie, "f1-viewer-403-member@example.com", "viewer");
    const res = await genKnowledgeCheck(viewerCookie, courseId, lessonId);
    expect(res.status).toBe(403);
  });

  it("on an unknown lesson id is a 404", async () => {
    await startServer();
    const { cookie, courseId } = await courseWithLesson("f1-unknown-lesson@example.com");

    const res = await genKnowledgeCheck(cookie, courseId, randomUUID());
    expect(res.status).toBe(404);
  });
});

// ─── F2: curriculum Learn Mode progress (§20 / §48 / §49 / §50) ────────────
// Mock architect only — VVUGC_LLM_LIVE is never set — so every generate-plan
// here is the deterministic 20×10 (or overridden) mock plan.
describe("curriculum learn-mode progress (F2)", () => {
  const F2_SEEDED = { topic: "Agentic AI", moduleCount: 20, lessonsPerModule: 10 };

  let f2Dir: string;

  beforeEach(() => {
    f2Dir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-f2-"));
    process.env.VVUGC_DB_PATH = join(f2Dir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(f2Dir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (f2Dir && existsSync(f2Dir)) rmSync(f2Dir, { recursive: true, force: true });
    server?.close();
  });

  const generatePlan = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/generate-plan`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const approve = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }
    });

  const getModules = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules`, { headers: { Cookie: cookie } }).then((r) => r.json());

  const getModule = (cookie: string, courseId: string, moduleId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}`, { headers: { Cookie: cookie } }).then((r) => r.json());

  const genKnowledgeCheck = (
    cookie: string,
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}/knowledge-check`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const complete = (
    cookie: string,
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}/complete`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getProgress = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/progress`, { headers: { Cookie: cookie } });

  const getToday = (cookie: string) =>
    fetch(`${baseUrl}/accounts/curricula/today`, { headers: { Cookie: cookie } });

  /** Invite a teammate at `role` through the real invite flow and return their session cookie. */
  async function inviteMemberCookie(ownerCookie: string, email: string, role: string): Promise<string> {
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const setCookie = accept.headers.get("set-cookie");
    if (!setCookie) throw new Error("no session cookie returned from invite accept");
    return setCookie.split(";")[0];
  }

  type ModuleRow = { id: string; order: number };
  type LessonRow = { id: string; globalOrder: number; moduleId: string; title: string };

  /** Course + full 20×10 seeded mock plan; returns module 1 and its lessons (globalOrder-sorted). */
  async function seededCourse(email: string) {
    const cookie = await signUpAndGetCookie(email);
    const { course } = await (await createCourse(cookie, F2_SEEDED)).json();
    const gen = await generatePlan(cookie, course.id, { seed: "agentic-ai" });
    if (gen.status !== 200) throw new Error(`generate-plan failed: ${gen.status}`);
    const { modules } = await getModules(cookie, course.id);
    const detail = await getModule(cookie, course.id, (modules as ModuleRow[])[0].id);
    return {
      cookie,
      courseId: course.id as string,
      module1: (modules as ModuleRow[])[0],
      lessons: detail.lessons as LessonRow[]
    };
  }

  it(
    "POST .../complete marks the caller's lesson done and GET .../progress reflects it",
    async () => {
      await startServer();
      const { cookie, courseId, module1, lessons } = await seededCourse("f2-complete@example.com");
      const [first, second] = lessons;

      const res = await complete(cookie, courseId, first.id);
      expect(res.status).toBe(200);
      const { completion } = await res.json();
      expect(completion.lessonId).toBe(first.id);
      expect(completion.accountId).toBeTruthy();
      expect(typeof completion.completedAt).toBe("string");

      const progRes = await getProgress(cookie, courseId);
      expect(progRes.status).toBe(200);
      const body = await progRes.json();
      expect(body.learning.lessonsTotal).toBe(200);
      expect(body.learning.lessonsCompleted).toBe(1);
      expect(body.learning.pct).toBe(1); // Math.round(100 * 1 / 200)
      expect(body.learning.nextLesson.id).toBe(second.id);
      expect(body.learning.modules).toHaveLength(20);
      const m1 = body.learning.modules.find((m: { moduleId: string }) => m.moduleId === module1.id);
      expect(m1.lessonsTotal).toBe(10);
      expect(m1.lessonsCompleted).toBe(1);
      expect(m1.pct).toBe(10);
    },
    30_000
  );

  it(
    "a repeat POST .../complete for the same lesson updates in place — no duplicate, score refreshed",
    async () => {
      await startServer();
      const { cookie, courseId, lessons } = await seededCourse("f2-idempotent@example.com");
      const [l1, l2] = lessons;

      expect((await complete(cookie, courseId, l1.id)).status).toBe(200);
      expect((await complete(cookie, courseId, l2.id)).status).toBe(200);
      let body = await (await getProgress(cookie, courseId)).json();
      expect(body.learning.lessonsCompleted).toBe(2);

      const again = await complete(cookie, courseId, l1.id, { knowledgeCheckScore: 90 });
      expect(again.status).toBe(200);
      expect((await again.json()).completion.knowledgeCheckScore).toBe(90);

      body = await (await getProgress(cookie, courseId)).json();
      expect(body.learning.lessonsCompleted).toBe(2); // still 2 — the row was replaced, not added
    },
    30_000
  );

  it(
    "POST .../complete with answers scores the lesson's knowledge-check; an explicit score overrides it",
    async () => {
      await startServer();
      const { cookie, courseId, lessons } = await seededCourse("f2-answers@example.com");
      const target = lessons[0];

      const kc = await genKnowledgeCheck(cookie, courseId, target.id);
      expect(kc.status).toBe(200);
      const questions = (await kc.json()).lesson.knowledgeCheck as {
        kind: string;
        answerIndex: number | null;
      }[];
      expect(questions.length).toBeGreaterThan(0);

      // Answer every MCQ with its own key (0 elsewhere) → a perfect computed score.
      const answers = questions.map((q) =>
        q.kind === "mcq" && q.answerIndex !== null ? q.answerIndex : 0
      );
      const scored = await complete(cookie, courseId, target.id, { answers });
      expect(scored.status).toBe(200);
      const computed = (await scored.json()).completion.knowledgeCheckScore;
      expect(typeof computed).toBe("number");
      expect(computed).toBeGreaterThanOrEqual(0);
      expect(computed).toBeLessThanOrEqual(100);
      expect(computed).toBe(100);

      const overridden = await complete(cookie, courseId, target.id, {
        answers,
        knowledgeCheckScore: 42
      });
      expect(overridden.status).toBe(200);
      expect((await overridden.json()).completion.knowledgeCheckScore).toBe(42);
    },
    30_000
  );

  it(
    "GET .../today: a draft course is hidden, an active course shows its next lesson, a finished course shows null",
    async () => {
      await startServer();
      const cookie = await signUpAndGetCookie("f2-today@example.com");

      // A full seeded course, left at "planned" (generate-plan ran, approve did not).
      const { course } = await (await createCourse(cookie, F2_SEEDED)).json();
      expect((await generatePlan(cookie, course.id, { seed: "agentic-ai" })).status).toBe(200);
      let today = await (await getToday(cookie)).json();
      expect(today.items.map((i: { courseId: string }) => i.courseId)).not.toContain(course.id);

      // Approve → status "active" → it appears, with the course's first lesson as nextLesson.
      expect((await approve(cookie, course.id)).status).toBe(201);
      today = await (await getToday(cookie)).json();
      const row = today.items.find((i: { courseId: string }) => i.courseId === course.id);
      expect(row).toBeDefined();
      expect(row.lessonsTotal).toBe(200);
      expect(row.lessonsCompleted).toBe(0);
      expect(row.pct).toBe(0);
      const { modules } = await getModules(cookie, course.id);
      const m1Detail = await getModule(cookie, course.id, (modules as ModuleRow[])[0].id);
      expect(row.nextLesson.id).toBe((m1Detail.lessons as LessonRow[])[0].id);

      // A tiny 1×1 course, fully completed → still listed, but nextLesson null / pct 100.
      const { course: tiny } = await (
        await createCourse(cookie, { ...F2_SEEDED, title: "Tiny F2", moduleCount: 1, lessonsPerModule: 1 })
      ).json();
      expect(
        (await generatePlan(cookie, tiny.id, { overrides: { moduleCount: 1, lessonsPerModule: 1 } })).status
      ).toBe(200);
      expect((await approve(cookie, tiny.id)).status).toBe(201);
      const tinyModules = (await getModules(cookie, tiny.id)).modules as ModuleRow[];
      const tinyDetail = await getModule(cookie, tiny.id, tinyModules[0].id);
      const onlyLesson = (tinyDetail.lessons as LessonRow[])[0];
      expect((await complete(cookie, tiny.id, onlyLesson.id)).status).toBe(200);

      today = await (await getToday(cookie)).json();
      const tinyRow = today.items.find((i: { courseId: string }) => i.courseId === tiny.id);
      expect(tinyRow).toBeDefined();
      expect(tinyRow.nextLesson).toBeNull();
      expect(tinyRow.pct).toBe(100);
      expect(tinyRow.lessonsCompleted).toBe(1);
    },
    45_000
  );

  it(
    "tenant isolation: Org B cannot complete or read progress on Org A's course, and counts never cross",
    async () => {
      await startServer();
      const a = await seededCourse("f2-iso-a@example.com");

      const cookieB = await signUpAndGetCookie("f2-iso-b@example.com");
      const { course: courseB } = await (await createCourse(cookieB, F2_SEEDED)).json();
      expect((await generatePlan(cookieB, courseB.id, { seed: "agentic-ai" })).status).toBe(200);
      const bModules = (await getModules(cookieB, courseB.id)).modules as ModuleRow[];
      const bDetail = await getModule(cookieB, courseB.id, bModules[0].id);
      const bLesson = (bDetail.lessons as LessonRow[])[0];

      // Org B holding Org A's ids: both routes 404.
      expect((await complete(cookieB, a.courseId, a.lessons[0].id)).status).toBe(404);
      expect((await getProgress(cookieB, a.courseId)).status).toBe(404);

      // Each org completes a lesson of its OWN course.
      expect((await complete(a.cookie, a.courseId, a.lessons[0].id)).status).toBe(200);
      expect((await complete(cookieB, courseB.id, bLesson.id)).status).toBe(200);

      // Each sees exactly its own single completion — never the other org's.
      expect((await (await getProgress(a.cookie, a.courseId)).json()).learning.lessonsCompleted).toBe(1);
      expect((await (await getProgress(cookieB, courseB.id)).json()).learning.lessonsCompleted).toBe(1);
    },
    45_000
  );

  it(
    "two users in the same org each see only their own progress (per-user, not per-org)",
    async () => {
      await startServer();
      const { cookie: ownerCookie, courseId, lessons } = await seededCourse("f2-multiuser@example.com");
      const editorCookie = await inviteMemberCookie(
        ownerCookie,
        "f2-multiuser-editor@example.com",
        "editor"
      );
      const [l1, l2] = lessons;

      expect((await complete(ownerCookie, courseId, l1.id)).status).toBe(200);
      expect((await complete(editorCookie, courseId, l2.id)).status).toBe(200);

      const ownerProg = await (await getProgress(ownerCookie, courseId)).json();
      const editorProg = await (await getProgress(editorCookie, courseId)).json();
      expect(ownerProg.learning.lessonsCompleted).toBe(1);
      expect(editorProg.learning.lessonsCompleted).toBe(1);
      // The owner finished lesson 1 → their next is lesson 2; the editor finished
      // lesson 2 → their next is still lesson 1 (first uncompleted by globalOrder).
      expect(ownerProg.learning.nextLesson.id).toBe(l2.id);
      expect(editorProg.learning.nextLesson.id).toBe(l1.id);
    },
    30_000
  );

  it(
    "POST .../complete on an unknown lesson id, and on an unknown course id, are both 404",
    async () => {
      await startServer();
      const { cookie, courseId } = await seededCourse("f2-unknown@example.com");

      expect((await complete(cookie, courseId, randomUUID())).status).toBe(404);
      expect((await complete(cookie, randomUUID(), randomUUID())).status).toBe(404);
    },
    30_000
  );
});

// ─── J1: curriculum cost-estimate (§J "cost preview") ──────────────────────
// PURE ARITHMETIC — no LLM, no runCycle, no store writes. Every case builds a
// real seeded course via the deterministic mock architect (VVUGC_LLM_LIVE is
// never set), then asks for a list-price preview and asserts the numbers,
// the spend-cap view, determinism, tenant isolation, and that the pipeline
// was never touched.
describe("curriculum cost-estimate (J1)", () => {
  const J1_SEEDED = { topic: "Agentic AI", moduleCount: 20, lessonsPerModule: 10 };

  let j1Dir: string;

  beforeEach(() => {
    j1Dir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-j1-"));
    process.env.VVUGC_DB_PATH = join(j1Dir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(j1Dir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (j1Dir && existsSync(j1Dir)) rmSync(j1Dir, { recursive: true, force: true });
    server?.close();
  });

  const generatePlan = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/generate-plan`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getModules = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules`, { headers: { Cookie: cookie } }).then(
      (r) => r.json()
    );

  const getModule = (cookie: string, courseId: string, moduleId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}`, {
      headers: { Cookie: cookie }
    }).then((r) => r.json());

  const costEstimate = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/cost-estimate`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  /** Invite a teammate at `role` through the real invite flow and return their session cookie. */
  async function inviteMemberCookie(ownerCookie: string, email: string, role: string): Promise<string> {
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const setCookie = accept.headers.get("set-cookie");
    if (!setCookie) throw new Error("no session cookie returned from invite accept");
    return setCookie.split(";")[0];
  }

  type ModuleRow = { id: string; order: number };
  type LessonRow = { id: string; globalOrder: number; moduleId: string };

  /** Course + full 20×10 seeded mock plan; returns module 1 and its lessons. */
  async function seededCourse(email: string, overrides: Record<string, unknown> = {}) {
    const cookie = await signUpAndGetCookie(email);
    const { course } = await (await createCourse(cookie, { ...J1_SEEDED, ...overrides })).json();
    const gen = await generatePlan(cookie, course.id, { seed: "agentic-ai" });
    if (gen.status !== 200) throw new Error(`generate-plan failed: ${gen.status}`);
    const { modules } = await getModules(cookie, course.id);
    const detail = await getModule(cookie, course.id, (modules as ModuleRow[])[0].id);
    return {
      cookie,
      courseId: course.id as string,
      modules: modules as ModuleRow[],
      lessons: detail.lessons as LessonRow[]
    };
  }

  it(
    "course scope: totals a 20×10 plan, and totalUsd ≈ perLessonUsd×200 + long-form line",
    async () => {
      await startServer();
      const { cookie, courseId } = await seededCourse("j1-course@example.com");

      const res = await costEstimate(cookie, courseId, { scope: "course" });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.scope).toBe("course");
      expect(body.currency).toBe("USD");
      expect(body.counts).toEqual({ lessons: 200, modules: 20 });
      expect(body.totalUsd).toBeGreaterThan(0);
      expect(body.totalUsd).toBeCloseTo(
        body.perLessonUsd * 200 + body.lineItems.longFormScriptUsd,
        2
      );
      expect(typeof body.disclaimer).toBe("string");
      expect(body.disclaimer.length).toBeGreaterThan(0);
      expect(Array.isArray(body.assumptions)).toBe(true);
      expect(body.assumptions.length).toBeGreaterThan(0);
    },
    30_000
  );

  it(
    "module scope: counts one module / its 10 lessons and totals below the whole-course estimate",
    async () => {
      await startServer();
      const { cookie, courseId, modules } = await seededCourse("j1-module@example.com");

      const courseTotal = (await (await costEstimate(cookie, courseId, { scope: "course" })).json())
        .totalUsd;

      const res = await costEstimate(cookie, courseId, {
        scope: "module",
        moduleId: modules[0].id
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.counts).toEqual({ lessons: 10, modules: 1 });
      expect(body.totalUsd).toBeGreaterThan(0);
      expect(body.totalUsd).toBeLessThan(courseTotal);
    },
    30_000
  );

  it(
    "lesson scope: counts one lesson / zero modules and carries no long-form line",
    async () => {
      await startServer();
      const { cookie, courseId, lessons } = await seededCourse("j1-lesson@example.com");

      const res = await costEstimate(cookie, courseId, {
        scope: "lesson",
        lessonId: lessons[0].id
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.counts).toEqual({ lessons: 1, modules: 0 });
      expect(body.lineItems.longFormScriptUsd).toBe(0);
      expect(body.totalUsd).toBeGreaterThan(0);
    },
    30_000
  );

  it(
    "scope 'module' with no moduleId, and scope 'lesson' with no lessonId, are both 400",
    async () => {
      await startServer();
      const { cookie, courseId } = await seededCourse("j1-badscope@example.com");

      expect((await costEstimate(cookie, courseId, { scope: "module" })).status).toBe(400);
      expect((await costEstimate(cookie, courseId, { scope: "lesson" })).status).toBe(400);
    },
    30_000
  );

  it(
    "spend cap: a tiny cap reports over-budget with a negative remainder; a null cap is always within",
    async () => {
      await startServer();
      const tiny = await seededCourse("j1-cap-tiny@example.com", { maxGenerationSpendUsd: 1 });
      const tinyBody = await (
        await costEstimate(tiny.cookie, tiny.courseId, { scope: "course" })
      ).json();
      expect(tinyBody.cap.maxGenerationSpendUsd).toBe(1);
      expect(tinyBody.cap.withinCap).toBe(false);
      expect(tinyBody.cap.remainingUsd).toBeLessThan(0);

      const uncapped = await seededCourse("j1-cap-null@example.com", { maxGenerationSpendUsd: null });
      const nullBody = await (
        await costEstimate(uncapped.cookie, uncapped.courseId, { scope: "course" })
      ).json();
      expect(nullBody.cap.maxGenerationSpendUsd).toBeNull();
      expect(nullBody.cap.withinCap).toBe(true);
      expect(nullBody.cap.remainingUsd).toBeNull();
    },
    30_000
  );

  it(
    "is deterministic — two identical requests return byte-identical JSON",
    async () => {
      await startServer();
      const { cookie, courseId } = await seededCourse("j1-determinism@example.com");

      const a = await (await costEstimate(cookie, courseId, { scope: "course" })).text();
      const b = await (await costEstimate(cookie, courseId, { scope: "course" })).text();
      expect(a).toBe(b);
      expect(JSON.parse(a)).toEqual(JSON.parse(b));
    },
    30_000
  );

  it(
    "tenant isolation — Org B gets a 404 for Org A's course, module, and lesson ids",
    async () => {
      await startServer();
      const { courseId, modules, lessons } = await seededCourse("j1-iso-a@example.com");
      const cookieB = await signUpAndGetCookie("j1-iso-b@example.com");

      expect((await costEstimate(cookieB, courseId, { scope: "course" })).status).toBe(404);
      expect(
        (await costEstimate(cookieB, courseId, { scope: "module", moduleId: modules[0].id })).status
      ).toBe(404);
      expect(
        (await costEstimate(cookieB, courseId, { scope: "lesson", lessonId: lessons[0].id })).status
      ).toBe(404);
    },
    30_000
  );

  it(
    "a viewer-role member can read a cost preview (curriculum.view) — 200",
    async () => {
      await startServer();
      const { cookie: ownerCookie, courseId } = await seededCourse("j1-viewer@example.com");
      const viewerCookie = await inviteMemberCookie(
        ownerCookie,
        "j1-viewer-member@example.com",
        "viewer"
      );

      const res = await costEstimate(viewerCookie, courseId, { scope: "course" });
      expect(res.status).toBe(200);
      expect((await res.json()).counts.lessons).toBe(200);
    },
    30_000
  );

  it("an unknown course id is a 404", async () => {
    await startServer();
    const cookie = await signUpAndGetCookie("j1-unknown@example.com");
    const res = await costEstimate(cookie, randomUUID(), { scope: "course" });
    expect(res.status).toBe(404);
  });

  it(
    "never touches the pipeline — no review item, no asset is created",
    async () => {
      await startServer();
      const { cookie, courseId, modules, lessons } = await seededCourse("j1-noside@example.com");

      const { listReviewItems } = await import("@vvugc/review-queue");
      const reviewItemsBefore = (await listReviewItems()).length;

      await costEstimate(cookie, courseId, { scope: "course" });
      await costEstimate(cookie, courseId, { scope: "module", moduleId: modules[0].id });
      await costEstimate(cookie, courseId, { scope: "lesson", lessonId: lessons[0].id });

      expect((await listReviewItems()).length).toBe(reviewItemsBefore);

      const assetsRes = await fetch(`${baseUrl}/accounts/curricula/${courseId}/assets`, {
        headers: { Cookie: cookie }
      });
      expect(assetsRes.status).toBe(200);
      expect((await assetsRes.json()).assets).toEqual([]);
    },
    30_000
  );
});

// ─── G1: curriculum module long-form produce (§G / §24) ────────────────────
// VVUGC_LLM_LIVE is never set, so every produce here is a dry-run: the whole
// VUGC pipeline runs against mock discovery/transcript/vendors, no network.
// The long-form analogue of the per-lesson produce route — the module's full
// multi-minute longFormScript is handed to runCycle as the source transcript
// and (in v2) rendered as a single 60s-capped segment.
describe("curriculum module long-form produce (G1)", () => {
  const G1_SEEDED = { topic: "Agentic AI", moduleCount: 20, lessonsPerModule: 10 };

  let g1Dir: string;

  beforeEach(() => {
    g1Dir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-g1-"));
    process.env.VVUGC_DB_PATH = join(g1Dir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(g1Dir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (g1Dir && existsSync(g1Dir)) rmSync(g1Dir, { recursive: true, force: true });
    server?.close();
  });

  const generatePlan = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/generate-plan`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getModules = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules`, { headers: { Cookie: cookie } }).then(
      (r) => r.json()
    );

  const getModule = (cookie: string, courseId: string, moduleId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}`, {
      headers: { Cookie: cookie }
    });

  const genModuleLongForm = (
    cookie: string,
    courseId: string,
    moduleId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}/long-form-script`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const produceLongForm = (
    cookie: string,
    courseId: string,
    moduleId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}/produce-long-form`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getAssets = (cookie: string, courseId: string, query = "") =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/assets${query}`, {
      headers: { Cookie: cookie }
    });

  /** Invite a teammate at `role` through the real invite flow and return their session cookie. */
  async function inviteMemberCookie(ownerCookie: string, email: string, role: string): Promise<string> {
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const setCookie = accept.headers.get("set-cookie");
    if (!setCookie) throw new Error("no session cookie returned from invite accept");
    return setCookie.split(";")[0];
  }

  type ModuleRow = { id: string; order: number };

  /** Course + full 20×10 seeded mock plan; returns module 1's id. */
  async function seededCourse(email: string) {
    const cookie = await signUpAndGetCookie(email);
    const { course } = await (await createCourse(cookie, G1_SEEDED)).json();
    const gen = await generatePlan(cookie, course.id, { seed: "agentic-ai" });
    if (gen.status !== 200) throw new Error(`generate-plan failed: ${gen.status}`);
    const { modules } = await getModules(cookie, course.id);
    return {
      cookie,
      courseId: course.id as string,
      moduleId: (modules as ModuleRow[])[0].id,
      modules: modules as ModuleRow[]
    };
  }

  /** …and give module 1 a real long-form script via the existing mock generator. */
  async function seededCourseWithLongForm(email: string) {
    const ctx = await seededCourse(email);
    const scripted = await genModuleLongForm(ctx.cookie, ctx.courseId, ctx.moduleId);
    if (scripted.status !== 200) {
      throw new Error(`long-form script generation failed: ${scripted.status}`);
    }
    return ctx;
  }

  it(
    "POST .../modules/:moduleId/produce-long-form runs the VUGC dry-run pipeline, records a long_video asset in review, moves the module to completed, and a real review item lands in the queue",
    async () => {
      await startServer();
      const { cookie, courseId, moduleId } = await seededCourseWithLongForm("g1-accept@example.com");

      const res = await produceLongForm(cookie, courseId, moduleId);
      expect(res.status).toBe(202);
      const { asset, run } = await res.json();

      expect(run.dryRun).toBe(true);
      expect(run.reviewItemsCreated).toBeGreaterThanOrEqual(1);
      expect(typeof run.runId).toBe("string");

      expect(asset.assetType).toBe("long_video");
      expect(asset.status).toBe("review");
      expect(asset.generationRunId).toBe(run.runId);
      expect(asset.moduleId).toBe(moduleId);
      expect(asset.courseId).toBe(courseId);
      expect(asset.meta.dryRun).toBe(true);
      expect(asset.meta.platform).toBe("youtube_long");
      expect(asset.meta.renderedDurationCappedSec).toBe(60);
      expect(typeof asset.reviewItemId).toBe("string");
      expect(asset.reviewItemId.length).toBeGreaterThan(0);

      // A genuine review-queue row exists for this run (the test controls
      // VVUGC_DB_PATH, so the queue module reads the store the pipeline wrote to).
      const { listReviewItems } = await import("@vvugc/review-queue");
      const items = (await listReviewItems()).filter((i) => i.runId === run.runId);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items[0].id).toBe(asset.reviewItemId);
      expect(items[0].dryRun).toBe(true);

      // The module moved to "completed" and a follow-up GET reflects it.
      const moduleAfter = await (await getModule(cookie, courseId, moduleId)).json();
      expect(moduleAfter.module.status).toBe("completed");

      // GET .../assets?assetType=long_video surfaces the produced asset.
      const listed = await getAssets(cookie, courseId, "?assetType=long_video");
      expect(listed.status).toBe(200);
      const { assets } = await listed.json();
      expect(assets.map((a: { id: string }) => a.id)).toContain(asset.id);
    },
    30_000
  );

  it("POST .../modules/:moduleId/produce-long-form on a module with no long-form script is a 409", async () => {
    await startServer();
    const { cookie, courseId, moduleId } = await seededCourse("g1-noscript@example.com");

    const res = await produceLongForm(cookie, courseId, moduleId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no long-form script/i);
  });

  it(
    "POST .../modules/:moduleId/produce-long-form on another org's module is a 404 and runs nothing",
    async () => {
      await startServer();
      const { courseId, moduleId } = await seededCourseWithLongForm("g1-iso-owner@example.com");

      const { listReviewItems } = await import("@vvugc/review-queue");
      const before = (await listReviewItems()).length;

      const strangerCookie = await signUpAndGetCookie("g1-iso-stranger@example.com");
      const res = await produceLongForm(strangerCookie, courseId, moduleId);
      expect(res.status).toBe(404);

      // Nothing ran: the review-queue count is exactly what it was.
      expect((await listReviewItems()).length).toBe(before);
    },
    30_000
  );

  it("POST .../modules/:moduleId/produce-long-form as a viewer-role member is a real 403", async () => {
    await startServer();
    const { cookie: ownerCookie, courseId, moduleId } = await seededCourseWithLongForm(
      "g1-viewer-403@example.com"
    );

    const viewerCookie = await inviteMemberCookie(ownerCookie, "g1-viewer-403-member@example.com", "viewer");
    const res = await produceLongForm(viewerCookie, courseId, moduleId);
    expect(res.status).toBe(403);
  });

  it(
    "POST .../modules/:moduleId/produce-long-form as an editor-role member (has curriculum.produce) is a 202",
    async () => {
      await startServer();
      const { cookie: ownerCookie, courseId, moduleId } = await seededCourseWithLongForm(
        "g1-editor-202@example.com"
      );

      const editorCookie = await inviteMemberCookie(
        ownerCookie,
        "g1-editor-202-member@example.com",
        "editor"
      );
      const res = await produceLongForm(editorCookie, courseId, moduleId);
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.run.dryRun).toBe(true);
      expect(body.asset.assetType).toBe("long_video");
    },
    30_000
  );

  it("POST .../modules/:moduleId/produce-long-form on an unknown module id is a 404", async () => {
    await startServer();
    const { cookie, courseId } = await seededCourse("g1-unknown-module@example.com");

    const res = await produceLongForm(cookie, courseId, randomUUID());
    expect(res.status).toBe(404);
  });
});

describe("curriculum batch queue (J2)", () => {
  // A deliberately tiny plan (1 module, 3 lessons) so a full batch is fast even
  // though every lesson triggers a real (mock) runCycle dry-run.
  const J2_TINY = { topic: "Agentic AI", moduleCount: 1, lessonsPerModule: 3 };
  const OVERRIDE_1x3 = { overrides: { moduleCount: 1, lessonsPerModule: 3 } };
  const OVERRIDE_1x4 = { overrides: { moduleCount: 1, lessonsPerModule: 4 } };

  let j2Dir: string;

  beforeEach(() => {
    j2Dir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-j2-"));
    process.env.VVUGC_DB_PATH = join(j2Dir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(j2Dir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(() => {
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    if (j2Dir && existsSync(j2Dir)) rmSync(j2Dir, { recursive: true, force: true });
    server?.close();
  });

  const generatePlan = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/generate-plan`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const approve = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }
    });

  const getModule = (cookie: string, courseId: string, moduleId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}`, {
      headers: { Cookie: cookie }
    }).then((r) => r.json());

  const getModules = (cookie: string, courseId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules`, { headers: { Cookie: cookie } }).then(
      (r) => r.json()
    );

  const scriptLesson = (cookie: string, courseId: string, lessonId: string) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonId}/script`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

  const queueModule = (
    cookie: string,
    courseId: string,
    moduleId: string,
    body: Record<string, unknown> = {}
  ) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}/queue`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const queueApproved = (cookie: string, courseId: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/queue-approved`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const getAssets = (cookie: string, courseId: string, query = "") =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/assets${query}`, { headers: { Cookie: cookie } });

  const costEstimate = (cookie: string, courseId: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/accounts/curricula/${courseId}/cost-estimate`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then((r) => r.json());

  async function inviteMemberCookie(ownerCookie: string, email: string, role: string): Promise<string> {
    const invite = await fetch(`${baseUrl}/accounts/invite`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status}`);
    const { inviteToken } = await invite.json();
    const accept = await fetch(`${baseUrl}/accounts/invite/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password: "hunter22" })
    });
    const setCookie = accept.headers.get("set-cookie");
    if (!setCookie) throw new Error("no session cookie returned from invite accept");
    return setCookie.split(";")[0];
  }

  type LessonRow = { id: string; globalOrder: number; shortScript?: string };

  /**
   * Course + tiny seeded plan; scripts the first `scriptCount` lessons (default:
   * all). Returns the module id and the ordered lesson rows.
   */
  async function seededScriptedCourse(
    email: string,
    createOverrides: Record<string, unknown> = {},
    planBody: Record<string, unknown> = OVERRIDE_1x3,
    scriptCount = Infinity
  ) {
    const cookie = await signUpAndGetCookie(email);
    const { course } = await (await createCourse(cookie, { ...J2_TINY, ...createOverrides })).json();
    const gen = await generatePlan(cookie, course.id, planBody);
    if (gen.status !== 200) throw new Error(`generate-plan failed: ${gen.status} ${await gen.text()}`);
    const { modules } = await getModules(cookie, course.id);
    const moduleId = (modules as { id: string }[])[0].id;
    const { lessons } = await getModule(cookie, course.id, moduleId);
    const ordered = (lessons as LessonRow[]).slice().sort((a, b) => a.globalOrder - b.globalOrder);
    const toScript = ordered.slice(0, Math.min(scriptCount, ordered.length));
    for (const l of toScript) {
      const s = await scriptLesson(cookie, course.id, l.id);
      if (s.status !== 200) throw new Error(`script failed: ${s.status}`);
    }
    return { cookie, courseId: course.id as string, moduleId, lessons: ordered };
  }

  it(
    "POST .../modules/:moduleId/queue batch-produces every scripted lesson under bounded concurrency, each landing a real review item",
    async () => {
      await startServer();
      const { cookie, courseId, moduleId } = await seededScriptedCourse("j2-happy@example.com");

      const res = await queueModule(cookie, courseId, moduleId);
      expect(res.status).toBe(202);
      const body = await res.json();

      expect(body.scope).toBe("module");
      expect(body.moduleId).toBe(moduleId);
      expect(body.dryRun).toBe(true);
      expect(body.eligible).toBe(3);
      expect(body.stoppedByCap).toBe(false);
      expect(body.skipped).toEqual([]);
      expect(body.produced).toHaveLength(3);
      for (const p of body.produced) {
        expect(typeof p.lessonId).toBe("string");
        expect(typeof p.assetId).toBe("string");
        expect(typeof p.runId).toBe("string");
        expect(p.reviewItemsCreated).toBeGreaterThanOrEqual(1);
      }
      expect(body.estimatedSpendUsd).toBeGreaterThan(0);

      // 3 short_video assets on the course.
      const { assets } = await (await getAssets(cookie, courseId, "?assetType=short_video")).json();
      expect(assets).toHaveLength(3);

      // 3 distinct real review-queue rows, one per runId.
      const { listReviewItems } = await import("@vvugc/review-queue");
      const runIds = new Set(body.produced.map((p: { runId: string }) => p.runId));
      expect(runIds.size).toBe(3);
      const all = await listReviewItems();
      for (const runId of runIds) {
        const forRun = all.filter((i) => i.runId === runId);
        expect(forRun.length).toBeGreaterThanOrEqual(1);
        expect(forRun[0].dryRun).toBe(true);
      }
    },
    90_000
  );

  it(
    "POST .../modules/:moduleId/queue a second time skips every lesson as already-produced and creates nothing new",
    async () => {
      await startServer();
      const { cookie, courseId, moduleId } = await seededScriptedCourse("j2-idempotent@example.com");

      await (await queueModule(cookie, courseId, moduleId)).json();
      const { listReviewItems } = await import("@vvugc/review-queue");
      const countAfterFirst = (await listReviewItems()).length;

      const body = await (await queueModule(cookie, courseId, moduleId)).json();
      expect(body.produced).toEqual([]);
      expect(body.skipped).toHaveLength(3);
      expect(body.skipped.every((s: { reason: string }) => s.reason === "already-produced")).toBe(true);
      expect(body.stoppedByCap).toBe(false);
      expect((await listReviewItems()).length).toBe(countAfterFirst);
    },
    90_000
  );

  it(
    "a lesson with no script is reported skipped 'no-script' and never handed to the pipeline",
    async () => {
      await startServer();
      // 1×4 plan, only the first 3 lessons scripted.
      const { cookie, courseId, moduleId, lessons } = await seededScriptedCourse(
        "j2-noscript@example.com",
        {},
        OVERRIDE_1x4,
        3
      );
      const unscripted = lessons[3];

      const body = await (await queueModule(cookie, courseId, moduleId)).json();
      expect(body.produced).toHaveLength(3);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0]).toEqual({ lessonId: unscripted.id, reason: "no-script" });
      expect(body.eligible).toBe(3);
    },
    90_000
  );

  it(
    "a tiny spend cap stops the batch before any lesson runs — nothing is produced",
    async () => {
      await startServer();
      const { cookie, courseId, moduleId } = await seededScriptedCourse("j2-cap-tiny@example.com", {
        maxGenerationSpendUsd: 0.01
      });

      const { listReviewItems } = await import("@vvugc/review-queue");
      const before = (await listReviewItems()).length;

      const body = await (await queueModule(cookie, courseId, moduleId)).json();
      expect(body.stoppedByCap).toBe(true);
      expect(body.produced).toEqual([]);
      expect(body.skipped).toHaveLength(3);
      expect(body.skipped.every((s: { reason: string }) => s.reason === "stopped-by-cap")).toBe(true);
      expect(body.estimatedSpendUsd).toBe(0);
      expect(body.cap.maxGenerationSpendUsd).toBe(0.01);

      // Nothing was handed to the pipeline.
      expect((await listReviewItems()).length).toBe(before);
      const { assets } = await (await getAssets(cookie, courseId, "?assetType=short_video")).json();
      expect(assets).toEqual([]);
    },
    90_000
  );

  it(
    "a null spend cap never stops the batch — every scripted lesson is produced",
    async () => {
      await startServer();
      const { cookie, courseId, moduleId } = await seededScriptedCourse("j2-cap-null@example.com", {
        maxGenerationSpendUsd: null
      });

      const body = await (await queueModule(cookie, courseId, moduleId)).json();
      expect(body.stoppedByCap).toBe(false);
      expect(body.produced).toHaveLength(3);
      expect(body.cap.maxGenerationSpendUsd).toBeNull();
    },
    90_000
  );

  it(
    "a mid-range spend cap stops the batch partway — earlier lessons produced, the rest skipped stopped-by-cap",
    async () => {
      await startServer();
      // Learn the per-lesson estimate from a cap-free reference course.
      const ref = await seededScriptedCourse("j2-cap-ref@example.com", { maxGenerationSpendUsd: null });
      const est = await costEstimate(ref.cookie, ref.courseId, { scope: "course" });
      const perLesson = est.perLessonUsd as number;
      expect(perLesson).toBeGreaterThan(0);

      // Cap that admits exactly one lesson (1.5×) — the 2nd reservation breaches it.
      const cap = Number((perLesson * 1.5).toFixed(4));
      const { cookie, courseId, moduleId } = await seededScriptedCourse("j2-cap-mid@example.com", {
        maxGenerationSpendUsd: cap
      });

      const body = await (await queueModule(cookie, courseId, moduleId)).json();
      expect(body.stoppedByCap).toBe(true);
      expect(body.produced).toHaveLength(1);
      expect(body.skipped).toHaveLength(2);
      expect(body.skipped.every((s: { reason: string }) => s.reason === "stopped-by-cap")).toBe(true);
    },
    120_000
  );

  it(
    "maxConcurrent: 1 still produces every lesson (serially)",
    async () => {
      await startServer();
      const { cookie, courseId, moduleId } = await seededScriptedCourse("j2-serial@example.com");

      const body = await (await queueModule(cookie, courseId, moduleId, { maxConcurrent: 1 })).json();
      expect(body.maxConcurrent).toBe(1);
      expect(body.produced).toHaveLength(3);
      expect(body.stoppedByCap).toBe(false);
    },
    90_000
  );

  it(
    "POST .../queue-approved is a 409 before approve and a 202 (scope: course) after",
    async () => {
      await startServer();
      const { cookie, courseId } = await seededScriptedCourse("j2-approved@example.com");

      const early = await queueApproved(cookie, courseId);
      expect(early.status).toBe(409);
      expect((await early.json()).error).toMatch(/no approved version/i);

      const appr = await approve(cookie, courseId);
      expect(appr.status).toBe(201);

      const res = await queueApproved(cookie, courseId);
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.scope).toBe("course");
      expect(body.moduleId).toBeUndefined();
      expect(body.produced).toHaveLength(3);
    },
    90_000
  );

  it(
    "tenant isolation — Org B gets a 404 on both queue routes for Org A's ids and nothing runs",
    async () => {
      await startServer();
      const { courseId, moduleId } = await seededScriptedCourse("j2-iso-owner@example.com");

      const { listReviewItems } = await import("@vvugc/review-queue");
      const before = (await listReviewItems()).length;

      const strangerCookie = await signUpAndGetCookie("j2-iso-stranger@example.com");
      expect((await queueModule(strangerCookie, courseId, moduleId)).status).toBe(404);
      expect((await queueApproved(strangerCookie, courseId)).status).toBe(404);

      expect((await listReviewItems()).length).toBe(before);
    },
    90_000
  );

  it(
    "a viewer-role member is a 403 on both queue routes; an editor-role member is a 202",
    async () => {
      await startServer();
      const { cookie: ownerCookie, courseId, moduleId } =
        await seededScriptedCourse("j2-roles@example.com");

      const viewerCookie = await inviteMemberCookie(ownerCookie, "j2-roles-viewer@example.com", "viewer");
      expect((await queueModule(viewerCookie, courseId, moduleId)).status).toBe(403);
      expect((await queueApproved(viewerCookie, courseId)).status).toBe(403);

      const editorCookie = await inviteMemberCookie(ownerCookie, "j2-roles-editor@example.com", "editor");
      const res = await queueModule(editorCookie, courseId, moduleId);
      expect(res.status).toBe(202);
    },
    90_000
  );

  it("POST .../modules/:moduleId/queue on an unknown module id is a 404", async () => {
    await startServer();
    const { cookie, courseId } = await seededScriptedCourse("j2-unknown-module@example.com");
    expect((await queueModule(cookie, courseId, randomUUID())).status).toBe(404);
  });
});
