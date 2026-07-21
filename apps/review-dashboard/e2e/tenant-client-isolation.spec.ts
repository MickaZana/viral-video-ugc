import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const password = "correct horse battery staple";

async function signup(page: import("@playwright/test").Page, email: string, orgName: string) {
  await page.goto("/account");
  await page.click("#tabSignup");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", password);
  await page.fill("#authOrgName", orgName);
  await page.click("#authSubmit");
  await expect(page.locator("#appView")).toBeVisible();
}

async function createClient(request: import("@playwright/test").APIRequestContext, name: string, niche: string) {
  const response = await request.post("/accounts/clients", {
    data: {
      name,
      niche,
      brandVoice: "clear, energetic",
      locale: "en",
      platforms: ["youtube_shorts"],
      targetDurationSec: 25,
      videoVendor: "gemini",
      cadence: "manual",
      active: true
    }
  });
  expect(response.status()).toBe(201);
  return (await response.json()).client as { id: string; name: string };
}

test("multiple client workspaces persist independently and review output cannot cross organization boundaries", async ({ browser }) => {
  const suffix = randomUUID();
  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const other = await otherContext.newPage();

  await signup(owner, `owner-${suffix}@example.com`, "Multi-client Agency");
  const fitness = await createClient(owner.request, "Fitness Brand", `fitness-${suffix}`);
  const finance = await createClient(owner.request, "Finance Brand", `finance-${suffix}`);

  await owner.reload();
  await expect(owner.locator("#clientSelect option")).toHaveCount(3);
  await expect(owner.locator("#clientSelect")).toContainText("Fitness Brand");
  await expect(owner.locator("#clientSelect")).toContainText("Finance Brand");

  const run = await owner.request.post("/accounts/run", { data: { clientId: fitness.id, dryRun: true } });
  expect(run.ok()).toBeTruthy();
  const runResult = await run.json();
  expect(runResult.clientId).toBe(fitness.id);
  expect(runResult.orgId).toBeTruthy();

  const fitnessItems = await owner.request.get(`/accounts/review-items?clientId=${fitness.id}`);
  expect(fitnessItems.ok()).toBeTruthy();
  const ownerItems = (await fitnessItems.json()).items as Array<{ id: string; clientId: string; orgId: string }>;
  expect(ownerItems.length).toBeGreaterThan(0);
  expect(ownerItems.every((item) => item.clientId === fitness.id && item.orgId === runResult.orgId)).toBeTruthy();

  await owner.reload();
  await owner.selectOption("#clientSelect", fitness.id);
  await expect(owner.locator("#customerReviewList [data-review-id]")).not.toHaveCount(0);
  await owner.locator(`#customerReviewList [data-review-id="${ownerItems[0].id}"] [data-action="approve"]`).click();
  await expect(owner.locator(`#customerReviewList [data-review-id="${ownerItems[0].id}"] .pill`)).toHaveText("approved");

  const financeItems = await owner.request.get(`/accounts/review-items?clientId=${finance.id}`);
  expect(((await financeItems.json()).items as unknown[]).length).toBe(0);

  const acceptance = await owner.request.post(`/accounts/clients/${finance.id}/acceptance`, { data: { live: false } });
  expect(acceptance.ok()).toBeTruthy();
  const evidence = await acceptance.json();
  expect(evidence.passed).toBe(true);
  expect(evidence.mode).toBe("dry-run");
  expect(evidence.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  expect(readFileSync(join(process.env.VVUGC_RUNS_DIR!, evidence.config.runId, "acceptance-evidence.json"), "utf8")).toContain('"passed": true');

  const accessToken = `secret-access-${suffix}`;
  const refreshToken = `secret-refresh-${suffix}`;
  const connect = await owner.request.post("/accounts/social-connections", {
    data: {
      clientId: fitness.id,
      platform: "youtube_shorts",
      accountLabel: "Fitness YouTube",
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  });
  expect(connect.status()).toBe(201);
  const connection = (await connect.json()).connection;
  expect(connection.accountLabel).toBe("Fitness YouTube");
  expect(connection.hasRefreshToken).toBe(true);
  expect(JSON.stringify(connection)).not.toContain(accessToken);
  const encryptedFile = readFileSync(join(process.env.VVUGC_RUNS_DIR!, "social-connections.json"), "utf8");
  expect(encryptedFile).not.toContain(accessToken);
  expect(encryptedFile).not.toContain(refreshToken);

  await signup(other, `other-${suffix}@example.com`, "Other Agency");
  const crossTenantList = await other.request.get(`/accounts/review-items?clientId=${fitness.id}`);
  expect(crossTenantList.status()).toBe(404);
  const crossTenantItem = await other.request.get(`/accounts/review-items/${ownerItems[0].id}`);
  expect(crossTenantItem.status()).toBe(404);
  const crossTenantApprove = await other.request.post(`/accounts/review-items/${ownerItems[0].id}/approve`);
  expect(crossTenantApprove.status()).toBe(404);
  const otherConnections = await other.request.get(`/accounts/social-connections?clientId=${fitness.id}`);
  expect(otherConnections.status()).toBe(404);

  // Force the second client's persisted weekly lease due, then exercise the real
  // operator scheduler tick. A second immediate tick must claim nothing: advancing
  // nextRunAt before execution is the idempotency boundary.
  const clientsPath = join(process.env.VVUGC_RUNS_DIR!, "agency-clients.json");
  const persisted = JSON.parse(readFileSync(clientsPath, "utf-8")) as Array<{ id: string; cadence: string; nextRunAt?: string }>;
  const scheduled = persisted.find((client) => client.id === finance.id)!;
  scheduled.cadence = "weekly";
  scheduled.nextRunAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(clientsPath, JSON.stringify(persisted, null, 2));

  const firstTick = await owner.request.post("/scheduler/run-due");
  expect(firstTick.ok()).toBeTruthy();
  const firstTickResult = await firstTick.json();
  expect(firstTickResult.claimed).toBe(1);
  expect(firstTickResult.enqueued[0].clientId).toBe(finance.id);
  await expect.poll(async () => {
    const response = await owner.request.get(`/accounts/jobs/${firstTickResult.enqueued[0].id}`);
    return (await response.json()).job.status;
  }, { timeout: 15_000 }).toBe("completed");
  const secondTick = await owner.request.post("/scheduler/run-due");
  expect((await secondTick.json()).claimed).toBe(0);

  const idempotencyKey = `e2e-job-${suffix}`;
  const queued = await owner.request.post("/accounts/jobs", {
    headers: { "Idempotency-Key": idempotencyKey },
    data: { clientId: finance.id, live: false }
  });
  expect(queued.status()).toBe(202);
  const queuedJob = (await queued.json()).job;
  const duplicate = await owner.request.post("/accounts/jobs", {
    headers: { "Idempotency-Key": idempotencyKey },
    data: { clientId: finance.id, live: false }
  });
  expect((await duplicate.json()).job.id).toBe(queuedJob.id);

  await expect.poll(async () => {
    const response = await owner.request.get(`/accounts/jobs/${queuedJob.id}`);
    return (await response.json()).job.status;
  }, { timeout: 15_000 }).toBe("completed");

  const otherJob = await other.request.get(`/accounts/jobs/${queuedJob.id}`);
  expect(otherJob.status()).toBe(404);
  const crossOrigin = await owner.request.post("/accounts/jobs", {
    headers: { Origin: "https://evil.example" },
    data: { clientId: finance.id }
  });
  expect(crossOrigin.status()).toBe(403);
  const accountPage = await owner.request.get("/account");
  expect(accountPage.headers()["x-frame-options"]).toBe("DENY");
  expect(accountPage.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(readFileSync(join(process.env.VVUGC_RUNS_DIR!, "audit.ndjson"), "utf8")).toContain("/accounts/jobs");

  await ownerContext.close();
  await otherContext.close();
});
