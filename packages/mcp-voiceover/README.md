# @vvugc/mcp-voiceover

Optional narration, perfectly synced to the burned-in captions Claude already timed (`apps/orchestrator/src/agents/caption-agent.ts`). Fully additive — nothing calls into this package unless a caller explicitly asks for it (`--voice-vendor` on the CLI), and no existing behavior changes when it isn't used.

## How "perfect sync" actually works

Every caption cue already has an exact `[startSec, endSec)` window (Claude decided this when it timed the captions). Instead of generating one long narration track and hoping its pacing happens to line up:

1. **Each cue's text is synthesized separately** — one TTS call per cue, not one call for the whole script.
2. **Each raw TTS clip is force-conformed to exactly that cue's duration** (`audio-sync.ts`'s `conformAudioDuration`) — sped up (`atempo`) if the vendor spoke it slower than the cue's window allows, padded with silence if faster, with a final hard trim/pad as a floating-point safety net.
3. **The conformed per-cue clips are concatenated in cue order** into one continuous track.

Because the captions and the narration are both built from the *same* cue array with the *same* timing, they cannot drift apart — there's no separate "hope the pacing matches" step; the timing is enforced per cue, not approximated for the whole script. `packages/mcp-assembly` then mixes this track into the final video, replacing the vendor clips' own audio (see `assembleVideo`'s `voiceoverPath` option).

This is audio↔caption sync only — **not lip sync**. The video-gen vendors in this pipeline (Higgsfield/Kling/Runway/Pika) produce B-roll from a text prompt, not consistent talking-head footage of one person's face, so there's no mouth to track/warp to match new audio. If a future vendor produces avatar/talking-head footage, this package's narration is a prerequisite for lip-sync (something needs to say the words first), not a replacement for it.

## Vendors

| | ElevenLabs | Grok (xAI) |
|---|---|---|
| Env var | `ELEVENLABS_API_KEY` | `XAI_API_KEY` |
| Voice override | `ELEVENLABS_VOICE_ID` (default: a stable built-in voice, "Rachel") | `GROK_VOICE_ID` (default: `eve`) |
| Endpoint | `POST /v1/text-to-speech/{voice_id}` (`api.elevenlabs.io`) | `POST /v1/tts` (`api.x.ai`) |
| Auth | `xi-api-key` header | `Authorization: Bearer` |
| Pricing | Plan-dependent — the rate in `packages/shared-cost` is a Creator-tier estimate, confirm against your actual plan | $4.20 per 1M characters (xAI's published rate) |

Both adapters were implemented and tested against each vendor's current, real documented API shape (see `src/adapters/elevenlabs.ts` / `grok.ts`'s comments for the exact endpoints verified) — not guessed at.

## Usage

Nothing here is called directly by app code outside `apps/orchestrator/src/conductor.ts`. The two entry points:

- `getVoiceoverAdapter(vendor, { dryRun })` — returns `undefined` when `vendor` is unset (opt-in, matching every other stage's `--dry-run`/unconfigured convention in this repo), the mock adapter when `dryRun` is true (real silent audio via `silent-wav.ts`, so the timing/conform logic still gets exercised without needing credentials), or the real ElevenLabs/Grok adapter otherwise.
- `generateVoiceoverTrack(cues, adapter, outDir, videoId)` — the per-cue synthesize→conform→concat pipeline described above. Runs once per candidate (not per platform) — captions are shared across every target platform for a candidate, so the resulting track is too.

A voiceover generation failure doesn't fail the candidate — `conductor.ts` catches it and falls back to the pre-voiceover behavior (silent/vendor-native audio) for that candidate only, the same non-fatal-per-unit approach used everywhere else in the pipeline.

## Why not ffmpeg's `lavfi` for test/mock silence

`mock.ts` and test fixtures generate silence via `silent-wav.ts` — a raw WAV header written directly in Node — instead of ffmpeg's `-f lavfi -i anullsrc`. `fluent-ffmpeg` 2.1.3 can't parse ffmpeg 8.x's `-formats` output for the `lavfi` device (it gained an extra device-capability flag column fluent-ffmpeg's parser predates), so it reports the format "not available" even though the real ffmpeg binary handles it fine. Writing WAV bytes directly sidesteps the whole problem — no ffmpeg dependency for silence generation at all, and the standard PCM WAV format is read without any special demuxer capability checks by ffmpeg/ffprobe.
