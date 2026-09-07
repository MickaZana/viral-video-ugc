import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header on response");
  return setCookie.split(";")[0]; // "vvugc_session=<token>"
}

async function startServer() {
  vi.resetModules();
  ({ app } = await import("./server.js"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://localhost:${port}`;
}

// Matches accounts.test.ts's own creator-image-upload tests: the base64 of
// just the 8-byte PNG magic number is enough to pass the route's signature check.
const TINY_PNG_BASE64 = "iVBORw0KGgo=";

/**
 * Signs up a fresh org, creates a creator with avatarMode "reference_images"
 * and consent confirmed, then uploads `count` reference images. Mirrors the
 * exact create-creator + upload-images sequence in accounts.test.ts's
 * "protects creator routes with session auth and CSRF" test.
 */
async function createCreatorWithImages(count: number): Promise<{
  cookie: string;
  csrfToken: string;
  creatorId: string;
  imageIds: string[];
}> {
  const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `soul-id-${Math.random().toString(36).slice(2)}@example.com`, password: "hunter22" })
  });
  const cookie = sessionCookieFrom(signupRes);
  const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
  const csrfToken = me.csrfToken as string;

  const payload = {
    displayName: "Ava",
    avatarMode: "reference_images",
    compatibleVendors: [],
    speechStyle: "",
    tone: "",
    wardrobe: "",
    visualStyle: "",
    language: "en",
    prohibitedDepictions: [],
    consentConfirmed: true,
    active: true
  };
  const created = await fetch(`${baseUrl}/accounts/creators`, {
    method: "POST",
    headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  expect(created.status).toBe(201);
  const creatorId = (await created.json()).creator.id as string;

  const imageIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const uploaded = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: `ref-${i}.png`, mimeType: "image/png", dataBase64: TINY_PNG_BASE64 })
    });
    expect(uploaded.status).toBe(201);
    const body = await uploaded.json();
    imageIds.push(body.creator.referenceImages[body.creator.referenceImages.length - 1].id);
  }

  return { cookie, csrfToken, creatorId, imageIds };
}

describe("Soul ID routes (train / identity / primary override)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-soul-id-test-"));
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

  it(
    "POST /accounts/creators/:id/train returns 401 unauthenticated",
    async () => {
      // First test in the file pays the one-time cold-start cost of dynamically
      // importing ./server.js (and its full dependency graph) for the first
      // time — bump this test's timeout rather than the file's default.
      await startServer();
      const res = await fetch(`${baseUrl}/accounts/creators/nonexistent/train`, { method: "POST" });
      expect(res.status).toBe(401);
    },
    15000
  );

  it("trains successfully with 3+ reference images, returning ready status and a primary image URL", async () => {
    await startServer();
    const { cookie, csrfToken, creatorId } = await createCreatorWithImages(3);

    const trained = await fetch(`${baseUrl}/accounts/creators/${creatorId}/train`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken }
    });
    expect([200, 201]).toContain(trained.status);
    const body = await trained.json();
    expect(body.faceEmbeddingStatus).toBe("ready");
    expect(typeof body.primaryReferenceImageUrl).toBe("string");
    expect(body.primaryReferenceImageUrl.length).toBeGreaterThan(0);
    expect(body.referenceImageCount).toBe(3);
  });

  it("fails training with 400 if fewer than 3 reference images exist", async () => {
    await startServer();
    const { cookie, csrfToken, creatorId } = await createCreatorWithImages(2);

    const trained = await fetch(`${baseUrl}/accounts/creators/${creatorId}/train`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken }
    });
    expect(trained.status).toBe(400);
    const body = await trained.json();
    expect(body.referenceImageCount).toBe(2);
    expect(body.minimumRequired).toBe(3);
  });

  it("fails training with 400 if avatarMode is 'none'", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "soul-id-none@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);
    const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
    const payload = {
      displayName: "NoAvatar",
      avatarMode: "none",
      compatibleVendors: [],
      speechStyle: "",
      tone: "",
      wardrobe: "",
      visualStyle: "",
      language: "en",
      prohibitedDepictions: [],
      consentConfirmed: false,
      active: true
    };
    const created = await fetch(`${baseUrl}/accounts/creators`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": me.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(created.status).toBe(201);
    const creatorId = (await created.json()).creator.id;

    const trained = await fetch(`${baseUrl}/accounts/creators/${creatorId}/train`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": me.csrfToken }
    });
    expect(trained.status).toBe(400);
    const body = await trained.json();
    expect(body.error).toMatch(/avatarMode/);
  });

  it("GET /accounts/creators/:id/identity returns status/count before and after training", async () => {
    await startServer();
    const { cookie, csrfToken, creatorId } = await createCreatorWithImages(3);

    const before = await fetch(`${baseUrl}/accounts/creators/${creatorId}/identity`, { headers: { Cookie: cookie } });
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.faceEmbeddingStatus).toBe("none");
    expect(beforeBody.primaryReferenceImageUrl).toBeNull();
    expect(beforeBody.referenceImageCount).toBe(3);

    const trained = await fetch(`${baseUrl}/accounts/creators/${creatorId}/train`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken }
    });
    expect(trained.status).toBe(200);

    const after = await fetch(`${baseUrl}/accounts/creators/${creatorId}/identity`, { headers: { Cookie: cookie } });
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.faceEmbeddingStatus).toBe("ready");
    expect(typeof afterBody.primaryReferenceImageUrl).toBe("string");
    expect(afterBody.referenceImageCount).toBe(3);
  });

  it("PUT /accounts/creators/:id/identity/primary overrides the primary to a different uploaded image", async () => {
    await startServer();
    const { cookie, csrfToken, creatorId, imageIds } = await createCreatorWithImages(3);

    const trained = await fetch(`${baseUrl}/accounts/creators/${creatorId}/train`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken }
    });
    expect(trained.status).toBe(200);
    const trainedBody = await trained.json();
    const originalPrimary = trainedBody.primaryReferenceImageUrl as string;

    // Train selects images[0] as primary — override to images[2] instead.
    const overrideTarget = imageIds[2];
    const overridden = await fetch(`${baseUrl}/accounts/creators/${creatorId}/identity/primary`, {
      method: "PUT",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ imageId: overrideTarget })
    });
    expect(overridden.status).toBe(200);
    const overriddenBody = await overridden.json();
    expect(overriddenBody.primaryReferenceImageUrl).not.toBe(originalPrimary);
    expect(overriddenBody.primaryReferenceImageUrl).toContain(overrideTarget);

    const after = await fetch(`${baseUrl}/accounts/creators/${creatorId}/identity`, { headers: { Cookie: cookie } });
    const afterBody = await after.json();
    expect(afterBody.primaryReferenceImageUrl).toBe(overriddenBody.primaryReferenceImageUrl);
  });

  it("cross-tenant isolation: a second org cannot train, read, or override another org's creator", async () => {
    await startServer();
    const { creatorId } = await createCreatorWithImages(3);

    const secondSignup = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "soul-id-other-org@example.com", password: "hunter22" })
    });
    const secondCookie = sessionCookieFrom(secondSignup);
    const secondMe = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: secondCookie } })).json();

    const trainAttempt = await fetch(`${baseUrl}/accounts/creators/${creatorId}/train`, {
      method: "POST",
      headers: { Cookie: secondCookie, "x-csrf-token": secondMe.csrfToken }
    });
    expect(trainAttempt.status).toBe(404);

    const identityAttempt = await fetch(`${baseUrl}/accounts/creators/${creatorId}/identity`, { headers: { Cookie: secondCookie } });
    expect(identityAttempt.status).toBe(404);

    const primaryAttempt = await fetch(`${baseUrl}/accounts/creators/${creatorId}/identity/primary`, {
      method: "PUT",
      headers: { Cookie: secondCookie, "x-csrf-token": secondMe.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ imageId: "whatever" })
    });
    expect(primaryAttempt.status).toBe(404);
  });
});
