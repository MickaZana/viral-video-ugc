import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { expect, test, type Page } from "@playwright/test";
import { PRICING_TIERS } from "@vvugc/shared-billing";
import { STRIPE_WEBHOOK_SECRET } from "../playwright.config.js";

/**
 * The full self-service customer journey, end to end, in one continuous run —
 * previously each piece of this (signup, settings, billing display, quota
 * enforcement, invites) was only tested in isolation (accounts.test.ts,
 * billing-routes.test.ts, run-quota.test.ts, webhook-lifecycle.test.ts), never
 * as one flow through a real browser. Integration seams between those pieces
 * — e.g. does the pricing this test signs up against actually match what the
 * billing panel shows post-webhook? Does an invited teammate's session really
 * reach the inviting owner's settings? — can't be caught by any of those
 * unit-level suites individually.
 *
 * Real Stripe Checkout (an actual redirect to Stripe's hosted page) needs a
 * live network call this sandbox can't make, so "start checkout" itself isn't
 * clicked here. What's driven instead is the realistic post-checkout half:
 * simulate the checkout.session.completed webhook the same way Stripe's own
 * CLI/test tooling does — a real HMAC-signed payload via the `stripe` package's
 * own `webhooks.generateTestHeaderString` test helper (see stripe-client.ts's
 * constructWebhookEvent, which this exercises against the real route, not a
 * mocked one) — and confirm the plan it produces is enforced for real by the
 * quota check, not just displayed.
 *
 * Split into ordered steps (for readable pass/fail reporting per stage) that
 * share ONE persistent authenticated page/browser context rather than each
 * getting Playwright's default fresh-context-per-test — the whole point is
 * that the owner's session survives from signup through to inviting a
 * teammate, the same way a real user's browser tab would.
 */

const stripe = new Stripe("sk_test_e2e_placeholder");

test.describe.configure({ mode: "serial" });

test.describe("customer journey: signup → settings → real pricing → billing → quota → invite", () => {
  const email = `e2e-customer-${randomUUID()}@example.com`;
  const password = "correct horse battery staple";
  const NICHE = `e2e-customer-niche-${randomUUID().slice(0, 8)}`;
  let accountId: string;

  let ownerPage: Page;
  test.beforeAll(async ({ browser }) => {
    ownerPage = await (await browser.newContext()).newPage();
  });
  test.afterAll(async () => {
    // The quota test below deliberately runs 4 real dry-run cycles (RunConfigSchema's
    // default maxCandidates, not scoped down) to exercise the real per-run limit, which
    // leaves a real batch of pending review items behind under NICHE. dashboard.spec.ts
    // asserts exact pending/total counts across the whole shared store when the full e2e
    // suite runs together — reject this test's own noise before closing so it doesn't
    // leak into that count, the same "don't leave the shared fixture data worse than you
    // found it" reasoning global-setup.ts's own comments already apply to dedicated niches.
    // Uses the operator API (Basic Auth, sent automatically via playwright.config.ts's
    // `use.httpCredentials`), not the customer session — cleanup is an operator action.
    const pending = await ownerPage.request.get(`/queue?niche=${encodeURIComponent(NICHE)}&status=pending`);
    const ids: string[] = (await pending.json()).map((item: { id: string }) => item.id);
    if (ids.length > 0) {
      await ownerPage.request.post("/queue/bulk/reject", { data: { ids } });
    }
    await ownerPage.context().close();
  });

  test("signup reaches the real settings/billing panels, and the pricing shown matches @vvugc/shared-billing's real tiers", async () => {
    const page = ownerPage;
    await page.goto("/account");
    await page.click("#tabSignup");
    await page.fill("#authEmail", email);
    await page.fill("#authPassword", password);
    await page.fill("#authOrgName", "E2E Customer Org");
    await page.click("#authSubmit");
    await expect(page.locator("#appView")).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.locator(".workspace-topbar h1")).toHaveText("Your content command center");
    await expect(page.locator("#onboardingView")).toBeVisible();
    await page.fill("#onboardingName", "E2E Customer");
    await page.click("#onboardingNext");
    await page.check('input[name="onboardingWorkspace"][value="My business"]');
    await page.click("#onboardingNext");
    await page.fill("#onboardingNiche", NICHE);
    await page.check('input[name="onboardingPlatform"][value="tiktok"]');
    await page.click("#onboardingNext");
    await expect(page.locator("#onboardingView")).toBeHidden();
    await expect(page.locator("#usageStats")).toBeVisible();

    // Settings — a real self-service save, not a fixture.
    await page.fill("#niche", NICHE);
    await page.fill("#brandVoice", "energetic, concise");
    await page.check('input[name="platform"][value="tiktok"]');
    await page.fill("#targetDurationSec", "30");
    await page.click('#settingsForm button[type="submit"]');
    await expect(page.locator("#settingsOk")).toBeVisible();
    await expect(page.locator("#settingsOk")).toHaveText("Saved.");

    // Reloading and re-reading confirms the save actually persisted server-side,
    // not just optimistic client state.
    await page.reload();
    await expect(page.locator("#appView")).toBeVisible();
    await expect(page.locator("#niche")).toHaveValue(NICHE);

    // Billing panel's tier buttons must show the exact real prices — this is the
    // assertion that the marketing site's pricing cards (render.ts's
    // renderPricingGrid, added alongside this test) and the logged-in billing
    // panel can never drift apart, because both now read PRICING_TIERS directly.
    for (const tier of PRICING_TIERS) {
      await expect(page.locator("#tierButtons")).toContainText(`${tier.name} — $${tier.priceUsdPerMonth}/mo`);
    }
    await expect(page.locator("#currentPlanLabel")).toHaveText("No active plan.");

    const me = await page.request.get("/accounts/me");
    accountId = (await me.json()).account.orgId;
  });

  test("workspace navigation creates a client and keeps the context panel synchronized", async () => {
    const page = ownerPage;
    await page.goto("/account");
    await expect(page.locator("#appView")).toBeVisible();
    await expect(page.locator('.side-nav a[href="#clients"]')).toBeVisible();
    await expect(page.locator('.side-nav a[href="#create"]')).toBeVisible();
    await expect(page.locator('.side-nav a[href="#review"]')).toBeVisible();

    const clientName = `E2E Brand ${randomUUID().slice(0, 8)}`;
    await page.fill("#newClientName", clientName);
    await page.fill("#niche", NICHE);
    await page.fill("#brandVoice", "energetic, concise");
    await page.check('input[name="platform"][value="tiktok"]');
    await page.click("#saveClientBtn");
    await expect(page.locator("#clientSelect")).toContainText(clientName);
    await expect(page.locator("#contextClientName")).toHaveText(clientName);
    await expect(page.locator("#contextClientDetail")).toContainText(NICHE);

    await page.click('.side-nav a[href="#billing"]');
    await expect(page.locator("#billing")).toBeInViewport();
    await page.click('.side-nav a[href="#review"]');
    await expect(page.locator("#review")).toBeInViewport();
  });

  test("a simulated Stripe checkout.session.completed webhook activates the Starter plan for real, and the billing panel reflects it", async () => {
    const page = ownerPage;
    expect(accountId, "requires the signup test above to have run first").toBeTruthy();

    const event = {
      id: `evt_${randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          client_reference_id: `${accountId}::starter`,
          customer: "cus_e2e_test",
          subscription: "sub_e2e_test"
        }
      }
    };
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });

    const res = await page.request.post("/webhooks/stripe", {
      data: payload,
      headers: { "Content-Type": "application/json", "Stripe-Signature": signature }
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    await page.goto("/account");
    await expect(page.locator("#appView")).toBeVisible();
    await expect(page.locator("#currentPlanLabel")).toContainText("Current plan: starter (active)");
    await expect(page.locator("#currentPlanLabel")).toContainText("0/4 runs this month");
  });

  test("the Starter plan's real 4-run monthly limit is enforced, not just displayed — a 5th dry run in the same month gets a real 402", async () => {
    const page = ownerPage;
    for (let i = 1; i <= 4; i++) {
      const res = await page.request.post("/accounts/run", { data: { dryRun: true } });
      expect(res.status(), `run #${i} should succeed within the Starter limit`).toBe(200);
    }
    const fifth = await page.request.post("/accounts/run", { data: { dryRun: true } });
    expect(fifth.status()).toBe(402);
    const body = await fifth.json();
    expect(body.error).toContain("monthly run limit reached");
  });

  test("inviting a teammate produces a real /account/join link that a second browser session can use to reach the same org's shared settings", async ({
    browser
  }) => {
    const page = ownerPage;
    await page.goto("/account");
    await expect(page.locator("#appView")).toBeVisible();

    const teammateEmail = `e2e-teammate-${randomUUID()}@example.com`;
    await page.fill("#inviteEmail", teammateEmail);
    await page.click('#inviteForm button[type="submit"]');
    await expect(page.locator("#inviteResult")).toContainText(teammateEmail);
    const resultText = (await page.locator("#inviteResult").textContent())!;
    const match = resultText.match(/https?:\/\/\S+/);
    expect(match, `invite result should contain a link: "${resultText}"`).not.toBeNull();
    const inviteLink = match![0];
    expect(inviteLink).toContain("/account/join?token=");

    // A brand-new browser context — no cookies, no shared state with the owner's
    // session above — proves the invite genuinely works for a different person,
    // not just "still logged in as the owner."
    const teammateContext = await browser.newContext();
    const teammatePage = await teammateContext.newPage();
    await teammatePage.goto(inviteLink);
    // This is the exact failure mode found and fixed alongside this test:
    // /account/join wasn't a registered route at all, so it fell through to the
    // operator's Basic Auth gate and 401'd — visible here as the auth form never
    // rendering (a 401 response has no HTML body to show "You've been invited").
    await expect(teammatePage.locator("#authView h1")).toHaveText("You've been invited — set a password to join");

    await teammatePage.fill("#authPassword", "another correct horse battery staple");
    await teammatePage.click("#authSubmit");
    await expect(teammatePage.locator("#appView")).toBeVisible();

    // Shared org data, not a fresh blank account: the teammate's session reaches
    // the SAME niche the owner saved earlier in this file.
    await expect(teammatePage.locator("#niche")).toHaveValue(NICHE);
    await expect(teammatePage.locator("#memberList")).toContainText(email);
    // Members can't manage billing/invites — only the org owner can.
    await expect(teammatePage.locator("#inviteForm")).toBeHidden();

    await teammateContext.close();
  });
});
