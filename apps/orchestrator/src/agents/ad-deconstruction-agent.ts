import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CostLedger } from "@vvugc/shared-cost";
import { z } from "zod";
import { generateWithFailover, type LlmImageInput } from "./llm-failover.js";

/**
 * Ad Deconstruction Agent: video in, structured shot-list out. Samples N
 * evenly-spaced frames from an existing (already-viral, or just a reference)
 * ad video via ffmpeg/ffprobe, then sends them as multimodal image content
 * blocks to Claude (or whichever provider the failover chain lands on) to
 * reconstruct the ad's scene-by-scene shot structure. This is raw analysis —
 * the Ad Storyboard Agent (ad-storyboard-agent.ts) reshapes this output into
 * what a video-generation call actually needs.
 */

const SYSTEM_PROMPT = `You are a video ad analyst. You are given a sequence of frames sampled at even
intervals across an existing ad video, in chronological order, along with the timestamp (in
seconds) each frame was sampled at. Reconstruct the ad's scene-by-scene shot structure:

- Group frames into distinct scenes/shots based on visible changes in framing, setting, subject,
  or on-screen content. A scene's time range should be your best estimate of where that shot
  actually starts and ends, not just the single sampled timestamp — frames are sparse samples,
  not every cut.
- For each scene, describe the shot/framing concretely (e.g. "close-up on hands opening the
  product box", "wide static shot of the presenter mid-room, direct address to camera").
- Transcribe any on-screen text/captions/graphics visible in that scene's frame(s), verbatim
  where legible. If none is visible, use null.
- Flag any beat where the product itself or the brand (logo, packaging, name) is visibly on
  screen, as short slugs (e.g. "product_reveal", "brand_logo", "packaging_close_up", "cta_card").
  Omit this array (empty) if nothing product/brand-specific is visible in that scene.
- Scenes must be contiguous and in chronological order, starting at 0.

Respond with ONLY a JSON array, no prose, no markdown fences:
[{"startSec": number, "endSec": number, "shotDescription": string, "onScreenText": string | null, "productOrBrandBeats": string[]}, ...]`;

export const AdDeconstructionSceneSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  shotDescription: z.string().trim().min(1),
  onScreenText: z.string().trim().min(1).nullable(),
  productOrBrandBeats: z.array(z.string().trim().min(1)).default([])
});
export type AdDeconstructionScene = z.infer<typeof AdDeconstructionSceneSchema>;

export const AdDeconstructionResultSchema = z.array(AdDeconstructionSceneSchema).min(1);
export type AdDeconstructionResult = z.infer<typeof AdDeconstructionResultSchema>;

export async function deconstructAd(
  videoPath: string,
  opts: { dryRun?: boolean; costLedger?: CostLedger; frameCount?: number } = {}
): Promise<AdDeconstructionResult> {
  if (opts.dryRun) return mockDeconstruction(videoPath);

  const frameCount = opts.frameCount ?? 6;
  const ffmpegBin = resolveBinary("ffmpeg");
  const ffprobeBin = resolveBinary("ffprobe");
  const durationSec = probeDurationSec(ffprobeBin, videoPath);
  const frames = sampleFrames(ffmpegBin, videoPath, durationSec, frameCount);

  const userPrompt = `Source ad video duration: ${durationSec.toFixed(2)}s
${frames.length} evenly-spaced frames are attached in chronological order, sampled at these
timestamps (seconds): ${frames.map((f) => f.atSec.toFixed(2)).join(", ")}.

Analyze the shot structure across these frames and reconstruct the ad's scene-by-scene breakdown.`;

  // Sonnet 5: interpreting sampled frames into a shot-list is a bounded, moderate-reasoning
  // analysis task with real downstream consequences (the storyboard agent builds directly off
  // this output) — a judgment call, not the creative bottleneck (script-agent's claude-fable-5)
  // or mechanical/high-volume work (caption-agent's claude-haiku-4-5). Keeps the balanced
  // default model, same tier as qa-agent's gatekeeping call. See CLAUDE.md's "Model selection".
  const model = "claude-sonnet-5";
  const images: LlmImageInput[] = frames.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
  const { text } = await generateWithFailover({
    system: SYSTEM_PROMPT,
    userPrompt,
    images,
    maxTokens: 2048,
    anthropicModel: model,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    grokModel: process.env.GROK_MODEL || "grok-4.3",
    stage: "ad_deconstruction",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJsonArray(text));
  return AdDeconstructionResultSchema.parse(parsed);
}

/** Offline fallback for --dry-run — no ffmpeg, no API call, deterministic output. */
function mockDeconstruction(videoPath: string): AdDeconstructionResult {
  return AdDeconstructionResultSchema.parse([
    {
      startSec: 0,
      endSec: 3,
      shotDescription: `[mock] Opening hook shot establishing the problem (source: ${videoPath}).`,
      onScreenText: null,
      productOrBrandBeats: []
    },
    {
      startSec: 3,
      endSec: 8,
      shotDescription: "[mock] Product reveal, close-up framing.",
      onScreenText: "[mock] New!",
      productOrBrandBeats: ["product_reveal"]
    },
    {
      startSec: 8,
      endSec: 12,
      shotDescription: "[mock] CTA card with brand logo.",
      onScreenText: "[mock] Shop now",
      productOrBrandBeats: ["brand_logo", "cta_card"]
    }
  ]);
}

/** ffmpeg-static/ffprobe-static are used elsewhere in this repo (packages/mcp-voiceover,
 *  packages/mcp-video-gen) but are NOT dependencies of @vvugc/orchestrator's package.json,
 *  and this change is not permitted to add one — so this resolves the system `ffmpeg`/
 *  `ffprobe` binaries off PATH instead (same "PATH" fallback branch every other ffmpeg
 *  wrapper in this repo already has, e.g. mcp-voiceover/src/vad.ts's resolveFfmpegPath).
 *  Unlike vad.ts's VAD (a refinement that fails open), frame sampling is this agent's core
 *  job, so a missing binary is a hard, clearly-explained failure, not a silent skip. */
function resolveBinary(name: "ffmpeg" | "ffprobe"): string {
  const result = spawnSync(name, ["-version"]);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${name} is required for ad-deconstruction video-frame sampling but was not found on PATH. Install ffmpeg (which bundles ffprobe) and ensure it is on PATH.`
    );
  }
  return name;
}

function probeDurationSec(ffprobeBin: string, filePath: string): number {
  const result = spawnSync(
    ffprobeBin,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    { encoding: "utf-8" }
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe failed to read duration for ${filePath}: ${result.stderr}`);
  }
  const durationSec = Number((result.stdout ?? "").trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe returned an invalid duration for ${filePath}: "${result.stdout}"`);
  }
  return durationSec;
}

function extractFrameJpeg(ffmpegBin: string, filePath: string, atSec: number, outPath: string): void {
  const result = spawnSync(
    ffmpegBin,
    ["-y", "-ss", String(atSec), "-i", filePath, "-frames:v", "1", "-q:v", "2", outPath],
    { encoding: "utf-8" }
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed to extract a frame at ${atSec}s from ${filePath}: ${result.stderr}`);
  }
}

/** Samples `frameCount` frames at the midpoint of `frameCount` evenly-sized windows across
 *  the video's duration (rather than exact multiples of duration/frameCount) — avoids
 *  landing exactly on frame 0 (often a black/fade-in frame) or exactly on the final
 *  timestamp (past-the-end for some containers). Frames are written to a temp dir, read
 *  back as base64, and the temp dir is always cleaned up before returning. */
function sampleFrames(
  ffmpegBin: string,
  videoPath: string,
  durationSec: number,
  frameCount: number
): Array<{ mediaType: "image/jpeg"; base64: string; atSec: number }> {
  const dir = mkdtempSync(join(tmpdir(), "vvugc-ad-deconstruction-"));
  try {
    const frames: Array<{ mediaType: "image/jpeg"; base64: string; atSec: number }> = [];
    for (let i = 0; i < frameCount; i++) {
      const atSec = Math.min(Math.max(0, durationSec - 0.05), ((i + 0.5) * durationSec) / frameCount);
      const outPath = join(dir, `frame-${i}.jpg`);
      extractFrameJpeg(ffmpegBin, videoPath, atSec, outPath);
      const base64 = readFileSync(outPath).toString("base64");
      frames.push({ mediaType: "image/jpeg", base64, atSec });
    }
    return frames;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`No JSON array found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}
