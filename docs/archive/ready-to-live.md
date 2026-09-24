# What stands between this repo and a real video

**Audited 2026-08-26.** Short answer: three things, and only one of them is an API key.

Run `node scripts/preflight.mjs` at any time to re-check. It exits non-zero while
anything is blocking, so it also works as a CI/pre-deploy gate.

---

## 1. `ANTHROPIC_API_KEY` — missing, hard-required

Every live run dies immediately without it. `generateWithFailover()` in
`apps/orchestrator/src/agents/llm-failover.ts` calls
`requireEnvVar("ANTHROPIC_API_KEY")` **before** it attempts the first request:

```ts
// A missing ANTHROPIC_API_KEY is a deployment/config error, not an outage — it
// must surface loudly, never silently route the whole pipeline onto Gemini.
requireEnvVar("ANTHROPIC_API_KEY");
```

This is worth understanding rather than working around. `GEMINI_API_KEY` is a
failover for Anthropic **outages** (connection, timeout, 5xx, 429) — the code
deliberately refuses to fail over on auth/config errors, because a silent
provider swap would hide a broken deployment. So a Gemini key does not
substitute for a missing Anthropic key, by design.

Affects the script agent, QA agent and caption agent — i.e. everything upstream
of video generation.

→ https://console.anthropic.com/settings/keys

## 2. The two governance gates were off

Not keys — env flags. The pipeline is safe-by-default: `dryRun` is true on every
request path, and real execution needs a two-key lock (per-request `live: true`
**plus** an environment opt-in). With the environment half unset, a client
sending `live: true` still gets mock output.

```
VVUGC_LLM_LIVE=true         # required — without it every run is forced to dry-run
VVUGC_DISCOVERY_LIVE=true   # optional — off means zero candidates + a brief seeded from the niche text
SCHEDULED_RUNS_LIVE=        # leave off until the weekly cadence is actually deployed
```

## 3. `GEMINI_API_KEY` is defined twice in `.env`, with two different values

Only one is in use. Which one wins depends on loader precedence, so a key you
believe is live may be silently ignored — and if the losing one is the valid
key, video generation fails with an auth error that points nowhere useful.

Delete whichever line is wrong. Preflight blocks until there's exactly one.
(`PUBLIC_BASE_URL` was also duplicated, but both values were identical, so that
one is harmless.)

---

## Everything else is already in place

| | Status |
|---|---|
| `GEMINI_API_KEY` | set — cheapest live video path (`--video-vendor gemini`: a still per segment, Ken-Burns-panned into a clip) |
| `REPLICATE_API_TOKEN` | set — alternative, real text-to-video models |
| `YOUTUBE_API_KEY` | set — the only fully-wired live discovery source |
| `OPENAI_API_KEY` | set — Whisper ASR fallback for candidates with no caption track |
| ffmpeg / ffprobe | **bundled** via `ffmpeg-static` / `ffprobe-static` — no system install needed |
| Supabase / Postgres | `SUPABASE_DATABASE_URL` set; `shared-config` maps it to `DATABASE_URL` |
| Google OAuth, Stripe, Meta, dashboard auth | set |

Not blocking, worth knowing:

- **Higgsfield** can't run from a plain CLI invocation — it needs a Claude Agent
  SDK session with the Higgsfield MCP server attached. Use `--video-vendor gemini`
  or `--video-vendor replicate` for a standalone run.
- **Voiceover is off.** Neither `ELEVENLABS_API_KEY` nor `XAI_API_KEY` is set, so
  videos stay silent / vendor-native audio. That's the current default, not a fault.
- **TikTok and Instagram discovery** are implemented and tested but gated behind
  each platform's approval process — not something code can clear.

---

## The four lines to add to `.env`

```
ANTHROPIC_API_KEY=sk-ant-...
VVUGC_LLM_LIVE=true
VVUGC_DISCOVERY_LIVE=true
SCHEDULED_RUNS_LIVE=
```

Then delete one of the two `GEMINI_API_KEY` lines.

## Verify, then run

```bash
node scripts/preflight.mjs            # must exit 0
pnpm install && pnpm build

# free rehearsal — full pipeline, mock stages, no credentials touched, no spend
pnpm cli run --niche=fitness --platforms=youtube_shorts --video-vendor=gemini --dry-run

# first real video — one candidate, smallest possible spend
pnpm cli run --niche=fitness --platforms=youtube_shorts --video-vendor=gemini --max-candidates=1
```

Do the dry-run first. It exercises every stage — discovery, transcript, script,
captions, QA, video, assembly — and contacts no third-party API, so a failure
there is a code or environment problem you want to find before you're paying per
call.

Output lands in `runs/<runId>/`; review it at `pnpm --filter @vvugc/review-dashboard dev`
on http://localhost:4310.

---

## One thing worth deciding before the first live run

The gates are now on, which means the next run with a valid `ANTHROPIC_API_KEY`
spends real money on Anthropic, Gemini and YouTube quota. That's what you asked
for. But `--max-candidates=1` on the first live run is not caution for its own
sake — a full-width run multiplies every per-segment vendor call, and the failure
you're most likely to hit first is a vendor response-shape mismatch, which costs
exactly as much to discover on one candidate as on ten.
