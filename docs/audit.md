# Holistic Audit — Engineering & UX Completeness

Snapshot as of this audit. Ratings are honest, not aspirational — "built" means verified working, not just written.

## Overall

| Dimension | Estimate | Read |
|---|---|---|
| **Engineering** (pipeline correctness, integration coverage, production-readiness) | **~55%** | Architecture is sound and the dry-run path is fully verified end-to-end. Real-world coverage is thin: 2 of ~8 external integrations are verified live (YouTube, Higgsfield), the rest are stub/unverified. Zero tests, zero CI, no deployment, no git history. |
| **UX** (what a user/customer actually touches) | **~20%** | The marketing site is genuinely polished. Everything else a paying customer would expect from a "Yorby-tier" product — accounts, billing, a real dashboard, run history, settings — doesn't exist yet. |

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

- **Zero tests.** No `.test.ts` files exist anywhere despite `vitest` being wired into every `package.json`. Nothing prevents a silent regression.
- **No CI.** No `.github/workflows`, no pre-merge checks, nothing enforcing that `pnpm -r run build` passes before code lands.
- **No git repository.** This has never been `git init`'d — there's no commit history, no ability to diff/rollback, no branch protection. Everything is one working tree.
- **No deployment.** `infra/cron` is a design doc. Nothing is running anywhere except your local machine.
- **No secrets management.** `.env` file convention only — fine for local dev, not appropriate for shared/production use.
- **No retry/backoff discipline.** Higgsfield/Kling polling loops use fixed attempt counts (e.g. 30 × 5s) with no exponential backoff or circuit breaking — a slow API will just time out ungracefully.
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
1. Write tests — at minimum: schema validation, each agent's prompt→parse round-trip with mocked Claude responses, the conductor's stage-sequencing logic.
2. `git init`, commit history, then CI (build + test on every push).
3. Verify Kling/Runway/Pika adapters against real accounts — expect to debug endpoint mismatches.
4. Verify ffmpeg assembly on an unrestricted machine (this sandbox can't do it).
5. Real ASR fallback provider (Whisper API is the natural pick — same vendor family as your other OpenAI-adjacent needs, or AssemblyAI if you want a dedicated ASR vendor).
6. TikTok Research API + Meta Graph API approval and live wiring (external — application/approval process, not just code).
7. Deploy `infra/cron` for real: containerize, pick real vs. serverless assembly compute (ffmpeg doesn't fit Lambda well for longer videos), wire EventBridge.
8. Replace the JSON-file review queue with a real datastore before any concurrent/multi-user use.
9. Add retry/backoff, cost tracking, and basic observability (even just structured logs shipped somewhere queryable).

**To call UX "100%" (a premium, Yorby-beating dashboard):**
1. **Auth** — this blocks everything else (accounts, billing, multi-seat).
2. **A real dashboard app** — not the current single-page queue. Needs: run history timeline, per-niche settings (brand voice, platforms, cadence — configurable without touching a CLI), filtering/search over review items, bulk approve/reject, regenerate-in-place, cost/usage view.
3. **Billing** — Stripe (or equivalent) with plan tiers, credit/usage metering tied to the real vendor costs in `docs/cost-table.md`.
4. **Shared design system** — pull the marketing site's design tokens (colors, type scale, card components) into a shared package so the dashboard doesn't look like a different product.
5. **Multi-language support** in the script-agent, since that's a named Yorby feature you'd want parity on.
6. **Accessibility pass** on both surfaces.

## What I'd do first

Given the pipeline core is the hard, differentiated part and it's already ~55% real (with the two riskiest integrations — Higgsfield and ffmpeg — either verified or partially verified), I'd prioritize **(a)** tests + git + CI before writing more feature code — right now a regression would be invisible — and **(b)** the real dashboard app, since that's the single largest gap between "interesting scaffold" and "thing you could actually put in front of a user or charge money for." Auth and billing only matter once there's a dashboard worth gating.
