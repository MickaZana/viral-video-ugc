# Viral Video UGC — Master Reform Prompt

Use this as the single source of truth for the next implementation pass.

- Repo: https://github.com/MickaZana/viral-video-ugc.git
- Local: C:\Users\mican\Documents\Viral Video UGC
- Branch: main. Work on a new branch.
- Do not rewrite the 9-stage conductor. Do not add Redis. Do not create apps/creator-dashboard. The workspace is apps/control-panel.

## 0. What "10x Higgsfield" means (true, not marketing)

Higgsfield (Aug 2026) is a generation studio: Soul ID, Cinema Studio 4.0, DoP camera, Marketing Studio (URL to 15s lipsync ad), Canvas, Supercomputer. They win character lock, directed camera, and model routing. They do not have a discovery loop, a weekly job, timed captions as an object, or an approve/publish queue.

Do not try to beat Soul ID, DoP, Cinema Studio lenses, or Seedance/Kling quality. Route picture jobs to Higgsfield/Kling/Runway/Pika/Gemini. Own the operator system of record they never built.

Higgsfield vs Viral Video UGC:

- Blank prompt / product URL / style preset  ->  Ranked viral sources this week
- One script, one 5-15s gen sitting in Assets  ->  Hook / Point / CTA x 3 platforms, voiced, captioned, assembled
- Flat Assets folder + comments  ->  Nested workspace: Week -> Job -> Stage
- Credit usage log  ->  Dollars and originality per keeper
- Virality Predictor on a clip you already made  ->  Pattern already proven in the wild, then scored again after assemble
- Supercomputer "weekly refresh" of a brief  ->  Discovery that cannot start from a blank prompt
- Click Generate is the human gate  ->  HITL queue: Needs QA -> Changes -> Approved -> Published

10x is the factory, not the pixel. A creator opens This Week, remixes a proven post, watches nine stages live, reviews a 9:16 master with captions + VO, and ships. Higgsfield still does not have that loop.

Steal and invert their language:

- Hero Frame First -> Viral Frame First (lock the proven hook before any gen)
- Hook + Setting -> Hook + Point + CTA as the script atom
- Ad Reference (you upload a video) -> live URL ingest
- "Cinema Studio. Its own workspace, at last" -> Week -> Job -> Stage, not Project -> Generation
- Claude never clicks Generate -> a real approve gate

## 1. Name, surfaces, what to kill

Name: Viral Video UGC. Kill UGU PROGRAM, ugu-program chrome, "better yorbi", and Yorby-as-the-only-competitor copy.

One public site. One authenticated workspace. The CLI stays as a power tool, not the product.

Kill:

- Dual landing. Delete SPA Landing.tsx as a product surface. Marketing lives in apps/marketing-site. Unauthenticated / -> /app (workspace sign-in). Authenticated / -> /app/review or /app (This Week).
- Operator HTML as home. render.ts and account-page.ts are not the product. Redirect / (session) -> /app/review. Collapse approve/reject into the SPA.
- Unicode/glyph nav. Real icon set, 16px, one weight.
- Google Fonts @import. Self-host.
- Tab-state IA (useState TabId + ugu-navigate events). Real routes.
- Second visual language. Lime is a signal LED, not a brand fill. Inter only for UI. JetBrains Mono only on telemetry (cost, seq, timestamps), never on nav or headlines. No Barlow Condensed.
- apps/creator-dashboard/ if anyone starts it. Extend apps/control-panel.
- Placeholder SVG gallery. Real 9:16 mp4s.
- Basic Auth on the product path. Session cookie + CSRF. MFA stays.

Keep (do not flatten):

- 9-stage conductor (discovery -> transcript -> script -> voiceover -> video -> assembly -> qa -> queue -> complete)
- Remix-from-URL, originality scoring, caption-timing agent, force-conformed VO, ffmpeg assembly, vendor fallback chain, cost ledger, dry-run, agency clients, HITL (nothing auto-posts)
- Existing onboarding overlay: deepen it (create client + first dry-run in 30s), do not add a fifth welcome
- Higgsfield as a pixel vendor (default kling3_0_turbo via MCP), not the product
- Design tokens file, but one palette

## 2. Workspace IA (nested, not flat)

Today: 7 sibling tabs, overlays for review/onboarding/password. That is a CLI with lime paint.

Information architecture: grouped, URL-addressable, one object deep at a time.

Public:

- /                         marketing site (apps/marketing-site)
- /app                      SPA shell; unauthenticated -> sign in

Workspace (SPA, served at /app/*):

- /app                      THIS WEEK     cadence board + quota + next run
- /app/intel                INTEL         viral inbox (was Spy)
- /app/intel/:sourceId                    source detail + Remix into this week
- /app/intel/remix                        paste URL (was Remix tab)
- /app/studio               STUDIO        start a run / pick models
- /app/studio/script/:id                  Hook / Point / CTA board (was Rewriter)
- /app/studio/runs/:runId                 live 9-stage factory (was in-tab takeover)
- /app/library              LIBRARY       9:16 masters (was History videos)
- /app/library/:id                        player + metadata + keeper ledger
- /app/review               REVIEW        HITL queue (was History modal + operator HTML)
- /app/review/:id                         watch, originality, cost, approve/reject
- /app/brand                BRAND         kit + clients + avatars (new, schema exists)
- /app/brand/clients/:id
- /app/billing              BILLING
- /app/settings             SETTINGS      password, MFA, theme, sessions

Primary nav is 6 groups, not 7 flat tools. Nested pages are children, never extra top-level items.

Sidebar:

    THIS WEEK
    INTEL          inbox, remix
    STUDIO         new run, scripts
    LIBRARY
    REVIEW         badge = needs QA count
    ---------------
    Brand
    Billing
    Settings

Rules:

- Every run is a place: /app/studio/runs/:runId. Progress does not die inside the generator tab.
- Review is a place, not a modal. A modal may be a quick action from the queue, never the only path.
- Remix is an action on a source, not a sibling product.
- Clients and Brand Kit are first-class. BrandKitSchema is dead until this route writes it and assembly burns logo/color/captions.
- No second "Landing" link inside the workspace. Logo -> This Week.

Router: React Router in apps/control-panel. review-dashboard serves index.html for /app and every workspace path above.

## 3. Visual system (Starlink, not SaaS lime)

Cinematic restraint. Black, near-black, white, one signal color.

- Background #080808, surface #111, raised #1a1a1a, hairline #242424
- Text #f0f0f0, secondary #8a8a8a
- Signal lime #c8ff00: progress, live, approved, the one CTA. Never large fills, never headlines, never backgrounds.
- Destructive red #ff2b2b only
- Type: Inter everywhere. Mono only on numbers.
- Geometry: square chrome, 1px borders, no pills in the workspace, no 10px marketing radius
- Motion: 150-250ms, opacity + 4px translate. Kill SYS: ONLINE, scanlines, blinking terminal cursors, pulse-lime-glow on cards. Keep prefers-reduced-motion.
- 9:16 is the hero unit. Grids are vertical cards, not landscape thumbnails.
- Light theme may stay as a token set. Default is dark.

Feel: Starlink.com ops console, not a cyberpunk dashboard and not a rounded marketing site.

## 4. Screens and objects that must exist (the 10x loop)

These are the product. Higgsfield does not have them.

### 4.1 This Week (home)

Object: Week { n, quota, platforms, jobs[] }.

- Quota strip: e.g. 7 finished / 3 platforms. Auto-pull top sources Monday. Freeze Friday.
- Next action is always one: Start this week's run, or Review N waiting.
- Not a stats shrine. Dashboard vanity numbers (creators tracked, source views) move to Intel.

### 4.2 Viral Inbox (/app/intel)

Object: ViralSource { url, platform, views, velocity, hook_transcript, structure }.

- Ranked live YouTube (and TikTok/IG when credentials exist). Not "Viral Presets" (named looks).
- Primary action: Remix into this week.
- Spy's "SURVEILLANCE ACTIVE" tone dies. This is an inbox, not a video game.

### 4.3 Script Board (/app/studio/script/:id)

Object: three editable blocks Hook / Point / CTA, each with YouTube / TikTok / IG variants and a diff vs source. Originality score on the board, not buried in a modal.

- Rewriter tab becomes this. Keep the Claude rewrite. Add platform columns.

### 4.4 Timed Caption Track + Voice Pass

Captions are a first-class layer (word-level, editable) before assemble. Voice is a re-runnable stage (ElevenLabs/Grok, take-N) that does not regenerate picture. This already exists in the pipeline. The UI must expose it as stages on /app/studio/runs/:runId, not a black box.

### 4.5 Assemble Job

Object: CutList { shots[], audio[], captions[], duration, aspect }. ffmpeg already concatenates, crops, burns captions, mixes VO. The run page shows the cut list as it lands.

### 4.6 HITL Review Queue (/app/review)

Columns: Needs QA / Changes / Approved / Published.

Per card: 9:16 player, originality, cost-to-keeper, source URL, [A] / [R].

No publish UI this round (API exists, not integrated). Approved = ready to export.

### 4.7 Run page (/app/studio/runs/:runId)

The feature Higgsfield cannot copy. Nine stages live via SSE. Deep-linkable. Reconnect via Last-Event-ID. This is the factory floor.

### 4.8 Keeper Ledger

Per finished asset: model, attempts, dollars (not credits), originality vs source, who approved, where published. Surface on library detail + review card. Higgsfield Usage is a credit log. This is campaign economics.

### 4.9 Brand + Client

/app/brand writes BrandKit (logo, colors, captionStyle, defaultCta, forbiddenClaims) onto AgencyClient. Assembly should burn logo/color/captions next (may be a follow pass; UI must collect it now). Create-client form in Studio must collect brand kit, not only niche + vendor.

### 4.10 First-run (30 seconds)

Deepen existing Onboarding.tsx. Happy path:

POST /api/accounts/start { niche, platform, sourceUrl? } -> 202 { job, runId, progressUrl }

Creates a default client if none exist. sourceUrl set -> remix (skip discovery). Omitted -> discovery. dryRun true unless live is explicit and the account has pipeline.run.live.

Land on /app/studio/runs/:runId. Dry-run is the default. Pro tip stays: dry-run is free.

## 5. Optimize the technology we already have (do not rebuild)

The pipeline is ahead of the costume. Upgrade the system around it.

Keep as-is:

- apps/orchestrator/src/conductor.ts 9-stage state machine
- Zod contracts in packages/shared-schema
- Vendor fallback generateClipWithFallback (higgsfield then gemini/replicate)
- Originality, cost ledger, dry-run, human review
- ffmpeg assembly, caption agent, voiceover force-conform
- Stripe hybrid tiers already in code: Starter 39/4, Growth 99/15, Agency 249/60 (ignore stale prices in Comparative_Analysis_vs_Higgsfield.md)
- Docker + Fly + GitHub Actions

Backend sequence (frozen):

1. Remove operator-only login from the product path. Tenant-scope every queue, runs, stats, preview, and SSE read. Session cookie plus CSRF. MFA stays. Do not require DASHBOARD_USERNAME in production.
2. Postgres as default for identity, sessions, jobs, queue, usage. JSON under ./runs is local fallback only.
3. One run path: POST /api/accounts/start (happy path) and POST /api/accounts/run plus /jobs (explicit, body { clientId, dryRun?, live? }) all return 202 { job, runId, progressUrl }. Detach the Fly worker using existing SKIP LOCKED. Persist ProgressEvent rows. No in-memory EventEmitter as source of truth.
4. Hosted secrets plus process split. architecture.md last.

No Redis. No conductor rewrite. No Temporal.

SSE contract (freeze):

- GET /api/accounts/run-progress/:runId (session cookie)
- Events: connected { runId, jobId, stages }, snapshot { runId, jobStatus, overallProgress, steps[], lastSeq } on connect/reconnect via Last-Event-ID, progress = existing ProgressEvent plus seq plus jobId, done { runId, jobId, ok, result? }
- Heartbeat comments every 15s
- Stages unchanged: discovery, transcript, script, voiceover, video, assembly, qa, queue, complete
- Status: start | progress | done | error
- PipelineProgress keeps its ProgressEvent shape. Treat run start as async 202 plus SSE.

Also frozen:

- GET /api/accounts/jobs, GET /api/accounts/jobs/:id, DELETE cancel, POST replay
- GET /api/runs org-scoped RunSummary[]
- Product queue read: GET /api/accounts/review-items. Unscoped /api/queue dies or aliases the scoped one.
- GET /api/media/:reviewItemId: session, org-scoped, video/mp4, Accept-Ranges bytes, 206 on Range
- GET /api/media/:reviewItemId/thumbnail: image, org-scoped. History grid uses thumbnailUrl on the payload, same-origin.
- SPA fallback: index.html for all /app workspace routes
- 302 /account to /app
- 302 / to /app/review when session exists; unauthenticated / to /app
- No publish UI this round

Picture quality (do not fake a Soul competitor this pass):

- Keep Higgsfield/Kling as renderer
- Prompting: stop sending the raw script line as the shot prompt. Add a thin shot-brief (hook vs point vs CTA, duration, aspect) in the video stage without rewriting the conductor stage graph
- Persist referenceImageUrl on the client when the user uploads one (CreatorProfile-lite). Full Soul/avatar training is a later pass
- Segment-type routing is a later pass unless it fits in the video-stage prompt builder without a conductor rewrite

## 6. Marketing site (one public face)

apps/marketing-site is the only public landing.

- Wordmark: Viral Video UGC
- Pitch: A week of finished shorts from what is already working. Not prompt-to-clip.
- Replace SVG placeholders with 3 to 5 real 9:16 mp4s
- Comparison: Higgsfield generates a clip. This ships a week. Yorby rewrites a script. This finishes the video.
- Same visual system as the workspace (dark, Inter, lime as LED)
- Waitlist CTA can stay. Private beta / YouTube-first is honest.

## 7. Rebuild order

1. Shell + router + name. Inter, lime-as-LED, grouped nav, kill UGU PROGRAM and Landing.tsx.
2. First-run. POST /api/accounts/start, land on the run page, 30 seconds to a dry-run.
3. Run page + SSE. Durable progress, nine stages, cost as it accrues.
4. Library 9:16. Real players, range requests, thumbnails, keeper numbers.
5. Review. Queue columns, /app/review/:id, fold operator HTML in.
6. Intel + Script Board. Viral inbox, remix-from-source, Hook/Point/CTA across platforms.
7. This Week cadence. Quota, Monday pull, Friday freeze.
8. Brand kit UI. Write the schema that already exists.
9. Marketing gallery. Real 9:16 demos.
10. Backend in parallel with steps 1-3: tenant scoping, Postgres default, 202 enqueue plus SKIP LOCKED plus ProgressEvent rows, then hosted split.


Done when:

- A new user can sign in, start a dry-run from a niche or a pasted URL, watch nine stages on a refreshable URL, and approve a 9:16 master in Review.
- They never see a second product or the words UGU PROGRAM.
- Nav is grouped and every run and review has a URL.
- Higgsfield is a vendor in the run log, not the name on the door.

## 9. North-star sentence

Viral Video UGC is the weekly factory that finds what is already viral, rewrites Hook / Point / CTA per platform, voices it, captions it, assembles a 9:16 master, and queues a human. Higgsfield is one of the cameras on the floor.
