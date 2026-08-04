import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The end-to-end customer security workflow — the completion gate for the Phase 7
 * SaaS-hardening work. Exercises the full account lifecycle in a real browser
 * against the compiled server (playwright.config.ts webServer runs dist/server.js):
 *
 *   signup → save settings → create a client → dry run (produces review items)
 *   → approve an item → enable 2FA (TOTP) → log out → log back in through the
 *   MFA challenge → see the security-events trail → download the data export
 *   → owner deletes the account → verify the whole org is gone (login fails,
 *   session revoked, and every on-disk artifact — account, MFA secret, client,
 *   review item, run dir, security events — is physically removed while another
 *   tenant's seeded data survives untouched).
 *
 * The TOTP codes are computed in-spec with the same RFC 6238 algorithm the server
 * verifies with (src/totp.ts), inlined so this test never depends on the app's
 * build output — no external authenticator needed. The MFA secret is read from
 * the enrollment UI (#mfaSecret), exactly as a real user would copy it.
 */

const password = "correct horse battery staple";
const RUNS_DIR = process.env.VVUGC_RUNS_DIR!;
const DB_PATH = process.env.VVUGC_DB_PATH!;

async function signup(page: import("@playwright/test").Page, email: string, orgName: string) {
  await page.goto("/account");
  await page.click("#tabSignup");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", password);
  await page.fill("#authOrgName", orgName);
  await page.click("#authSubmit");
  await expect(page.locator("#appView")).toBeVisible();
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
  await expect(page.locator("#mfaStatus")).toContainText("Two-factor authentication is OFF");

  const me = await (await page.request.get("/accounts/me")).json();
  const orgId = me.account.orgId as string;
  const accountId = me.account.id as string;

  // ── Save settings, then create a client (a run requires one) ───────────────
  await page.fill("#niche", NICHE);
  await page.fill("#brandVoice", "clear, energetic");
  await page.check('input[name="platform"][value="tiktok"]');
  await page.check('input[name="platform"][value="youtube_shorts"]');
  await page.selectOption("#videoVendor", "gemini");
  await page.click("#settingsForm button[type='submit']");
  await expect(page.locator("#settingsOk")).toBeVisible();

  await page.fill("#newClientName", "Security E2E Client");
  await page.click("#saveClientBtn");
  // The save handler is async (POST → re-render the client select) — wait for the
  // select to actually land on the new client instead of reading the stale empty value.
  await expect(page.locator("#clientSelect")).not.toHaveValue("", { timeout: 15_000 });
  const clientId = await page.locator("#clientSelect").inputValue();
  expect(clientId).toBeTruthy();

  // ── Dry run from the browser, then approve the first produced item ─────────
  await page.click("#runNowBtn");
  await expect(page.locator("#runOk")).toBeVisible({ timeout: 60_000 });

  const firstItem = page.locator("#customerReviewList article[data-review-id]").first();
  await expect(firstItem).toBeVisible({ timeout: 15_000 });
  const reviewId = (await firstItem.getAttribute("data-review-id"))!;
  await firstItem.locator('[data-action="approve"]').click();
  await expect(page.locator(`#customerReviewList [data-review-id="${reviewId}"] .pill`)).toHaveText("approved");

  // The run wrote a run dir tagged with this org — the post-deletion assertion
  // verifies purgeOrgRuns physically removed it. Fail early if it never existed.
  expect(runDirsForOrg(orgId).length).toBeGreaterThan(0);

  // ── Enable two-factor authentication ───────────────────────────────────────
  await page.click("#mfaEnableBtn");
  // The enroll handler is async (POST → inject the secret into the UI) — wait for
  // the secret to appear instead of reading the empty placeholder.
  await expect(page.locator("#mfaSecret")).not.toBeEmpty({ timeout: 15_000 });
  const secret = (await page.locator("#mfaSecret").textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await page.fill("#mfaVerifyCode", totp(secret));
  await page.click("#mfaVerifyBtn");
  await expect(page.locator("#mfaStatus")).toContainText("Two-factor authentication is ON");

  // ── Log out, then log back in through the MFA challenge ────────────────────
  await page.click("#logoutBtn");
  await expect(page.locator("#authView")).toBeVisible();
  // The logout handler leaves the form in signup mode after a fresh signup —
  // switching to the Log in tab is exactly what a real user would do.
  await page.click("#tabLogin");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", password);
  await page.click("#authSubmit");
  await expect(page.locator("#mfaField")).toBeVisible();
  await expect(page.locator("#authSubmit")).toHaveText("Verify code");
  await page.fill("#authMfaCode", totp(secret));
  await page.click("#authSubmit");
  await expect(page.locator("#appView")).toBeVisible();

  // ── The security-events trail reflects the whole flow ──────────────────────
  const eventsList = page.locator("#securityEventsList");
  await expect(eventsList).toContainText("mfa.enabled");
  await expect(eventsList).toContainText("login.mfa_succeeded");

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

  // ── Owner deletes the account → the whole org is wiped ─────────────────────
  await page.fill("#deleteConfirm", "DELETE");
  await page.fill("#deletePassword", password);
  await page.click("#deleteForm button[type='submit']");
  await expect(page.locator("#authView")).toBeVisible();
  await expect(page.locator("#authNotice")).toContainText("organization were deleted");

  // Login is no longer possible, and the deleted session is revoked server-side.
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", password);
  await page.click("#authSubmit");
  await expect(page.locator("#authError")).toContainText("invalid email or password");
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
  expect(existsSync(join(RUNS_DIR, "e2e-failed-run", "manifest.json"))).toBe(true);

  const eventsPath = join(RUNS_DIR, "security-events.ndjson");
  const eventsFile = existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8") : "";
  expect(eventsFile.split("\n").filter((line) => line.includes(orgId))).toHaveLength(0);

  await context.close();
});
