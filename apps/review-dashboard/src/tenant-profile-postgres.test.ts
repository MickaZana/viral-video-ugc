import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurriculumCourseInput, CurriculumPlan } from "@vvugc/curriculum-engine";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@vvugc/shared-persistence";
import { MIGRATIONS, runMigrations } from "@vvugc/review-queue";
import { MfaSecretCipher, PostgresIdentityRepository } from "./identity-postgres.js";
import { LocalTenantProfileRepository, PostgresTenantProfileRepository } from "./tenant-profile-postgres.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const secret = "social-test-key-that-is-longer-than-thirty-two-characters";
const clientInput = { name: "Brand", niche: "fitness", brandVoice: "direct", locale: "en", platforms: ["youtube_shorts"], targetDurationSec: 30, videoVendor: "higgsfield", cadence: "manual", active: true } as any;
const productInput = { name: "Bottle", description: "", shortDescription: "", productCategory: "", targetCustomer: "", customerPain: "", primaryBenefits: [], features: [], claims: [], forbiddenClaims: [], differentiators: [], callToAction: "Buy", extractedImageUrls: [] } as any;
const creatorInput = { displayName: "Alex", description: "", faceEmbeddingStatus: "none", avatarMode: "none", compatibleVendors: [], lipSyncVendor: "none", speechStyle: "", tone: "", wardrobe: "", visualStyle: "", language: "en", prohibitedDepictions: [], consentConfirmed: true, consentConfirmedAt: new Date().toISOString(), consentConfirmedBy: "test", active: true } as any;

describe.skipIf(!TEST_DATABASE_URL)("Postgres tenant profile repository", () => {
  let database: IsolatedTestDatabase; let identity: PostgresIdentityRepository; let profiles: PostgresTenantProfileRepository;
  beforeAll(async () => { database = await createIsolatedTestDatabase(); await runMigrations(database.pool, MIGRATIONS); identity = new PostgresIdentityRepository(database.pool, new MfaSecretCipher(secret)); profiles = new PostgresTenantProfileRepository(database.pool, secret); });
  afterAll(async () => database?.dispose());

  it("enforces tenant scope for client, product, creator, consent/image metadata and encrypted social secrets", async () => {
    const one = await identity.signUp("profile-one@example.test", "correct horse battery staple"); const two = await identity.signUp("profile-two@example.test", "correct horse battery staple");
    const client = await profiles.clientCreate(one.orgId, clientInput); const product = await profiles.productCreate(one.orgId, { ...productInput, clientId: client.id }); const creator = await profiles.creatorCreate(one.orgId, { ...creatorInput, clientId: client.id });
    expect(await profiles.clientGet(two.orgId, client.id)).toBeUndefined(); expect(await profiles.productGet(two.orgId, product.id)).toBeUndefined(); expect(await profiles.creatorGet(two.orgId, creator.id)).toBeUndefined();
    const image = { id: "image", fileName: "reference.png", mimeType: "image/png" as const, filePath: "creator-assets/x", createdAt: new Date().toISOString() }; expect((await profiles.creatorAddImage(one.orgId, creator.id, image))?.referenceImages).toHaveLength(1);
    const social = await profiles.socialConnect(one.orgId, { clientId: client.id, platform: "youtube_shorts", accountLabel: "channel", accessToken: "raw-access", refreshToken: "raw-refresh" }); expect(await profiles.socialSecrets(two.orgId, social.id)).toBeUndefined(); expect(await profiles.socialSecrets(one.orgId, social.id)).toEqual({ accessToken: "raw-access", refreshToken: "raw-refresh" }); await expect(profiles.rotateSocialKey(`${secret}-wrong`, `${secret}-rotated`)).rejects.toThrow(); expect(await profiles.socialSecrets(one.orgId, social.id)).toEqual({ accessToken: "raw-access", refreshToken: "raw-refresh" }); await profiles.rotateSocialKey(secret, `${secret}-rotated`);
    expect((await database.pool.query<{ access_ciphertext: string }>("SELECT access_ciphertext FROM social_connections WHERE id=$1", [social.id])).rows[0]?.access_ciphertext).not.toContain("raw-access");
    expect(await new PostgresTenantProfileRepository(database.pool, `${secret}-rotated`).socialSecrets(one.orgId, social.id)).toEqual({ accessToken: "raw-access", refreshToken: "raw-refresh" });
  });

  it("claims invitations once under concurrency and cascades all profile state with an organization", async () => {
    const owner = await identity.signUp("invite-owner@example.test", "correct horse battery staple"); const invite = await profiles.inviteCreate(owner.orgId, "invitee@example.test", owner.id, "editor");
    const [first, second] = await Promise.allSettled([identity.acceptInvite(invite, "correct horse battery staple"), identity.acceptInvite(invite, "correct horse battery staple")]);
    expect([first, second].filter((result) => result.status === "fulfilled" && result.value).length).toBe(1); expect(await profiles.inviteVerify(invite.token)).toBeUndefined();
    const client = await profiles.clientCreate(owner.orgId, clientInput); await profiles.productCreate(owner.orgId, { ...productInput, clientId: client.id }); await profiles.creatorCreate(owner.orgId, { ...creatorInput, clientId: client.id }); await identity.deleteOrg(owner.orgId);
    expect(await profiles.clientList(owner.orgId)).toEqual([]); expect(await profiles.productList(owner.orgId)).toEqual([]); expect(await profiles.creatorList(owner.orgId)).toEqual([]);
  });

  // ─── Curriculum Mode v2 (Postgres path) — mirrors the Local suite below ──
  it("curriculum: round-trips a course and scopes curriculumCourseGet / curriculumCourseList to the owning org", async () => {
    const course = await profiles.curriculumCourseCreate("curr-org-a", courseInput());
    expect(course.orgId).toBe("curr-org-a");
    expect(course.activeVersion).toBeNull();
    expect(await profiles.curriculumCourseGet("curr-org-a", course.id)).toEqual(course);
    expect(await profiles.curriculumCourseGet("curr-org-b", course.id)).toBeUndefined();
    expect(await profiles.curriculumCourseList("curr-org-a")).toHaveLength(1);
    expect(await profiles.curriculumCourseList("curr-org-b")).toEqual([]);
  });

  it("curriculum: curriculumSaveApprovedPlan expands a 2×2+2 plan into 2 modules / 4 lessons / 2 projects", async () => {
    const course = await profiles.curriculumCourseCreate("curr-org-plan", courseInput());
    const result = await profiles.curriculumSaveApprovedPlan("curr-org-plan", course.id, buildPlan());
    expect(result.modules).toHaveLength(2);
    expect(result.lessons).toHaveLength(4);
    expect(result.projects).toHaveLength(2);
    expect(await profiles.curriculumModuleList("curr-org-plan", course.id)).toHaveLength(2);
    expect(await profiles.curriculumProjectList("curr-org-plan", course.id)).toHaveLength(2);
    const lessons = await profiles.curriculumLessonList("curr-org-plan", course.id);
    expect(lessons.map((l) => l.globalOrder)).toEqual([1, 2, 3, 4]);
    const [firstModule] = await profiles.curriculumModuleList("curr-org-plan", course.id);
    const scoped = await profiles.curriculumLessonList("curr-org-plan", course.id, firstModule.id);
    expect(scoped).toHaveLength(2);
    expect(scoped.every((l) => l.moduleId === firstModule.id)).toBe(true);
    expect((await profiles.curriculumCourseGet("curr-org-plan", course.id))?.status).toBe("planned");
    expect(await profiles.curriculumModuleList("other-org", course.id)).toEqual([]);
  });

  it("curriculum: curriculumCourseDelete cascades modules/lessons/projects via the FK", async () => {
    const course = await profiles.curriculumCourseCreate("curr-org-del", courseInput());
    await profiles.curriculumSaveApprovedPlan("curr-org-del", course.id, buildPlan());
    expect(await profiles.curriculumCourseDelete("other-org", course.id)).toBe(false);
    expect(await profiles.curriculumCourseDelete("curr-org-del", course.id)).toBe(true);
    expect(await profiles.curriculumCourseGet("curr-org-del", course.id)).toBeUndefined();
    expect(await profiles.curriculumModuleList("curr-org-del", course.id)).toEqual([]);
    expect(await profiles.curriculumLessonList("curr-org-del", course.id)).toEqual([]);
    expect(await profiles.curriculumProjectList("curr-org-del", course.id)).toEqual([]);
    expect(await profiles.curriculumCourseDelete("curr-org-del", course.id)).toBe(false);
  });

  it("curriculum: curriculumSaveApprovedPlan rejects a wrong-count plan atomically (DB unchanged)", async () => {
    const course = await profiles.curriculumCourseCreate("curr-org-atomic", courseInput());
    await profiles.curriculumSaveApprovedPlan("curr-org-atomic", course.id, buildPlan());
    const badPlan = buildPlan();
    badPlan.lessons = badPlan.lessons.slice(0, 3); // 3 ≠ moduleCount(2) × lessonsPerModule(2)
    await expect(profiles.curriculumSaveApprovedPlan("curr-org-atomic", course.id, badPlan)).rejects.toThrow(/lessons/i);
    expect(await profiles.curriculumModuleList("curr-org-atomic", course.id)).toHaveLength(2);
    expect(await profiles.curriculumLessonList("curr-org-atomic", course.id)).toHaveLength(4);
    expect(await profiles.curriculumProjectList("curr-org-atomic", course.id)).toHaveLength(2);
  });

  it("curriculum: curriculumSaveApprovedPlan is refused once a version is locked (version guard)", async () => {
    const course = await profiles.curriculumCourseCreate("curr-org-ver", courseInput());
    await profiles.curriculumSaveApprovedPlan("curr-org-ver", course.id, buildPlan());
    const next = await profiles.curriculumNextVersionNumber("curr-org-ver", course.id);
    expect(next).toBe(1);
    await profiles.curriculumVersionCreate("curr-org-ver", course.id, { version: next, createdByAccountId: "acc-1", reason: "lock for production", snapshot: { locked: true } });
    expect((await profiles.curriculumCourseGet("curr-org-ver", course.id))?.activeVersion).toBe(1);
    await expect(profiles.curriculumSaveApprovedPlan("curr-org-ver", course.id, buildPlan())).rejects.toThrow(/active version/i);
    const versions = await profiles.curriculumVersionList("curr-org-ver", course.id);
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(await profiles.curriculumNextVersionNumber("curr-org-ver", course.id)).toBe(2);
    expect(await profiles.curriculumModuleList("curr-org-ver", course.id)).toHaveLength(2);
  });
});

function courseInput(over: Partial<CurriculumCourseInput> = {}): CurriculumCourseInput {
  return { title: "Practical AI Prompting", slug: "practical-ai-prompting", topic: "prompt engineering", audience: "developers", startingKnowledge: ["basic programming"], endGoal: "design robust prompt pipelines", language: "en", moduleCount: 2, lessonsPerModule: 2, shortDurationSec: 60, longFormTargetMin: 12, maxGenerationSpendUsd: 50, ...over };
}

/** A hand-built 2×2 plan: 2 modules, 2 lessons each (globalOrder 1..4), 1 project per module. */
function buildPlan(): CurriculumPlan {
  const modules = Array.from({ length: 2 }, (_, i) => ({ order: i + 1, title: `Module ${i + 1}`, description: `description ${i + 1}`, goal: `goal ${i + 1}`, prerequisites: [], learningObjectives: [`objective ${i + 1}`], concepts: [`concept ${i + 1}`] }));
  const lessons = [{ mo: 1, lo: 1 }, { mo: 1, lo: 2 }, { mo: 2, lo: 1 }, { mo: 2, lo: 2 }].map((s, i) => ({ moduleOrder: s.mo, lessonOrder: s.lo, globalOrder: i + 1, title: `Lesson ${s.mo}.${s.lo}`, learningObjective: `learn ${s.mo}.${s.lo}`, prerequisites: [], concepts: [] }));
  const projects = Array.from({ length: 2 }, (_, i) => ({ moduleOrder: i + 1, title: `Project ${i + 1}`, objective: `objective ${i + 1}`, outcome: `outcome ${i + 1}`, requirements: [], steps: [], technologies: [] }));
  return { course: { title: "Practical AI Prompting", slug: "practical-ai-prompting", topic: "prompt engineering", audience: "developers", startingKnowledge: ["basic programming"], endGoal: "design robust prompt pipelines", language: "en", moduleCount: 2, lessonsPerModule: 2, shortDurationSec: 45, longFormTargetMin: 15 }, modules, lessons, projects };
}

describe("LocalTenantProfileRepository — curriculum", () => {
  let runsDir: string; let repo: LocalTenantProfileRepository;
  beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), "vvugc-curriculum-boundary-")); repo = new LocalTenantProfileRepository(runsDir, "x".repeat(32)); });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  it("round-trips a course through curriculumCourseCreate → curriculumCourseGet", async () => {
    const course = await repo.curriculumCourseCreate("orgA", courseInput());
    expect(course.orgId).toBe("orgA"); expect(course.activeVersion).toBeNull();
    expect(await repo.curriculumCourseGet("orgA", course.id)).toEqual(course);
  });

  it("scopes curriculumCourseGet / curriculumCourseList to the owning org", async () => {
    const course = await repo.curriculumCourseCreate("orgA", courseInput());
    expect(await repo.curriculumCourseGet("orgB", course.id)).toBeUndefined();
    expect(await repo.curriculumCourseList("orgA")).toHaveLength(1);
    expect(await repo.curriculumCourseList("orgB")).toEqual([]);
  });

  it("expands an approved plan into modules, lessons and projects", async () => {
    const course = await repo.curriculumCourseCreate("orgA", courseInput());
    await repo.curriculumSaveApprovedPlan("orgA", course.id, buildPlan());
    expect(await repo.curriculumModuleList("orgA", course.id)).toHaveLength(2);
    expect(await repo.curriculumProjectList("orgA", course.id)).toHaveLength(2);
    const lessons = await repo.curriculumLessonList("orgA", course.id);
    expect(lessons).toHaveLength(4);
    expect(lessons.map((l) => l.globalOrder)).toEqual([1, 2, 3, 4]);
  });

  it("filters curriculumLessonList by module through the boundary", async () => {
    const course = await repo.curriculumCourseCreate("orgA", courseInput());
    await repo.curriculumSaveApprovedPlan("orgA", course.id, buildPlan());
    const [first] = await repo.curriculumModuleList("orgA", course.id);
    const lessons = await repo.curriculumLessonList("orgA", course.id, first.id);
    expect(lessons).toHaveLength(2);
    expect(lessons.every((l) => l.moduleId === first.id)).toBe(true);
  });

  it("curriculumCourseDelete cascades to modules, lessons and projects", async () => {
    const course = await repo.curriculumCourseCreate("orgA", courseInput());
    await repo.curriculumSaveApprovedPlan("orgA", course.id, buildPlan());
    expect(await repo.curriculumCourseDelete("orgA", course.id)).toBe(true);
    expect(await repo.curriculumCourseGet("orgA", course.id)).toBeUndefined();
    expect(await repo.curriculumModuleList("orgA", course.id)).toEqual([]);
    expect(await repo.curriculumLessonList("orgA", course.id)).toEqual([]);
    expect(await repo.curriculumProjectList("orgA", course.id)).toEqual([]);
  });

  it("isolates tenants: another org sees no plan rows and cannot delete the course", async () => {
    const course = await repo.curriculumCourseCreate("orgA", courseInput());
    await repo.curriculumSaveApprovedPlan("orgA", course.id, buildPlan());
    expect(await repo.curriculumModuleList("orgB", course.id)).toEqual([]);
    expect(await repo.curriculumLessonList("orgB", course.id)).toEqual([]);
    expect(await repo.curriculumCourseDelete("orgB", course.id)).toBe(false);
    expect(await repo.curriculumModuleList("orgA", course.id)).toHaveLength(2);
  });
});
