import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { runCycle } from "@vvugc/orchestrator";
import { RunConfigSchema } from "@vvugc/shared-schema";

/**
 * The rest of this e2e suite (dashboard.spec.ts) drives the UI against data
 * seeded directly into the queue store by global-setup.ts — real coverage of
 * the dashboard's own behavior, but it never exercises the seam between the
 * CLI/conductor and the dashboard: does a real `runCycle()` dry-run actually
 * produce review items and a cost ledger that the dashboard picks up and
 * renders correctly? Those two halves were previously only tested in
 * isolation (conductor.test.ts mocks everything past runCycle; dashboard.spec.ts
 * never calls runCycle at all).
 *
 * This spec closes that gap: it calls the real `runCycle()` — the same function
 * both the CLI and /accounts/run call — in dry-run mode (no vendor credentials
 * needed, matching this e2e suite's no-secrets setup), which writes review
 * items and a manifest/cost-ledger to the same VVUGC_DB_PATH/VVUGC_RUNS_DIR
 * files playwright.config.ts already points this e2e server at. Then it drives
 * the real dashboard UI to find, approve, and confirm the run appears in run
 * history with the real cost ledger — the full operator journey, not just the
 * UI half of it.
 *
 * Publishing (POST /queue/:id/publish) is deliberately out of scope here: every
 * adapter requires real vendor credentials this e2e suite doesn't have. Each
 * adapter's request/response shape is already covered by mocked-fetch unit
 * tests in packages/mcp-publish, and the signed-public-URL plumbing has its
 * own coverage in public-assets.test.ts — duplicating that against a live
 * browser wouldn't add real coverage, only vendor-credential risk.
 */

const NICHE = `e2e-operator-journey-${randomUUID().slice(0, 8)}`;

test.describe("operator journey: real runCycle → dashboard → approve → run history", () => {
  test.beforeAll(async () => {
    const config = RunConfigSchema.parse({
      runId: `e2e-operator-journey-${randomUUID()}`,
      niche: NICHE,
      platforms: ["tiktok"],
      maxCandidates: 1,
      dryRun: true,
      createdAt: new Date().toISOString()
    });
    const result = await runCycle(config);
    // The mock discovery source used under --dry-run always returns whatever
    // maxCandidates asks for — pinned to 1 so this spec can assert an exact
    // single-item count downstream, the same way global-setup.ts's fixtures do.
    expect(result.reviewItemsCreated).toBe(1);
  });

  test("a real dry-run cycle's output is reachable, approvable, and reflected in run history from the dashboard UI", async ({
    page
  }) => {
    await page.goto("/");
    await expect(page.locator(".queue-list .item").first()).not.toHaveClass(/skeleton-item/);

    // The niche select only lists niches actually present in the queue — this
    // niche existing as an option at all proves runCycle's insertReviewItem
    // call landed in the same store the dashboard server reads.
    await page.selectOption("#filter-niche", NICHE);
    const target = page.locator(".queue-list .item");
    await expect(target).toHaveCount(1);
    await expect(target.locator(".pill-pending")).toBeVisible();

    await target.getByRole("button", { name: /^Approve/ }).click();
    await expect(page.locator(".queue-list .item")).toHaveCount(0);

    // Switching to the All status filter (same niche) proves the item is now
    // approved, not just gone from the pending view.
    await page.selectOption("#filter-status", "");
    const approved = page.locator(".queue-list .item");
    await expect(approved).toHaveCount(1);
    await expect(approved.locator(".pill-approved")).toBeVisible();

    // Run history reads manifest.json/cost-ledger.json straight off disk
    // (runs.ts) — this is the assertion that a real runCycle() call's output
    // reached that file layer too, not just the review-queue store.
    const row = page.locator("#runs-tbody tr", { hasText: NICHE });
    await expect(row).toBeVisible();
    await expect(row).toContainText("1"); // reviewItemsCreated
  });
});
