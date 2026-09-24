# Viral Video UGC Architecture

> Companion to the canonical [`../ARCHITECTURE.md`](../ARCHITECTURE.md), which owns module
> boundaries, key identifiers, and feature flags — this doc owns the pipeline/dataflow design
> and operational hardening notes, and is kept consistent with it. Current status:
> [`go-live-plan.md`](go-live-plan.md); superseded audits live in [`archive/`](archive/).

## Why this exists

Yorby.ai (reverse-engineered from its public site) is a **script remixer**: paste a viral video link, get a rewritten hook/point/CTA script back in under a minute. It stops there — no discovery automation, no video generation, no scheduling, no editor. Viral Video UGC is the full pipeline Yorby doesn't build: **discovery → transcript → script rewrite → video generation → assembly → human-reviewed queue**, running on a weekly cadence from one command.

## Topology

A single **conductor** (`apps/orchestrator/src/conductor.ts`) owns the pipeline state machine and calls each stage in sequence. Stages are separated into independently buildable/testable packages so a discovery source, video vendor, or assembly step can change without touching the others:

```
CLI: vvugc run --niche=fitness --platforms=youtube_shorts
        │
        ▼
  conductor.runCycle(RunConfig)
        │
        ├─ Stage 1  Discovery         → packages/mcp-discovery   (YouTube live; TikTok + Instagram fully implemented and tested, both pending API approval, not code — see README's Platform support section)
        ├─ Stage 2  Transcription     → packages/mcp-transcript  (YouTube captions live; ASR fallback real — yt-dlp audio extraction → Whisper, used automatically when captions are missing)
        ├─ Stage 3  Script rewrite    → apps/orchestrator/src/agents/script-agent.ts (Claude, via Anthropic SDK)
        ├─ Stage 4  Caption timing    → apps/orchestrator/src/agents/caption-agent.ts (Claude decides cue text/timing)
        ├─ Stage 5  Voiceover         → packages/mcp-voiceover   (ElevenLabs/Grok — opt-in via --voice-vendor, narration synced per-cue to Stage 4's captions; skipped entirely when unset)
        ├─ Stage 6  Video generation  → packages/mcp-video-gen   (Higgsfield via injected MCP call; Kling/Runway/Pika/Alibaba Model Studio/Replicate/Seedance/Grok-video/Wan via REST; Gemini stills + Ken Burns — pixels only)
        ├─ Stage 7  Assembly          → packages/mcp-assembly    (ffmpeg: concat, aspect-ratio crop, burns Claude's caption cues, mixes in Stage 5's narration if present, thumbnail)
        ├─ Stage 8  QA / scoring      → apps/orchestrator/src/agents/qa-agent.ts (Claude, via Anthropic SDK — not a vendor tool)
        └─ Stage 9  Review queue      → packages/review-queue (JSON file, or Postgres via DATABASE_URL — see its README) + apps/review-dashboard (approve/reject UI)
```

Each candidate, and within it each platform, is wrapped in its own try/catch (`conductor.ts`) — a bad transcript, a vendor timeout, or one failed video-gen call skips just that unit and logs a warning; it does not abort the run. `RunResult`/`manifest.json` report `candidatesFailed`/`platformsFailed` alongside `reviewItemsCreated` so a partially-failed run is visible, not silent — the review-dashboard's run-history table surfaces both.

**Vendor boundary is deliberate**: Higgsfield/Kling/Runway/Pika/Alibaba Model Studio are called for pixel generation only (`generate_video` / equivalent). Claude is the sole agent that decides captions and virality scores — it never delegates those judgments to a vendor's built-in tool (e.g. Higgsfield's `virality_predictor` is intentionally unused here), because Claude already holds the full script/brand-voice context from the rewrite stage and that context matters more to these judgments than seeing the rendered frames.

Each MCP-shaped package (`mcp-discovery`, `mcp-transcript`, `mcp-assembly`) ships both a plain library (what the CLI calls directly today) and an MCP server entrypoint (`src/server.ts`) exposing the same logic as tools — so the exact same code can be wired into a real Claude Agent SDK subagent session later without a rewrite.

## Why not LangGraph/AutoGen

The pipeline is a fixed, mostly-linear sequence with a couple of fan-outs (per platform, per script segment) — not a dynamic graph requiring runtime replanning. A hand-written TypeScript state machine calling Claude directly for the one reasoning-heavy stage (script rewrite) is simpler to read, test, and deploy than adding a second orchestration framework on top of Claude. This keeps the system "Claude-powered" without extra moving parts.

## Data contracts

All inter-stage data is Zod-validated (`packages/shared-schema`), not free text: `CandidateVideo → Transcript → RewrittenScript → (RawClip[] + CaptionCue[]) → AssembledVideo → ReviewItem`. This is what makes stages swappable — e.g. adding a scraping-based discovery provider later only needs to produce valid `CandidateVideo[]`.

## Voiceover narration (audio ↔ caption sync)

Opt-in via `--voice-vendor elevenlabs|grok` on the CLI (`packages/mcp-voiceover`) — omit it and behavior is unchanged from before this feature existed (silent clips, or whatever native audio the video-gen vendor's clips carry). When enabled, narration is guaranteed to stay in sync with the burned-in captions by construction, not by approximation: each caption cue's text is synthesized as its own TTS call, then force-conformed (`atempo` speedup or silence padding) to exactly that cue's `[startSec, endSec)` window before the per-cue clips are concatenated into one track. Since the captions and the narration are both built from the same cue array with the same timing, they cannot drift apart. `mcp-assembly`'s `assembleVideo` mixes this track in as the final video's audio (replacing the vendor clips' own audio), controlled entirely by an optional `voiceoverPath` parameter — omitted, assembly behaves exactly as it did before.

Generated once per candidate (not per platform, matching how captions are already shared across platforms), and a synthesis failure doesn't fail the candidate — it falls back to no narration for that candidate only, the same non-fatal-per-unit pattern used everywhere else in `conductor.ts`. Deliberately does not attempt lip-sync — see `packages/mcp-voiceover/README.md` for why (the video-gen vendors produce B-roll, not consistent talking-head footage with a mouth to track).

## Staging and rollback

CI previously only published `:latest`/`:<sha>` on merge to `main`, with no staging channel and no rollback runbook beyond "figure out the right `docker pull` command yourself." Now: pushing to an (opt-in) `staging` branch tags images `:staging` + `:<sha>` instead, via the same `.github/workflows/ci.yml` job (just a different moving tag, computed per-branch); `.github/workflows/rollback.yml` is a manual-only `workflow_dispatch` that repoints `:latest`/`:staging` at an already-built `:<sha>` via `docker buildx imagetools create` — a registry-side retag, not a rebuild, so a rollback deploys the exact bytes that already passed CI for that commit rather than risking a fresh build failing or drifting. Verified against a real local registry (`registry:2`): pushed two distinct images as fake `:sha-a`/`:sha-b`, pointed `:latest` at `:sha-b`, ran the rollback command, and confirmed via `docker manifest inspect` that `:latest`'s digest changed to exactly match `:sha-a`'s.

## Alerting on silent-failure runs

Metrics were already collected (`/metrics` on both web apps) but nothing consumed them, and `.github/workflows/weekly-run.yml`'s scheduled runs had no way to distinguish "genuinely nothing to review this week" from "every candidate silently failed" — both looked identical: a green, zero-item run. `apps/orchestrator/src/cli.ts` now exposes `--fail-on-zero-results` (and a pure, unit-tested `determineExitCode` deciding whether to apply it) — set on the scheduled workflow's invocation, unset by default for interactive local use. A `runCycle` throw is also now caught and printed cleanly instead of an unhandled-rejection stack trace, while still exiting non-zero. Either failure mode fails the GitHub Actions job, which trips GitHub's own built-in "notify on failed scheduled workflow" — no new alerting service/account needed for the path that's actually deployed today.

## Agent test coverage

`apps/orchestrator/src/agents/{script-agent,qa-agent,caption-agent}.ts` previously had zero dedicated tests — the only coverage was indirect, through `conductor.test.ts`'s mocked dry-run paths. Each now has its own test file (`@anthropic-ai/sdk`'s default export mocked at the `messages.create` level, not the HTTP layer) covering: the dry-run fallback path never calls the API; the live path calls the model the [model-mix policy](../CLAUDE.md) actually assigns it (`claude-fable-5`/`claude-sonnet-5`/`claude-haiku-4-5` respectively — this is exactly the wiring flagged as unprotected after the model-mix change); cost-ledger recording under the right stage/model; malformed-response error handling (no text block, no JSON found, schema-invalid JSON); and a missing `ANTHROPIC_API_KEY` failing clearly before ever calling the SDK. `qa-agent.test.ts` additionally exercises every branch of the `--dry-run` heuristic scorer (each of the 5 flag conditions individually, plus the 100-point ceiling).

## Failure reasons reach the dashboard

`manifest.json` used to only record aggregate `candidatesFailed`/`platformsFailed` counts — the actual reason (a bad transcript, a vendor timeout, a QA rejection) only ever reached structured pino logs and the CLI's `onProgress` console output, both invisible to a dashboard-only user. `conductor.ts` now collects a `failures: { candidateId, platform?, reason }[]` array alongside those counts and writes it into the manifest; `runs.ts` passes it through; the dashboard's run-history table renders the failed-count cell as a `<details>` disclosure that expands to the actual reason text, instead of a bare number with no way to find out why. Older manifests without a `failures` field degrade gracefully (a "no failure details recorded" note, not a broken row).

## CLI progress and QA readability

`vvugc run` used to print nothing between "run started" and completion — a live run hitting several vendor APIs can take minutes, and with no output in between a terminal looks hung. `runCycle` now takes an optional `onProgress` callback (`apps/orchestrator/src/conductor.ts`), fired once per meaningful step (discovery, and per-candidate: transcribing → rewriting → generating per platform → queued/failed); the CLI wires it to `console.log`. The final summary also no longer leads with a raw `JSON.stringify(result)` dump — that read like debug/crash output even though it wasn't; the JSON is still available (that's what `manifest.json` is for), just not the first thing printed.

The review-dashboard similarly used to show a bare QA score and raw flag slugs (`hook_too_long`) with no way for a reviewer to judge severity without reading the orchestrator's source. `apps/review-dashboard/src/render.ts` now renders `{score}/100 · {qualitative label}` and de-slugifies flags into readable text — a curated phrasing for the fixed `--dry-run` heuristic flags, falling back to snake_case→Title Case for whatever slug the live QA agent's freeform Claude output invents (its system prompt intentionally doesn't constrain flags to a fixed enum).

## Human-in-the-loop

No stage of `conductor.ts` posts to any platform — publishing is reachable only from the review-dashboard's `POST /queue/:id/publish` route (`apps/review-dashboard/src/server.ts`), gated on `status === "approved"` (plus non-dry-run asset and once-only receipt checks), so the approve-then-publish gate this architecture is built around stays intact. `runCycle` always terminates by inserting `ReviewItem` records into `packages/review-queue`'s store with `status: "pending"`; `apps/review-dashboard` is where a human approves or rejects, and an approved item can then be published through `packages/mcp-publish` (YouTube/TikTok/Facebook/Instagram Reels adapters — TikTok/Meta posting still needs the same external app approvals as their discovery APIs; see "Publishing APIs" below). The CLI's `--auto-post` flag exists for future full-autonomy but today only prints a warning and still writes to the queue — the pipeline never publishes by itself, by design, until you decide you trust its output unsupervised.

## Known gaps / where to extend next

- **TikTok/Instagram discovery**: real, tested implementations (`packages/mcp-discovery/src/tools/{tiktok,meta}.ts`, 22 tests against mocked-but-verified API shapes) — blocked purely on you obtaining approved API access (TikTok Research API application; Meta app with `instagram_basic`), not on missing code. **Facebook discovery is genuinely unimplemented** — its Graph API has no hashtag/trending search, only a Page Feed API scoped to a specific page you already operate, which needs a niche→Page-ID config mapping this scaffold doesn't have yet.
- **ASR fallback**: now wired end-to-end — `mcp-transcript`'s `transcribeWithAsrFallback` extracts audio via yt-dlp (`audio-extract.ts`) and transcribes with a real Whisper client (`asr.ts`), and `transcribeCandidate` falls back to it automatically when YouTube captions are missing (requires a Whisper-capable `OPENAI_API_KEY`; an earlier version of this doc described it as a throwing stub — no longer true).
- **Higgsfield in a deployed (non-Claude-session) context**: the Higgsfield adapter takes an injected `callMcpTool` (used only for `generate_video` — pixel generation, never scoring/captions) because Higgsfield today is only reachable via an active MCP connection, not a standalone REST API — see `infra/cron/README.md` for the deployment implication.
- **`--video-vendor gemini`**: a still-image-driven alternative to the video vendors above — one Gemini-generated image per script segment, Ken-Burns-panned into a clip (`packages/mcp-video-gen/src/adapters/gemini.ts`). Useful when no video-gen vendor credential is configured (or Higgsfield's interactive-session requirement doesn't fit a given deployment) — it's a standalone REST call, not MCP-only like Higgsfield. Also the path `apps/marketing-site/scripts/generate-demo-videos.ts` uses to populate the landing page's placeholder gallery without needing an interactive Claude session — see `docs/marketing-site.md`'s "Phase A".
- **`--video-vendor alibaba`**: Alibaba Model Studio hosted async video generation (`packages/mcp-video-gen/src/adapters/alibaba.ts`). Defaults to `wan3.0-video`; configure `DASHSCOPE_API_KEY`, the full region-matched `ALIBABA_VIDEO_ENDPOINT`, and optionally `ALIBABA_VIDEO_MODEL` for Wan 2.7 / 3.0 or HappyHorse 1.1 model IDs. The adapter sends `X-DashScope-Async: enable`, polls `/api/v1/tasks/{task_id}` every 15 seconds for up to 15 minutes, then downloads the temporary MP4 before the provider's 24-hour URL expiry. Model Studio requires the API key, model, and endpoint to belong to the same region. Pricing is model/region-specific; the ledger's rate is only a placeholder. See `.env.example` and `docs/cost-table.md`.
- **Publishing APIs**: real adapters exist in `packages/mcp-publish` for all four targets — YouTube Data API v3 resumable upload (`youtube.ts`, reached with the dashboard's `youtube.upload` OAuth scope in `google-oauth.ts`), TikTok Content Posting direct-post (`tiktok.ts`), Facebook Page resumable upload, and Instagram Reels publish (`meta.ts`), each covered by mocked-contract tests — but they are only reachable from the dashboard's approve-gated `POST /queue/:id/publish` route, never from the pipeline itself. Not yet proven with a real funded/authorized posting account, and TikTok/Meta publishing waits on the same external app approvals as their discovery APIs (see `docs/go-live-plan.md` Part D).
- **ffmpeg execution**: `packages/mcp-assembly` probes the `ffmpeg-static`/`ffprobe-static` binaries first and falls back to a system `ffmpeg`/`ffprobe` on PATH when the downloaded binary isn't runnable (the original motivation: this project's dev sandbox once blocked the freshly downloaded `ffmpeg.exe` with `EFTYPE`/"Exec format error"; `resolveFfmpegPath`/`resolveFfprobePath` in `src/lib.ts` handle that case instead of failing). The assembly tests run real ffmpeg/ffprobe against real files, and this machine has a working system ffmpeg (`ffmpeg -version` → 8.0.1) — but if you hit spawn failures on a new host, that's the first thing to check (`ffmpeg -version` runs cleanly?) before suspecting the code.

## Linting

`.github/workflows/ci.yml` previously listed a `lint` task in `turbo.json` and a root `lint` script, but no package actually defined one and there was no ESLint config anywhere — `pnpm lint` silently did nothing. Fixed with a real flat-config ESLint setup (`eslint.config.mjs`, `typescript-eslint` recommended rules) run as `pnpm lint` (a single pass over the whole workspace, not per-package via turbo — one shared config makes that unnecessary), wired into CI as the first step after `pnpm install`, before the slower build/test/e2e steps. First real run caught two genuine issues (a dead `dirname` import in `mcp-assembly/src/lib.ts`, and a handful of files missing browser/Node global definitions) — both fixed, not suppressed.

## Dependency vulnerability scanning

`pnpm audit` is currently non-functional (npm's audit endpoint was retired, HTTP 410) — CI now runs [OSV-Scanner](https://google.github.io/osv-scanner/) against `pnpm-lock.yaml` instead (`.github/workflows/ci.yml`'s `dependency-scan` job, `fail-on-vuln: true`), plus `.github/dependabot.yml` for ongoing weekly alerts/PRs across npm, GitHub Actions, and the Docker base image.

Running this for the first time found something real: all three runtime Docker images were shipping `vitest`/`vite`/`esbuild` (including a Critical-severity vitest CVE) despite being pure devDependencies that never execute at runtime — the multi-stage Dockerfiles copied the *entire* build stage's `/repo` (all devDependencies included) into the runtime image with no pruning step. Fixed by wiping `node_modules` and reinstalling `--prod` in the runtime stage of all three Dockerfiles; verified by rebuilding each image and confirming the packages are gone from the running container's filesystem, and that each app still starts/serves/passes its smoke test afterward. (`pnpm prune --prod` looks like the more obvious one-line fix but silently no-ops in this pnpm version when run in a non-interactive Docker `RUN` layer — it wants to prompt "reinstall from scratch?" with no TTY to answer it — so don't reach for it here without checking it actually removed anything.)

**Follow-up from this pass — since resolved**: the `vitest`/`vite`/`esbuild` lockfile bump that this note deferred has landed (lockfile now carries vitest 3.2.7, vite 6.4.3, esbuild 0.25.12 — the CVE-driven 2.x→3.x migration this paragraph warned about is done; re-verified against `pnpm-lock.yaml`).

## Process lifecycle

Both web apps install `installLifecycleHandlers` (`@vvugc/shared-metrics`) on their real (non-test) server instance: an `unhandledRejection`/`uncaughtException` handler that logs the cause with the structured logger before exiting (rather than a silent crash with only Node's default stderr dump), and a `SIGTERM`/`SIGINT` handler that calls `server.close()` to drain in-flight requests before exiting 0 — with a 10s forced-exit fallback if draining hangs. Verified against a real container via `docker stop` (sends actual SIGTERM), not just unit tests.

## Trust proxy

Both web apps read `TRUST_PROXY_HOPS` (`@vvugc/shared-config`) and call `app.set("trust proxy", hops)` when it's set (default 0 — trust nothing). This exists specifically for the rate limiters below, which key on `req.ip`: with no reverse proxy in front (local dev, a directly exposed container) that's correctly the real client; behind a load balancer/reverse proxy it defaults to the proxy's own address unless `trust proxy` is set to how many hops to trust — otherwise every real client gets bucketed into the same rate-limit counter as the proxy. Verified with a real `X-Forwarded-For` header: unset, it's ignored (`req.ip` stays the direct socket peer); `TRUST_PROXY_HOPS=1` picks it up correctly.

## Rate limiting

Both web apps limit request volume per client IP (`express-rate-limit`) on the endpoints that matter: the marketing-site's public, unauthenticated `POST /api/waitlist` (10 submissions per 15 minutes — otherwise an open disk-fill/webhook-hammering vector), and the review-dashboard's Basic Auth check (20 *failed* attempts per 15 minutes per IP, `skipSuccessfulRequests: true` so an already-authenticated admin never gets throttled — this slows brute-forcing the password at network speed, which timing-safe comparison alone doesn't address).

## Public metadata

`apps/marketing-site`'s og:image/twitter:image/og:url meta tags are absolute URLs, filled in at request time from `PUBLIC_BASE_URL` (set this in any real deployment) or, if unset, derived from the incoming request's own protocol/host — see `resolveBaseUrl` in `apps/marketing-site/src/server.ts`.

## Running it

See the repo root [`README.md`](../README.md) for `pnpm install`, `--dry-run`, and live-run instructions.
