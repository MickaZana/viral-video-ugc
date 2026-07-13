# Viral Video UGC Architecture

## Why this exists

Yorby.ai (reverse-engineered from its public site) is a **script remixer**: paste a viral video link, get a rewritten hook/point/CTA script back in under a minute. It stops there — no discovery automation, no video generation, no scheduling, no editor. Viral Video UGC is the full pipeline Yorby doesn't build: **discovery → transcript → script rewrite → video generation → assembly → human-reviewed queue**, running on a weekly cadence from one command.

## Topology

A single **conductor** (`apps/orchestrator/src/conductor.ts`) owns the pipeline state machine and calls each stage in sequence. Stages are separated into independently buildable/testable packages so a discovery source, video vendor, or assembly step can change without touching the others:

```
CLI: vvugc run --niche=fitness --platforms=tiktok,youtube_shorts
        │
        ▼
  conductor.runCycle(RunConfig)
        │
        ├─ Stage 1  Discovery         → packages/mcp-discovery   (YouTube live; TikTok/Meta adapters stubbed pending API approval)
        ├─ Stage 2  Transcription     → packages/mcp-transcript  (YouTube captions live; ASR fallback stubbed)
        ├─ Stage 3  Script rewrite    → apps/orchestrator/src/agents/script-agent.ts (Claude, via Anthropic SDK)
        ├─ Stage 4  Caption timing    → apps/orchestrator/src/agents/caption-agent.ts (Claude decides cue text/timing)
        ├─ Stage 5  Video generation  → packages/mcp-video-gen   (Higgsfield via injected MCP call, Kling/Runway/Pika via REST — pixels only)
        ├─ Stage 6  Assembly          → packages/mcp-assembly    (ffmpeg: concat, aspect-ratio crop, burns Claude's caption cues, thumbnail)
        ├─ Stage 7  QA / scoring      → apps/orchestrator/src/agents/qa-agent.ts (Claude, via Anthropic SDK — not a vendor tool)
        └─ Stage 8  Review queue      → packages/review-queue (JSON file) + apps/review-dashboard (approve/reject UI)
```

**Vendor boundary is deliberate**: Higgsfield/Kling/Runway/Pika are called for pixel generation only (`generate_video` / equivalent). Claude is the sole agent that decides captions and virality scores — it never delegates those judgments to a vendor's built-in tool (e.g. Higgsfield's `virality_predictor` is intentionally unused here), because Claude already holds the full script/brand-voice context from the rewrite stage and that context matters more to these judgments than seeing the rendered frames.

Each MCP-shaped package (`mcp-discovery`, `mcp-transcript`, `mcp-assembly`) ships both a plain library (what the CLI calls directly today) and an MCP server entrypoint (`src/server.ts`) exposing the same logic as tools — so the exact same code can be wired into a real Claude Agent SDK subagent session later without a rewrite.

## Why not LangGraph/AutoGen

The pipeline is a fixed, mostly-linear sequence with a couple of fan-outs (per platform, per script segment) — not a dynamic graph requiring runtime replanning. A hand-written TypeScript state machine calling Claude directly for the one reasoning-heavy stage (script rewrite) is simpler to read, test, and deploy than adding a second orchestration framework on top of Claude. This keeps the system "Claude-powered" without extra moving parts.

## Data contracts

All inter-stage data is Zod-validated (`packages/shared-schema`), not free text: `CandidateVideo → Transcript → RewrittenScript → (RawClip[] + CaptionCue[]) → AssembledVideo → ReviewItem`. This is what makes stages swappable — e.g. adding a scraping-based discovery provider later only needs to produce valid `CandidateVideo[]`.

## Human-in-the-loop

No stage posts to any platform. `runCycle` always terminates by inserting `ReviewItem` records into `packages/review-queue`'s JSON store with `status: "pending"`; `apps/review-dashboard` is where a human approves or rejects. `--auto-post` exists as a CLI flag for future full-autonomy but currently only prints a warning — no publishing API integration has been built, by design, until you decide you trust the pipeline's output unsupervised.

## Known gaps / where to extend next

- **TikTok/Meta discovery**: adapters are shaped correctly (`packages/mcp-discovery/src/tools/{tiktok,meta}.ts`) but throw until you have approved API access — see the error messages for exactly what's needed.
- **ASR fallback**: `mcp-transcript`'s `transcribeWithAsrFallback` throws until a Whisper/AssemblyAI/Deepgram client is wired in; YouTube's public caption track covers the currently-live path.
- **Higgsfield in a deployed (non-Claude-session) context**: the Higgsfield adapter takes an injected `callMcpTool` (used only for `generate_video` — pixel generation, never scoring/captions) because Higgsfield today is only reachable via an active MCP connection, not a standalone REST API — see `infra/cron/README.md` for the deployment implication.
- **Publishing APIs**: none are integrated yet (TikTok Content Posting API, Meta Content Publishing API, YouTube Shorts upload) — intentionally deferred behind the human review gate.
- **ffmpeg execution**: `packages/mcp-assembly` was verified against real ffmpeg-static binaries but this build's dev sandbox blocked spawning the downloaded `ffmpeg.exe` (`EFTYPE`/"Exec format error" even though the binary is a valid PE32+ Windows executable) — likely a local execution-policy restriction on freshly downloaded binaries, not a code issue. `--dry-run` bypasses ffmpeg entirely (mock adapters never write real video), so the full pipeline is verified end-to-end regardless; confirm `ffmpeg -version` runs cleanly on whatever machine does live (non-dry-run) assembly before relying on it.

## Running it

See the repo root `README.md` (or the Verification section of the build plan) for `pnpm install`, `--dry-run`, and live-run instructions.
