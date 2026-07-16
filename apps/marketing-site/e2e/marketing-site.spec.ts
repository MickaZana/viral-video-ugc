import { expect, test } from "@playwright/test";

// Exercises public/script.js in a real browser — previously the only coverage
// was server-rendered HTML-string assertions (render.test.ts) and route tests
// (server.test.ts), neither of which ever executed the client-side JS itself
// (mobile nav toggle, video play/pause, the waitlist form's fetch call).

test("mobile nav toggle shows and hides the nav links", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  const navLinks = page.locator(".nav-links");
  await expect(navLinks).not.toBeVisible();

  await page.click("#navToggle");
  await expect(navLinks).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/nav-open/);

  await page.click("#navToggle");
  await expect(navLinks).not.toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/nav-open/);
});

test("clicking a ready video card plays it, then pauses it on a second click", async ({ page }) => {
  // The current content/video-manifest.json has exactly one "ready" entry (the
  // hero), which autoplays with no play/pause button — none of the gallery/UGC-wall
  // cards script.js's click-to-play logic actually targets are "ready" today, so
  // there's no such element on the live page to click. Rather than fake this with
  // a synthetic DOM fragment (which would test nothing about the real page), splice
  // one real ready video-card into the actual server response and let the browser's
  // normal script.js execution wire it up — this still exercises the production
  // click handler against real markup, just with augmented content.
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const readyCard = `
      <article class="video-card" data-id="e2e-ready" data-status="ready">
        <div class="video-card-media">
          <video poster="/videos/hero-reel.svg" muted loop playsinline preload="none">
            <source src="/videos/hero-reel.mp4" type="video/mp4" />
          </video>
          <button class="play-btn" aria-label="Play video">▶</button>
        </div>
      </article>`;
    await route.fulfill({ response, body: html.replace('<div class="video-grid">', `<div class="video-grid">${readyCard}`) });
  });
  await page.goto("/");

  const readyCard = page.locator(".video-card[data-status='ready']").first();
  await expect(readyCard).toBeVisible();

  const video = readyCard.locator("video");
  const playBtn = readyCard.locator(".play-btn");
  const media = readyCard.locator(".video-card-media");

  await expect(playBtn).toBeVisible();
  await media.click();
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(false);
  await expect(playBtn).toBeHidden();

  await media.click();
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.paused))
    .toBe(true);
  await expect(playBtn).toBeVisible();
});

test.describe("waitlist form", () => {
  test("a valid email shows a thank-you message and resets the form", async ({ page }) => {
    await page.goto("/");
    const emailInput = page.locator("#emailForm input[name='email']");
    await emailInput.fill("e2e-test@example.com");
    await page.click("#emailForm button[type='submit']");

    await expect(page.locator("#emailNote")).toHaveText(/Thanks — we'll reach out to e2e-test@example\.com/);
    await expect(emailInput).toHaveValue("");
  });

  test("an invalid email shows the server's validation error, not a fake success", async ({ page }) => {
    await page.goto("/");
    const emailInput = page.locator("#emailForm input[name='email']");
    // Bypass the input's own type="email" client-side validation so the request
    // actually reaches the server and we're testing its response, not the browser's.
    await emailInput.evaluate((el: HTMLInputElement) => (el.type = "text"));
    await emailInput.fill("not-an-email");
    await page.click("#emailForm button[type='submit']");

    await expect(page.locator("#emailNote")).toHaveText(/valid email/i);
  });

  test("the submit button shows a loading state while the request is in flight", async ({ page }) => {
    await page.route("**/api/waitlist", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto("/");
    await page.locator("#emailForm input[name='email']").fill("slow@example.com");
    const submitBtn = page.locator("#emailForm button[type='submit']");
    await submitBtn.click();

    await expect(submitBtn).toBeDisabled();
    await expect(submitBtn).toHaveClass(/btn-loading/);
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await expect(submitBtn).not.toHaveClass(/btn-loading/);
  });
});
