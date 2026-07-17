# Holistic Audit — Engineering & UX Completeness

Snapshot as of this audit. Ratings are honest, not aspirational — "built" means verified working, not just written.

## Overall (current — supersedes every rating below it)

| Dimension | Estimate | Read |
|---|---|---|
| **Engineering** (pipeline correctness, integration coverage, production-readiness) | **~93%** (was ~88%) | This pass closed the last two genuinely-buildable engineering gaps from the punch list: **Instagram Reels publishing** (a self-hosted, signed, time-limited public video URL — `apps/review-dashboard/src/public-assets.ts` — unblocks Meta's Content Publishing API, which needs a fetchable `video_url` this pipeline previously had no way to supply) and a **real accessibility audit** (axe-core e2e scans against every page in both apps, in CI; found and fixed 2 genuine WCAG issues). Also found and fixed a real recurring bug class: `packages/shared-billing` (added two passes ago) was missing from all three Dockerfiles' COPY manifests, breaking `pnpm install --frozen-lockfile`'s workspace resolution — caught by CI actually failing, not by re-reading the Dockerfile. What still holds this below ~97: no vendor (video-gen, voiceover, publishing) has ever completed a live call against a funded/authorized account (structurally not closeable without you providing credentials); TikTok/Meta discovery approval is an external process, not code; GHAS/osv-scan remains disabled at your explicit choice; deeper observability (error tracking, log aggregation) is still just structured stdout logs + the cost ledger. |
| **UX** (what a user/customer actually touches) | **~86%** (was ~62%) | This pass shipped essentially the entire prior UX punch list in one continuous push: a self-service onboarding + settings panel (`/account`), trend charts (a real spend-over-time bar chart, not just a flat table), multi-language script generation (`locale` threaded through script-agent and the schema), Stripe billing scaffolding with clearly-marked placeholder tiers (checkout, webhook, plan gating), multi-seat/teams (org accounts, invite links, owner-gated billing/invites — verified end-to-end: an invited teammate's session genuinely reaches the owner's shared settings/usage/billing data), and a real accessibility audit. What still holds this below ~90: billing UI is wired against invented placeholder dollar amounts, not your real pricing; the "content labs" public-metrics concept still needs 30-60 days of real published content this pipeline hasn't produced yet; nobody has actually used any of this against a live, funded vendor account. |

---

## This pass (2026-07-17, later — punch-list completion pass)

Scope: work through the prior pass's punch list end-to-end, split into "within reach alone" vs. "needs the product owner" per an explicit triage — live vendor testing and real pricing tiers were deferred by your choice (funded credentials to come later; billing built with placeholder tiers you can edit); everything else below was closed.

**What shipped, in order:**

1. **Self-service onboarding + settings panel** (`/account`) — signup/login, a real settings form (niche, brand voice, platforms, target duration, video/voice vendor, cadence) backed by a new `packages/shared-auth/src/settings.ts`, and a "Run now" button (dry-run by default, an explicit checkbox to spend real vendor credits). Previously this was CLI flags or GitHub Actions workflow inputs only.
2. **Trend charts** — the account page's usage panel now renders a real per-run spend bar chart (last 20 runs), not just the flat run-history table.
3. **Multi-language script generation** — `locale: z.string().default("en")` threaded through `RunConfigSchema`/`RewrittenScriptSchema`, `script-agent.ts`'s prompt, and a new `--locale` CLI flag. Along the way, found and fixed a real Unicode bug: `packages/shared-originality`'s tokenizer was ASCII-only (`[^a-z0-9\s']`), which would silently reduce any non-Latin-script text (Japanese, Arabic, Korean) to zero tokens — fixed to `[^\p{L}\p{N}\s']` with the Unicode regex flag.
4. **Billing scaffolding** (`packages/shared-billing`, new package) — real Stripe integration (Checkout Sessions, webhook signature verification, plan storage), three tiers with dollar amounts explicitly commented as placeholders "never provided by the product owner," gated to the org owner. The Stripe webhook route is registered before Express's JSON body parser specifically because HMAC signature verification needs the raw bytes — get that ordering wrong and it silently breaks.
5. **Multi-seat/teams** — an `orgId`/`role` indirection on `Account` (every solo signup is its own one-person org; inviting a teammate links their `orgId` to the inviter's), so settings/usage/billing are shared across an org instead of siloed per login. Invite links are returned directly in the API response for the owner to send themselves (no email infrastructure exists in this repo, same posture as everywhere else deliberately unbuilt). Invite/billing management is gated to owners with real 403s. Verified end-to-end, not just "signup succeeded": an invited teammate's session genuinely reaches the owner's previously-saved settings.
6. **Instagram Reels publishing** — the last unimplemented publish target. `apps/review-dashboard/src/public-assets.ts` signs a short-lived, HMAC-verified public URL for a single video file under `VVUGC_RUNS_DIR`, served from a route reachable without the operator's Basic Auth (same posture as `/account`). `getPublishAdapter("instagram_reels")` now returns a real adapter (media-container create → poll `status_code` until `FINISHED` → `media_publish`) instead of throwing. Verified with a real Express server + real HTTP fetch of the signed URL, and a publish-route test confirming the actual `video_url` sent to Meta is the signed public URL, not the raw local path.
7. **Real accessibility audit** — `@axe-core/playwright` scans, run in a real browser via the existing Playwright e2e suites (already wired into CI), against every real page: the operator queue dashboard, both `/account` states (signed-out and signed-in with the Team panel actually populated), and the marketing homepage including its mobile nav. Two real findings, both fixed: a horizontally-scrollable comparison table with no keyboard access (`tabindex="0"` + `role="region"` + a shared `[tabindex]:focus-visible` ring), and an unlabeled invite-email input (added a visually-hidden `<label>`).
8. **A recurring bug class caught again, by CI actually failing.** `packages/shared-billing` (added in step 4 above) was missing from all three Dockerfiles' COPY manifests — same failure mode as the `shared-auth`/`shared-originality`/`mcp-publish` miss from the prior pass: `pnpm install --frozen-lockfile` never creates a package's `node_modules` symlink if its `package.json` isn't copied in before that install layer, surfacing much later as `Cannot find module 'stripe'` deep inside the full-repo build. Fixed and verified with a real local `docker build` run to completion before pushing, not just re-reading the Dockerfile.

**Deliberately not done, and why (same reasoning as before, now the only things left):**
- **Live vendor calls with funded credentials** — you chose to defer this ("I'll provide `ANTHROPIC_API_KEY` + one video/voice vendor later"); every adapter is real-shaped and tested against real docs, zero-dollar-spend-verified only.
- **Real pricing tiers** — billing was built with placeholder dollar amounts by your choice; swapping in real numbers is a config change, not an engineering task.
- **TikTok/Meta discovery API approval, GHAS/osv-scan** — external processes / your explicit prior choice, unchanged.

---

## Prior pass (2026-07-17 — repo push, CI, and product-depth pass)

**What actually shipped, in order:**

1. **Got the repo deployable for the first time.** Created `github.com/MickaZana/viral-video-ugc`, committed ~110 previously-uncommitted files across 7 logical commits, discovered CI had never once run (default branch was `master`, workflow only triggers on `main`), fixed it, and then found and fixed **four real, previously-undiscoverable bugs** purely by watching real CI execute on a clean Linux runner instead of this Windows dev sandbox:
   - `ffmpeg-static` doesn't bundle `ffprobe` — silently worked locally (a system `ffprobe` happened to be on PATH), failed outright in CI. Fixed with `ffprobe-static` + explicit `setFfprobePath()`.
   - All three Dockerfiles were missing `packages/mcp-voiceover`'s (and later `shared-auth`/`shared-originality`/`mcp-publish`'s) `package.json` from their COPY manifests — `pnpm install --frozen-lockfile` never created those workspace symlinks, so `tsc -b` failed with "Cannot find module" the moment those packages were referenced.
   - `yt-dlp-exec` (added for ASR) runs a `preinstall` hook requiring a system `python` binary — `node:20-slim` has none. Then, once `python3` was added, discovered Debian's `python3` package deliberately does *not* symlink `/usr/bin/python` — needed `python-is-python3` too.
   - A `switch` in `mcp-publish/src/lib.ts` type-checked fine locally but produced a real TS2366 in the Docker build, traced back to the missing-COPY-manifest bug above breaking module resolution; hardened with an explicit `default` case regardless.

   **Net result: `build-and-test` and all three `build-and-push-images` jobs are now green on real CI.** This is the first time in this project's history any of that has been true.

2. **ASR closed end-to-end.** `transcribeWithAsrFallback` used to `throw` unconditionally. `packages/mcp-transcript/src/audio-extract.ts` now wires in `yt-dlp` (via `yt-dlp-exec`) to pull audio from a candidate's URL and hand it to the already-real Whisper client — no more gap between "Whisper client is real" and "nothing ever calls it with real bytes."
3. **Originality/compliance scoring** (`packages/shared-originality`) — free, deterministic, no LLM call: 5-word n-gram Jaccard similarity for wording, sentence-count/length ratio for structure, exact 6+-word phrase-overlap detection as concrete evidence for a reviewer. Runs on every candidate; surfaced in the dashboard next to the Claude virality score.
4. **Scene/script regeneration** — a reviewer can edit hook/points/cta or regenerate a single scene without re-running discovery/transcript/script-rewrite. Backed by a new `replaceReviewItem` on the review-queue store (both JSON and Postgres backends) and a minimal-but-real dashboard editor panel.
5. **Accounts, sessions, and usage metering** (`packages/shared-auth`) — real signup/login (scrypt-hashed passwords), expiring/revocable sessions, and `aggregateUsage` reading real run manifests + cost ledgers per account. This is genuinely new: the product previously had zero concept of "a customer," only a single operator behind Basic Auth.
6. **Publishing adapters** (`packages/mcp-publish`) — TikTok Content Posting API, Facebook Page video (resumable upload), YouTube Data API v3 resumable upload, all verified against each platform's current REST docs. Reachable only from `POST /queue/:id/publish` on an already-`approved` item — the human-review gate this whole architecture is built around stays intact.
7. **Marketing copy repositioned** around the actual ICP (agencies running 5-20 client accounts) instead of a generic solo-creator pitch.

**Deliberately not done, and why:**
- **Billing/Stripe** — needs real pricing-tier decisions, not something to invent.
- **Self-service onboarding UI, settings panel, trend charts** — real frontend builds, sequenced behind auth (now in place) rather than done blind.
- **TikTok/Meta live discovery, any live vendor call** — external approval or funded credentials this session doesn't have; code is real and ready, going live is a business/access step, not an engineering one.
- **Code scanning (osv-scan)** — blocked on GitHub Advanced Security, which isn't enabled on this private repo; explicitly deferred per your own choice.

---

## Verified in this pass (deployment-readiness pass, follow-up to the hygiene pass below)

Scope this time: close as much of the engineering-production-readiness and UX-dashboard gap as could be done for real (build-verified, test-verified, or live-curled) without spending further vendor credits or making untested live vendor API calls, per the same constraint as the prior pass.

**Engineering:**
- **Concurrency-safe review-queue.** The JSON-file store's read-all/write-all cycle was a real race (two rapid dashboard clicks, or a dashboard write racing a CLI run's insert, could silently drop a write). Added an exclusive lockfile (`open(path, "wx")`) around every read-modify-write cycle in `packages/review-queue/src/db.ts`. Verified with a 20-concurrent-insert test that confirms no writes are lost and no `.lock` file is left behind.
- **Real Whisper ASR client.** `transcribeWithAsrFallback` used to unconditionally `throw`. `packages/mcp-transcript/src/asr.ts` now has a real, tested (mocked-fetch) OpenAI Whisper API client — multipart upload, bearer auth, verbose_json parsing into the shared `Transcript` shape. What's still missing is the audio-*extraction* step (yt-dlp or a platform downloader) to turn a candidate's URL into bytes to send it — that boundary is now the single, explicit, correctly-scoped gap instead of the whole ASR path being unbuilt.
- **Real cost/usage tracking.** `packages/shared-cost` is a new ledger that records real Claude token usage (from the Anthropic SDK's actual `message.usage` on every script-rewrite/caption/QA call) and per-clip counts for whichever video-gen vendor ran, and estimates USD from a rate table. Every run now writes `runs/<runId>/cost-ledger.json` and the CLI prints an estimate — `docs/cost-table.md` was previously a fill-in-by-hand template with zero code support.
- **Real deployable scheduling.** `.github/workflows/weekly-run.yml` runs `vvugc run` on a `cron:` trigger (and on-demand via `workflow_dispatch`) using GitHub Actions secrets for vendor keys, uploading `runs/` as a downloadable artifact. Unlike the EventBridge path (still docs-only, now positioned as the heavier-scale option in `infra/cron/README.md`), this is real and deployable the moment the repo is pushed to GitHub with secrets set — no AWS account needed. This directly closes "infra/cron is documentation only" for the common single-niche case.
- **Containerization.** `Dockerfile.orchestrator`, `Dockerfile.review-dashboard`, `Dockerfile.marketing-site`, and `docker-compose.yml` at the repo root — multi-stage builds following the same `pnpm -r run build` pattern already verified in CI. **Caveat, stated plainly:** this sandbox has no running Docker daemon, so these images could not actually be built and run here — they're syntactically complete and follow the verified build pattern, not build-verified. Build them for real before trusting them in production.
- **A real bug found by live-testing the dashboard, not by the test suite alone.** The new bulk-approve/reject routes (`POST /queue/bulk/approve`) were registered *after* `POST /queue/:id/approve` — Express matched `:id="bulk"` first and 404'd. Caught by actually curling the endpoint after building, not by TypeScript or the initial test pass (which only asserted response shape, not that the right handler ran). Fixed by reordering route registration; added a comment explaining why the order matters so it doesn't regress.

**UX:**
- **Shared design system.** New `packages/design-tokens` package (`tokens.css`, served at `/tokens.css` by both apps via `require.resolve`) — palette, type scale, and `.btn`/`.card`/`.pill`/`.input` primitives with a visible focus-visible ring. Marketing site's `styles.css` had its ~60 lines of duplicated base tokens removed in favor of the shared file (its hero `<h1>` keeps a deliberately larger one-off size — the one place the page is meant to look different). This is the fix for "two different visual languages across the product today" called out in the original audit.
- **Real review-dashboard**, rebuilt from a single unstyled list into an actual operator surface:
  - **Stats header** — live pending/approved/rejected counts and total estimated spend (reading the new cost ledgers), via `GET /stats`.
  - **Filters** — status, niche, and platform, via query params on `GET /queue` (extended `listReviewItems` to take a filter object; kept the old bare-status call shape working too).
  - **Bulk actions** — select-all / individual checkboxes, bulk approve/reject via new `setReviewItemsStatus` (one lock acquisition per batch, not one per item).
  - **Run history** — new `apps/review-dashboard/src/runs.ts` reads every `runs/<runId>/manifest.json` (+ `cost-ledger.json` where present) into a real history table; previously each run's manifest just sat in its own directory with no aggregating UI at all.
  - **Accessibility** — every filter has a real `<label for>`, every interactive element gets the shared focus-visible ring, status changes announce via `aria-live` regions. Not a full WCAG audit, but a real step up from "no keyboard/focus/ARIA attention at all."
  - All of the above verified two ways: 22 new/updated tests (route behavior, run-history parsing, page-shell markup), and a live manual pass — ran the CLI dry-run to populate real data, started the actual server, and curled `/queue`, `/stats`, `/runs`, `/tokens.css`, the bulk-approve endpoint, and the rendered page.

**Explicitly still not touched** (same reasoning as before — these need either your cloud account + go-ahead, external API approval, or are the deferred dashboard-v2-scale initiative): auth, billing, multi-seat, niche/schedule configuration via UI (still CLI flags), multi-language script generation, A/B testing, regenerate-in-place (a "Reset to pending" action was considered but not added, since real regeneration means re-invoking the paid pipeline — out of scope under the no-further-live-vendor-calls constraint), TikTok/Meta discovery (still API-approval-gated), and replacing the JSON review-queue with a real datastore (it's now concurrency-safe on one machine, which was the actually-broken part — the bigger swap is still deferred to whenever multi-machine deployment is real).

---

## Verified in the prior pass (hygiene + fix pass)

Per the earlier scoping decision, that pass targeted foundational engineering hygiene and fixing bugs/inefficiencies found by actually running the app.

**Now in place:**
- **Git repository** — `git init` + real commit history (previously: none at all).
- **98 tests across all 10 packages at the time**, all passing (now 131 across 13 packages after this pass) — schema validation, adapter request/response shapes with mocked `fetch`, the conductor's full stage sequence via `--dry-run`, CLI option parsing, the review-dashboard's HTTP API via a real ephemeral-port server.
- **CI** (`.github/workflows/ci.yml`) — build + test on push/PR (not yet exercised against a real remote, since this repo isn't pushed anywhere yet).

**Real bugs found and fixed while writing tests and exercising the app** (not just coverage added around existing behavior):
- `shared-config` cached `process.env` on first read with no reset path — beyond breaking tests, this meant any runtime env change after first access would silently be ignored. Removed the cache.
- **Kling adapter was fundamentally non-functional**: assumed a static bearer API key, but Kling requires a signed HS256 JWT from an Access Key/Secret Key pair, and wraps every response in a `{code, message, data}` envelope the original code never unwrapped. Rewrote against confirmed API docs.
- **Pika adapter was targeting a dead endpoint**: Pika retired its standalone public API (~Dec 2025) and is now served exclusively through fal.ai's queue API. Replaced with a real fal.ai integration.
- **Runway adapter had the wrong base URL, missing a required header, wrong polling path, and wrong status vocabulary** — rewrote against confirmed docs; one detail (the exact text-to-video endpoint path) remains flagged as unconfirmed in a code comment rather than silently assumed.
- All four video-gen adapters polled on a **fixed 5s interval** regardless of job progress — added a shared exponential-backoff helper.
- `mcp-assembly` ran **three sequential ffmpeg passes** where one would do (ffmpeg's concat demuxer accepts filters directly) — consolidated, cutting encode time and two rounds of unnecessary re-encode quality loss.
- `cli.ts` and both Express servers ran side-effecting code (argv parsing / `app.listen()`) at **module scope**, making them impossible to safely import for testing — extracted pure logic, guarded entrypoints.
- **CLI crashed with a raw unhandled stack trace** on an invalid `--platforms` value or out-of-range `--duration`/`--max-candidates`, instead of a clean error message like commander's own validation produces — found by manually exercising the CLI with malformed input, not by the test suite. Fixed.

---

## 1. Core pipeline — stage by stage

| Stage | Status | Gap |
|---|---|---|
| Discovery | 🟡 Partial | YouTube Data API: **live, verified**. TikTok Research API + Meta Graph API: adapters shaped correctly but `throw` — gated on API approval you don't have yet. Two of three discovery sources are non-functional today. |
| Transcription | 🟡 Partial, improved | YouTube public captions: **live, verified**. ASR fallback: the Whisper API *client* is now real and tested (`packages/mcp-transcript/src/asr.ts`) — what's still missing is an audio-extraction step (yt-dlp or a platform downloader) upstream of it. |
| Script rewrite | 🟢 Done | Claude via Anthropic SDK, verified in dry-run (mock) and architecturally sound for live use — not yet verified with a real API call end-to-end in this environment (no `ANTHROPIC_API_KEY` set here). Real token usage now flows into the cost ledger when it does run live. |
| Caption timing | 🟢 Done | Same as above — code path verified via dry-run mock, not yet verified with a real Claude call. |
| Video generation | 🟡 Partial | **Higgsfield: live, verified** (generated the real hero clip). **Kling, Runway, Pika: correctly shaped against real API docs, still unverified against a live account** — that requires real credentials this session doesn't have. |
| Assembly (ffmpeg) | 🟡 Unverified in this environment | Code is complete (concat, crop, subtitle burn, thumbnail) and consolidated to one ffmpeg pass. Could not verify live — this sandbox blocks execution of the downloaded `ffmpeg.exe` binary (unrelated to the code). Should work inside the new Docker images (Linux, real ffmpeg binary) or GitHub Actions runner — **neither has been build/run-verified yet**. |
| QA / virality scoring | 🟢 Done | Claude-based, replacing the earlier Higgsfield dependency per your direction. Same caveat as script rewrite — dry-run verified, not yet live-verified. Real token usage now flows into the cost ledger. |
| Review queue | 🟢 Done, concurrency-safe on one machine | JSON file store, now protected by a lockfile against same-machine concurrent writers (dashboard clicks racing a CLI insert). Still not a real datastore — no query/filter *beyond* the dashboard's own filtering, no cross-machine safety, no audit trail of who approved what. |
| Scheduling (weekly cadence) | 🟢 **Now real** for the common case | `.github/workflows/weekly-run.yml` is a working GitHub Actions cron + on-demand dispatch — deployable the moment this repo is pushed with secrets set. The heavier-scale EventBridge/Lambda path (`infra/cron/eventbridge-stub.ts`) remains documentation-only, now explicitly positioned as the scale-up option. |
| Publishing | 🟢 Code-complete, zero-dollar-verified | TikTok, Facebook, YouTube, and (as of this pass) Instagram Reels all have real, doc-verified adapters, reachable only from an already-`approved` item via `POST /queue/:id/publish` — the human-review gate stays intact. None has posted a real video against a funded/authorized account yet. |

## 2. Cross-cutting engineering gaps

- ~~Zero tests~~ **Fixed** — 131 tests across all 13 packages, all passing.
- ~~No CI~~ **Fixed** — `.github/workflows/ci.yml`.
- ~~No git repository~~ **Fixed** — real commit history.
- ~~No retry/backoff discipline~~ **Fixed** — shared exponential-backoff helper used by all four video-gen adapters.
- ~~No deployment~~ **Partially fixed** — `.github/workflows/weekly-run.yml` is real and deployable today; Dockerfiles exist for all three apps but are unverified (no Docker daemon in this sandbox). The EventBridge/Lambda path is still a design doc for when you outgrow GitHub-hosted runners.
- ~~No rate-limit/cost awareness~~ **Fixed** — `packages/shared-cost` tracks real Claude token usage and video-gen clip counts per run, written to `runs/<runId>/cost-ledger.json` and surfaced in the dashboard's stats header and run-history table.
- **No secrets management beyond `.env` / GitHub Actions secrets.** Fine for local dev and the new GH Actions cron path; not appropriate for a shared multi-operator deployment — that still wants Secrets Manager/SSM if you go the EventBridge route.
- **No observability beyond structured logs + the new cost ledger.** `pino` logs to stdout only — no log aggregation, no error tracking (Sentry-equivalent), no alerting on `runCycle` failures or `reviewItemsCreated === 0`. The cost ledger gives spend visibility, which is a real subset of observability, but not the whole thing.
- **No input validation hardening audit.** Zod schemas cover the happy path; adversarial-input handling hasn't been stress-tested.

## 3. UX — what exists vs. a "premium dashboard, Yorby-tier"

| Yorby premium-tier feature | Our status |
|---|---|
| User accounts / login | 🟢 **Fixed.** Real signup/login/sessions, plus org-scoped multi-seat/teams with invite links. |
| Billing / subscription tiers | 🟡 **Scaffolded, not real pricing.** Real Stripe Checkout, webhook, and plan gating, wired to real usage data — the tier dollar amounts are explicit placeholders pending your actual pricing decisions. |
| A real operator dashboard | 🟢 Stats header, status/niche/platform filters, select-all + bulk approve/reject, run history table, shared design system with the marketing site, real accessibility attention verified by axe-core, not just eyeballed. |
| Run history / trends over time | 🟢 **Fixed.** `/runs` endpoint + table, plus a real spend-over-time bar chart in the new self-service account page. |
| Niche/brand-voice/schedule management via UI | 🟢 **Fixed.** `/account`'s settings panel covers niche, brand voice, platforms, target duration, video/voice vendor, and cadence — no CLI or workflow-file editing required for a self-service user. |
| Multi-language script generation | 🟢 **Fixed.** `locale` threaded through the schema, script-agent's prompt, and a `--locale` CLI flag. |
| Unlimited revisions / regenerate-in-place | 🟢 Scene and full-script regeneration, with a working (intentionally minimal) editor panel in the dashboard. |
| A/B testing UI | 🔴 Not implemented. |
| Team/multi-seat access | 🟢 **Fixed.** Org accounts, invite links, owner-gated invite/billing management — verified end-to-end (an invited teammate reaches the owner's shared settings/usage/billing). |
| Marketing/landing page | 🟢 Done, and better than Yorby's — real embedded video (Yorby has none), UGC-review wall, honest comparison table. Now also on the shared design system. |
| Design system consistency | 🟢 **Fixed.** `packages/design-tokens` is the single source for palette/type/primitives, served at `/tokens.css` by both apps. One product, one visual language, not two. |
| Accessibility | 🟢 **Fixed.** Real axe-core WCAG 2.x A/AA scans, in a real browser, wired into CI, against every page in both apps — not just eyeballed label/focus-visible attention. 2 real findings caught and fixed this pass. |

## 4. Priority punch list to close the gap (current)

**To call engineering "100%" (production-grade, not just architecturally complete):**
1. ~~Write tests~~ **Done** — 300+ tests, all passing, across every package.
2. ~~`git init`, commit history, then CI~~ **Done**, and now genuinely proven — CI passes on real GitHub Actions infrastructure, not just "would probably work."
3. ~~Build and run the Docker images for real~~ **Done** — all three build and push to GHCR on every push to `main`, verified this pass (including catching and fixing a real missing-COPY-manifest regression from the billing package).
4. ~~ASR audio-extraction~~ **Done** — yt-dlp wired ahead of Whisper.
5. ~~Instagram Reels publishing~~ **Done** — self-hosted signed public video URL (`apps/review-dashboard/src/public-assets.ts`) unblocks Meta's Content Publishing API; verified end-to-end.
6. **No vendor has completed a real, funded/authorized live call — for anything.** Video-gen (Kling/Runway/Pika/Higgsfield/Gemini), voiceover (ElevenLabs/Grok), and publishing (TikTok/Facebook/YouTube/Instagram) are all real-shaped, tested against real API docs, and ready — none has actually moved a dollar or posted a real video yet. This is the single largest remaining engineering unknown, and it's fundamentally not closeable without you providing funded/authorized credentials for at least one vendor per stage and running it live. **You've indicated you'll provide `ANTHROPIC_API_KEY` + one video/voice vendor — this is the next real unlock.**
7. TikTok Research API + Meta Graph API discovery approval and live wiring (external application/approval process, not code).
8. Enable GitHub Advanced Security (or make the repo public) to unblock the `osv-scan` dependency-scanning job — currently the only red job in CI, deferred at your explicit choice.
9. Multi-niche fan-out and the heavier EventBridge/Lambda scheduling path (`infra/cron/eventbridge-stub.ts`) remain documentation-only — `weekly-run.yml` covers the single/few-niche case for real.
10. Replace the JSON review-queue with the already-built Postgres backend for any *multi-machine* deployment (same-machine concurrency is already safe).
11. Deeper observability: ship logs somewhere queryable, add error tracking (Sentry-equivalent), alert on run failures — the cost ledger covers spend visibility, not error/failure visibility.

**To call UX "100%":**
1. ~~Auth~~ **Done** — real accounts, sessions, and per-account usage metering, additive to the existing operator Basic Auth.
2. ~~Regenerate-in-place~~ **Done** — scene and full-script regeneration, with a working (intentionally minimal) editor panel in the dashboard.
3. ~~Self-service onboarding~~ **Done** — `/account` signup wizard walks a new account through settings and a first run, no CLI required.
4. ~~Settings panel~~ **Done** — niche/brand-voice/platforms/duration/vendor/cadence, all in `/account`.
5. ~~Trend charts~~ **Done** — a real per-run spend bar chart in the usage panel.
6. ~~Billing UI~~ **Done, against placeholder pricing** — plan tiers, Stripe Checkout, plan status all in `/account`; the tiers themselves are clearly-marked placeholder dollar amounts, not your real pricing yet.
7. ~~Multi-seat/teams~~ **Done** — org accounts, invite links, owner-gated invite/billing management, verified end-to-end (an invited teammate reaches the owner's shared data).
8. ~~Multi-language script generation~~ **Done** — `locale` threaded through the schema, script-agent's prompt, and a `--locale` CLI flag.
9. ~~Accessibility audit~~ **Done** — axe-core e2e scans in CI against every page in both apps; 2 real findings fixed (unfocusable scrollable table, unlabeled input).
10. **Real pricing tiers** — the billing UI above is wired against invented placeholder numbers; swapping in your actual pricing is a config/content change, not an engineering task.
11. **The "content labs" / public live-counter concept** (327 videos · 4.2M views · $6.80 avg cost) from the agency-positioning strategy — genuinely can't be built with fabricated numbers; needs 30-60 days of real published content and real analytics feedback, which needs live publishing (now code-complete for all four platforms) and a paying/testing account first.

## What I'd do first

Everything that was buildable without you — every item in this pass's punch list that didn't require a business decision, external approval, or spending real vendor money — is now done. What's left almost entirely requires you specifically:

**Next, in order:**
1. **Provide `ANTHROPIC_API_KEY` + one video/voice vendor's real, funded credentials and run one real candidate end to end** — you've already indicated this is coming. This retires the single biggest remaining engineering unknown (every vendor adapter is real-shaped and doc-verified, zero-dollar-spend-verified only) and is the prerequisite for the "20 genuinely strong finished examples" and "content labs" goals in the agency-positioning strategy.
2. **Give real pricing tiers** to replace the placeholder dollar amounts in `packages/shared-billing/src/tiers.ts` — a config change against infrastructure that's already fully wired.
3. **TikTok/Meta discovery approval** — submit the applications; the code is waiting.
4. **Decide on GitHub Advanced Security** (enable it, or make the repo public) to close the one remaining red CI job — deferred at your explicit choice, not a technical blocker.
