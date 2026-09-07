import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// This proof deliberately stops after enabling Live Run.  It uses the ordinary
// signup and client-creation UI, but never presses RUN LIVE, so it exercises the
// server-owned quote without making a provider call or creating a workflow run.
let signupCounter = 0;

async function signup(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ugu-onboarding-done", "1"));
  await page.goto("/app");
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await page.getByRole("button", { name: "SIGN UP" }).click();
  await page.locator("#email").fill(`live-quote-${Date.now()}-${signupCounter++}@example.com`);
  await page.locator("#orgName").fill("Live Quote E2E Org");
  await page.locator("#password").fill("hunter22");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "This Week", exact: true })).toBeVisible();
}

async function assertStudioA11y(page: Page): Promise<void> {
  // The product already provides a reduced-motion treatment; scan the settled,
  // readable version rather than a transitional opacity animation frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("Studio quotes live vendor spend without starting a live run", async ({ page }, testInfo) => {
  await signup(page);
  await page.getByRole("link", { name: "Studio", exact: true }).click();

  // Create a customer-owned client entirely through the visible Studio form.
  // Finance is the one-platform quick preset, giving a deterministic minimum:
  // 4 freeform clips × one platform × $0.40 = $1.60.
  await expect(page.getByText(/No client yet/)).toBeVisible();
  await page.getByRole("button", { name: /Finance/ }).click();
  await page.getByLabel("Client name").fill("Live Quote Brand");
  await page.getByRole("button", { name: "CREATE CLIENT", exact: true }).click();
  await expect(page.getByRole("button", { name: "RUN DRY-RUN", exact: true })).toBeVisible();

  // Record only a real run submission.  The quote request is a separate endpoint
  // and must remain permitted here; the click below must not POST /accounts/run.
  const actualRunRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/accounts/run") actualRunRequests.push(url.href);
  });

  await page.getByLabel("Live run (real vendor spend)").check();
  const quote = page.getByRole("status", { name: "Live vendor-spend estimate" });
  await expect(quote).toBeVisible();
  await expect(quote).toContainText("Estimated vendor spend: from $1.60 USD");
  await expect(quote).toContainText("4 clips × 1 selected platform for one candidate via higgsfield.");
  await expect(quote).toContainText("Up to $19.20 video spend for up to 8 generated platform videos.");
  await expect(quote).toContainText(/(Plus variable .+ usage\.|Voiceover is not selected\.)/);
  await expect(quote).toContainText("This is vendor spend only. Subscription-plan overages, if any, are shown separately in Billing.");
  await expect(page.getByRole("button", { name: "RUN LIVE", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "RUN LIVE", exact: true })).not.toHaveText(/\$/);
  expect(actualRunRequests).toEqual([]);
  await expect(page).toHaveURL(/\/app\/studio$/);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath("studio-live-quote-dark.png"), fullPage: true });
  // Header theme toggle — its accessible name is the action ("Switch to light
  // background"), distinct from Settings' "Light" appearance button.
  await page.getByRole("button", { name: "Switch to light background", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(quote).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("studio-live-quote-light.png"), fullPage: true });

  await assertStudioA11y(page);
  expect(actualRunRequests).toEqual([]);
  await expect(page).toHaveURL(/\/app\/studio$/);
});
