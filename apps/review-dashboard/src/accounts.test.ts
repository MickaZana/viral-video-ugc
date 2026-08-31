import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCookies, isPrivateAddress, extractProductFields } from "./accounts.js";

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

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("vvugc_session=abc123")).toEqual({ vvugc_session: "abc123" });
  });

  it("parses multiple cookies and URL-decodes values", () => {
    expect(parseCookies("a=1; b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });

  it("returns an empty object for an undefined or malformed header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("not-a-cookie-pair")).toEqual({});
  });
});

describe("product profile ingestion guards", () => {
  it("rejects loopback, link-local, mapped IPv4, and reserved ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("extracts product intelligence fields from a product page", () => {
    const fields = extractProductFields('<title>Glow Serum</title><meta name="description" content="A serum for dry skin"><p>Designed for sensitive skin. Helps improve hydration. Shop now.</p>', "https://example.com/p");
    expect(fields.name).toBe("Glow Serum");
    expect(fields.targetCustomer).toMatch(/sensitive skin/);
    expect(fields.primaryBenefits?.length).toBeGreaterThan(0);
    expect(fields.callToAction).toBe("Shop now");
  });
});

describe("account signup/login/session routes (additive, separate from dashboard Basic Auth)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vvugc-accounts-test-"));
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

  it("signup creates an account, sets a session cookie, and does not require Basic Auth", async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "agency@example.com", password: "hunter22", orgName: "Acme Agency" })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.account.email).toBe("agency@example.com");
    expect(body.account).not.toHaveProperty("passwordHash");
    expect(res.headers.get("set-cookie")).toContain("vvugc_session=");
  });

  it("rejects a weak password or invalid email with 400, no account created", async () => {
    await startServer();
    const shortPassword = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "short" })
    });
    expect(shortPassword.status).toBe(400);

    const badEmail = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "longenough1" })
    });
    expect(badEmail.status).toBe(400);
  });

  it("rejects a duplicate signup with 409", async () => {
    await startServer();
    const body = JSON.stringify({ email: "dup@example.com", password: "hunter22" });
    const headers = { "Content-Type": "application/json" };
    await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers, body });
    const second = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers, body });
    expect(second.status).toBe(409);
  });

  it("login with correct credentials returns a session cookie; wrong password returns 401", async () => {
    await startServer();
    const headers = { "Content-Type": "application/json" };
    await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "loginme@example.com", password: "correctpass1" })
    });

    const wrong = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "loginme@example.com", password: "wrongpass" })
    });
    expect(wrong.status).toBe(401);

    const right = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "loginme@example.com", password: "correctpass1" })
    });
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain("vvugc_session=");
  });

  it("GET /accounts/me requires a valid session cookie, not Basic Auth", async () => {
    await startServer();
    const unauthed = await fetch(`${baseUrl}/accounts/me`);
    expect(unauthed.status).toBe(401);

    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "me@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);

    const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.account.email).toBe("me@example.com");
  });

  it("requires the session-bound CSRF token for browser-originated mutations", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "csrf@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);
    const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();

    const rejected = await fetch(`${baseUrl}/accounts/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl }
    });
    expect(rejected.status).toBe(403);

    const accepted = await fetch(`${baseUrl}/accounts/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "X-CSRF-Token": me.csrfToken }
    });
    expect(accepted.status).toBe(204);
  });

  it("serves authenticated built-in templates and previews tenant-scoped inputs without creating a run", async () => {
    await startServer();
    expect((await fetch(`${baseUrl}/templates`)).status).toBe(401);
    const signup = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "templates@example.com", password: "hunter22" }) });
    const cookie = sessionCookieFrom(signup);
    const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
    const templates = await fetch(`${baseUrl}/templates`, { headers: { Cookie: cookie } });
    expect(templates.status).toBe(200);
    expect((await templates.json()).templates).toHaveLength(7);
    const founder = await fetch(`${baseUrl}/templates/founder_story`, { headers: { Cookie: cookie } });
    expect((await founder.json()).template.scriptStructure).toContain("why existing options failed");

    const csrfHeaders = { Cookie: cookie, Origin: baseUrl, "x-csrf-token": me.csrfToken, "Content-Type": "application/json" };
    const blocked = await fetch(`${baseUrl}/accounts/preview-template`, { method: "POST", headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "founder_story" }) });
    expect(blocked.status).toBe(403);
    const incomplete = await fetch(`${baseUrl}/accounts/preview-template`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ templateId: "founder_story", platforms: ["facebook"], durationSec: 20 }) });
    expect(incomplete.status).toBe(200);
    const incompleteBody = await incomplete.json();
    expect(incompleteBody.missingFields).toEqual(expect.arrayContaining(["productProfile", "brandVoice"]));
    expect(incompleteBody.compatibilityWarnings.length).toBeGreaterThan(0);
    expect(incompleteBody.plannedScriptBeats).toContain("why existing options failed");

    const createdProduct = await fetch(`${baseUrl}/accounts/products`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ name: "Template Product" }) });
    expect(createdProduct.status).toBe(201);
    const product = await createdProduct.json();
    const preview = await fetch(`${baseUrl}/accounts/preview-template`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ templateId: "founder_story", productProfileId: product.product.id, brandVoice: "warm", platforms: ["tiktok"], durationSec: 45 }) });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.missingFields).toEqual([]);
    expect(previewBody.requiredInputs.every((entry: { present: boolean }) => entry.present)).toBe(true);
  });

  it("serves authenticated curated presets, with category filtering and 404/400 for unknown ids/categories", async () => {
    await startServer();
    expect((await fetch(`${baseUrl}/presets`)).status).toBe(401);
    const signup = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "presets@example.com", password: "hunter22" }) });
    const cookie = sessionCookieFrom(signup);

    const all = await fetch(`${baseUrl}/presets`, { headers: { Cookie: cookie } });
    expect(all.status).toBe(200);
    expect((await all.json()).presets).toHaveLength(16);

    const filtered = await fetch(`${baseUrl}/presets?category=saas_apps`, { headers: { Cookie: cookie } });
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json();
    expect(filteredBody.presets).toHaveLength(4);
    expect(filteredBody.presets.every((p: { category: string }) => p.category === "saas_apps")).toBe(true);

    const badCategory = await fetch(`${baseUrl}/presets?category=not_a_real_category`, { headers: { Cookie: cookie } });
    expect(badCategory.status).toBe(400);

    const one = await fetch(`${baseUrl}/presets/ecom_unboxing_reveal`, { headers: { Cookie: cookie } });
    expect(one.status).toBe(200);
    expect((await one.json()).preset.templateId).toBe("unboxing");

    const missing = await fetch(`${baseUrl}/presets/does-not-exist`, { headers: { Cookie: cookie } });
    expect(missing.status).toBe(404);
  });

  it("records and summarizes product/UX usage events, always scoped to the session's own org", async () => {
    await startServer();
    expect((await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventType: "discovery_viewed" }) })).status).toBe(401);

    const signup = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "analytics@example.com", password: "hunter22" }) });
    const cookie = sessionCookieFrom(signup);
    const me = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
    const csrfHeaders = { Cookie: cookie, Origin: baseUrl, "x-csrf-token": me.csrfToken, "Content-Type": "application/json" };

    const blocked = await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ eventType: "discovery_viewed" }) });
    expect(blocked.status).toBe(403);

    const invalidType = await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ eventType: "not_a_real_event" }) });
    expect(invalidType.status).toBe(400);

    const recorded = await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ eventType: "discovery_viewed" }) });
    expect(recorded.status).toBe(201);
    const recordedBody = await recorded.json();
    expect(recordedBody.event.eventType).toBe("discovery_viewed");
    expect(recordedBody.event.id).toBeTruthy();

    await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ eventType: "discovery_viewed" }) });
    await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: csrfHeaders, body: JSON.stringify({ eventType: "settings_viewed", meta: { theme: "dark" } }) });

    const summary = await fetch(`${baseUrl}/accounts/analytics/summary`, { headers: { Cookie: cookie } });
    expect(summary.status).toBe(200);
    const summaryBody = await summary.json();
    expect(summaryBody.totalEvents).toBe(3);
    expect(summaryBody.featureUsageCounts.discovery_viewed).toBe(2);
    expect(summaryBody.featureUsageCounts.settings_viewed).toBe(1);
    expect(summaryBody.mostUsedFeatures[0]).toEqual({ eventType: "discovery_viewed", count: 2 });
    expect(summaryBody.activeAccountCount).toBe(1);

    // A second org's events never bleed into the first org's summary.
    const otherSignup = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "other-analytics@example.com", password: "hunter22" }) });
    const otherCookie = sessionCookieFrom(otherSignup);
    const otherMe = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: otherCookie } })).json();
    await fetch(`${baseUrl}/accounts/analytics/event`, { method: "POST", headers: { Cookie: otherCookie, Origin: baseUrl, "x-csrf-token": otherMe.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ eventType: "billing_viewed" }) });
    const stillFirstOrg = await (await fetch(`${baseUrl}/accounts/analytics/summary`, { headers: { Cookie: cookie } })).json();
    expect(stillFirstOrg.totalEvents).toBe(3);
  });

  it("protects creator routes with session auth and CSRF", async () => {
    await startServer();
    expect((await fetch(`${baseUrl}/accounts/creators`)).status).toBe(401);
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "creator-route@example.com", password: "hunter22" }) });
    const cookie = sessionCookieFrom(signupRes); const signup = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } })).json();
    const payload = { displayName: "Ava", avatarMode: "none", compatibleVendors: [], speechStyle: "", tone: "", wardrobe: "", visualStyle: "", language: "en", prohibitedDepictions: [], consentConfirmed: true, active: true };
    expect((await fetch(`${baseUrl}/accounts/creators`, { method: "POST", headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status).toBe(403);
    const created = await fetch(`${baseUrl}/accounts/creators`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": signup.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    expect(created.status).toBe(201); const body = await created.json(); expect(body.creator.referenceImages?.[0]?.filePath).toBeUndefined();
    const creatorId = body.creator.id;
    const uploaded = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images`, { method: "POST", headers: { Cookie: cookie, "x-csrf-token": signup.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ fileName: "ref.png", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }) });
    expect(uploaded.status).toBe(201); const uploadedBody = await uploaded.json(); expect(uploadedBody.creator.referenceImages[0].filePath).toBeUndefined();
    const other = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images/${uploadedBody.creator.referenceImages[0].id}`, { headers: { Cookie: cookie } }); expect(other.status).toBe(200);
    const deleted = await fetch(`${baseUrl}/accounts/creators/${creatorId}/images/${uploadedBody.creator.referenceImages[0].id}`, { method: "DELETE", headers: { Cookie: cookie, "x-csrf-token": signup.csrfToken } }); expect(deleted.status).toBe(204);
  });

  it("rejects unaudited consent, invalid signatures, and cross-tenant image access", async () => {
    await startServer();
    const firstSignup = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "creator-negative-a@example.com", password: "hunter22" }) });
    const firstCookie = sessionCookieFrom(firstSignup); const firstMe = await (await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: firstCookie } })).json();
    const created = await fetch(`${baseUrl}/accounts/creators`, { method: "POST", headers: { Cookie: firstCookie, "x-csrf-token": firstMe.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Unaudited", avatarMode: "none", compatibleVendors: [], speechStyle: "", tone: "", wardrobe: "", visualStyle: "", language: "en", prohibitedDepictions: [], consentConfirmed: false, active: true }) });
    expect(created.status).toBe(201); const creator = await created.json();
    const denied = await fetch(`${baseUrl}/accounts/creators/${creator.creator.id}/images`, { method: "POST", headers: { Cookie: firstCookie, "x-csrf-token": firstMe.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ fileName: "bad.png", mimeType: "image/png", dataBase64: "aGVsbG8=" }) });
    expect(denied.status).toBe(400);

    const secondSignup = await fetch(`${baseUrl}/accounts/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "creator-negative-b@example.com", password: "hunter22" }) });
    const secondCookie = sessionCookieFrom(secondSignup);
    const crossTenant = await fetch(`${baseUrl}/accounts/creators/${creator.creator.id}` , { headers: { Cookie: secondCookie } });
    expect(crossTenant.status).toBe(404);
  });

  it("logout revokes the session — a subsequent /accounts/me with the same cookie is unauthenticated", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "logout@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);

    const logoutRes = await fetch(`${baseUrl}/accounts/logout`, { method: "POST", headers: { Cookie: cookie } });
    expect(logoutRes.status).toBe(204);

    const me = await fetch(`${baseUrl}/accounts/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
  });

  it("GET /accounts/usage returns zeroed usage for a brand-new account with no runs", async () => {
    await startServer();
    const signupRes = await fetch(`${baseUrl}/accounts/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "usage@example.com", password: "hunter22" })
    });
    const cookie = sessionCookieFrom(signupRes);

    const usage = await (await fetch(`${baseUrl}/accounts/usage`, { headers: { Cookie: cookie } })).json();
    expect(usage.totalRuns).toBe(0);
    expect(usage.totalUsd).toBe(0);
  });

  it("account routes are reachable without the dashboard's Basic Auth header at all", async () => {
    await startServer();
    // No Authorization header anywhere in this test — proves accounts routes
    // are registered ahead of the Basic Auth gate, not accidentally behind it.
    const res = await fetch(`${baseUrl}/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrongpass" })
    });
    expect(res.status).toBe(401); // reached the handler (wrong creds), not blocked by Basic Auth (which would be 401 with WWW-Authenticate)
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});
