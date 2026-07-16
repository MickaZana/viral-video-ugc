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
| Gemini (image, `--video-vendor gemini`) | images | $0.039/image (`gemini-2.5-flash-image`, up to 1024x1024) | 1 image per script segment | TBD | Still-image-driven alternative to a video vendor — see `packages/mcp-video-gen/src/adapters/gemini.ts`. Higher-resolution Gemini image models are priced per resolution tier, not flat; overriding `GEMINI_IMAGE_MODEL` will make this estimate drift |
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
