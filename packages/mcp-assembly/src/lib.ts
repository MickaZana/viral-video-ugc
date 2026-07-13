import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import type { AssembledVideo, CaptionCue, Platform, RawClip, RewrittenScript } from "@vvugc/shared-schema";

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);

export const ASPECT_RATIO_BY_PLATFORM: Record<Platform, AssembledVideo["aspectRatio"]> = {
  tiktok: "9:16",
  youtube_shorts: "9:16",
  instagram_reels: "9:16",
  facebook: "1:1"
};

const DIMENSIONS: Record<AssembledVideo["aspectRatio"], { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 }
};

function run(build: (cmd: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = build(ffmpeg());
    cmd
      .on("error", reject)
      .on("end", () => resolve())
      .save(output);
  });
}

/**
 * Caption timing/text comes from Claude (apps/orchestrator/src/agents/caption-agent.ts), not a
 * naive even-split of the script — this just serializes the cues Claude already decided on.
 */
function cuesToSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${cue.text}\n`)
    .join("\n");
}

function formatSrtTime(sec: number): string {
  const totalMs = Math.round(sec * 1000);
  const h = String(Math.floor(totalMs / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((totalMs % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((totalMs % 60_000) / 1000)).padStart(2, "0");
  const ms = String(totalMs % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

export interface AssembleOptions {
  clips: RawClip[];
  script: RewrittenScript;
  captions: CaptionCue[];
  platform: Platform;
  outDir: string;
  hashtags?: string[];
  /** Skips real ffmpeg processing — mock clips from --dry-run aren't real video files. */
  dryRun?: boolean;
}

/**
 * Concats clips (assumes vendor adapters already produced compatible mp4s),
 * scales/pads to the platform's target aspect ratio, and burns in the
 * caption cues Claude already timed (see caption-agent.ts) — this stage
 * only serializes and burns them, it doesn't decide timing/text itself.
 */
export async function assembleVideo(opts: AssembleOptions): Promise<AssembledVideo> {
  const { clips, script, captions, platform, outDir } = opts;
  if (captions.length === 0) throw new Error("assembleVideo requires at least one caption cue");
  if (clips.length === 0) throw new Error("assembleVideo requires at least one clip");

  mkdirSync(outDir, { recursive: true });

  if (opts.dryRun) {
    const filePath = join(outDir, `${script.videoId}-mock-final.mp4`);
    writeFileSync(filePath, `MOCK ASSEMBLED VIDEO for ${script.videoId} (${clips.length} clips)\n`);
    return {
      videoId: script.videoId,
      platform,
      filePath,
      durationSec: script.durationSec,
      aspectRatio: ASPECT_RATIO_BY_PLATFORM[platform],
      captionsBurned: true,
      hashtags: opts.hashtags ?? deriveHashtags(script)
    };
  }

  const sorted = [...clips].sort((a, b) => a.scriptSegmentIndex - b.scriptSegmentIndex);

  const concatListPath = join(outDir, `${script.videoId}-concat.txt`);
  writeFileSync(concatListPath, sorted.map((c) => `file '${c.filePath.replace(/'/g, "'\\''")}'`).join("\n"));

  const rawPath = join(outDir, `${script.videoId}-raw.mp4`);
  await run(
    (cmd) => cmd.input(concatListPath).inputOptions(["-f concat", "-safe 0"]).outputOptions(["-c copy"]),
    rawPath
  );

  const { w, h } = DIMENSIONS[ASPECT_RATIO_BY_PLATFORM[platform]];
  const scaledPath = join(outDir, `${script.videoId}-scaled.mp4`);
  await run(
    (cmd) =>
      cmd
        .input(rawPath)
        .videoFilters([
          `scale=${w}:${h}:force_original_aspect_ratio=increase`,
          `crop=${w}:${h}`
        ]),
    scaledPath
  );

  const srtPath = join(outDir, `${script.videoId}.srt`);
  writeFileSync(srtPath, cuesToSrt(captions));

  const finalPath = join(outDir, `${script.videoId}-final.mp4`);
  const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  await run((cmd) => cmd.input(scaledPath).videoFilters([`subtitles='${escapedSrt}'`]), finalPath);

  const thumbnailPath = join(outDir, `${script.videoId}-thumb.jpg`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(finalPath)
      .on("error", reject)
      .on("end", () => resolve())
      .screenshots({ timestamps: [1], filename: `${script.videoId}-thumb.jpg`, folder: outDir });
  });

  return {
    videoId: script.videoId,
    platform,
    filePath: finalPath,
    durationSec: script.durationSec,
    aspectRatio: ASPECT_RATIO_BY_PLATFORM[platform],
    captionsBurned: true,
    hashtags: opts.hashtags ?? deriveHashtags(script),
    thumbnailPath
  };
}

function deriveHashtags(script: RewrittenScript): string[] {
  return [...new Set(script.trendingPhrases.map((p) => `#${p.replace(/\s+/g, "").toLowerCase()}`))].slice(
    0,
    8
  );
}
