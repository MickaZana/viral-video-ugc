# Race to 100% — Fix Plan

Baseline for this plan is the independently re-verified audit (not `docs/audit.md`'s
self-reported numbers): **Engineering ~90%, UX ~86%**, corrected down from 93%/86%
because the prior audit misfiled a real, buildable gap (unpatched CVEs failing CI)
as an external/business blocker. See "Verification results" recap below.

## Implemented in this pass (2026-07-18)

Everything in **P0** and most of **P1** below is now done, verified (typecheck +
full test suite green across all 20 workspace packages, plus all 21 e2e tests),
and found two real product bugs neither of the prior audits caught:

- **P0.1/P0.2 — all CVE and safe dependency bumps, done.** `vitest` 2→3.2.7,
  `vite` (transitive) forced to 6.4.3 and `esbuild` to 0.25.12 via a `pnpm.overrides`
  pin (closes all 5 CVEs osv-scan was failing on), plus `dotenv`, `pino`,
  `commander`, `express-rate-limit`, `nanoid`, `@types/node`, and
  `@anthropic-ai/sdk` (0.32.1→0.112.1, cost-ledger `usage` shape re-verified
  compatible).
- **zod 3→4 and express 4→5 — also done**, not deferred as originally planned once
  a route/pattern audit showed this codebase's usage surface was simple (no
  wildcard routes, no `req.query` reassignment, no `z.record`-with-enum-key
  outside one spot). Found and fixed one real breaking change: Zod 4 made
  `z.record()` with an enum key exhaustive by default (every enum member
  required as a key) — `RewrittenScript.platformNotes` (genuinely partial —
  Claude only returns notes for the platforms actually targeted) needed
  `z.partialRecord()` instead, or it rejected every real response. Express 5's
  now-automatic async-rejection forwarding made the repo's own `asyncHandler`
  wrappers redundant-but-harmless; comments updated, wrappers kept rather than
  ripped out across a dozen call sites for a purely cosmetic change.
- **Quota-enforcement scope boundary — documented** in `quota.ts`: CLI/cron runs
  are intentionally unmetered today; a one-line comment now flags this for
  whoever exposes CLI access to customers later.
- **P1.4 (alerting) — turned out to already be real**, not a gap: `weekly-run.yml`
  already runs with `--fail-on-zero-results`, and GitHub's own scheduled-workflow
  failure notification covers it. The original plan draft was wrong here; corrected
  above rather than building redundant infra.
- **Sections A3/A4 (the missing scripted E2E journeys) — both built**, in
  `apps/review-dashboard/e2e/`: `customer-journey.spec.ts` (signup → settings →
  real-pricing cross-check → simulated Stripe webhook → real quota-limit
  enforcement → teammate invite, one continuous authenticated session) and
  `operator-journey.spec.ts` (a real `runCycle()` dry-run → dashboard →
  approve → run history, not fixture-seeded data). Building them for real
  surfaced two genuine bugs no prior test caught:
  1. **The multi-seat invite link was completely broken.** `account-page.ts`
     sends the owner a link to `/account/join?token=...`, but that route was
     never registered — it fell through to the operator's Basic Auth gate and
     401'd for the exact teammate it was meant for. `docs/audit.md` had marked
     multi-seat/teams "✅ verified end-to-end" — it wasn't; the invite-creation
     API was tested, the link itself never was. Fixed in `server.ts`.
  2. **Approving/rejecting the last pending item in a filtered niche silently
     reset the niche filter to "All".** `populateFilterOptions()` derived the
     niche dropdown only from the currently-displayed (possibly now-empty)
     item set, dropping any active filter with zero matches back to no filter.
     Fixed in `render.ts`.
  3. (Infrastructure, not a product bug) `playwright.config.ts` re-evaluated
     its `mkdtempSync` unconditionally in every worker process, so a worker
     writing to the store directly (as `operator-journey.spec.ts` needs to)
     silently wrote to a different temp file than the one the actual webServer
     was reading — invisible until a test needed direct store access from a
     worker for the first time. Fixed by guarding on `VVUGC_DB_PATH` already
     being set.

Still open from this plan: P2 (funded vendor credentials, real Stripe Price
IDs, platform approval, GHAS decision) — correctly blocked on the product
owner, unchanged. Section A5 (a real `docker compose up` CI smoke test) and
the alerting trend-detection nice-to-have were not built this pass.

## Baseline recap (what verification actually found)

| Claim | Verdict | Detail |
|---|---|---|
| osv-scan is "blocked on GHAS, deferred by choice" | **Wrong** | It runs for real and fails on 5 real CVEs (1 Critical, 1 High, 3 Medium — esbuild, vite, vitest), all scanner-confirmed fixable by version bump. Not a business decision — a dependency bump nobody did yet. |
| 10 Dependabot PRs open since 2026-07-16 | **New finding**, not in audit.md | Includes a major-version-behind `@anthropic-ai/sdk` (0.32.1 → 0.112.1) — notable because this repo's entire cost-ledger/model-mix architecture depends on that SDK's shape. |
| Docker COPY manifests complete | **Verified** | All 16 packages present in all three Dockerfiles. |
| Accessibility (axe-core) real and CI-wired | **Verified** | Runs against real pages in both apps, in CI. |
| Quota enforcement (`checkRunQuota`) | **Verified, scope note** | Only gates `POST /accounts/run`. The CLI's `runCycle` (operator/cron path) has no billing concept and bypasses it by design — correct today, becomes a real gap only if CLI/cron access is ever exposed to paying customers directly. |
| `packages/shared-metrics` exists (Prometheus, request tracing, graceful shutdown) | **Underclaimed by audit.md** | Real capability that exists and isn't mentioned. Alerting on top of it is still missing. |
| Marketing site "Pricing" nav link | **Real gap, now fixed by this pass** | Previously led only to a feature-comparison table with no actual dollar amounts — the real $39/$99/$249 tiers only ever surfaced behind the `/account` signup+login wall. Fixed in this pass (see below). |

---

## Fix plan, prioritized

### P0 — Quick wins, fully within reach today (no owner input needed)

1. **Bump `vite`/`vitest`/`esbuild`** to the patched versions osv-scan already names in its own output. Closes the only currently-red CI job for a real reason, not by disabling the scanner.
2. **Work through the 10 open Dependabot PRs**, in this order:
   - `@anthropic-ai/sdk` first — this repo's whole cost-ledger/model-mix architecture (`packages/shared-cost`, `CLAUDE.md`'s model table) depends on its `usage` shape; verify nothing in `costLedger.recordAnthropicUsage` breaks against the new major version before merging.
   - `zod` 3→4 and `express` 4→5 next — both are real migrations, not drop-in bumps (Zod 4 changes some error-shape APIs; Express 5 changes async-handler error forwarding, which `apps/marketing-site/src/server.ts` already has a comment about working around for Express 4's behavior — re-verify that comment/workaround under Express 5 or remove it if the framework now handles it natively).
   - Remaining minor/patch bumps — batch-merge after CI is green on each.
3. **Marketing-site pricing page — done in this pass.** `renderPricingGrid()` in `apps/marketing-site/src/render.ts` now pulls real tiers from `@vvugc/shared-billing` (single source of truth shared with `/account`'s billing panel and Stripe checkout — no more invented numbers, no drift risk between the two surfaces) and renders a modern 3-card grid (`{{PRICING_GRID}}` in `index.html`, styles in `styles.css`: card-hover lift, gradient "Most popular" badge on the middle tier, kept the existing feature-comparison table below it rather than removing it). 17 render tests added/passing; `tsc -b` and the full marketing-site suite (server + render, 30 tests) verified green.

### P1 — Real engineering work, buildable without the owner

4. ~~Alerting on `runCycle` producing zero review items~~ **Already real — verified, not a gap.** `weekly-run.yml` already runs the CLI with `--fail-on-zero-results` (`apps/orchestrator/src/cli.ts`'s `determineExitCode`), so a silent empty run fails the job loudly instead of exiting 0, and GitHub's own scheduled-workflow-failure notification (automatic, no extra config) catches it. What's still genuinely missing is alerting on `/metrics`-level *trends* (e.g. a slow rise in per-run failure rate that never actually hits zero) — lower priority, not a "nothing pages anyone" gap as originally stated here.
5. **Document the quota-enforcement scope boundary explicitly** in code comments and `docs/audit.md` — CLI/cron runs are intentionally unmetered today. Not a bug, but worth a one-line note near `checkRunQuota` so a future change that exposes CLI access to customers doesn't silently reintroduce the exact "display vs. enforce" gap the last commit (c9317a4) just closed for the HTTP path.
6. **A/B testing UI** — audit.md correctly marks this 🔴 unstarted. Real, unblocked build whenever prioritized; not on this plan's critical path to 100% since it's a stated nice-to-have, not a claimed-done item that's actually broken.

### P2 — Blocked on the product owner (unchanged from audit.md, still accurate)

7. **Funded vendor credentials** (`ANTHROPIC_API_KEY` + one video/voice vendor) for a real, live end-to-end run. Single largest remaining unknown — every adapter is real-shaped and doc-verified, zero-dollar-spend-verified only.
8. **Real Stripe Price IDs** for the three tiers (`STRIPE_PRICE_ID_STARTER/GROWTH/AGENCY` env vars) — the dollar amounts are now real and public-facing (P0.3 above), but checkout still needs live Stripe product/price objects created in your Stripe dashboard before `startCheckout()` can complete a real purchase.
9. **TikTok/Meta discovery API approval** — external application process.
10. **GitHub Advanced Security decision** — enable it, or accept osv-scan as the only gate (now that P0.1/P0.2 make it actually meaningful instead of perpetually red).
11. **"Content labs" public live-counter** — needs 30-60 days of real published content this pipeline hasn't produced yet.

---

## Section A — Automated End-to-End Test Plan

Goal: every claim in this plan and in `docs/audit.md` should be re-verifiable by running a command, not by re-reading a commit message. This section is what CI should run (or already runs) on every push to `main`; gaps below are what's missing from that guarantee today.

**A1. Unit + integration suites (exists, keep green)**
- All 20 workspace packages' `vitest` suites (`turbo run test`). In this sandbox, memory-constrained runs must use `node --max-old-space-size=2048 <vitest> run --pool=forks --poolOptions.forks.singleFork=true` per-package rather than a single recursive run — document this in `CONTRIBUTING`/`docs/` so it isn't rediscovered every session.
- Explicit coverage floor to watch as dependency bumps land (P0.2): billing webhook lifecycle (9 event cases), quota enforcement (3 cases), pricing-grid rendering (new, 3 cases), accounts/sessions (11 cases), server HTTP API (26+13 cases across both apps).

**A2. Accessibility (exists, keep green)**
- `@axe-core/playwright` scans in `apps/review-dashboard/e2e` and `apps/marketing-site/e2e`, wired into CI via `pnpm test:e2e` after a Chromium install step.
- **Add to this suite**: a scan pass over the new pricing section specifically (the gradient "Most popular" badge and card-hover states are new DOM/CSS since the last a11y pass) — cheap addition, same fixture, just assert the scan still includes `#pricing`.

**A3. Full customer journey, scripted (missing — build this)**
A single Playwright script that never existed as one flow (today it's tested in disconnected unit pieces): sign up → save settings → view real pricing on the marketing site and cross-check the number shown matches `/accounts/billing`'s tier list (now enforceable since both read the same `PRICING_TIERS` source) → start Stripe checkout in test mode → simulate the webhook (`checkout.session.completed`) → confirm `/accounts/billing` reflects the new plan → hit the run-quota boundary (4/4 on Starter) and confirm a real 402 → invite a teammate → confirm the teammate's session reaches shared settings/usage. Most of the underlying routes are already individually tested; this suite's value is catching integration seams between them that unit tests structurally can't see (e.g., a schema drift between what `/accounts/billing` returns and what the marketing site's pricing cards now assume).

**A4. Full operator journey, scripted (missing — build this)**
CLI dry-run → review-dashboard queue populated → filter/bulk-approve → run history reflects the cost ledger → publish an approved item through each of the four adapters in a mocked-vendor mode (TikTok/Facebook/YouTube/Instagram Reels) → confirm the signed public-asset URL for Instagram is actually fetchable and time-limited (verified once per adapter today; not as one continuous scripted path).

**A5. Docker/deploy verification (partially missing)**
- CI already builds and pushes all three images — real.
- **Missing**: an actual `docker compose up` smoke test in CI (or at least on a schedule) that starts all three real containers against `docker-compose.yml`, waits for `/healthz` on each, and hits one authenticated route per app. This is the only way to catch a COPY-manifest regression (this repo's single most recurring bug class) before it reaches production rather than after a push fails.

---

## Section B — Manual / Exploratory End-to-End Test Plan

Goal: things a scripted suite structurally cannot verify — visual correctness, real third-party behavior, and the actual first-five-minutes experience of a new user. Run this once before any release that changes UI or billing, and once fully before calling the product "10/10."

**B1. Visual/UX walkthrough, both themes, real browser**
- Load `/` (marketing site): hero, stage grid, agency section, gallery, UGC wall, **new pricing cards** (check the "Most popular" badge lands on Growth, card-hover lift feels intentional not janky, mobile breakpoint at 900px stacks cards with Growth first), comparison table, CTA form. Submit a real waitlist email and confirm the rate limiter kicks in after 10 attempts.
- Load `/account` signed out → sign up → toggle the **new light/dark theme switch** and confirm every card, form, and the pricing/billing panel readably restyles in both modes, confirm the choice survives a reload (localStorage) and doesn't flash the wrong theme on load.
- Load the operator dashboard with real Basic Auth, exercise filters, bulk actions, run history, and the scene/script regeneration editor panel by hand.

**B2. Real-money / real-vendor smoke test (do this once funded credentials exist — P2.7/P2.8)**
- One real Stripe test-mode checkout end to end, confirm the card on file in Stripe's dashboard, cancel it, confirm `/account` reflects cancellation within the webhook's normal delay.
- One real `vvugc run` (live, not dry-run) against one funded video/voice vendor, watching cost-ledger output match what the vendor's own billing dashboard shows, end to end through to a real file landing in the review queue.
- One real publish to one platform (start with whichever of TikTok/FB/YouTube/IG has fastest approval) from an `approved` queue item, confirmed by actually opening the post on that platform.

**B3. Cross-device/responsive pass**
- Real phone (not just DevTools emulation) for the marketing site hero video and pricing cards — `phone-frame` CSS and the 3-column-to-1-column pricing collapse are exactly the kind of thing DevTools emulation can hide subtle issues in (safe-area insets, tap-target sizing on the price-cta buttons).

**B4. Failure-path walkthrough**
- Kill the review-dashboard mid-request to confirm `installLifecycleHandlers`'s graceful-shutdown path doesn't drop an in-flight approve/reject.
- Submit a Stripe webhook with an unrecognized `tierId` by hand (curl with a crafted signed payload) and confirm the "fail open, don't block a paying customer" behavior documented in commit c9317a4 actually holds in a live server, not just in `webhook-lifecycle.test.ts`.

---

## Bottom line

Nothing above requires re-deciding architecture. The fastest path to a real, verifiable 10/10:
1. P0 (CVE bump + Dependabot queue) closes the one currently-red, currently-mislabeled CI job — do this first, it's the highest-leverage item and entirely within reach.
2. P1 items (alerting, scope documentation) are real but small.
3. Sections A3–A5 (the missing scripted E2E suites) are what turns "we tested the pieces" into "we tested the product" — build these before the next claim of "verified end-to-end."
4. P2 stays correctly blocked on you — funded credentials, real Stripe price IDs, platform approvals, and the GHAS decision are the only items nothing above can close without you.
