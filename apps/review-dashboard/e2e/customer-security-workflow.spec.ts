import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The end-to-end customer security workflow — the completion gate for the Phase 7
 * SaaS-hardening work. Exercises the full account lifecycle in a real browser
 * against the compiled server (playwright.config.ts webServer runs dist/server.js):
 *
 *   signup → create a client → dry run (produces review items) → approve an item
 *   (via the real SPA's review page) → enable 2FA (TOTP) → log out → log back in
 *   through the real MFA challenge (SignIn.tsx) → the security-events trail
 *   reflects it → download the data export → owner deletes the account → verify
 *   the whole org is gone (login fails, session revoked, and every on-disk
 *   artifact — account, MFA secret, client, review item, run dir, security
 *   events — is physically removed while another tenant's seeded data survives
 *   untouched).
 *
 * Signup and the review approval go through the real control-panel SPA (the
 * product's actual UI). MFA enrollment, the security-events trail, and account
 * deletion are driven at the API level: Settings.tsx documents these as
 * intentionally API-only today ("Enrollment stays on the account API") — this
 * test exercises the real backend behavior for each without inventing UI the
 * product doesn't have. The login → MFA challenge step DOES have real SPA UI
 * (SignIn.tsx's mfaToken/code form) and is driven through it.
 *
 * The TOTP codes are computed in-spec with the same RFC 6238 algorithm the server
 * verifies with (src/totp.ts), inlined so this test never depends on the app's
 * build output — no external authenticator needed.
 */

const password = "correct horse battery staple";
const RUNS_DIR = process.env.VVUGC_RUNS_DIR!;
const DB_PATH = process.env.VVUGC_DB_PATH!;

async function signup(page: import("@playwright/test").Page, email: string, orgName: string) {
  // /account is the retired legacy page's URL, kept alive only as a redirect
  // into the real product — the control-panel SPA (see server.ts and
  // customer-journey.spec.ts, which exercises this same redirect).
  await page.addInitScript(() => localStorage.setItem("ugu-onboarding-done", "1"));
  await page.goto("/account?mode=signup");
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await page.fill("#email", email);
  await page.fill("#orgName", orgName);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
}

// ── Minimal RFC 6238 TOTP (mirror of src/totp.ts, inlined for hermeticity) ────
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
  const bytes = Buffer.alloc(Math.floor((cleaned.length * 5) / 8));
  let bufferBits = 0;
  let value = 0;
  let pos = 0;
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character "${char}" in TOTP secret`);
    value = (value << 5) | index;
    bufferBits += 5;
    if (bufferBits >= 8) {
      bytes[pos++] = (value >>> (bufferBits - 8)) & 0xff;
      bufferBits -= 8;
    }
  }
  return bytes;
}

function totp(secret: string, timeMs: number = Date.now()): string {
  const counter = Math.floor(timeMs / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(truncated % 1_000_000).padStart(6, "0");
}

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8")) as T[];
}

/** Run directories whose manifest is tagged with the org (what purgeOrgRuns removes). */
function runDirsForOrg(orgId: string): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const manifestPath = join(RUNS_DIR, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) return false;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { config?: { accountId?: string } };
        return manifest.config?.accountId === orgId;
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name);
}

test("full customer security workflow: dry run, approve, MFA, export, and org deletion", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const suffix = randomUUID();
  const email = `security-${suffix}@example.com`;
  const orgName = "Security E2E Agency";
  // Dedicated niche (like customer-journey.spec.ts's NICHE) so the items this
  // spec's dry run creates never collide with the seeded fitness/personal-finance
  // niches the dashboard specs assert exact counts against — the spec deletes the
  // whole org at the end, but a mid-flow failure must not poison other specs.
  const NICHE = `e2e-security-workflow-${suffix.slice(0, 8)}`;

  // ── Signup ──────────────────────────────────────────────────────────────────
  await signup(page, email, orgName);

  const me = await (await page.request.get("/accounts/me")).json();
  const orgId = me.account.orgId as string;
  const accountId = me.account.id as string;
  const csrfToken = me.csrfToken as string;
  const csrfHeader = { "X-CSRF-Token": csrfToken };

  // ── Create a client (a run requires one) ────────────────────────────────────
  const clientRes = await page.request.post("/accounts/clients", {
    headers: csrfHeader,
    data: {
      name: "Security E2E Client",
      niche: NICHE,
      brandVoice: "clear, energetic",
      platforms: ["tiktok", "youtube_shorts"],
      targetDurationSec: 25,
      videoVendor: "gemini",
      cadence: "manual"
    }
  });
  expect(clientRes.status()).toBe(201);
  const clientId = (await clientRes.json()).client.id as string;

  // ── Dry run, then approve the first produced item via the real review page ─
  const runRes = await page.request.post("/accounts/run", { headers: csrfHeader, data: { clientId } });
  expect(runRes.ok()).toBeTruthy();

  const itemsRes = await page.request.get(`/accounts/review-items?clientId=${clientId}`);
  const items = (await itemsRes.json()).items as Array<{ id: string }>;
  expect(items.length).toBeGreaterThan(0);
  const reviewId = items[0].id;

  await page.goto(`/app/review/${reviewId}`);
  await page.getByRole("button", { name: /APPROVE FOR PRODUCTION/ }).click();
  await expect.poll(async () => {
    const res = await page.request.get(`/accounts/review-items/${reviewId}`);
    return (await res.json()).item.status;
  }).toBe("approved");

  // The run wrote a run dir tagged with this org — the post-deletion assertion
  // verifies purgeOrgRuns physically removed it. Fail early if it never existed.
  expect(runDirsForOrg(orgId).length).toBeGreaterThan(0);

  // ── Enable two-factor authentication (API-only today — Settings.tsx says so) ─
  const enrollRes = await page.request.post("/accounts/mfa/enroll", { headers: csrfHeader });
  expect(enrollRes.status()).toBe(200);
  const secret = (await enrollRes.json()).secret as string;
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  const verifyRes = await page.request.post("/accounts/mfa/verify", { headers: csrfHeader, data: { code: totp(secret) } });
  expect(verifyRes.status()).toBe(200);

  // ── Log out, then log back in through the real MFA challenge (SignIn.tsx) ──
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Sign Out" }).click();
  await page.goto("/account?mode=signin");
  await expect(page).toHaveURL(/\/app(\?|$)/);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByText("Two-factor code")).toBeVisible();
  await page.fill("#code", totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();

  // ── The security-events trail reflects the whole flow ──────────────────────
  const events = (await (await page.request.get("/accounts/security-events")).json()).events as Array<{ type: string }>;
  expect(events.some((e) => e.type === "mfa.enrolled")).toBe(true);
  expect(events.some((e) => e.type === "login.mfa_succeeded")).toBe(true);

  // ── Data export (GDPR-style access request) ────────────────────────────────
  const exportRes = await page.request.get("/accounts/export");
  expect(exportRes.status()).toBe(200);
  expect(exportRes.headers()["content-disposition"]).toContain("attachment");
  const bundle = await exportRes.json();
  expect(bundle.orgId).toBe(orgId);
  expect(bundle.account.email).toBe(email);
  expect((bundle.clients as Array<{ id: string }>).some((client) => client.id === clientId)).toBe(true);
  expect((bundle.reviewItems as Array<{ id: string }>).some((item) => item.id === reviewId)).toBe(true);
  expect((bundle.securityEvents as Array<{ type: string }>).some((event) => event.type === "login.mfa_succeeded")).toBe(true);

  // ── Owner deletes the account → the whole org is wiped (API-only — no SPA UI) ─
  const meAfterLogin = await (await page.request.get("/accounts/me")).json();
  const deleteRes = await page.request.post("/accounts/delete-account", {
    headers: { "X-CSRF-Token": meAfterLogin.csrfToken },
    data: { confirm: "DELETE", password }
  });
  expect(deleteRes.status()).toBe(204);

  // Login is no longer possible, and the deleted session is revoked server-side.
  const loginAfterDelete = await page.request.post("/accounts/login", { data: { email, password } });
  expect(loginAfterDelete.status()).toBe(401);
  expect((await page.request.get("/accounts/me")).status()).toBe(401);

  // ── On-disk verification that deletion physically removed the org's data ───
  const accounts = readJsonArray<{ id: string; email: string }>(join(RUNS_DIR, "accounts.json"));
  expect(accounts.some((account) => account.email === email)).toBe(false);

  const mfaRecords = readJsonArray<{ accountId: string }>(join(RUNS_DIR, "mfa.json"));
  expect(mfaRecords.some((record) => record.accountId === accountId)).toBe(false);

  const clients = readJsonArray<{ id: string }>(join(RUNS_DIR, "agency-clients.json"));
  expect(clients.some((client) => client.id === clientId)).toBe(false);

  const queue = readJsonArray<{ id: string; orgId?: string }>(DB_PATH);
  expect(queue.some((item) => item.id === reviewId)).toBe(false);
  // Another tenant's seeded data survives the purge untouched.
  expect(queue.some((item) => item.id === "fit-tiktok-1")).toBe(true);

  expect(runDirsForOrg(orgId)).toHaveLength(0);

  const eventsPath = join(RUNS_DIR, "security-events.ndjson");
  const eventsFile = existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8") : "";
  expect(eventsFile.split("\n").filter((line) => line.includes(orgId))).toHaveLength(0);

  await context.close();
});
