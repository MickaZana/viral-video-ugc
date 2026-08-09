# Viral Video UGC

Claude-powered, cloud-orchestrated pipeline that discovers viral short-form video content, rewrites it into new scripts, generates and assembles finished platform-ready videos, and queues them for human review — on a weekly cadence, from one command.

See [`docs/architecture.md`](docs/architecture.md) for the full design and [`docs/cost-table.md`](docs/cost-table.md) for the vendor cost template.

## Quickstart

```bash
pnpm install
pnpm build
cp .env.example .env   # fill in keys for any live (non-dry-run) stages you want to use

# Full pipeline with mocked discovery/transcript/video-gen — no API keys needed
pnpm cli run --niche=fitness --platforms=tiktok,youtube_shorts --dry-run

# Review queue UI
pnpm --filter @vvugc/review-dashboard dev
# open http://localhost:4310

# Marketing/landing page (see docs/marketing-site.md for the video-manifest workflow)
pnpm --filter @vvugc/marketing-site dev
# open http://localhost:4320
```

## Live run (needs real API keys)

At minimum: `ANTHROPIC_API_KEY` (script rewrite) and `YOUTUBE_API_KEY` (the only fully-wired live discovery source today).

```bash
pnpm cli run --niche=fitness --platforms=youtube_shorts --max-candidates=3
```

The Kling/Runway/Pika video vendors are implemented but need their respective API credentials — see `docs/architecture.md`'s "Known gaps" section for what each one needs before it goes live. Higgsfield video generation requires running inside a Claude Agent SDK session with the Higgsfield MCP server attached (it has no standalone REST API) — see `infra/cron/README.md`. `--video-vendor gemini` is a still-image-driven alternative that needs only `GEMINI_API_KEY` (a standalone REST call, no MCP session required) — see `packages/mcp-video-gen/src/adapters/gemini.ts`.

### Voiceover narration (optional)

Add `--voice-vendor elevenlabs` or `--voice-vendor grok` to narrate the video with speech perfectly synced to the burned-in captions — omit it and videos stay silent/vendor-native-audio, today's default. Needs `ELEVENLABS_API_KEY` or `XAI_API_KEY` respectively (see `.env.example`); works in `--dry-run` too, with no credentials needed (a mock adapter exercises the same timing/sync logic against generated silence). See `packages/mcp-voiceover/README.md` for how the sync guarantee actually works — this is not lip-sync (the video vendors here produce B-roll, not consistent talking-head footage).

```bash
pnpm cli run --niche=fitness --platforms=youtube_shorts --voice-vendor=elevenlabs --dry-run
```

### Populating the marketing site's demo gallery

The landing page ships with 7 empty video-gallery placeholders (`apps/marketing-site/content/video-manifest.json`). `generate-demo-videos.ts` fills them in with real, generated content — Gemini stills Ken-Burns-panned into clips, ElevenLabs/Grok narration, burned-in captions — reusing the same `mcp-video-gen`/`mcp-voiceover`/`mcp-assembly` packages as the main pipeline, without needing an interactive Higgsfield session. See `docs/marketing-site.md`'s "Phase A" section.

```bash
pnpm --filter @vvugc/marketing-site generate-demo-videos -- --dry-run  # no API keys needed
pnpm --filter @vvugc/marketing-site generate-demo-videos               # needs GEMINI_API_KEY
```

### Platform support

**v1 scope is YouTube Shorts only for live discovery — not because the other adapters are unbuilt, but because they sit behind an external approval gate this scaffold can't clear on its own.** TikTok (`packages/mcp-discovery/src/tools/tiktok.ts`) and Instagram (`.../meta.ts`) are real, working implementations, verified against each platform's actual documented API shape and covered by tests that mock the real request/response contracts (22 tests total: OAuth token exchange, the Research API's `query.and[].{field_name,operation,field_values}` condition shape, `ig_hashtag_search` → `{hashtag-id}/top_media`, error handling for both HTTP-level and in-body error codes). They will make real API calls the moment credentials are in place:

- **TikTok** — set `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`. Requires an approved TikTok Research API application (client-credentials OAuth exchange happens automatically inside the adapter).
- **Instagram** — set `META_ACCESS_TOKEN` **and** `META_IG_BUSINESS_ACCOUNT_ID` (both required — a token alone isn't enough; Instagram's hashtag-search endpoints require the querying Business/Creator Account's ID). Requires an approved Meta app with `instagram_basic` permission.
- **Facebook** — genuinely not implemented, for a different reason than approval: Facebook's Graph API has no hashtag/trending search at all, only a Page Feed API that reads posts from a *specific page you already operate*. That's a niche→Page-ID mapping this scaffold has no config shape for yet, not just missing credentials.

Neither approval process is something this repo (or an AI agent working in it) can complete on your behalf — they require your TikTok/Meta developer accounts and a human review step on their end.

- `--dry-run` exercises the full pipeline for **all four platforms** with mock candidate data — useful for demos and testing without any of this.
- Live (non-dry-run) runs with `--platforms` including `tiktok`, `instagram_reels`, or `facebook` print a warning and produce zero candidates for those platforms until credentials are configured — the run still completes using whatever platforms *did* work (each candidate/platform is independently fault-tolerant; see `docs/architecture.md`).
- The CLI defaults `--platforms` to `youtube_shorts` only, for exactly this reason.

## Deployment

**CI publishes runnable images; it doesn't pick where they run.** On every push to `main`, `.github/workflows/ci.yml` builds all three Docker images and pushes them to GitHub Container Registry (`ghcr.io/<owner>/<repo>/{review-dashboard,marketing-site,orchestrator}:latest`, plus an immutable commit-SHA tag) — no setup needed, it authenticates with the workflow's own `GITHUB_TOKEN`. That's the "publish the artifact" half of CD. The "run it somewhere reachable" half needs a hosting target — Fly.io, Railway, ECS, a VPS, etc — which is a real cost/ops tradeoff only you can make; point whichever host you pick at the published image.

**Fly.io, concretely**: if you don't want to pick a host from scratch, `fly.review-dashboard.toml` and `fly.marketing-site.toml` at the repo root are ready-to-use configs (health checks, persistent volumes, the `TRUST_PROXY_HOPS` setting Fly's proxy requires) — see [`docs/deploy-fly.md`](docs/deploy-fly.md) for the full first-deploy walkthrough, required secrets, and rollback notes. These build from source on Fly's own builders rather than deploying the GHCR image above, so `rollback.yml` doesn't apply to a Fly deployment — `docs/deploy-fly.md` covers what does.

**Staging (opt-in)**: push/merge to a `staging` branch instead of `main` and the same workflow tags images `:staging` + `:<sha>` rather than `:latest` + `:<sha>` — point a staging host at the `:staging` tag, verify there, then merge the same commit into `main` to promote it to production. Nothing about this is required; if you don't use a `staging` branch it simply never triggers. If you do, give the staging deployment its own `DATABASE_URL` (a separate Postgres, not the production one — see `packages/review-queue/README.md`) so staging traffic never touches production review-queue data.

**Rollback**: `.github/workflows/rollback.yml` (manual `workflow_dispatch` only — never runs automatically) retags an already-built `:<sha>` image as `:latest` or `:staging` via `docker buildx imagetools create`, which repoints the tag in the registry without rebuilding — the exact bytes that already passed CI for that commit, not a fresh build that could itself fail or drift. Find the commit SHA to roll back to from the Actions history (a prior successful "build-and-push-images" run), run the workflow with that SHA + which image(s) + which channel, then redeploy/restart your host so it pulls the repointed tag.

**The review-dashboard requires `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`** in any real deployment — it approves/rejects content before it ships, so it's never served unauthenticated (see `apps/review-dashboard/src/auth.ts`). Leave both unset only for local dev/testing; the dashboard then generates a random one-time password and prints it in a plain-text startup banner. Production fails closed when explicit credentials are missing. Set real env vars for a login that survives restarts; never treat generated local credentials as a deployment secret.

**All three containers run as a non-root user (uid 1000)**, not root. The `./runs` bind-mount keeps whatever ownership it already has on the host — if your host account isn't also uid 1000, the container won't be able to write to it. Run `chmod -R a+rwX runs` once before `docker compose up` (see the comment atop `docker-compose.yml` for the alternative: override each service's `user:` to match your own uid/gid instead).

**The marketing-site should have `PUBLIC_BASE_URL` set** in any real deployment — og:image/twitter:image meta tags must be absolute URLs per spec, and the server has no other way to know its own public origin (a proxy/CDN in front of it may present a different host than what it binds to). Leave it unset for local dev; the server then falls back to deriving the origin from each incoming request.

## Repo layout

```
apps/orchestrator/       conductor + CLI (`vvugc run ...`)
apps/review-dashboard/   human-in-the-loop approve/reject UI
apps/marketing-site/     public landing page — video gallery + UGC-review wall, manifest-driven
packages/mcp-discovery/  YouTube/TikTok/Meta discovery adapters
packages/mcp-transcript/ caption/ASR transcription
packages/mcp-video-gen/  Higgsfield/Kling/Runway/Pika video adapters
packages/mcp-assembly/   ffmpeg stitching, captions, aspect-ratio, thumbnails
packages/review-queue/   HITL queue — JSON file by default, Postgres via DATABASE_URL (see its README)
packages/shared-schema/  Zod data contracts shared by every stage
packages/shared-config/  env/secrets loader
infra/cron/              documented (not deployed) weekly-cadence Lambda shape
docs/                     architecture + cost table
```
