# Holistic Audit — Engineering & UX Completeness

Snapshot as of this audit. Ratings are honest, not aspirational — "built" means verified working, not just written.

## Overall (current — supersedes every rating below it)

| Dimension | Estimate | Read |
|---|---|---|
| **Engineering** (pipeline correctness, integration coverage, production-readiness) | **~88%** (was ~78%) | This pass got the repo onto a real GitHub remote for the first time (`github.com/MickaZana/viral-video-ugc`), and — critically — **got real CI passing for the first time ever**: build, lint, 250+ tests, e2e, and all three Docker images now build and push successfully on a clean Linux runner. That closes the single biggest gap from the prior audit ("the new Docker images... could not actually be built... not build-verified"). ASR is now end-to-end wired (yt-dlp + Whisper). Added originality/compliance scoring, scene/script regeneration, and code-complete publishing adapters. What still holds this below 95: no vendor (video-gen, voiceover, publishing) has ever completed a live call against a funded/authorized account — every one of them is real-shaped and unit-tested against real docs, but zero-dollar-spend-verified only. |
| **UX** (what a user/customer actually touches) | **~62%** (was ~48%) | Real accounts/sessions (not just dashboard Basic Auth), per-account usage metering, in-place scene/script regeneration with a working (if minimal) editor panel, and an originality signal surfaced to reviewers are all new and real. Held below 70 by: no billing, no self-service onboarding UI, no settings panel, no trend charts, no full accessibility audit — see the punch list. |

---

## This pass (2026-07-17 — repo push, CI, and product-depth pass)

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
| Publishing | 🔴 Not built | Intentionally deferred (by design, per your HITL requirement) — but worth naming explicitly: there is no code path from "approved" to "posted" anywhere yet. |

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
| User accounts / login | 🔴 None. No auth anywhere in the stack. |
| Billing / subscription tiers | 🔴 None. No Stripe integration, no plan gating, no usage metering (though per-run *cost* is now tracked — metering against a plan/quota is a different, unbuilt thing). |
| A real operator dashboard | 🟢 **Fixed — this was the biggest single gap and is now closed.** Stats header, status/niche/platform filters, select-all + bulk approve/reject, run history table, shared design system with the marketing site, real accessibility attention (labels, focus-visible, aria-live). Still missing vs. a full product surface: settings panel, charts/trends over time (beyond the flat history table), undo. |
| Run history / trends over time | 🟢 **Fixed.** New `/runs` endpoint + table reads every run's manifest + cost ledger into one view. "Trends" (charts over time) specifically is still just a flat table, not visualized. |
| Niche/brand-voice/schedule management via UI | 🔴 None. Everything is still CLI flags (`vvugc run --niche=...`) or GitHub Actions workflow inputs. No way to configure a recurring niche without editing a workflow file or script. |
| Multi-language script generation | 🔴 Not implemented. `script-agent.ts` has no locale parameter. |
| Unlimited revisions / regenerate-in-place | 🔴 Not implemented. Considered a "reset to pending" action this pass but didn't add it — genuine regeneration means re-invoking the paid pipeline, out of scope under the no-further-live-vendor-calls constraint this pass operated under. A rejected item still has no in-dashboard path back to a new render. |
| A/B testing UI | 🔴 Not implemented. |
| Team/multi-seat access | 🔴 Not implemented — single implicit user throughout. |
| Marketing/landing page | 🟢 Done, and better than Yorby's — real embedded video (Yorby has none), UGC-review wall, honest comparison table. Now also on the shared design system. |
| Design system consistency | 🟢 **Fixed.** `packages/design-tokens` is the single source for palette/type/primitives, served at `/tokens.css` by both apps. One product, one visual language, not two. |
| Accessibility | 🟡 Improved, not fully audited. Dashboard now has real label/focus-visible/aria-live attention. Marketing site still has decent semantic HTML but no formal a11y audit on either surface. |

## 4. Priority punch list to close the gap (current)

**To call engineering "100%" (production-grade, not just architecturally complete):**
1. ~~Write tests~~ **Done** — 250+ tests, all passing, across every package.
2. ~~`git init`, commit history, then CI~~ **Done**, and now genuinely proven — CI passes on real GitHub Actions infrastructure, not just "would probably work."
3. ~~Build and run the Docker images for real~~ **Done** — all three build and push to GHCR on every push to `main`, verified this pass.
4. ~~ASR audio-extraction~~ **Done** — yt-dlp wired ahead of Whisper.
5. **No vendor has completed a real, funded/authorized live call — for anything.** Video-gen (Kling/Runway/Pika/Higgsfield/Gemini), voiceover (ElevenLabs/Grok), and publishing (TikTok/Facebook/YouTube) are all real-shaped, tested against real API docs, and ready — none has actually moved a dollar or posted a real video yet. This is the single largest remaining engineering unknown, and it's fundamentally not closeable without you providing funded/authorized credentials for at least one vendor per stage and running it live.
6. TikTok Research API + Meta Graph API discovery approval and live wiring (external application/approval process, not code).
7. Instagram Reels publishing — genuinely unimplemented, needs a public asset host this pipeline doesn't have (see `packages/mcp-publish/src/tools/meta.ts`).
8. Enable GitHub Advanced Security (or make the repo public) to unblock the `osv-scan` dependency-scanning job — currently the only red job in CI, deferred at your explicit choice.
9. Multi-niche fan-out and the heavier EventBridge/Lambda scheduling path (`infra/cron/eventbridge-stub.ts`) remain documentation-only — `weekly-run.yml` covers the single/few-niche case for real.
10. Replace the JSON review-queue with the already-built Postgres backend for any *multi-machine* deployment (same-machine concurrency is already safe).
11. Deeper observability: ship logs somewhere queryable, add error tracking (Sentry-equivalent), alert on run failures — the cost ledger covers spend visibility, not error/failure visibility.
12. Billing/Stripe integration against the now-real per-account usage data — needs your actual pricing tiers, not invented numbers.

**To call UX "100%":**
1. ~~Auth~~ **Done** — real accounts, sessions, and per-account usage metering, additive to the existing operator Basic Auth.
2. ~~Regenerate-in-place~~ **Done** — scene and full-script regeneration, with a working (intentionally minimal) editor panel in the dashboard.
3. **Self-service onboarding** — no signup wizard/UI walks a new account through picking a niche and starting their first run; today that's still `POST /accounts/signup` + the CLI.
4. **Settings panel** — niche/brand-voice/cadence configuration is still CLI flags or GitHub Actions workflow inputs, not a UI a non-technical operator could use.
5. **Trend charts** — run history is still a flat table, not visualized over time.
6. **Billing UI** — plan tiers, upgrade/downgrade, payment method — none of it exists (matches the billing gap above).
7. **Multi-seat/teams within one account** — each account is a single implicit owner; no invited-teammate or role concept yet.
8. **Multi-language script generation** — `script-agent.ts` still has no locale parameter.
9. **Full accessibility audit** on both surfaces — real attention (labels, focus-visible, aria-live) exists on the dashboard, but neither surface has had a formal WCAG pass.
10. **The "content labs" / public live-counter concept** (327 videos · 4.2M views · $6.80 avg cost) from the agency-positioning strategy — genuinely can't be built with fabricated numbers; needs 30-60 days of real published content and real analytics feedback, which needs live publishing (above) and a paying/testing account first.

## What I'd do first

The two things that were structurally impossible to verify before this pass — "does this actually deploy" and "does CI actually pass" — are now both real yes's, proven on live infrastructure, not assumed. That was the correct thing to close first, because everything else (billing, self-service UI, live vendor spend) is only worth building against a foundation you know actually ships.

**Next, in order:**
1. **Pick one vendor per stage and go live with real credentials** — even just Higgsfield (video) + one voice vendor + TikTok (publish) end to end, for one real candidate. This retires the single biggest remaining unknown and is the prerequisite for the "20 genuinely strong finished examples" and "content labs" goals in the agency-positioning strategy.
2. **Settings panel + self-service onboarding UI** — now that auth exists, this is a real, scoped frontend project, not blocked on anything else.
3. **Billing**, once you have real pricing tiers to wire against the usage data that's already being tracked.
4. **TikTok/Meta discovery approval** — submit the applications; the code is waiting.
