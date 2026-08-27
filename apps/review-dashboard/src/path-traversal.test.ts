import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertReviewItem } from "@vvugc/review-queue";
import type { ReviewItem } from "@vvugc/review-queue";
import { createPublicAssetUrl } from "./public-assets.js";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";
const BASIC_AUTH = `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64")}`;

let testDir: string;
let runsDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header on response");
  return setCookie.split(";")[0];
}

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    runId: "run-1",
    niche: "fitness",
    videoPath: join(runsDir, "final.mp4"),
    platform: "youtube_shorts",
    script: {
      videoId: "v1",
      hook: "Hook line",
      points: ["Point one"],
      cta: "Cta line",
      durationSec: 20,
      brandVoice: "energetic",
      locale: "en",
      trendingPhrases: []
    },
    score: 90,
    flags: [],
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    dryRun: overrides.dryRun ?? false
  };
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

async function signupAndGetSession(email: string) {
  const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22" })
  });
  const cookie = sessionCookieFrom(signupRes);
  const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken, account: me.account };
}

// ─── /media/:itemId Path Traversal Defense ──────────────────────────────────

describe("Path traversal defense on /media/:itemId", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-path-traversal-"));
    runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = runsDir;
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

  it("refuses a path that uses relative ../ to escape VVUGC_RUNS_DIR", async () => {
    const sensitiveFile = join(testDir, "secret.txt");
    writeFileSync(sensitiveFile, "top-secret-password");

    insertReviewItem(
      makeItem({
        id: "item-escape-1",
        videoPath: join(runsDir, "..", "secret.txt")
      })
    );

    await startServer();
    const res = await fetch(`${baseUrl}/media/item-escape-1`, { headers: { Authorization: BASIC_AUTH } });
    expect(res.status).toBe(404);
  });

  it("refuses an absolute path pointing outside VVUGC_RUNS_DIR", async () => {
    const outsideFile = join(testDir, "outside-video.mp4");
    writeFileSync(outsideFile, "fake-video-bytes");

    insertReviewItem(
      makeItem({
        id: "item-escape-2",
        videoPath: outsideFile
      })
    );

    await startServer();
    const res = await fetch(`${baseUrl}/media/item-escape-2`, { headers: { Authorization: BASIC_AUTH } });
    expect(res.status).toBe(404);
  });

  it("refuses a deep traversal path (runs/../../../etc/passwd)", async () => {
    insertReviewItem(
      makeItem({
        id: "item-escape-3",
        videoPath: join(runsDir, "..", "..", "..", "etc", "passwd")
      })
    );

    await startServer();
    const res = await fetch(`${baseUrl}/media/item-escape-3`, { headers: { Authorization: BASIC_AUTH } });
    expect(res.status).toBe(404);
  });

  it("refuses a path when videoPath is exactly equal to VVUGC_RUNS_DIR directory root", async () => {
    insertReviewItem(
      makeItem({
        id: "item-root",
        videoPath: runsDir
      })
    );

    await startServer();
    const res = await fetch(`${baseUrl}/media/item-root`, { headers: { Authorization: BASIC_AUTH } });
    expect(res.status).toBe(404);
  });

  it("defeats symlink-based traversal escaping VVUGC_RUNS_DIR via realpathSync", async () => {
    const externalSecret = join(testDir, "external-secret.mp4");
    writeFileSync(externalSecret, "secret-mp4-payload");

    const symlinkPath = join(runsDir, "symlink-video.mp4");
    try {
      symlinkSync(externalSecret, symlinkPath);
    } catch {
      return;
    }

    insertReviewItem(
      makeItem({
        id: "item-symlink",
        videoPath: symlinkPath
      })
    );

    await startServer();
    const res = await fetch(`${baseUrl}/media/item-symlink`, { headers: { Authorization: BASIC_AUTH } });
    expect(res.status).toBe(404);
  });

  it("serves valid video files within VVUGC_RUNS_DIR correctly", async () => {
    const validVideo = join(runsDir, "valid-video.mp4");
    writeFileSync(validVideo, "valid-video-bytes");

    insertReviewItem(
      makeItem({
        id: "item-valid",
        videoPath: validVideo
      })
    );

    await startServer();
    const res = await fetch(`${baseUrl}/media/item-valid`, { headers: { Authorization: BASIC_AUTH } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const text = await res.text();
    expect(text).toBe("valid-video-bytes");
  });

  it("cross-tenant video isolation: tenant B cannot access tenant A's video item", async () => {
    const validVideo = join(runsDir, "tenant-a-video.mp4");
    writeFileSync(validVideo, "tenant-a-video-bytes");

    insertReviewItem(
      makeItem({
        id: "item-tenant-a",
        orgId: "org-AAA",
        videoPath: validVideo
      })
    );

    await startServer();
    const { cookie } = await signupAndGetSession("user-b@example.com");
    const res = await fetch(`${baseUrl}/media/item-tenant-a`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
  });
});

// ─── /public/assets/:token Path Traversal & Token Forgery Defense ───────────

describe("Public signed asset URL traversal and token integrity defense", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-public-asset-test-"));
    runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    process.env.VVUGC_RUNS_DIR = runsDir;
    process.env.PUBLIC_BASE_URL = "https://cdn.example.com";
    process.env.ASSET_SIGNING_SECRET = "asset-signing-secret-at-least-32-chars!!";
  });

  afterEach(() => {
    delete process.env.VVUGC_RUNS_DIR;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.ASSET_SIGNING_SECRET;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    server?.close();
  });

  it("createPublicAssetUrl refuses to sign a URL for a file outside VVUGC_RUNS_DIR", () => {
    const outside = join(testDir, "outside.mp4");
    writeFileSync(outside, "bytes");
    expect(() => createPublicAssetUrl(outside)).toThrow(/refusing to serve a video outside VVUGC_RUNS_DIR/);
  });

  it("rejects a manually crafted token targeting /etc/passwd (signature mismatch)", async () => {
    await startServer();
    const fakePayload = Buffer.from(JSON.stringify({ p: "/etc/passwd", exp: Date.now() + 600_000 })).toString("base64url");
    const forgedToken = `${fakePayload}.invalidSignature123456789`;

    const res = await fetch(`${baseUrl}/public/assets/${forgedToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects a token signed with a different secret", async () => {
    await startServer();
    const validVideo = join(runsDir, "signed-video.mp4");
    writeFileSync(validVideo, "video-content");

    const { url } = createPublicAssetUrl(validVideo);
    const token = url.split("/public/assets/")[1];

    process.env.ASSET_SIGNING_SECRET = "a-completely-different-signing-secret-now!!";

    const res = await fetch(`${baseUrl}/public/assets/${token}`);
    expect(res.status).toBe(404);
  });

  it("rejects an expired signed token", async () => {
    await startServer();
    const validVideo = join(runsDir, "expired-video.mp4");
    writeFileSync(validVideo, "video-content");

    const { url } = createPublicAssetUrl(validVideo, -1000);
    const token = url.split("/public/assets/")[1];

    const res = await fetch(`${baseUrl}/public/assets/${token}`);
    expect(res.status).toBe(404);
  });
});

// ─── Image Route Path Traversal Defense ──────────────────────────────────────

describe("Image route parameter traversal defense", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-img-traversal-"));
    runsDir = join(testDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    process.env.VVUGC_DB_PATH = join(testDir, "queue.json");
    process.env.VVUGC_RUNS_DIR = runsDir;
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

  it("rejects crafted :imageId with ../ (not found in tenant store)", async () => {
    await startServer();
    const { cookie } = await signupAndGetSession("img-traversal@example.com");

    const res = await fetch(`${baseUrl}/accounts/creators/some-creator/images/..%2F..%2Fetc%2Fpasswd`, {
      headers: { Cookie: cookie }
    });
    expect(res.status).toBe(404);
  });

  it("rejects crafted :creatorId with ../ (not found in tenant store)", async () => {
    await startServer();
    const { cookie } = await signupAndGetSession("creator-traversal@example.com");

    const res = await fetch(`${baseUrl}/accounts/creators/..%2F..%2Fsecret/images/some-img`, {
      headers: { Cookie: cookie }
    });
    expect(res.status).toBe(404);
  });

  it("rejects crafted :productId with ../ (not found in tenant store)", async () => {
    await startServer();
    const { cookie } = await signupAndGetSession("product-traversal@example.com");

    const res = await fetch(`${baseUrl}/accounts/products/..%2F..%2Fsecret/images/some-img`, {
      headers: { Cookie: cookie }
    });
    expect(res.status).toBe(404);
  });

  it("ensures internal filePath is NEVER exposed in creator API responses", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("filepath-leak@example.com");

    const creatorRes = await fetch(`${baseUrl}/accounts/creators`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Sanitized Creator",
        avatarMode: "none",
        compatibleVendors: [],
        speechStyle: "",
        tone: "",
        wardrobe: "",
        visualStyle: "",
        language: "en",
        prohibitedDepictions: [],
        consentConfirmed: true,
        active: true
      })
    });
    const creatorBody = await creatorRes.json();
    const creatorId = creatorBody.creator.id;

    const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const uploadRes = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "ref.png", mimeType: "image/png", dataBase64: validPngBase64 })
    });
    expect(uploadRes.status).toBe(201);
    const uploadedData = await uploadRes.json();

    expect(uploadedData.creator.referenceImages[0].filePath).toBeUndefined();
    expect(JSON.stringify(uploadedData)).not.toContain("filePath");
    expect(JSON.stringify(uploadedData)).not.toContain("creator-assets");

    const getRes = await fetch(`${baseUrl}/accounts/creators/${creatorId}`, {
      headers: { Cookie: cookie }
    });
    const getData = await getRes.json();
    expect(getData.creator.referenceImages[0].filePath).toBeUndefined();
    expect(JSON.stringify(getData)).not.toContain("filePath");
    expect(JSON.stringify(getData)).not.toContain("creator-assets");
  });
});
