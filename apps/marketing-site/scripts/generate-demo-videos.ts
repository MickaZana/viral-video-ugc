#!/usr/bin/env node
/**
 * Populates the marketing site's empty video-gallery placeholders
 * (apps/marketing-site/content/video-manifest.json, status: "placeholder") with real
 * generated content: a still image per script line from Gemini (--video-vendor gemini
 * in the main pipeline; see packages/mcp-video-gen/src/adapters/gemini.ts), Ken-Burns
 * animated into clips, narrated by ElevenLabs or Grok and burned-in-caption-synced
 * (packages/mcp-voiceover), then assembled the same way the real orchestrator does
 * (packages/mcp-assembly). Gemini is required (GEMINI_API_KEY); voiceover is
 * best-effort — a TTS failure (e.g. an unfunded ElevenLabs/xAI account) logs a warning
 * and the entry still gets a real, captioned, silent video rather than being skipped.
 *
 * Each entry's hook/points/cta already exist in the manifest (hand-authored marketing
 * copy) — there's no source video to transcribe/rewrite, so this intentionally doesn't
 * run the discovery/transcript/script-rewrite stages, only video-gen + voiceover +
 * assembly. Caption timing is a simple reading-length proportional split, not
 * Claude-timed (see caption-agent.ts) — this is fixed marketing copy, not per-run
 * variable content, so a deterministic split is enough and avoids an extra Anthropic
 * call for every entry.
 *
 * Usage:
 *   pnpm --filter @vvugc/marketing-site generate-demo-videos              # all placeholders
 *   pnpm --filter @vvugc/marketing-site generate-demo-videos -- --ids=demo-fitness,demo-beauty
 *   pnpm --filter @vvugc/marketing-site generate-demo-videos -- --dry-run # no API keys needed
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getVideoGenAdapter } from "@vvugc/mcp-video-gen";
import { assembleVideo } from "@vvugc/mcp-assembly";
import { getVoiceoverAdapter, generateVoiceoverTrack } from "@vvugc/mcp-voiceover";
import type { CaptionCue, Platform, RawClip, RewrittenScript } from "@vvugc/shared-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(__dirname, "..");
const manifestPath = join(siteRoot, "content", "video-manifest.json");
const publicVideosDir = join(siteRoot, "public", "videos");
const workDir = join(siteRoot, ".demo-video-work");

interface VideoEntry {
  id: string;
  type: "product-demo" | "ugc-review";
  niche: string;
  platform: Platform;
  aspectRatio: "9:16" | "1:1" | "16:9";
  hook: string;
  points: string[];
  cta: string;
  creatorHandle?: string;
  viralityScore: number | null;
  videoPath: string | null;
  posterPath: string;
  status: "placeholder" | "ready";
}

const MIN_SEGMENT_SEC = 2;
const TOTAL_DURATION_SEC = 22;

/** Proportional-to-reading-length split across [hook, ...points, cta], each clamped to
 *  at least MIN_SEGMENT_SEC and renormalized so the cues still sum to exactly the total —
 *  same shape as caption-agent.ts's mockCaptions fallback, just weighted instead of even. */
function buildCaptionCues(lines: string[], totalSec: number): CaptionCue[] {
  const weights = lines.map((l) => Math.max(l.length, 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => Math.max((w / weightSum) * totalSec, MIN_SEGMENT_SEC));
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map((d) => (d / rawSum) * totalSec);

  const cues: CaptionCue[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const endSec = i === lines.length - 1 ? totalSec : cursor + scaled[i];
    cues.push({ startSec: cursor, endSec, text: lines[i] });
    cursor = endSec;
  }
  return cues;
}

function buildImagePrompt(entry: VideoEntry, lineText: string): string {
  return (
    `Vertical short-form ${entry.type === "ugc-review" ? "UGC creator testimonial" : "social video"} still, ` +
    `${entry.niche} niche, cinematic phone-shot lighting, candid framing. Scene: ${lineText}`
  );
}

async function generateOne(entry: VideoEntry, opts: { dryRun: boolean }): Promise<VideoEntry> {
  const script: RewrittenScript = {
    videoId: entry.id,
    hook: entry.hook,
    points: entry.points,
    cta: entry.cta,
    durationSec: TOTAL_DURATION_SEC,
    brandVoice: "neutral, energetic, concise",
    trendingPhrases: []
  };

  const lines = [entry.hook, ...entry.points, entry.cta];
  const cues = buildCaptionCues(lines, TOTAL_DURATION_SEC);

  const entryWorkDir = join(workDir, entry.id);
  mkdirSync(entryWorkDir, { recursive: true });

  const videoGenAdapter = getVideoGenAdapter("gemini", { outDir: entryWorkDir, dryRun: opts.dryRun });
  const clips: RawClip[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const clip = await videoGenAdapter.generate({
      scriptSegmentIndex: i,
      prompt: buildImagePrompt(entry, cue.text),
      durationSec: cue.endSec - cue.startSec,
      aspectRatio: entry.aspectRatio
    });
    clips.push(clip);
  }

  // Best-effort: prefer ElevenLabs, fall back to Grok, skip narration entirely if
  // neither is configured (or if the configured one fails, e.g. an unfunded account —
  // see this file's top comment). A silent-but-real, captioned video still beats no
  // video at all for a placeholder slot.
  let voiceoverPath: string | undefined;
  const voiceVendor = process.env.ELEVENLABS_API_KEY ? "elevenlabs" : process.env.XAI_API_KEY ? "grok" : undefined;
  const voiceoverAdapter = getVoiceoverAdapter(voiceVendor, { dryRun: opts.dryRun });
  if (voiceoverAdapter) {
    try {
      const track = await generateVoiceoverTrack(cues, voiceoverAdapter, join(entryWorkDir, "voiceover"), entry.id);
      voiceoverPath = track.filePath;
    } catch (err) {
      console.warn(`[${entry.id}] voiceover generation failed, continuing without narration: ${String(err)}`);
    }
  }

  const assembled = await assembleVideo({
    clips,
    script,
    captions: cues,
    platform: entry.platform,
    outDir: entryWorkDir,
    hashtags: [],
    dryRun: opts.dryRun,
    voiceoverPath
  });

  if (opts.dryRun) {
    console.log(`[${entry.id}] dry-run OK — mock clips, voiceoverAdded=${assembled.voiceoverAdded}`);
    return entry;
  }

  mkdirSync(publicVideosDir, { recursive: true });
  const finalVideoPath = join(publicVideosDir, `${entry.id}.mp4`);
  copyFileSync(assembled.filePath, finalVideoPath);

  let posterPath = entry.posterPath;
  if (assembled.thumbnailPath) {
    const finalThumbPath = join(publicVideosDir, `${entry.id}.jpg`);
    copyFileSync(assembled.thumbnailPath, finalThumbPath);
    posterPath = `/videos/${entry.id}.jpg`;
  }

  console.log(`[${entry.id}] ready — voiceoverAdded=${assembled.voiceoverAdded}`);
  return {
    ...entry,
    status: "ready",
    videoPath: `/videos/${entry.id}.mp4`,
    posterPath
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const idsArg = args.find((a) => a.startsWith("--ids="));
  const ids = idsArg ? new Set(idsArg.slice("--ids=".length).split(",")) : undefined;

  if (!dryRun && !process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required for a real (non-dry-run) run. Set it in .env or your shell.");
    process.exitCode = 1;
    return;
  }

  const manifest: VideoEntry[] = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const targets = manifest.filter((e) => e.status === "placeholder" && (!ids || ids.has(e.id)));

  if (targets.length === 0) {
    console.log("No matching placeholder entries to generate.");
    return;
  }
  console.log(`Generating ${targets.length} entr${targets.length === 1 ? "y" : "ies"}: ${targets.map((e) => e.id).join(", ")}`);

  const updated = new Map<string, VideoEntry>();
  for (const entry of targets) {
    try {
      updated.set(entry.id, await generateOne(entry, { dryRun }));
    } catch (err) {
      console.error(`[${entry.id}] failed, leaving as placeholder: ${String(err)}`);
    }
  }

  if (dryRun) return; // dry-run never touches videoPath/status, so the manifest is unchanged.

  const nextManifest = manifest.map((e) => updated.get(e.id) ?? e);
  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  console.log(`Updated ${updated.size} entr${updated.size === 1 ? "y" : "ies"} in ${manifestPath}`);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { buildCaptionCues };
