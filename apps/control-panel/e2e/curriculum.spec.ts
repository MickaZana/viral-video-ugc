import { expect, test, type Page } from "@playwright/test";

// End-to-end acceptance for Curriculum Mode against the real review-dashboard
// backend (no route mocks — the server's own hermetic MOCK generators run
// because playwright.config.ts never sets VVUGC_LLM_LIVE):
//   1. §43 — the enabled-mode sub-nav: every section renders real data, no fetch
//      errors.
//   2. §59 — the full acceptance chain: create course → generate plan (starter
//      outline) → approve & lock → script a lesson → dry-run production → the
//      review queue, asserted on durable backend data, not just the UI.
//   3. Curriculum Mode is fully additive: toggling it off returns the app to
//      exactly Standard VUGC, and that survives a reload.
//
// The `signup` helper is a trimmed copy of the one in workspace.spec.ts — the
// account store persists for the whole run, so every signup needs a unique
// email.

let signupCounter = 0;
async function signup(page: Page): Promise<void> {
  const email = `e2e-curriculum-${Date.now()}-${signupCounter++}@example.com`;
  // Skip the first-run onboarding modal — its overlay would otherwise block the
  // clicks this suite makes right after signup.
  await page.addInitScript(() => localStorage.setItem("ugu-onboarding-done", "1"));
  await page.goto("/app");
  await page.getByRole("button", { name: "Get Started", exact: true }).first().click();
  await page.getByRole("button", { name: "SIGN UP" }).click();
  await page.locator("#email").fill(email);
  await page.locator("#orgName").fill("E2E Curriculum Org");
  await page.locator("#password").fill("hunter22");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
}

/** Toggle Standard → Curriculum via the workspace header button and land on the
 *  enabled Curriculum workspace. */
async function enableCurriculumMode(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Switch to Curriculum Mode" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Curriculum Mode" }).click();
  await expect(page).toHaveURL(/\/curriculum$/);
  await expect(page.getByRole("heading", { name: "Education Engine" })).toBeVisible();
}

test("§43: Curriculum Mode sub-nav — every section renders real data, no fetch errors", async ({
  page
}) => {
  await signup(page);
  await enableCurriculumMode(page);

  // Each sub-nav tab: click it, assert its section rendered a known real label,
  // and assert neither a client-side fetch failure ("Load error") nor a server
  // 500 body ("Internal error") leaked onto the page. A fresh org has no courses
  // yet, so the honest empty states are what should render.
  const sections = [
    { link: "Overview", marker: (p: Page) => p.getByText("No courses yet", { exact: true }) },
    { link: "Courses", marker: (p: Page) => p.getByRole("button", { name: /New course/ }) },
    { link: "Learn", marker: (p: Page) => p.getByText(/what to learn next/) },
    { link: "Projects", marker: (p: Page) => p.getByText(/capstone work by module/) },
    { link: "Produce", marker: (p: Page) => p.getByText(/pick a course/) },
    { link: "Schedule", marker: (p: Page) => p.getByText(/what is next per course/) }
  ] as const;

  for (const section of sections) {
    await page.getByRole("link", { name: section.link, exact: true }).click();
    await expect(section.marker(page).first()).toBeVisible();
    await expect(page.locator("text=Load error")).toHaveCount(0);
    await expect(page.locator("text=Internal error")).toHaveCount(0);
  }
});

test("§59 acceptance: Agentic AI Simplified travels curriculum → plan → approve → script → dry-run production → review queue", async ({
  page
}) => {
  test.setTimeout(180_000);

  await signup(page);
  // Auto-accept the "Approve & lock" window.confirm.
  page.on("dialog", (dialog) => {
    void dialog.accept();
  });
  await enableCurriculumMode(page);

  // ── Create the course through the wizard, with the starter outline ──
  await page.getByRole("link", { name: "Courses", exact: true }).click();
  await page.getByRole("button", { name: /New course/ }).click();
  await expect(page).toHaveURL(/\/curriculum\/courses\/new$/);

  await page.getByLabel("Title", { exact: true }).fill("Agentic AI Simplified");
  await page.getByLabel("Topic", { exact: true }).fill("Agentic AI");
  await page.getByLabel("Audience", { exact: true }).fill("Engineers new to AI agents");
  await page.getByLabel("End goal", { exact: true }).fill("Ship a small autonomous agent");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create course" }).click();

  // The wizard either navigates straight to the course page, or parks on the
  // "starter plan generated" summary (only when the generated plan has QA
  // warnings) with a "View course" button.
  const summaryButton = page.getByRole("button", { name: /View course/ });
  const courseUrlRe = /\/curriculum\/courses\/(?!new$)[^/?#]+$/;
  await expect
    .poll(
      async () =>
        courseUrlRe.test(new URL(page.url()).pathname) ||
        (await summaryButton.isVisible().catch(() => false)),
      { timeout: 60_000 }
    )
    .toBe(true);
  if (await summaryButton.isVisible().catch(() => false)) {
    await summaryButton.click();
  }
  await expect(page).toHaveURL(courseUrlRe);
  const id = new URL(page.url()).pathname.split("/").pop() as string;
  expect(id.length).toBeGreaterThan(0);

  // ── Durable-data assertion (the crux): 20 modules × 10 lessons = 200
  //    lessons, plus one capstone project per module ──
  const detail = (await (await page.request.get(`/accounts/curricula/${id}`)).json()) as {
    counts: { modules: number; lessons: number; projects: number };
    course: { status: string; activeVersion: number | null };
  };
  expect(detail.counts.modules).toBe(20);
  expect(detail.counts.lessons).toBe(200);
  expect(detail.counts.projects).toBe(20);
  expect(detail.course.status).toBe("planned");

  // …and the same reality is on screen: the course shape line + a 20-row module
  // list (every module row shows its "10 lessons" count).
  await expect(page.getByText(/20 modules . 10 lessons/)).toBeVisible();
  await expect(page.getByRole("button", { name: /10 lessons/ })).toHaveCount(20);

  // ── Approve & lock ──
  await page.getByRole("button", { name: "Approve & lock" }).click();
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/accounts/curricula/${id}`);
        const body = (await res.json()) as { course: { status: string } };
        return body.course.status;
      },
      { timeout: 30_000 }
    )
    .toBe("active");
  const locked = (await (await page.request.get(`/accounts/curricula/${id}`)).json()) as {
    course: { status: string; activeVersion: number | null };
  };
  expect(locked.course.status).toBe("active");
  expect(locked.course.activeVersion).toBe(1);

  // ── Script + produce lesson 1 of module 1 via the API ──
  const me = (await (await page.request.get("/accounts/me")).json()) as { csrfToken: string };
  const csrfHeaders = { "X-CSRF-Token": me.csrfToken };

  const modulesBody = (await (
    await page.request.get(`/accounts/curricula/${id}/modules`)
  ).json()) as { modules: Array<{ id: string; order: number }> };
  const module1 = [...modulesBody.modules].sort((a, b) => a.order - b.order)[0];
  expect(module1).toBeTruthy();

  const module1Body = (await (
    await page.request.get(`/accounts/curricula/${id}/modules/${module1.id}`)
  ).json()) as { lessons: Array<{ id: string; globalOrder: number }> };
  const lesson1 = [...module1Body.lessons].sort((a, b) => a.globalOrder - b.globalOrder)[0];
  expect(lesson1).toBeTruthy();

  const scriptRes = await page.request.post(
    `/accounts/curricula/${id}/lessons/${lesson1.id}/script`,
    { headers: csrfHeaders, data: {} }
  );
  expect(scriptRes.status()).toBe(200);

  const produceRes = await page.request.post(
    `/accounts/curricula/${id}/lessons/${lesson1.id}/produce`,
    { headers: csrfHeaders, data: {} }
  );
  expect(produceRes.status()).toBe(202);
  const produceBody = (await produceRes.json()) as {
    asset: { reviewItemId?: string; generationRunId: string; status: string };
    run: { runId: string; dryRun: boolean };
  };
  const runId = produceBody.run.runId;
  const reviewItemId = produceBody.asset.reviewItemId;
  expect(runId.length).toBeGreaterThan(0);
  expect(reviewItemId).toBeTruthy();
  expect(produceBody.run.dryRun).toBe(true);

  // ── Review-queue assertion: the dry-run production landed a review item, and
  //    the CurriculumAsset points at exactly that item ──
  const queueBody = (await (await page.request.get("/api/queue")).json()) as
    | Array<{ id: string; runId: string; dryRun: boolean }>
    | { items: Array<{ id: string; runId: string; dryRun: boolean }> };
  const items = Array.isArray(queueBody) ? queueBody : queueBody.items;
  const queued = items.find((i) => i.runId === runId);
  expect(queued).toBeTruthy();
  expect(queued!.id).toBe(reviewItemId);
  expect(queued!.dryRun).toBe(true);

  // ── The course's asset ledger records the produced short video in "review" ──
  const assetsBody = (await (
    await page.request.get(`/accounts/curricula/${id}/assets?assetType=short_video`)
  ).json()) as { assets: Array<{ generationRunId: string; status: string }> };
  const producedAsset = assetsBody.assets.find((a) => a.generationRunId === runId);
  expect(producedAsset).toBeTruthy();
  expect(producedAsset!.status).toBe("review");

  // ── The Produce dashboard for this course shows the one produced asset ──
  await page.getByRole("link", { name: "Produce", exact: true }).click();
  await page.getByRole("button", { name: /Agentic AI Simplified/ }).click();
  await expect(page.getByRole("heading", { name: "Agentic AI Simplified" })).toBeVisible();
  await expect(page.getByText("Assets (1)")).toBeVisible();
  await expect(page.locator("text=Load error")).toHaveCount(0);
});

test("Standard Mode is unaffected — toggling Curriculum off returns the app to exactly Standard VUGC", async ({
  page
}) => {
  await signup(page);
  await enableCurriculumMode(page);

  // Toggle back off — navigates home to Standard VUGC.
  await page.getByRole("button", { name: "Switch to Standard Mode" }).click();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to Curriculum Mode" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Education Engine" })).toHaveCount(0);

  // A Standard nav destination still works and renders real data.
  await page.getByRole("link", { name: "Studio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Studio", exact: true })).toBeVisible();
  await expect(page.locator("text=Load error")).toHaveCount(0);

  // Back home, then a full reload: still Standard, not Curriculum — the mode is
  // server-persisted OFF, and nothing about Curriculum Mode lingers.
  await page.getByRole("link", { name: "This Week", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "This Week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Education Engine" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Switch to Curriculum Mode" })).toBeVisible();
});
