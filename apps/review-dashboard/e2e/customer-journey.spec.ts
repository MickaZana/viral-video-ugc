import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { expect, test, type Page } from "@playwright/test";
import { PRICING_TIERS, computeOverageCost } from "@vvugc/shared-billing";
import { STRIPE_WEBHOOK_SECRET } from "../playwright.config.js";

/**
 * The full self-service customer journey, end to end, in one continuous run —
 * previously each piece of this (signup, billing display, quota enforcement,
 * invites) was only tested in isolation (accounts.test.ts, billing-routes.test.ts,
 * run-quota.test.ts, webhook-lifecycle.test.ts), never as one flow through a
 * real browser. Integration seams between those pieces — e.g. does the pricing
 * this test signs up against actually match what the billing tab shows
 * post-webhook? Does an invited teammate's session really reach the inviting
 * owner's shared org data? — can't be caught by any of those unit-level suites
 * individually.
 *
 * This exercises the real control-panel SPA (apps/control-panel), not the old
 * server-rendered account-page.ts — that page (and its /account, /dashboard
 * routes) was retired once the SPA gained feature parity for team invites and
 * publishing connections. /account now redirects to /app; this test follows
 * that redirect like a real browser would.
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

test.describe("customer journey: signup → real pricing → billing → quota → invite", () => {
  const email = `e2e-customer-${randomUUID()}@example.com`;
  const password = "correct horse battery staple";
  const NICHE = `e2e-customer-niche-${randomUUID().slice(0, 8)}`;
  let accountId: string;
  let clientId: string;
  let csrfToken: string;

  let ownerPage: Page;
  test.beforeAll(async ({ browser }) => {
    ownerPage = await (await browser.newContext()).newPage();
    // Skip the first-run onboarding modal (components/Onboarding.tsx) — it's a
    // separate, already-covered feature, and its overlay otherwise blocks every
    // click this journey makes right after signup.
    await ownerPage.addInitScript(() => localStorage.setItem('ugu-onboarding-done', '1'));
  });
  test.afterAll(async () => {
    // The quota test below deliberately runs 4 real dry-run cycles (RunConfigSchema's
    // default maxCandidates, not scoped down) to exercise the real per-run limit, which
    // leaves a real batch of pending review items behind under NICHE. dashboard.spec.ts
    // asserts exact pending/total counts across the whole shared store when the full e2e
    // suite runs together — reject this test's own noise before closing so it doesn't
    // leak into that count, the same "don't leave the shared fixture data worse than you
    // found it" reasoning global-setup.ts's own comments already apply to dedicated niches.
    // ownerPage carries the owner's real session cookie (not operator Basic Auth —
    // a session cookie always wins over Basic Auth in the server's auth gate, so
    // this was never actually an operator-authenticated request). requireQueuePermission
    // deliberately requires a CSRF token for any session-cookie caller on queue
    // mutations, even one that omits Origin — so the reject below carries the same
    // X-CSRF-Token the real SPA attaches, captured from /accounts/me at signup.
    const pending = await ownerPage.request.get(`/queue?niche=${encodeURIComponent(NICHE)}&status=pending`);
    const pendingBody = await pending.json();
    const pendingItems: Array<{ id: string }> = Array.isArray(pendingBody) ? pendingBody : pendingBody.items;
    const ids: string[] = pendingItems.map((item) => item.id);
    if (ids.length > 0) {
      await ownerPage.request.post("/queue/bulk/reject", { data: { ids }, headers: { "X-CSRF-Token": csrfToken } });
    }
    await ownerPage.context().close();
  });

  test("signup reaches the real SPA workspace, and the pricing shown matches @vvugc/shared-billing's real tiers", async () => {
    const page = ownerPage;
    // /account is the old page's URL, kept alive only as a redirect into the SPA
    // — following it is exactly what a real bookmarked/linked-to /account visit does.
    await page.goto("/account?mode=signup");
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await page.fill("#email", email);
    await page.fill("#orgName", "E2E Customer Org");
    await page.fill("#password", password);
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();

    const me = await page.request.get("/accounts/me");
    const meBody = await me.json();
    accountId = meBody.account.orgId;
    csrfToken = meBody.csrfToken;

    // Billing tab's tier cards must show the exact real prices — this is the
    // assertion that the marketing site's pricing cards (render.ts's
    // renderPricingGrid) and the logged-in billing tab can never drift apart,
    // because both now read PRICING_TIERS directly.
    await page.getByRole("link", { name: "Billing" }).click();
    for (const tier of PRICING_TIERS) {
      await expect(page.locator("body")).toContainText(tier.name);
      await expect(page.locator("body")).toContainText(`$${tier.priceUsdPerMonth}`);
    }
    await expect(page.locator("body")).toContainText("NO PLAN");
  });

  test("creating a client reaches the real settings save, not a fixture", async () => {
    const page = ownerPage;
    const res = await page.request.post("/accounts/clients", {
      data: {
        name: "E2E Brand",
        niche: NICHE,
        brandVoice: "energetic, concise",
        platforms: ["tiktok"],
        targetDurationSec: 30,
        videoVendor: "gemini",
        cadence: "manual"
      }
    });
    expect(res.status(), "client creation should succeed").toBe(201);
    clientId = (await res.json()).client.id;
    expect(clientId).toBeTruthy();
  });

  test("a simulated Stripe checkout.session.completed webhook activates the Starter plan for real, and the billing tab reflects it", async () => {
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

    await page.goto("/app/billing");
    await expect(page.locator("body")).toContainText("Starter");
    await expect(page.locator("body")).toContainText("status: active");
    await expect(page.locator("body")).toContainText("included: 4 / month");
  });

  test("the Starter plan's real 4-run monthly limit is enforced as hybrid billing (never a hard block) — a 5th run in the same month is charged real overage, and the billing tab reflects it", async () => {
    const page = ownerPage;
    for (let i = 1; i <= 4; i++) {
      const res = await page.request.post("/accounts/run", { data: { clientId } });
      expect(res.status(), `run #${i} should succeed within the Starter limit`).toBe(200);
      const body = await res.json();
      expect(body.overage, `run #${i} is within the included allowance — no overage charge`).toBeNull();
    }
    const fifth = await page.request.post("/accounts/run", { data: { clientId } });
    expect(fifth.status(), "hybrid billing allows the run rather than hard-blocking with a 402").toBe(200);
    const fifthBody = await fifth.json();
    // Overage price scales with the client's targetDurationSec (30s, set at
    // creation above) via computeOverageCost — not the tier's flat base rate.
    const starter = PRICING_TIERS.find((t) => t.id === "starter")!;
    expect(fifthBody.overage?.priceUsdPerRun).toBe(computeOverageCost(starter.overagePriceUsdPerRun, 30));

    await page.goto("/app/billing");
    await expect(page.locator("body")).toContainText("Runs Used5");
    await expect(page.locator("body")).toContainText("Overage Runs1");
  });

  test("inviting a teammate from Settings produces a real /account/join link that a second browser session can use to reach the same org's shared data", async ({
    browser
  }) => {
    const page = ownerPage;
    await page.goto("/app/settings");

    const teammateEmail = `e2e-teammate-${randomUUID()}@example.com`;
    await page.getByPlaceholder("teammate@agency.com").fill(teammateEmail);
    await page.getByRole("button", { name: "Send Invite" }).click();
    await expect(page.locator("body")).toContainText(teammateEmail);
    const resultText = await page.locator("text=Invite link").textContent();
    const match = resultText?.match(/https?:\/\/\S+/);
    expect(match, `invite result should contain a link: "${resultText}"`).not.toBeNull();
    const inviteLink = match![0];
    expect(inviteLink).toContain("mode=invite&token=");

    // A brand-new browser context — no cookies, no shared state with the owner's
    // session above — proves the invite genuinely works for a different person,
    // not just "still logged in as the owner."
    const teammateContext = await browser.newContext();
    const teammatePage = await teammateContext.newPage();
    await teammatePage.addInitScript(() => localStorage.setItem('ugu-onboarding-done', '1'));
    await teammatePage.goto(inviteLink);
    await expect(teammatePage.getByText("You've been invited")).toBeVisible();

    await teammatePage.fill("#password", "another correct horse battery staple");
    await teammatePage.getByRole("button", { name: "Accept invite & join" }).click();
    await expect(teammatePage.getByRole("heading", { name: "This Week" })).toBeVisible();

    // Shared org data, not a fresh blank account: the teammate's session reaches
    // the SAME org the owner signed up above, and sees the owner in the team list.
    await teammatePage.getByRole("link", { name: "Settings" }).click();
    await expect(teammatePage.locator("body")).toContainText(email);
    // Members (the default invite role) can't manage the team — no invite form.
    await expect(teammatePage.getByPlaceholder("teammate@agency.com")).toHaveCount(0);

    await teammateContext.close();
  });
});
