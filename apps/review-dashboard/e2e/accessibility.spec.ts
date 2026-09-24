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
    // /account is the retired legacy page's URL, kept alive only as a redirect
    // into the real product — the control-panel SPA (see server.ts and
    // customer-journey.spec.ts, which exercises this same redirect).
    await page.goto("/account?mode=signup");
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await expect(page.locator("#email")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test("the signed-in /app/settings view (team, password, theme) has no WCAG A/AA violations", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ugu-onboarding-done", "1"));
    await page.goto("/account?mode=signup");
    await page.fill("#email", `a11y-e2e-${Date.now()}@example.com`);
    await page.fill("#password", "hunter22345");
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();

    await page.getByRole("link", { name: "Settings" }).click();
    // A fresh signup is its own org owner — wait for TeamSection's async
    // api.members() fetch to actually populate/reveal the invite form before
    // scanning, not just for the parent panel to be visible (that renders
    // synchronously, before the fetch lands).
    await expect(page.getByPlaceholder("teammate@agency.com")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
