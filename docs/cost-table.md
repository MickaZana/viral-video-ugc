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
| Claude (Anthropic API) | input/output tokens | see `claude-api` pricing reference | ~1 script-rewrite call + QA heuristic per candidate | TBD | Cached system prompt reduces repeated cost across a run |

**How to fill this in**: after a real (non-dry-run) cycle, sum vendor dashboard usage for that run's time window and divide by `reviewItemsCreated` from the run's `manifest.json` to get cost-per-finished-video.
