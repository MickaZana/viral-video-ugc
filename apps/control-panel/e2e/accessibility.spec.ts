import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Automated WCAG 2.x A/AA coverage via axe-core for the control-panel SPA —
// the same baseline the review-dashboard and marketing-site suites use, applied
// to the product workspace surface that previously had zero accessibility e2e.
// Scoped to wcag2a/wcag2aa/wcag21aa tags (the common audit baseline);
// "best-practice" rules are excluded as opinionated style preferences.

async function scan(page: Page, label: string): Promise<void> {
  // Measure the settled state: the hero flow and status indicators animate
  // (opacity 0→1 flow-ins, blinking/pulsing dots), and axe catches mid-animation
  // frames whose colors are blended against the page background — a real element
  // that passes WCAG AA at full opacity can read as sub-4.5:1 mid-fade. Emulating
  // reduced motion disables those decorative animations (see index.css), so the
  // scan checks the fully-opaque colors a static user actually reads.
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  // Skip the first-run onboarding modal (components/Onboarding.tsx) — it's a
  // separate, already-covered feature, and its overlay would otherwise still be
  // open (and would itself need its own a11y pass) when this scan runs.
  await page.addInitScript(() => localStorage.setItem("ugu-onboarding-done", "1"));
  await page.goto("/app");
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await page.getByRole("button", { name: "SIGN UP" }).click();
  await page.locator("#email").fill(`a11y-e2e-${Date.now()}@example.com`);
  await page.locator("#orgName").fill("A11y Org");
  await page.locator("#password").fill("hunter22");
  await page.getByRole("button", { name: "Create Account" }).click();

  // Wait for real data to render (This Week's stats), not just the shell.
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await expect(page.getByText("Waiting")).toBeVisible();
  await scan(page, "workspace dashboard");
});
