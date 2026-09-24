/**
 * VAD atom A6 — billing metering for curriculum produce/queue and regenerate routes.
 *
 * Proves, against the real routes (server.js under vi.resetModules, with the
 * billing repository and the orchestrator's vendor-touching entry points mocked):
 *
 *  (a) a LIVE curriculum produce reserves via billing.reserveRun BEFORE runCycle
 *      and settles after with the run's estimated vendor cost — same ordering
 *      as POST /accounts/run (accounts.ts:1396-1404);
 *  (b) a dry/mock produce never reserves or settles (both halves of the
 *      live:true + VVUGC_LLM_LIVE double gate are honored);
 *  (c) a LIVE module queue reserves once per lesson with distinct runIds and
 *      settles each reservation after its own runCycle;
 *  (d) live regenerate-scene reserves before the vendor call, settles after,
 *      and a failed reservation fails closed (402, vendor never called);
 *  (e) regenerate-live always reserves (no env gate — the route's whole
 *      purpose is forced live spend), while a dry regenerate-scene never does.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/shared-schema";

vi.setConfig({ testTimeout: 30_000 });

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const AUTH_HEADER = { Authorization: "Basic " + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64") };
const ORG_ID = "org-billing";

type EventKind = "reserveRun" | "runCycle" | "settleReservation" | "regenerateScene" | "regenerateScript";

const h = vi.hoisted(() => ({
  events: [] as Array<{ kind: EventKind; runId?: string }>,
  reserveInputs: [] as Array<{
    orgId: string;
    runId: string;
    durationSec?: number;
    usageRunCount?: number;
  }>,
  settleInputs: [] as Array<{ orgId: string; runId: string; estimatedVendorCostUsd?: number }>,
  reserveShouldThrow: false as boolean
}));

vi.mock("./billing-postgres.js", () => {
  class FakeBillingRepository {
    async getPlan(orgId: string) {
      return { accountId: orgId, tierId: null, status: "none" as const, updatedAt: new Date(0).toISOString() };
    }
    async findPlanBySubscriptionId() {
      return undefined;
    }
    async upsertPlan() {
      throw new Error("not used in these tests");
    }
    async deletePlan() {
      return false;
    }
    async reserveRun(input: {
      orgId: string;
      runId: string;
      clientId?: string;
      durationSec?: number;
      usageRunCount?: number;
    }) {
      if (h.reserveShouldThrow) throw new Error("quota exceeded");
      h.events.push({ kind: "reserveRun", runId: input.runId });
      h.reserveInputs.push(input);
      return {
        id: `res-${input.runId}`,
        orgId: input.orgId,
        runId: input.runId,
        clientId: input.clientId,
        month: new Date().toISOString().slice(0, 7),
        kind: "included" as const,
        amountCents: 0,
        status: "reserved" as const,
        createdAt: new Date().toISOString()
      };
    }
    async settleReservation(input: { orgId: string; runId: string; estimatedVendorCostUsd?: number }) {
      h.events.push({ kind: "settleReservation", runId: input.runId });
      h.settleInputs.push(input);
      return undefined;
    }
    async releaseReservation() {
      return false;
    }
    async overageSummary() {
      return { count: 0, totalUsd: 0 };
    }
  }
  return { LocalBillingRepository: FakeBillingRepository, PostgresBillingRepository: FakeBillingRepository };
});

vi.mock("@vvugc/orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vvugc/orchestrator")>();
  return {
    ...actual,
    runCycle: vi.fn(async (config: { runId: string }) => {
      h.events.push({ kind: "runCycle", runId: config.runId });
      return {
        candidatesFound: 0,
        reviewItemsCreated: 1,
        manifestPath: "/tmp/manifest.json",
        estimatedCostUsd: 1.25
      };
    }),
    regenerateScene: vi.fn(async (item: ReviewItem) => {
      h.events.push({ kind: "regenerateScene", runId: item.runId });
      return { ...item, status: "pending" as const };
    }),
    regenerateScript: vi.fn(async (item: ReviewItem) => {
      h.events.push({ kind: "regenerateScript", runId: item.runId });
      return { ...item, status: "pending" as const };
    })
  };
});

let testDir: string;
let server: Server | undefined;
let baseUrl: string;

async function startServer() {
  vi.resetModules();
  const { app } = await import("./server.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server!.address() as { port: number }).port;
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
  return setCookie.split(";")[0]!;
}

const VALID_BODY = {
  title: "Agentic AI Simplified",
  topic: "Agentic AI systems",
  audience: "Working software engineers new to LLM agents",
  endGoal: "Ship a small production agent with tools, memory, and guardrails"
};

async function createCourse(cookie: string): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/accounts/curricula`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(VALID_BODY)
  });
  if (res.status !== 201) throw new Error(`course create failed: ${res.status}`);
  return (await res.json()).course;
}

async function courseWithScriptedLessons(email: string, count: number) {
  const cookie = await signUpAndGetCookie(email);
  const course = await createCourse(cookie);
  const plan = await fetch(`${baseUrl}/accounts/curricula/${course.id}/generate-plan`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: { moduleCount: 3, lessonsPerModule: 2 } })
  });
  if (plan.status !== 200) throw new Error(`generate-plan failed: ${plan.status}`);
  const modules = (
    await (await fetch(`${baseUrl}/accounts/curricula/${course.id}/modules`, { headers: { Cookie: cookie } })).json()
  ).modules;
  const moduleDetail = (
    await (
      await fetch(`${baseUrl}/accounts/curricula/${course.id}/modules/${modules[0].id}`, {
        headers: { Cookie: cookie }
      })
    ).json()
  ).lessons as Array<{ id: string }>;
  for (let i = 0; i < count; i++) {
    const scriptRes = await fetch(`${baseUrl}/accounts/curricula/${course.id}/lessons/${moduleDetail[i]!.id}/script`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (scriptRes.status !== 200) throw new Error(`script generation failed: ${scriptRes.status}`);
  }
  return {
    cookie,
    courseId: course.id as string,
    moduleId: modules[0].id as string,
    lessonIds: moduleDetail.map((lesson) => lesson.id)
  };
}

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  const script = {
    videoId: "v1",
    hook: "Original hook",
    points: ["Original point one", "Original point two"],
    cta: "Original cta",
    durationSec: 24,
    brandVoice: "energetic",
    locale: "en",
    trendingPhrases: []
  };
  return {
    id: "item-1",
    runId: "run-1",
    orgId: ORG_ID,
    niche: "fitness",
    videoPath: "/tmp/old.mp4",
    platform: "tiktok",
    script,
    score: 70,
    flags: [],
    clips: [{ id: "c0", scriptSegmentIndex: 0, vendor: "kling", filePath: "/tmp/c0.mp4", durationSec: 6 }],
    captions: [{ startSec: 0, endSec: 6, text: "x" }],
    status: "approved",
    dryRun: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const eventKinds = () => h.events.map((event) => event.kind);

describe("A6 — curriculum produce/queue billing metering", () => {
  beforeEach(() => {
    h.events.length = 0;
    h.reserveInputs.length = 0;
    h.settleInputs.length = 0;
    h.reserveShouldThrow = false;
    testDir = mkdtempSync(join(tmpdir(), "vvugc-a6-metering-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("live produce reserves before runCycle, then settles with the run's estimated cost", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    await startServer();
    const { cookie, courseId, lessonIds } = await courseWithScriptedLessons("a6-produce-live@example.com", 1);

    const res = await fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonIds[0]}/produce`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ live: true })
    });
    expect(res.status).toBe(202);
    const { run } = await res.json();
    expect(run.dryRun).toBe(false);

    expect(eventKinds()).toEqual(["reserveRun", "runCycle", "settleReservation"]);
    expect(h.reserveInputs).toHaveLength(1);
    expect(h.reserveInputs[0]).toMatchObject({
      runId: run.runId,
      durationSec: 60,
      usageRunCount: 0
    });
    expect(typeof h.reserveInputs[0]!.orgId).toBe("string");
    expect(h.reserveInputs[0]!.orgId.length).toBeGreaterThan(0);
    expect(h.settleInputs).toHaveLength(1);
    expect(h.settleInputs[0]).toMatchObject({ runId: run.runId, estimatedVendorCostUsd: 1.25 });
  });

  it("a produce that misses either half of the live gate never reserves or settles", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    await startServer();
    const { cookie, courseId, lessonIds } = await courseWithScriptedLessons("a6-produce-dry@example.com", 1);

    const res = await fetch(`${baseUrl}/accounts/curricula/${courseId}/lessons/${lessonIds[0]}/produce`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ live: false })
    });
    expect(res.status).toBe(202);
    const { run } = await res.json();
    expect(run.dryRun).toBe(true);
    expect(eventKinds()).toEqual(["runCycle"]);
  });

  it("a live module queue reserves and settles once per lesson with distinct runIds", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    await startServer();
    const { cookie, courseId, moduleId } = await courseWithScriptedLessons("a6-queue-live@example.com", 2);

    const res = await fetch(`${baseUrl}/accounts/curricula/${courseId}/modules/${moduleId}/queue`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ live: true, maxConcurrent: 1 })
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.dryRun).toBe(false);
    expect(body.produced).toHaveLength(2);
    expect(body.skipped).toEqual([]);

    expect(h.reserveInputs).toHaveLength(2);
    expect(h.settleInputs).toHaveLength(2);
    const reserveRunIds = h.reserveInputs.map((input) => input.runId);
    expect(new Set(reserveRunIds).size).toBe(2);
    expect(new Set(h.settleInputs.map((input) => input.runId))).toEqual(new Set(reserveRunIds));
    expect(h.reserveInputs.every((input) => input.durationSec === 60)).toBe(true);
    expect(h.settleInputs.every((input) => input.estimatedVendorCostUsd === 1.25)).toBe(true);
    for (const runId of reserveRunIds) {
      expect(h.events.filter((event) => event.runId === runId).map((event) => event.kind)).toEqual([
        "reserveRun",
        "runCycle",
        "settleReservation"
      ]);
    }
  });
});

describe("A6 — regenerate route billing metering", () => {
  beforeEach(() => {
    h.events.length = 0;
    h.reserveInputs.length = 0;
    h.settleInputs.length = 0;
    h.reserveShouldThrow = false;
    testDir = mkdtempSync(join(tmpdir(), "vvugc-a6-regen-"));
    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = join(testDir, "runs");
    process.env.DASHBOARD_USERNAME = TEST_USER;
    process.env.DASHBOARD_PASSWORD = TEST_PASS;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.VVUGC_DB_PATH;
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.DASHBOARD_USERNAME;
    delete process.env.DASHBOARD_PASSWORD;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("live regenerate-scene reserves before the vendor call and settles after", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    insertReviewItem(makeItem());
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 0, dryRun: false })
    });
    expect(res.status).toBe(200);

    expect(eventKinds()).toEqual(["reserveRun", "regenerateScene", "settleReservation"]);
    expect(h.reserveInputs[0]).toMatchObject({
      orgId: ORG_ID,
      runId: "run-1",
      durationSec: 24,
      usageRunCount: 0
    });
    expect(h.settleInputs[0]).toMatchObject({ orgId: ORG_ID, runId: "run-1" });
    expect(h.settleInputs[0]!.estimatedVendorCostUsd).toBeUndefined();
  });

  it("a failed reservation blocks a live regenerate-scene with 402 and never calls the vendor", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    h.reserveShouldThrow = true;
    insertReviewItem(makeItem());
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 0, dryRun: false })
    });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/billing reservation failed/);
    expect(eventKinds()).toEqual([]);
  });

  it("a dry regenerate-scene never reserves or settles even when VVUGC_LLM_LIVE is on", async () => {
    vi.stubEnv("VVUGC_LLM_LIVE", "true");
    insertReviewItem(makeItem());
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-scene`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ sceneIndex: 0, dryRun: true })
    });
    expect(res.status).toBe(200);
    expect(eventKinds()).toEqual(["regenerateScene"]);
  });

  it("regenerate-live always reserves and settles — no env gate on this route", async () => {
    insertReviewItem(makeItem());
    await startServer();

    const res = await fetch(`${baseUrl}/queue/item-1/regenerate-live`, {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(res.status).toBe(200);

    expect(eventKinds()).toEqual(["reserveRun", "regenerateScript", "settleReservation"]);
    expect(h.reserveInputs[0]).toMatchObject({
      orgId: ORG_ID,
      runId: "run-1",
      durationSec: 24,
      usageRunCount: 0
    });
    expect(h.settleInputs[0]).toMatchObject({ orgId: ORG_ID, runId: "run-1" });

    const persisted = await (await fetch(`${baseUrl}/queue/item-1`, { headers: AUTH_HEADER })).json();
    expect(persisted.dryRun).toBe(false);
  });
});
