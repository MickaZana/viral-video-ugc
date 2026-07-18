import { expect, test } from "@playwright/test";

// Exercises the dashboard's client-side JS in a real browser — filters, bulk
// select, and the confirm-before-reject dialog were previously only covered by
// route-level (supertest-style) tests, never by anything that actually runs
// the inline <script> in render.ts. Runs against the seeded fixture data from
// global-setup.ts: 5 pending items (3 general-purpose + 2 dedicated single-use
// targets for the reject/approve tests) and 1 already-approved item.
//
// playwright.config.ts sets `use.httpCredentials`, so every test's `page` fixture
// already authenticates automatically (matching a real browser with saved
// credentials) — the tests below deliberately bypass that per-context default to
// confirm the wall is actually there, using plain fetch() against the same
// server instead of a browser context.

test.describe("authentication", () => {
  // Real-navigation coverage of "unreachable without credentials" is deliberately
  // not done here via a second BrowserContext: Chromium's HTTP Basic Auth cache is
  // not reliably isolated per-context within one browser process (a fresh context
  // can inherit a prior context's successful auth challenge), which makes that
  // shape of test flaky in a way that reflects a browser quirk, not the app's
  // actual behavior. The plain fetch() tests below hit the same server over real
  // HTTP and are exactly as authoritative about the app's behavior, without that
  // browser-internal caching variable — server.test.ts and the curl checks run
  // during development additionally confirm this holds for actual browser-style
  // requests, not just this test runner's fetch().
  test("the API rejects a plain unauthenticated fetch", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/queue`);
    expect(res.status).toBe(401);
  });

  test("the API rejects the wrong password", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/queue`, {
      headers: { Authorization: "Basic " + Buffer.from("e2e-user:wrong-password").toString("base64") }
    });
    expect(res.status).toBe(401);
  });

  test("/healthz remains reachable with no credentials", async ({ baseURL }) => {
    const res = await fetch(`${baseURL}/healthz`);
    expect(res.status).toBe(200);
  });
});

test.describe("review queue", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Default filter is status=pending — wait for the real (non-skeleton) items to render.
    await expect(page.locator(".queue-list .item").first()).not.toHaveClass(/skeleton-item/);
  });

  test("shows only pending items by default (6 of the 7 seeded items)", async ({ page }) => {
    await expect(page.locator(".queue-list .item")).toHaveCount(6);
  });

  test("filtering by niche narrows the list to matching items only", async ({ page }) => {
    await page.selectOption("#filter-niche", "fitness");
    await expect(page.locator(".queue-list .item")).toHaveCount(2);
    for (const niche of await page.locator(".item-head strong").allTextContents()) {
      expect(niche).toBe("fitness");
    }
  });

  test("renders the score out of 100 with a qualitative label, and flags as readable text (not raw slugs)", async ({
    page
  }) => {
    await page.selectOption("#filter-niche", "e2e-flags-target");
    const target = page.locator(".queue-list .item");
    await expect(target).toHaveCount(1);

    // score: 35 → "Weak" per the dashboard's scoreLabel() thresholds.
    await expect(target.locator(".item-score")).toHaveText("35/100 · Weak");

    const flagsText = await target.locator(".item-flags").textContent();
    // A known flag gets its curated phrasing, not the raw slug.
    expect(flagsText).toContain("Hook is too long");
    expect(flagsText).not.toContain("hook_too_long");
    // An unrecognized flag (standing in for whatever slug the live QA agent's
    // freeform Claude output might invent) still de-slugifies into readable text.
    expect(flagsText).toContain("Some new flag claude invented");
    expect(flagsText).not.toContain("some_new_flag_claude_invented");
  });

  test("switching status filter to All reveals the already-approved item too", async ({ page }) => {
    // Scoped to the "fitness" niche (2 pending + 1 already-approved, per
    // global-setup.ts) rather than asserting a raw total across the whole store:
    // the review-queue store has no delete operation (an intentional audit-trail
    // design, not a gap), so any other e2e spec that creates real items via a
    // live runCycle() call (see customer-journey.spec.ts, operator-journey.spec.ts)
    // permanently grows the store's all-time total/rejected counts for the rest
    // of this e2e run — an unscoped count here would be a false failure the
    // moment those specs run first, not a real regression in this behavior.
    await page.selectOption("#filter-niche", "fitness");
    await page.selectOption("#filter-status", "");
    await expect(page.locator(".queue-list .item")).toHaveCount(3);
    await expect(page.locator(".pill-approved")).toHaveCount(1);
  });

  test("select-all enables bulk actions, and clearing it disables them again", async ({ page }) => {
    const bulkApprove = page.locator("#bulk-approve");
    const bulkReject = page.locator("#bulk-reject");
    await expect(bulkApprove).toBeDisabled();
    await expect(bulkReject).toBeDisabled();

    await page.check("#select-all");
    await expect(bulkApprove).toBeEnabled();
    await expect(bulkReject).toBeEnabled();
    expect(await page.locator('.queue-list input[type="checkbox"]:checked').count()).toBe(6);

    await page.uncheck("#select-all");
    await expect(bulkApprove).toBeDisabled();
    await expect(bulkReject).toBeDisabled();
  });

  // Uses its own dedicated seeded item (niche "e2e-reject-target") rather than
  // "the first item in the list" — the latter would silently depend on which
  // other tests in this file already ran and mutated the shared queue.
  test("reject asks for confirmation — dismissing it leaves the item untouched", async ({ page }) => {
    await page.selectOption("#filter-niche", "e2e-reject-target");
    const target = page.locator(".queue-list .item");
    await expect(target).toHaveCount(1);

    page.once("dialog", (dialog) => dialog.dismiss());
    await target.getByRole("button", { name: /^Reject/ }).click();

    // No request should have gone out — still present and still pending.
    await page.waitForTimeout(200); // give a wrongly-fired request a moment to land, if any
    await expect(page.locator(".queue-list .item")).toHaveCount(1);
    await expect(page.locator(".pill-pending")).toHaveCount(1);
  });

  test("reject asks for confirmation — accepting it removes the item from the pending view", async ({ page }) => {
    await page.selectOption("#filter-niche", "e2e-reject-target");
    const target = page.locator(".queue-list .item");
    await expect(target).toHaveCount(1);

    page.once("dialog", (dialog) => dialog.accept());
    await target.getByRole("button", { name: /^Reject/ }).click();

    // The list re-fetches with the still-active status=pending + niche filter,
    // so the now-rejected item drops out of view entirely.
    await expect(page.locator(".queue-list .item")).toHaveCount(0);
    // #empty-state, not .empty-state — that class is shared with the unrelated
    // "No runs yet." cell in the run-history table further down the page.
    await expect(page.locator("#empty-state")).toBeVisible();
  });

  test("approve requires no confirmation and removes the item from the pending view", async ({ page }) => {
    await page.selectOption("#filter-niche", "e2e-approve-target");
    const target = page.locator(".queue-list .item");
    await expect(target).toHaveCount(1);

    await target.getByRole("button", { name: /^Approve/ }).click();
    await expect(page.locator(".queue-list .item")).toHaveCount(0);
  });

  test("skip link is the first focusable element and becomes visible on focus", async ({ page }) => {
    const skipLink = page.locator(".skip-link");
    await expect(skipLink).toHaveAttribute("href", "#queue-list");
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
  });
});

test.describe("run history — failure reasons", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".queue-list .item").first()).not.toHaveClass(/skeleton-item/);
  });

  // Previously the runs table only showed an aggregate "1 candidate, 0 platforms"
  // count with no way to find out *why* from the dashboard alone — see global-setup.ts's
  // "e2e-failed-run" seeded manifest for the underlying failure reason this expands to.
  test("the failed-count cell expands to reveal the actual failure reason, not just an aggregate count", async ({
    page
  }) => {
    const row = page.locator("#runs-tbody tr", { hasText: "e2e-failure-reasons" });
    await expect(row).toBeVisible();

    const details = row.locator("details");
    await expect(details.locator("summary")).toContainText("1 candidate");

    // Reason text lives inside <details> — not visible until expanded, same as a
    // native disclosure widget anywhere else on the web.
    await expect(details.locator("li")).toBeHidden();
    await details.locator("summary").click();
    await expect(details.locator("li")).toContainText("simulated script-agent failure for e2e");
  });
});
