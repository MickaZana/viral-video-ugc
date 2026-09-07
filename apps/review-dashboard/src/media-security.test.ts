import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_USER = "test-user";
const TEST_PASS = "test-pass";

let testDir: string;
let runsDir: string;
let server: Server;
let baseUrl: string;
let app: import("express").Express;

// Minimal valid image base64 strings with matching magic bytes
const VALID_JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
  0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0xff, 0xd9
]).toString("base64");

const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const VALID_WEBP_BASE64 = Buffer.from(
  "RIFF\x24\x00\x00\x00WEBPVP8 \x18\x00\x00\x00\x30\x01\x00\x9d\x01\x2a\x01\x00\x01\x00\x02\x00\x34\x25\xa4\x00\x03\x70\x00\xfe\xfb\xfd\x50\x00",
  "binary"
).toString("base64");

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header on response");
  return setCookie.split(";")[0];
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

async function createConsentedCreator(cookie: string, csrfToken: string, consent = true) {
  const res = await fetch(`${baseUrl}/accounts/creators`, {
    method: "POST",
    headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: "Security Test Creator",
      avatarMode: "none",
      compatibleVendors: [],
      speechStyle: "",
      tone: "",
      wardrobe: "",
      visualStyle: "",
      language: "en",
      prohibitedDepictions: [],
      consentConfirmed: consent,
      active: true
    })
  });
  const body = await res.json();
  return body.creator.id;
}

// ─── Image Upload Validation ────────────────────────────────────────────────

describe("Media Upload Validation (MIME, Magic Bytes, Size, Base64)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-media-sec-"));
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

  it("accepts a valid JPEG with FFD8 magic bytes", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("jpeg@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "photo.jpg", mimeType: "image/jpeg", dataBase64: VALID_JPEG_BASE64 })
    });
    expect(res.status).toBe(201);
  });

  it("accepts a valid PNG with PNG magic bytes", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("png@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "photo.png", mimeType: "image/png", dataBase64: VALID_PNG_BASE64 })
    });
    expect(res.status).toBe(201);
  });

  it("accepts a valid WebP with RIFF...WEBP magic bytes", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("webp@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "photo.webp", mimeType: "image/webp", dataBase64: VALID_WEBP_BASE64 })
    });
    expect(res.status).toBe(201);
  });

  it("rejects application/pdf MIME type with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("pdf@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const pdfBase64 = Buffer.from("%PDF-1.4 header text...").toString("base64");
    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "doc.pdf", mimeType: "application/pdf", dataBase64: pdfBase64 })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid JPEG, PNG, or WebP/i);
  });

  it("rejects image/svg+xml MIME type with 400 (blocks SVG XSS vector)", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("svg@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "vector.svg", mimeType: "image/svg+xml", dataBase64: svgBase64 })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid JPEG, PNG, or WebP/i);
  });

  it("rejects declared image/jpeg with PNG magic bytes (signature mismatch) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("mismatch-jpeg@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "fake.jpg", mimeType: "image/jpeg", dataBase64: VALID_PNG_BASE64 })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature mismatch/i);
  });

  it("rejects declared image/png with JPEG magic bytes (signature mismatch) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("mismatch-png@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "fake.png", mimeType: "image/png", dataBase64: VALID_JPEG_BASE64 })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature mismatch/i);
  });

  it("rejects oversized image (>2MB) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("oversized@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    // Build a 2.5MB payload starting with JPEG header
    const bigBuf = Buffer.alloc(2_500_000, 0x00);
    bigBuf[0] = 0xff;
    bigBuf[1] = 0xd8; // JPEG magic
    const bigBase64 = bigBuf.toString("base64");

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "huge.jpg", mimeType: "image/jpeg", dataBase64: bigBase64 })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("rejects invalid base64 encoding (illegal characters / invalid padding) with 400", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("bad-base64@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "bad.jpg", mimeType: "image/jpeg", dataBase64: "NOT-VALID-BASE64!@#" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects image upload for creator without explicit consent", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("no-consent@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken, false); // consentConfirmed: false

    const res = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "photo.jpg", mimeType: "image/jpeg", dataBase64: VALID_JPEG_BASE64 })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/consent is required/i);
  });
});

// ─── Response Sanitization & Access Control ─────────────────────────────────

describe("Media Response Sanitization and Access Control", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-media-access-"));
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

  it("product responses strip filePath from productImages", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("product-sanitized@example.com");

    // Create a product
    const createRes = await fetch(`${baseUrl}/accounts/products`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sanitized Product" })
    });
    expect(createRes.status).toBe(201);
    const product = (await createRes.json()).product;

    // Upload a product image
    const imgRes = await fetch(`${baseUrl}/accounts/products/${product.id}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "prod.jpg", mimeType: "image/jpeg", dataBase64: VALID_JPEG_BASE64 })
    });
    expect(imgRes.status).toBe(201);
    const imgData = await imgRes.json();

    // Verify upload response has no filePath
    expect(imgData.product.productImages[0].filePath).toBeUndefined();
    expect(JSON.stringify(imgData)).not.toContain("filePath");
    expect(JSON.stringify(imgData)).not.toContain("product-assets");

    // Verify GET response has no filePath
    const getRes = await fetch(`${baseUrl}/accounts/products/${product.id}`, {
      headers: { Cookie: cookie }
    });
    const getData = await getRes.json();
    expect(getData.product.productImages[0].filePath).toBeUndefined();
    expect(JSON.stringify(getData)).not.toContain("filePath");
  });

  it("cross-tenant image access is blocked — tenant B gets 404 for tenant A's image", async () => {
    await startServer();
    const userA = await signupAndGetSession("tenant-a-img@example.com");
    const creatorAId = await createConsentedCreator(userA.cookie, userA.csrfToken);

    // Upload an image for tenant A
    const uploadRes = await fetch(`${baseUrl}/accounts/creators/${creatorAId}/images`, {
      method: "POST",
      headers: { Cookie: userA.cookie, "x-csrf-token": userA.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "photo.jpg", mimeType: "image/jpeg", dataBase64: VALID_JPEG_BASE64 })
    });
    const imageId = (await uploadRes.json()).creator.referenceImages[0].id;

    // Tenant A can access the image
    const accessA = await fetch(`${baseUrl}/accounts/creators/${creatorAId}/images/${imageId}`, {
      headers: { Cookie: userA.cookie }
    });
    expect(accessA.status).toBe(200);

    // Tenant B cannot access tenant A's image
    const userB = await signupAndGetSession("tenant-b-img@example.com");
    const accessB = await fetch(`${baseUrl}/accounts/creators/${creatorAId}/images/${imageId}`, {
      headers: { Cookie: userB.cookie }
    });
    expect(accessB.status).toBe(404);
  });

  it("unauthenticated image requests get 401", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/accounts/creators/some-id/images/some-img`);
    expect(res.status).toBe(401);
  });
});

// ─── Media Serving Safety ───────────────────────────────────────────────────

describe("Media Serving Safety Headers & Content Integrity", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-media-serve-"));
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

  it("serves images with correct Content-Type, nosniff, and Content-Disposition inline headers", async () => {
    await startServer();
    const { cookie, csrfToken } = await signupAndGetSession("serve-safety@example.com");
    const creatorId = await createConsentedCreator(cookie, csrfToken);

    // Upload a PNG
    const uploadRes = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, {
      method: "POST",
      headers: { Cookie: cookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "photo.png", mimeType: "image/png", dataBase64: VALID_PNG_BASE64 })
    });
    const imageId = (await uploadRes.json()).creator.referenceImages[0].id;

    const imgRes = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images/${imageId}`, {
      headers: { Cookie: cookie }
    });
    expect(imgRes.status).toBe(200);

    // Header validations
    expect(imgRes.headers.get("content-type")).toContain("image/png");
    expect(imgRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(imgRes.headers.get("content-disposition")).toBe("inline");
  });
});
