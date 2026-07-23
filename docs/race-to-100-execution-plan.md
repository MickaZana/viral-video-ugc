# Race to 100% — Execution Plan

**Date:** 2026-07-22
**Current Engineering:** ~93%
**Current UX:** ~90%
**Target:** 100%

> **Completion update (2026-07-23):** The repository-controlled hardening,
> worker, observability, CI supply-chain, and YouTube OAuth work from this plan
> has been executed and verified. The authoritative owner-only launch checklist
> is now [`engineering-100-handoff.md`](./engineering-100-handoff.md). Meta is
> deliberately excluded from the current YouTube-only launch scope.

This is the actionable implementation plan. Every item is buildable today with no additional product-owner input unless explicitly noted.

---

## How to read this plan

Each phase groups items by **dependency**: nothing in a later phase blocks an earlier one, but completing a phase unlocks the next. Items within a phase are unordered — do whichever you have context for.

Each item includes:
- **Files to touch** — exact paths so you can open them directly
- **Test strategy** — how to verify it works
- **Effort** — rough estimate (hours or PRs)

---

## Phase 0 — Security Hardening (buildable now, ~3 PRs)

No owner input needed. These are the highest-leverage items because they close real vulnerability surfaces.

### P0.1 — Marketing site security headers

The marketing site (`apps/marketing-site/src/server.ts`) sets **zero** security headers. Visitors have no CSP, HSTS, X-Frame-Options, or X-Content-Type-Options protection.

**Files to touch:**
- `apps/marketing-site/src/server.ts` — Add the same security-headers middleware the review dashboard uses, at minimum: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Strict-Transport-Security: max-age=31536000; includeSubDomains` (production only), `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; script-src 'self'` (no `unsafe-inline` for scripts — the marketing site doesn't use inline JS).

**Test strategy:**
- Add a test that fetches `/` and asserts each header is present with the correct value
- Verify the existing render tests still pass (the CSP should not break anything since the marketing site loads CSS from a file and JS from a script tag)

**Effort:** ~30 min

### P0.2 — Strengthen review-dashboard CSP

The review dashboard currently allows `script-src 'self' 'unsafe-inline'` and `style-src 'self' 'unsafe-inline'`. The `unsafe-inline` on scripts nullifies CSP's XSS protection.

**Files to touch:**
- `apps/review-dashboard/src/server.ts` — Audit inline `<script>` tags in the rendered HTML. Where they exist (e.g., theme toggle, account page JS), extract to external `.js` files in a new `apps/review-dashboard/public/` directory and serve them statically. Then remove `'unsafe-inline'` from `script-src`.
- For `style-src`: the account page uses inline styles in some places. Either move to CSS classes, or use a nonce. If moving to classes is too invasive, keep `'unsafe-inline'` on `style-src` only (CSS injection is lower risk than JS injection).

**Test strategy:**
- Add CSP header assertions to existing server tests
- Run the e2e Playwright suite to confirm no page breaks from blocked resources
- Check browser console for CSP violation reports

**Effort:** ~2-3 hours

### P0.3 — Request body size limiting

Both apps use `express.json()` without a `limit` option, leaving them vulnerable to memory-exhaustion attacks.

**Files to touch:**
- `apps/review-dashboard/src/server.ts` — Change `express.json()` to `express.json({ limit: "1mb" })`
- `apps/marketing-site/src/server.ts` — Same change

**Test strategy:**
- Existing server tests still pass (payloads are well under 1MB)
- Any endpoint that legitimately accepts larger payloads (e.g., webhook with large metadata) — check; none currently do

**Effort:** ~10 min

### P0.4 — Validate bulk-endpoint inputs

`POST /queue/bulk/approve` and `POST /queue/bulk/reject` accept `ids: string[]` with no schema validation.

**Files to touch:**
- `apps/review-dashboard/src/server.ts` — Add Zod validation: `z.object({ ids: z.array(z.string().min(1)).min(1).max(100) })` to both bulk endpoints

**Test strategy:**
- Add test cases for: empty array, too-large array, non-string elements, valid array — correct 400 vs 200

**Effort:** ~30 min

### P0.5 — Development encryption key

The social token encryption key falls back to a hardcoded string `"development-only-social-token-key-32chars"` when `NODE_ENV !== "production"`. This is predictable.

**Files to touch:**
- `apps/review-dashboard/src/server.ts` (line ~44)
- `apps/review-dashboard/src/accounts.ts` (line ~156)
  - Replace the hardcoded string with `crypto.randomBytes(32).toString("hex")` so each dev session gets a unique ephemeral key

**Test strategy:**
- Existing tests pass (they use the dev path)
- Token encrypt/decrypt still round-trips correctly

**Effort:** ~15 min

### P0.6 — `__Host-` prefix on session cookies

The `__Host-` cookie prefix requires `Secure`, `Path=/`, and no `Domain` attribute — additional hardening.

**Files to touch:**
- `apps/review-dashboard/src/accounts.ts` — Change cookie name from `session` to `__Host-session` and verify the cookie options already set `Secure: true` in production and `Path: "/"`

**Test strategy:**
- Session-based tests still pass (login, session reads)
- Verify cookie name change is consistent in both set and read paths

**Effort:** ~15 min

---

## Phase 1 — Engineering Depth (buildable now, ~4 PRs)

Close the remaining test-coverage gaps, add basic error tracking, and harden observability.

### P1.1 — Test `packages/shared-auth/src/clients.ts`

This is the single largest untested business-logic file (158 lines). It implements `AgencyClientStore` with file-based CRUD, `claimDue` scheduling, and lock-based concurrency.

**Files to touch:**
- `packages/shared-auth/src/clients.test.ts` (new file)
  - Test `create`, `get`, `list`, `update`, `delete` on the file-based store
  - Test `claimDue` — creates clients with different schedules, confirms only due ones are claimed
  - Test lock contention — concurrent writes don't lose data
  - Test `loadClients` and `saveClients`

**Test strategy:**
- Use a temp directory (`mkdtempSync`) for each test
- No mocking needed — the store is self-contained file I/O
- Follow the pattern from `accounts.test.ts` and `sessions.test.ts` in the same package

**Effort:** ~2-3 hours

### P1.2 — Test `apps/orchestrator/src/acceptance.ts`

The acceptance test runner orchestrates multi-check verification and has no tests.

**Files to touch:**
- `apps/orchestrator/src/acceptance.test.ts` (new file)
  - Test each check function: `checkRunId`, `checkManifest`, `checkCostLedger`, `checkReviewItems`
  - Test the full `runAcceptance` flow with a seeded test run directory
  - Test reporting output format

**Test strategy:**
- Create fixture run directories with known manifest/cost-ledger/review-queue content
- Verify checks pass/fail correctly for valid vs. invalid fixtures

**Effort:** ~1-2 hours

### P1.3 — Test `apps/review-dashboard/src/scheduler.ts`

`runDueClientSchedules` and `startClientScheduler` have no tests.

**Files to touch:**
- `apps/review-dashboard/src/scheduler.test.ts` (new file)
  - Test `runDueClientSchedules` — seed clients with varied schedules, verify only due ones trigger
  - Test that the scheduler correctly enqueues pipeline jobs

**Test strategy:**
- Mock the client store and pipeline job store
- Control the "current time" via injected dependency or jest timer mock

**Effort:** ~1-2 hours

### P1.4 — Add error tracking stub

The project has no error tracking (no Sentry, no equivalent). Add a lightweight structured error-reporting mechanism.

**Files to touch:**
- `packages/shared-metrics/src/index.ts` or new `packages/shared-metrics/src/errors.ts`
  - Add a `reportError(error, context?)` function that:
    1. Logs the full error with pino (structured, with stack trace)
    2. Optionally writes to a `errors.ndjson` file in the runs directory
    3. Has a no-op stub that's easy to swap for a real Sentry integration later
- Wire `reportError` into both Express apps' global error middleware

**Test strategy:**
- Unit test the error reporter (formats correctly, writes expected output)
- Integration test: trigger an error through the Express error middleware, confirm the error is logged

**Effort:** ~1 hour

---

## Phase 2 — Infrastructure & CI/CD (buildable now, ~4 PRs)

Close the gaps in CI reliability, deployment verification, and infrastructure hygiene.

### P2.1 — Docker compose smoke test in CI

The single most recurring bug class in this project is missing COPY manifests in Dockerfiles. A `docker compose up` smoke test after each build would catch these before they reach production.

**Files to touch:**
- `.github/workflows/ci.yml` — Add a step (or a new job) after `build-and-push-images`:
  ```yaml
  - name: Docker compose smoke test
    run: |
      docker compose up -d
      sleep 10
      curl --fail http://localhost:4310/healthz  # review-dashboard
      curl --fail http://localhost:4320/healthz  # marketing-site
      docker compose down
    env:
      VVUGC_RUNS_DIR: /tmp/vvugc-test-runs
  ```

**Consideration:** The CI runner will need Docker available (it's available by default on `ubuntu-latest`). The smoke test doesn't need Postgres — it tests that the images *boot and serve*, not that they have a database.

**Test strategy:**
- The CI run itself validates this — if the smoke test fails, the workflow fails

**Effort:** ~1 hour

### P2.2 — Add CI timeout limits

None of the CI jobs set `timeout-minutes`, defaulting to GitHub's 360-minute max.

**Files to touch:**
- `.github/workflows/ci.yml` — Add `timeout-minutes: 15` to the `build-and-test` job and `timeout-minutes: 20` to `build-and-push-images`
- `.github/workflows/weekly-run.yml` — Add `timeout-minutes: 60` (pipeline runs can be long)

**Test strategy:**
- Trivial — just config change. Verify CI still passes.

**Effort:** ~10 min

### P2.3 — Fix `.dockerignore` / `.gitignore` asymmetry

`.gitignore` has `*.sqlite` but `.dockerignore` does not. If a `.sqlite` file exists in the tree at build time, it would be baked into the Docker image.

**Files to touch:**
- `.dockerignore` — Add `*.sqlite`

**Test strategy:**
- Trivial — no test needed

**Effort:** ~2 min

### P2.4 — Add SBOM and provenance to Docker builds

Enable supply-chain security features on the CI Docker builds.

**Files to touch:**
- `.github/workflows/ci.yml` — In the `docker/build-push-action@v6` step, add:
  ```yaml
  provenance: true
  sbom: true
  ```

**Test strategy:**
- Verify CI still passes. Check generated images for attestation manifest.

**Effort:** ~15 min

---

## Phase 3 — Deployment Flow (buildable now, ~2 PRs but needs your Fly account)

### P3.1 — Add Fly.io deploy workflow

Create a GitHub Actions workflow that deploys to Fly after a successful CI build on `main`.

**Files to touch:**
- `.github/workflows/deploy-fly.yml` (new file)
  - Trigger: `workflow_run` on successful `ci.yml` run on `main`, or `workflow_dispatch`
  - Uses `superfly/flyctl-actions/setup-flyctl@master` and `flyctl deploy --config fly.review-dashboard.toml` / `fly.marketing-site.toml`
  - Requires `FLY_API_TOKEN` secret

**Note:** This requires a Fly account and `FLY_API_TOKEN` set in GitHub secrets. The workflow file can be created now but will be dormant until the token is configured.

**Effort:** ~1 hour

### P3.2 — Node version matrix

The CI only tests against Node 20. Add Node 22 to the matrix.

**Files to touch:**
- `.github/workflows/ci.yml` — Convert the node setup step to a matrix:
  ```yaml
  strategy:
    matrix:
      node-version: [20, 22]
  ```

**Test strategy:**
- CI runs both versions. If Node 22 has issues, they surface immediately.

**Effort:** ~15 min

---

## Phase 4 — Requires Product Owner

These items cannot be closed by code changes alone. They require your credentials, accounts, or decisions.

### P4.1 — Run one live pipeline end-to-end

The single largest remaining unknown. Every adapter is real-shaped and doc-verified, but none has spent real money or produced a real video end-to-end.

**What's needed from you:**
- `ANTHROPIC_API_KEY` — Claude for script/QA/caption agents
- One video-gen vendor credential — Kling, Runway, Gemini, or Replicate (pick one)

**What to run:**
```
pnpm cli run \
  --niche "short-film-analysis" \
  --max-candidates 1 \
  --video-vendor kling \
  --platforms youtube
```

**Files to create:**
- `docs/live-run-evidence.md` — Record: run ID, provider job IDs, actual USD cost, total processing time, human quality decision

**Effort:** ~1 day (mostly waiting for vendor processing)

### P4.2 — Create real Stripe Price IDs

The billing UI is fully wired with Stripe. What's missing is live Product/Price objects in your Stripe dashboard.

**What's needed from you:**
- Log into Stripe dashboard
- Create three products: Starter ($39/mo), Growth ($99/mo), Agency ($249/mo)
- Set the resulting Price IDs as `STRIPE_PRICE_ID_STARTER`, `STRIPE_PRICE_ID_GROWTH`, `STRIPE_PRICE_ID_AGENCY` in production env

**Effort:** ~30 min

### P4.3 — Submit TikTok/Meta discovery API applications

External approval process. Code is ready and waiting.

**Files to submit:** Use the privacy policy and terms of service now served at `/privacy` and `/terms` on the marketing site.

**Effort:** External timeline (days to weeks)

### P4.4 — Enable GitHub Advanced Security (or make repo public)

The OSV scanner job runs but cannot upload SARIF results without GHAS. Two paths:
- Enable GHAS (requires business/enterprise plan)
- Make the repo public (osv-scan works with public repos)
- Or: just accept osv-scan as a CI gate without SARIF upload (current state)

**Effort:** Decision, not code

---

## Current engineering rating breakdown

| Category | Weight | Current | What moves it |
|---|---|---|---|
| Pipeline correctness | 25% | 95% | Live vendor call (P4.1) |
| Test coverage | 20% | 92% | P1.1-P1.3 (close test gaps) |
| Security hardening | 15% | 85% | Phase 0 (headers, CSP, size limits) |
| CI/CD reliability | 15% | 90% | P2.1-P2.4 (compose smoke test, timeouts) |
| Observability | 10% | 80% | P1.4 (error tracking stub) |
| Deployment readiness | 10% | 90% | P3.1 (Fly deploy workflow) |
| External integrations | 5% | 50% | P4.3 (TikTok/Meta approval) |
| **Total** | **100%** | **~93%** | |

### Moving the needle

Closing **Phase 0 + Phase 1 + Phase 2** (everything buildable without you) gets Engineering to **~97%**. The final 3% requires:

1. Live funded pipeline run (P4.1) — confirms every adapter works for real
2. TikTok/Meta API approval (P4.3) — closes the two remaining discovery sources
3. GHAS decision (P4.4) — unblocks SARIF upload or confirms the current posture is accepted

The UX rating (~90%) moves to 100% with:
- 30-60 days of real published content for the "content labs" public counter
- Live vendor account usage to validate the actual workflow
