# Cost Table (template — fill in as real usage data comes in)

Estimate per weekly run cycle: N niches × M platforms × K candidates × (1 hook + P points + 1 CTA) clips.

| Vendor | Unit | Est. cost/unit | Est. units/run | Est. cost/run | Notes |
|---|---|---|---|---|---|
| YouTube Data API v3 | quota units | free tier: 10,000 units/day | search.list=100, videos.list=1 per call | TBD | Free tier usually sufficient at weekly cadence; watch quota if scaling candidates/niches up |
| TikTok Research API | API calls | TBD (requires approved research access, terms vary) | TBD | TBD | Not yet wired — access-gated |
| Meta Graph API | API calls | free within rate limits | TBD | TBD | Requires approved app + tracked hashtags/pages |
| Higgsfield | credits | see `show_plans_and_credits` MCP tool | 1 clip per script segment | TBD | Primary video vendor; also covers `virality_predictor` QA scoring |
| Kling AI | API calls / credits | per Kling pricing page | 1 clip per script segment | TBD | Custom REST wrapper, no MCP overhead |
| Runway / Pika | credits | per vendor pricing | fallback only | TBD | Only used if Higgsfield/Kling fail or rate-limit |
| Replicate (`--video-vendor replicate`) | credits/API calls | per-model pricing on replicate.com (varies by model — `REPLICATE_MODEL` overrides the default) | 1 clip per script segment | TBD | Model-hosting platform, not a single vendor — one token/account gives access to many interchangeable text-to-video models (Luma Ray, MiniMax/Hailuo, Kling, Wan, Veo, and others) through the same REST contract; see `packages/mcp-video-gen/src/adapters/replicate.ts` |
| Gemini (image, `--video-vendor gemini`, or standalone `generateImage()`) | images | $0.039/image (`gemini-2.5-flash-image` "Nano Banana", up to 1024x1024) | 1 image per script segment, or 1 per image-first-generation starting frame | TBD | Still-image-driven alternative to a video vendor, and the image-generation half of image-first generation (Nano Banana → animate via Wan/Seedance/Kling `startingFrame`) — see `packages/mcp-video-gen/src/adapters/gemini.ts`. `GEMINI_IMAGE_MODEL` also selects Nano Banana Pro (`gemini-3-pro-image-preview`) or Nano Banana 2 (`gemini-3.1-flash-image-preview`), both priced per resolution tier, not flat — confirm current pricing before relying on this estimate for either. **Live-checked Aug 2026: this project's own `GEMINI_API_KEY` has zero billing quota for image generation** (confirmed structural via a real API call, not a transient rate limit) — nothing here has been verified end-to-end with real image bytes yet. |
| Seedance (`--video-vendor seedance`, via fal.ai) | clips | ~$0.02–0.07/sec at 480p, ~$0.09–0.20/sec at 720p (`bytedance/seedance-2.5`) | 1 clip per script segment | TBD | Native 30s single-pass, up to 720p, audio generated jointly with video (no separate voiceover mux needed). Three endpoints (text-to-video / image-to-video / reference-to-video, up to 50 references) — see `packages/mcp-video-gen/src/adapters/seedance.ts`. `SEEDANCE_MODEL` overrides the model base (e.g. pin back to `bytedance/seedance-2.0`) |
| Wan 3.0 (`--video-vendor wan`, via Replicate `alibaba/wan-3`) | clips | $0.05 / $0.10 / $0.20 per output-second at 480p / 720p / 1080p | 1 clip per script segment | TBD | Native 30s clips, up to 1080p, up to 10 reference images, character consistency — confirmed live against Replicate's real input schema (not assumed from docs). Separate from the generic `--video-vendor replicate` path (which can also reach older Wan versions like `wan-video/wan-2.5-t2v` via `REPLICATE_MODEL`) — Wan 3.0 has its own dedicated adapter for its distinct pricing/capability story. See `packages/mcp-video-gen/src/adapters/wan.ts` |
| Claude (Anthropic API) | input/output tokens | see per-model breakdown below | ~1 script-rewrite call + QA heuristic per candidate | TBD | Cached system prompt reduces repeated cost across a run |
| ElevenLabs (voiceover) | characters | ~$0.24/1,000 chars (Creator-tier estimate — confirm your plan) | 1 TTS call per caption cue, once per candidate | TBD | Opt-in via `--voice-vendor elevenlabs`; $0 when unset |
| Grok TTS (voiceover) | characters | $4.20/1,000,000 chars (xAI's published rate) | 1 TTS call per caption cue, once per candidate | TBD | Opt-in via `--voice-vendor grok`; $0 when unset |

**How to fill this in**: after a real (non-dry-run) cycle, sum vendor dashboard usage for that run's time window and divide by `reviewItemsCreated` from the run's `manifest.json` to get cost-per-finished-video.

## Claude model pricing (per million tokens)

Rates below must match `ANTHROPIC_RATE_TABLE` in `packages/shared-cost/src/index.ts` — update both together. See `CLAUDE.md`'s "Model selection" section for the reasoning behind which agent uses which model — that's the durable policy; this table is just the pricing reference.

| Model | Input $/M | Output $/M | Used by | Notes |
|---|---|---|---|---|
| Claude Sonnet 5 (`claude-sonnet-5`) | $3.00 | $15.00 | `qa-agent.ts` (`qa_score`) | Gatekeeping judgment call — decides what reaches the human review queue |
| Claude Sonnet 4.5 (`claude-sonnet-4-5`) | $3.00 | $15.00 | *(none — historical only)* | Same $3/$15 tier as Sonnet 5; kept in the rate table only so old cost-ledger JSON on disk still prices correctly |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | $1.00 | $5.00 | `caption-agent.ts` (`caption_timing`) | Mechanical, high-volume, low-judgment — splits an already-written script into timed cards |
| Claude Fable 5 (`claude-fable-5`) | $10.00 | $50.00 | `script-agent.ts` (`script_rewrite`) | Estimate — confirm before relying on it. The hook/point/CTA creative bottleneck — highest quality leverage in the pipeline |

## Gemini & Grok failover text model pricing (per million tokens)

Rates below must match `GEMINI_RATE_TABLE` and `GROK_RATE_TABLE` in `packages/shared-cost/src/index.ts`. Used by `apps/orchestrator/src/agents/llm-failover.ts` when falling back or routing to Gemini / Grok.

| Model | Input $/M | Output $/M | Stage / Role | Notes |
|---|---|---|---|---|
| Gemini 2.5 Pro (`gemini-2.5-pro`) | $1.25 | $10.00 | `script_rewrite`, `qa_score` fallback | Secondary / fallback model for creative writing and QA |
| Gemini 2.5 Flash (`gemini-2.5-flash`) | $0.30 | $2.50 | `caption_timing` fallback | Fast, high-volume model for mechanical caption timing |
| Grok 2 (`grok-2`) | $2.00 | $10.00 | `script_rewrite`, `qa_score`, `caption_timing` fallback (default) | Verified-working chat model on the current xAI tier; `GROK_MODEL` env var overrides this default. `grok-2-latest` 400s ("Model not found") on this account and must not be used. |
| Grok 2 Mini (`grok-2-mini`) | $0.20 | $1.00 | Lightweight tasks fallback | Low-cost Grok option |
| Grok Beta (`grok-beta`) | $5.00 | $15.00 | `GROK_MODEL` override | Alternate fallback model id, priced for reference if selected via override |
| Grok 3 (`grok-3`) | $3.00 | $15.00 | `GROK_MODEL` override | Alternate fallback model id, priced for reference if selected via override |

