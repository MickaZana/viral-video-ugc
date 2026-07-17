import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Automated WCAG 2.x A/AA coverage via axe-core against the real rendered
// homepage — complements the manual mobile-nav/video/form coverage already
// in marketing-site.spec.ts. Scoped to wcag2a/wcag2aa/wcag21aa; "best-practice"
// rules are opinionated style preferences, not WCAG conformance failures.

test("the homepage has no automatically-detectable WCAG A/AA violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("the mobile nav menu has no violations once opened", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await page.click("#navToggle");
  await expect(page.locator(".nav-links")).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
