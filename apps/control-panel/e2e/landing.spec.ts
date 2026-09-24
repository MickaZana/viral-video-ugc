import { expect, test } from "@playwright/test";

// The marketing landing page (served by the SPA at /app for anonymous guests)
// and its "live preview" — the preview frame renders the real tabs against the
// backend's public /preview/* endpoints, so it must show real seeded data, not
// fabricated placeholders.

test("the landing page hero and product narrative render", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Spy The Format/ })).toBeVisible();
  await expect(page.getByText("AI-Powered Viral Engine").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Click around the real app" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Everything you need to go viral" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spy. Rewrite. Remake." })).toBeVisible();
});

test("the live preview frame renders real seeded data, not placeholders", async ({ page }) => {
  await page.goto("/app");
  const preview = page.locator("#preview");

  // Dashboard preview — stat cards reflect the seeded review queue
  // (tabs/Dashboard.tsx's real stat labels).
  await expect(preview.getByText("Creators Tracked")).toBeVisible();
  await expect(preview.getByText("Avg Viral Score")).toBeVisible();

  // Switching the preview nav re-renders a different real tab. The preview nav
  // buttons carry their icon glyphs in their accessible names ("▤ HISTORY"),
  // which also distinguishes them from the embedded Dashboard's own
  // "Open History ↗" button — hence the icon-anchored match.
  //
  // The preview frame is anonymous/public, so it deliberately serves static
  // synthetic data (review-dashboard's demo-preview-data.ts), never a real
  // customer's queue — this checks that fixed, real content, not seeded data.
  await preview.getByRole("button", { name: /▤ HISTORY/ }).click();
  await expect(preview.getByText(/Stop doing crunches/)).toBeVisible();
  await preview.getByRole("button", { name: /◈ CREATOR SPY/ }).click();
  await expect(preview.getByText("Fitness Motivation Daily").first()).toBeVisible();
});

test("Get Started opens the auth screen", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  // Get Started routes to signup mode (App.tsx's onGetStarted), not signin —
  // "Create your account" is signup's <p>, "Access your account" is signin's.
  await expect(page.getByText("Create your account")).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
});
