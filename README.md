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

TikTok/Instagram/Facebook discovery and the Kling/Runway/Pika video vendors are implemented but need their respective API credentials — see `docs/architecture.md`'s "Known gaps" section for what each one needs before it goes live. Higgsfield video generation requires running inside a Claude Agent SDK session with the Higgsfield MCP server attached (it has no standalone REST API) — see `infra/cron/README.md`.

## Repo layout

```
apps/orchestrator/       conductor + CLI (`vvugc run ...`)
apps/review-dashboard/   human-in-the-loop approve/reject UI
apps/marketing-site/     public landing page — video gallery + UGC-review wall, manifest-driven
packages/mcp-discovery/  YouTube/TikTok/Meta discovery adapters
packages/mcp-transcript/ caption/ASR transcription
packages/mcp-video-gen/  Higgsfield/Kling/Runway/Pika video adapters
packages/mcp-assembly/   ffmpeg stitching, captions, aspect-ratio, thumbnails
packages/review-queue/   JSON-file-backed HITL queue
packages/shared-schema/  Zod data contracts shared by every stage
packages/shared-config/  env/secrets loader
infra/cron/              documented (not deployed) weekly-cadence Lambda shape
docs/                     architecture + cost table
```
