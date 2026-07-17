import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Automated WCAG 2.x A/AA coverage via axe-core, run against real rendered
// pages in a real browser (not a static HTML string check) — complements the
// manual keyboard/skip-link coverage already in dashboard.spec.ts. Scoped to
// wcag2a/wcag2aa/wcag21aa rule tags, the same baseline most accessibility
// audits are held to; "best-practice" rules are excluded since those are
// opinionated style preferences, not WCAG conformance failures.

test.describe("accessibility — operator queue dashboard", () => {
  test("the queue page (/) has no automatically-detectable WCAG A/AA violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".queue-list .item").first()).not.toHaveClass(/skeleton-item/);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});

test.describe("accessibility — self-service account page", () => {
  test("the signed-out /account view (login/signup form) has no WCAG A/AA violations", async ({ page }) => {
    await page.goto("/account");
    await expect(page.locator("#authView")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test("the signed-in /account view (usage, team, billing, settings) has no WCAG A/AA violations", async ({
    page
  }) => {
    await page.goto("/account");
    await page.click("#tabSignup");
    await page.fill("#authEmail", "a11y-e2e@example.com");
    await page.fill("#authPassword", "hunter22");
    await page.click("#authSubmit");
    await expect(page.locator("#appView")).toBeVisible();
    // A fresh signup is its own org owner — wait for the async loadTeam() fetch to
    // actually populate/reveal the invite form before scanning, not just for the
    // parent panel to be visible (that flips synchronously, before the fetch lands).
    await expect(page.locator("#inviteForm")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
