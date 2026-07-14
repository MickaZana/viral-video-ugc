# Holistic Audit — Engineering & UX Completeness

Snapshot as of this audit. Ratings are honest, not aspirational — "built" means verified working, not just written.

## Overall

| Dimension | Estimate | Read |
|---|---|---|
| **Engineering** (pipeline correctness, integration coverage, production-readiness) | **~65%** (was ~55%) | Foundational hygiene (git, tests, CI) is now in place, and testing surfaced/fixed several real bugs rather than just adding coverage around them. Still gated on the same external unknowns as before: Kling/Runway/Pika need a real account to confirm against, ffmpeg needs an unrestricted machine, TikTok/Meta need API approval. |
| **UX** (what a user/customer actually touches) | **~20%**, unchanged | This pass was explicitly scoped to hygiene + fixing what exists, not building the missing dashboard/auth/billing surfaces — see `## Verified in this pass` below for what "fixing what exists" concretely meant. |

---

## Verified in this pass (hygiene + fix pass, follow-up to the original audit)

Per your scoping decision, this pass targeted foundational engineering hygiene and fixing bugs/inefficiencies found by actually running the app — not the dashboard/auth/billing initiative in section 4 below, which remains untouched and still applies as written.

**Now in place:**
- **Git repository** — `git init` + real commit history (previously: none at all).
- **98 tests across all 10 packages**, all passing — schema validation, adapter request/response shapes with mocked `fetch`, the conductor's full stage sequence via `--dry-run`, CLI option parsing, the review-dashboard's HTTP API via a real ephemeral-port server.
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

**Explicitly not touched this pass** (per scoping): the JSON review-queue is still a flat file (not concurrency-safe — unchanged), no auth/billing/dashboard work, TikTok/Meta discovery still blocked on external API approval, ffmpeg still unverified on a real machine (this sandbox still can't execute the binary), Kling/Runway/Pika are now *correctly shaped* against documentation but still unverified against live accounts — that requires real credentials this session doesn't have.

---

## 1. Core pipeline — stage by stage

| Stage | Status | Gap |
|---|---|---|
| Discovery | 🟡 Partial | YouTube Data API: **live, verified**. TikTok Research API + Meta Graph API: adapters shaped correctly but `throw` — gated on API approval you don't have yet. Two of three discovery sources are non-functional today. |
| Transcription | 🟡 Partial | YouTube public captions: **live, verified**. ASR fallback (Whisper/AssemblyAI/Deepgram) for platforms without captions: `throw`, not wired to any provider. |
| Script rewrite | 🟢 Done | Claude via Anthropic SDK, verified in dry-run (mock) and architecturally sound for live use — not yet verified with a real API call end-to-end in this environment (no `ANTHROPIC_API_KEY` set here). |
| Caption timing | 🟢 Done | Same as above — code path verified via dry-run mock, not yet verified with a real Claude call. |
| Video generation | 🟡 Partial | **Higgsfield: live, verified** (generated the real hero clip). **Kling, Runway, Pika: written but unverified** — their REST endpoint shapes (`api.klingai.com/v1/...` etc.) were inferred from typical patterns, not confirmed against real API docs or a live account. Treat these as "probably needs debugging on first real use," not production-ready. |
| Assembly (ffmpeg) | 🟡 Unverified in this environment | Code is complete (concat, crop, subtitle burn, thumbnail). Could not verify live — this sandbox blocks execution of the downloaded `ffmpeg.exe` binary (unrelated to the code). **Needs a real run on an unrestricted machine before you trust it.** |
| QA / virality scoring | 🟢 Done | Claude-based, replacing the earlier Higgsfield dependency per your direction. Same caveat as script rewrite — dry-run verified, not yet live-verified. |
| Review queue | 🟢 Done, but | Works, but is a flat JSON file — fine for one local user, **not concurrency-safe**, no query/filter capability, no audit trail of who approved what. |
| Scheduling (weekly cadence) | 🔴 Not built | `infra/cron/` is **documentation only** — no EventBridge rule, no Lambda, nothing actually scheduled. Today the system only runs when you manually type a command. |
| Publishing | 🔴 Not built | Intentionally deferred (by design, per your HITL requirement) — but worth naming explicitly: there is no code path from "approved" to "posted" anywhere yet. |

## 2. Cross-cutting engineering gaps (the unglamorous 20%)

- ~~Zero tests~~ **Fixed** — 98 tests across all 10 packages.
- ~~No CI~~ **Fixed** — `.github/workflows/ci.yml`, untested against a real remote since none is pushed yet.
- ~~No git repository~~ **Fixed** — real commit history from this pass forward.
- ~~No retry/backoff discipline~~ **Fixed** — shared exponential-backoff helper (`packages/mcp-video-gen/src/poll.ts`) used by all four video-gen adapters.
- **No deployment.** `infra/cron` is still a design doc. Nothing is running anywhere except your local machine.
- **No secrets management.** `.env` file convention only — fine for local dev, not appropriate for shared/production use.
- **No rate-limit awareness.** YouTube quota, Higgsfield credits, Anthropic tokens — `docs/cost-table.md` is a manual template; nothing in code tracks or caps spend.
- **No observability.** `pino` logs to stdout only. No log aggregation, no error tracking (Sentry-equivalent), no metrics/dashboards on run success rate.
- **No input validation hardening audit.** Zod schemas cover the happy path; adversarial-input handling (e.g. a malicious niche string, an oversized transcript) hasn't been stress-tested.

## 3. UX — what exists vs. a "premium dashboard, Yorby-tier"

Yorby's paid tier ($40–$300/mo) bundles: accounts, unlimited revisions, A/B testing, multi-language generation, 24/7 access, and (top tier) a human strategist + weekly calls. Mapping what we have against that:

| Yorby premium-tier feature | Our status |
|---|---|
| User accounts / login | 🔴 None. No auth anywhere in the stack. |
| Billing / subscription tiers | 🔴 None. No Stripe integration, no plan gating, no usage metering. |
| A real operator dashboard | 🔴 **This is the biggest gap.** `apps/review-dashboard` is a single unstyled page: a list, two buttons, no login, no run history, no filtering by niche/platform/score, no bulk actions, no undo, no charts, no settings panel. It is a working proof-of-concept, not a product surface. |
| Run history / trends over time | 🔴 None. Each run's `manifest.json` sits in `runs/<id>/` with no aggregating UI. |
| Niche/brand-voice/schedule management via UI | 🔴 None. Everything is CLI flags (`vvugc run --niche=...`). No way to configure a recurring niche without editing scripts. |
| Multi-language script generation | 🔴 Not implemented. `script-agent.ts` has no locale parameter. |
| Unlimited revisions / regenerate-in-place | 🔴 Not implemented. A rejected review item has no "regenerate" action — you'd rerun the whole CLI cycle. |
| A/B testing UI | 🔴 Not implemented. |
| Team/multi-seat access | 🔴 Not implemented — single implicit user throughout. |
| Marketing/landing page | 🟢 **Done, and better than Yorby's** — real embedded video (Yorby has none), UGC-review wall, honest comparison table. |
| Design system consistency | 🟡 Marketing site has a considered dark theme; review-dashboard has ~15 lines of inline CSS and doesn't share it. Two different visual languages across the product today. |
| Accessibility | 🟡 Marketing site has decent semantic HTML, unaudited for a11y. Review-dashboard has no keyboard/focus/ARIA attention at all. |

## 4. Priority punch list to close the gap

**To call engineering "100%" (production-grade, not just architecturally complete):**
1. ~~Write tests~~ **Done** — 98 tests, all passing, across all 10 packages.
2. ~~`git init`, commit history, then CI~~ **Done.**
3. Verify Kling/Runway/Pika adapters against real accounts — they're now *correctly shaped* against real API docs (this pass), but still need a live account to confirm end-to-end.
4. Verify ffmpeg assembly on an unrestricted machine (this sandbox still can't do it — confirmed still blocked this pass).
5. Real ASR fallback provider (Whisper API is the natural pick — same vendor family as your other OpenAI-adjacent needs, or AssemblyAI if you want a dedicated ASR vendor).
6. TikTok Research API + Meta Graph API approval and live wiring (external — application/approval process, not just code).
7. Deploy `infra/cron` for real: containerize, pick real vs. serverless assembly compute (ffmpeg doesn't fit Lambda well for longer videos), wire EventBridge.
8. Replace the JSON-file review queue with a real datastore before any concurrent/multi-user use.
9. Cost tracking and basic observability (even just structured logs shipped somewhere queryable) — retry/backoff is now done.

**To call UX "100%" (a premium, Yorby-beating dashboard):**
1. **Auth** — this blocks everything else (accounts, billing, multi-seat).
2. **A real dashboard app** — not the current single-page queue. Needs: run history timeline, per-niche settings (brand voice, platforms, cadence — configurable without touching a CLI), filtering/search over review items, bulk approve/reject, regenerate-in-place, cost/usage view.
3. **Billing** — Stripe (or equivalent) with plan tiers, credit/usage metering tied to the real vendor costs in `docs/cost-table.md`.
4. **Shared design system** — pull the marketing site's design tokens (colors, type scale, card components) into a shared package so the dashboard doesn't look like a different product.
5. **Multi-language support** in the script-agent, since that's a named Yorby feature you'd want parity on.
6. **Accessibility pass** on both surfaces.

## What I'd do first

~~Tests + git + CI~~ is now done — that recommendation from the original audit has been executed as its own pass. What's left unchanged from the original read: **the real dashboard app** is still the single largest gap between "interesting scaffold" and "thing you could actually put in front of a user or charge money for." Auth and billing only matter once there's a dashboard worth gating. That's the next natural pass whenever you want to take it on.
