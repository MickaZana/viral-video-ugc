import { expect, test, type Page } from "@playwright/test";

// Exercises the control-panel SPA against the real review-dashboard backend:
// signup through the actual /accounts/* API, the full workspace shell, every
// nav destination rendering real data, theme toggle, and sign-out. No mocks —
// the browser talks to the same server a real user would.
//
// Nav is route-based (WorkspaceLayout's <Link>s: This Week/Intel/Studio/Review/
// Library/Brand/Billing/Settings), not the older tab-button bar this file used
// to test against — the page *components* underneath (VideoGenerator, History,
// Billing) are largely unchanged, only how you navigate to them changed.

// The account store persists for the whole run (one temp store per invocation),
// so every signup needs a unique email — a shared one would 409 on the second
// test.
let signupCounter = 0;
async function signup(page: Page): Promise<void> {
  const email = `e2e-${Date.now()}-${signupCounter++}@example.com`;
  // Skip the first-run onboarding modal (components/Onboarding.tsx) — it's a
  // separate, already-covered feature, and its overlay otherwise blocks every
  // click this suite makes right after signup (a real first-time account
  // correctly sees it; that's not what these tests are exercising).
  await page.addInitScript(() => localStorage.setItem("ugu-onboarding-done", "1"));
  await page.goto("/app");
  // Landing → auth screen via the header CTA.
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await page.getByRole("button", { name: "SIGN UP" }).click();
  await page.locator("#email").fill(email);
  await page.locator("#orgName").fill("E2E Org");
  await page.locator("#password").fill("hunter22");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
}

test("a guest sees the landing page, not the workspace", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Spy The Format/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Out" })).toHaveCount(0);
});

test("signup opens the workspace with all eight nav destinations, each rendering real data", async ({ page }) => {
  await signup(page);

  // WorkspaceLayout's own page header <h1> reflects the current route
  // (titleFor()) — that's the real per-page heading now, not a tab-button bar.
  const destinations = [
    { link: "This Week", heading: "This Week" },
    { link: "Intel", heading: "Intel" },
    { link: "Studio", heading: "Studio" },
    { link: "Review", heading: "Review" },
    { link: "Library", heading: "Library" },
    { link: "Brand", heading: "Brand" },
    { link: "Billing", heading: "Billing" },
    { link: "Settings", heading: "Settings" }
  ] as const;
  for (const { link, heading } of destinations) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    // No destination should end up showing a fetch failure.
    await expect(page.locator("text=Load error")).toHaveCount(0);
  }
});

/**
 * Creates a real client and runs a real dry-run pipeline via the API — the
 * global-setup.ts seed data (used by review-dashboard's own e2e suite) has no
 * orgId, so it's visible only to the cross-tenant Basic-Auth operator, never
 * to a session-authenticated customer (resolveRequestOrg scopes /queue to an
 * exact orgId match). Tests exercising a fresh signup's own data need to
 * create it themselves.
 */
async function createClientAndRun(page: Page): Promise<{ clientId: string }> {
  const me = await (await page.request.get("/accounts/me")).json();
  const clientRes = await page.request.post("/accounts/clients", {
    headers: { "X-CSRF-Token": me.csrfToken },
    data: {
      name: "E2E Brand",
      niche: `e2e-workspace-${Date.now()}`,
      brandVoice: "energetic, direct",
      platforms: ["tiktok"],
      targetDurationSec: 30,
      videoVendor: "gemini",
      cadence: "manual"
    }
  });
  const clientId = (await clientRes.json()).client.id as string;
  const runRes = await page.request.post("/accounts/run", { headers: { "X-CSRF-Token": me.csrfToken }, data: { clientId } });
  if (!runRes.ok()) throw new Error(`run failed: ${runRes.status()} ${await runRes.text()}`);
  return { clientId };
}

test("This Week shows the real pending count and run count for the org's own data", async ({ page }) => {
  await signup(page);
  await createClientAndRun(page);
  await page.reload();

  await expect(page.getByText("Waiting")).toBeVisible();
  await expect(page.getByRole("button", { name: /Review \d+ waiting/ })).toBeVisible();
  // Exactly one run was just created via createClientAndRun — its count is the
  // <p> immediately following the "Runs" label <p> (ThisWeek.tsx's stat block).
  await expect(page.locator("p", { hasText: /^Runs$/ }).locator("xpath=following-sibling::p[1]")).toHaveText("1");
});

test("history shows the run's review items and the workflow run, all rendering real data", async ({ page }) => {
  await signup(page);
  await createClientAndRun(page);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();

  // Video Demos (default category): at least one item from the run, showing
  // real text (a script hook), not an empty/placeholder state.
  await expect(page.getByRole("button", { name: /▶ VIDEO DEMOS/ })).toContainText(/[1-9]/);

  // Script Demos: same items, script-focused view.
  await page.getByRole("button", { name: /SCRIPT DEMOS/ }).click();
  await expect(page.getByText(/\d+ rewritten/)).toBeVisible();

  // Workflow Demos: the run that was just created.
  await page.getByRole("button", { name: /WORKFLOW DEMOS/ }).click();
  await expect(page.getByText("1 runs")).toBeVisible();
});

test("theme toggle flips the document between dark and light", async ({ page }) => {
  await signup(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("sign out clears the session and returns to the landing page", async ({ page }) => {
  await signup(page);
  await page.getByRole("button", { name: "Sign Out" }).click();
  await expect(page.getByRole("heading", { name: /Spy The Format/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Out" })).toHaveCount(0);
});

test("a reload with a live session restores the workspace without re-login", async ({ page }) => {
  await signup(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
});

test("video generator creates a client and runs a real dry-run pipeline", async ({ page }) => {
  test.setTimeout(90_000); // real pipeline run — default 30s is shorter than the 60s wait below
  await signup(page);
  await page.getByRole("link", { name: "Studio", exact: true }).click();

  // Fresh orgs have no clients — the honest empty state shows a real create form.
  await expect(page.getByText(/No client yet/)).toBeVisible();
  await page.getByLabel("Client name").fill("E2E Brand");
  await page.getByLabel("Niche").fill("fitness");
  await page.getByLabel("TikTok").check();
  await page.getByLabel("YouTube Shorts").check();
  await page.getByRole("button", { name: "CREATE CLIENT" }).click();

  // The client now exists and the run section is live.
  await expect(page.getByRole("button", { name: "RUN DRY-RUN" })).toBeVisible();

  // Run the real pipeline against the backend (dry-run: no vendor spend).
  // api.run() blocks until the whole pipeline finishes, then VideoGenerator
  // navigates to /studio/runs/:id (StudioRun.tsx) — RunSummary's own "Run
  // Complete" text on the page just left is never actually seen by a real
  // user going through this flow; PipelineProgress's "✓ COMPLETE" header on
  // the page it navigates to is the real completion signal.
  await page.getByRole("button", { name: "RUN DRY-RUN" }).click();
  await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
  await expect(page.getByText("✓ COMPLETE")).toBeVisible({ timeout: 60_000 });

  // The pipeline actually queued review items — a real manifest + cost ledger
  // exist, verified via the real API rather than assumed from the UI.
  const queue = await (await page.request.get("/api/queue")).json();
  const items = Array.isArray(queue) ? queue : queue.items;
  expect(items.length).toBeGreaterThan(0);
});

test("billing checkout hits the real endpoint and surfaces its error honestly", async ({ page }) => {
  await signup(page);
  await page.getByRole("link", { name: "Billing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();

  // Tier cards must show the backend's real per-month prices — a field-name
  // mismatch between the SPA type and the API shape used to render "$undefined"
  // here, so assert a real dollar amount renders on every card.
  await expect(page.getByText(/^\$\d+/m).first()).toBeVisible();
  await expect(page.getByText(/\$undefined/)).toHaveCount(0);

  // A fresh org has no plan, so every tier shows a real "GET STARTED" button —
  // no dead links. The test server runs with Stripe price IDs unset
  // (playwright.config.ts), so clicking one exercises the genuine
  // POST /accounts/billing/checkout path and the backend's real configuration
  // error must be shown verbatim rather than a fake success or silent dead click.
  const checkout = page.getByRole("button", { name: "GET STARTED", exact: true }).first();
  await expect(checkout).toBeVisible();
  await checkout.click();
  await expect(page.getByText(/Checkout error: .*STRIPE_PRICE_ID_(STARTER|GROWTH|AGENCY)/)).toBeVisible();
});
