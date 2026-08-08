import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Automated WCAG 2.x A/AA coverage via axe-core for the control-panel SPA —
// the same baseline the review-dashboard and marketing-site suites use, applied
// to the product workspace surface that previously had zero accessibility e2e.
// Scoped to wcag2a/wcag2aa/wcag21aa tags (the common audit baseline);
// "best-practice" rules are excluded as opinionated style preferences.

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations, `${label} — ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

test("the landing page has no automatically-detectable WCAG A/AA violations", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Spy The Format/ })).toBeVisible();
  await scan(page, "landing");
});

test("the auth screen has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await expect(page.locator("#email")).toBeVisible();
  await scan(page, "auth screen");
});

test("the signed-in workspace (dashboard) has no WCAG A/AA violations", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await page.getByRole("button", { name: "SIGN UP" }).click();
  await page.locator("#email").fill("a11y-e2e@example.com");
  await page.locator("#orgName").fill("A11y Org");
  await page.locator("#password").fill("hunter22");
  await page.getByRole("button", { name: "Create Account" }).click();

  // Wait for real data to render (stat cards), not just the shell.
  await expect(page.getByText(/1 run\(s\) recorded/)).toBeVisible();
  await scan(page, "workspace dashboard");
});
