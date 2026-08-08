import { expect, test, type Page } from "@playwright/test";

// Exercises the control-panel SPA against the real review-dashboard backend:
// signup through the actual /accounts/* API, the full workspace shell, every
// tab rendering real data, theme toggle, and sign-out. No mocks — the browser
// talks to the same server a real user would.

// The account store persists for the whole run (one temp store per invocation),
// so every signup needs a unique email — a shared one would 409 on the second
// test.
let signupCounter = 0;
async function signup(page: Page): Promise<void> {
  const email = `e2e-${Date.now()}-${signupCounter++}@example.com`;
  await page.goto("/app");
  // Landing → auth screen via the header CTA.
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await page.getByRole("button", { name: "SIGN UP" }).click();
  await page.locator("#email").fill(email);
  await page.locator("#orgName").fill("E2E Org");
  await page.locator("#password").fill("hunter22");
  await page.getByRole("button", { name: "Create Account" }).click();
}

test("a guest sees the landing page, not the workspace", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Spy The Format/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Out" })).toHaveCount(0);
});

test("signup opens the workspace with all seven tabs, each rendering real data", async ({ page }) => {
  await signup(page);

  // Workspace shell is up. (Nav button accessible names include their icon
  // glyphs, e.g. "▤ HISTORY", so match on substring, not exact.)
  await expect(page.getByRole("button", { name: "DASHBOARD" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "DASHBOARD", exact: true })).toBeVisible();

  const tabs = ["DASHBOARD", "CREATOR SPY", "SCRIPT REWRITER", "REMIX FROM URL", "VIDEO GENERATOR", "HISTORY", "BILLING"] as const;
  for (const tab of tabs) {
    await page.getByRole("button", { name: tab }).click();
    await expect(page.getByRole("heading", { name: tab, exact: true })).toBeVisible();
    // No tab should end up showing a fetch failure.
    await expect(page.locator("text=Load error")).toHaveCount(0);
  }
});

test("dashboard renders the seeded queue and run data", async ({ page }) => {
  await signup(page);

  // Workflow run panel reflects the seeded manifest (1 run).
  await expect(page.getByText(/1 run\(s\) recorded/)).toBeVisible();
  // Activity log surfaces the seeded pending item's hook.
  await expect(page.getByText(/New review item — "This warm-up is killing your gains"/)).toBeVisible();
});

test("history shows the approved video, all rewritten scripts, and the workflow run", async ({ page }) => {
  await signup(page);
  // The Dashboard tab renders an "Open History ↗" button, so anchor on the nav
  // button's icon glyph to disambiguate.
  await page.getByRole("button", { name: /▤ HISTORY/ }).click();

  // Video Demos: the single approved item.
  await expect(page.getByText("Wait, nobody told you this?")).toBeVisible();
  await expect(page.getByText("1 ready")).toBeVisible();

  // Script Demos: all three seeded review items.
  await page.getByRole("button", { name: /SCRIPT DEMOS/ }).click();
  await expect(page.getByText("3 rewritten")).toBeVisible();
  await expect(page.getByText("This warm-up is killing your gains")).toBeVisible();

  // Workflow Demos: the seeded run.
  await page.getByRole("button", { name: /WORKFLOW DEMOS/ }).click();
  await expect(page.getByText("1 runs")).toBeVisible();
  await expect(page.getByText(/6 candidates/)).toBeVisible();
});

test("theme toggle flips the document between dark and light", async ({ page }) => {
  await signup(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator('button[title="Toggle between dark and white theme"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator('button[title="Toggle between dark and white theme"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("sign out clears the session and returns to the auth screen", async ({ page }) => {
  await signup(page);
  await page.getByRole("button", { name: "Sign Out" }).click();
  // The app returns to the sign-in screen (the guest view stays on auth after a
  // logout) — the workspace shell must be gone and the email field present.
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign Out" })).toHaveCount(0);
});

test("a reload with a live session restores the workspace without re-login", async ({ page }) => {
  await signup(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "DASHBOARD" })).toBeVisible();
});
