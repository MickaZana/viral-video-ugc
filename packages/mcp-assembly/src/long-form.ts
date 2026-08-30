import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import type { CaptionCue, LongFormTutorial } from "@vvugc/shared-schema";

const VIDEO_ASSET_TYPES = new Set(["screen_recording", "video"]);
const STATIC_ASSET_TYPES = new Set(["slide", "screenshot", "image"]);
const LONG_FORM_DIMENSIONS = { w: 1920, h: 1080 };

function configureFfmpeg(): void {
  if (!ffmpegPath) return;
  try {
    execFileSync(ffmpegPath as unknown as string, ["-version"], { stdio: "ignore" });
    ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
  } catch {
    // A system ffmpeg on PATH is fluent-ffmpeg's fallback in dev and CI.
  }
}

function run(build: (command: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    build(ffmpeg())
      .on("error", reject)
      .on("end", () => resolve())
      .save(output);
  });
}

function cuesToSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${cue.text}\n`)
    .join("\n");
}

function formatSrtTime(sec: number): string {
  const totalMs = Math.round(sec * 1000);
  const hours = String(Math.floor(totalMs / 3_600_000)).padStart(2, "0");
  const minutes = String(Math.floor((totalMs % 3_600_000) / 60_000)).padStart(2, "0");
  const seconds = String(Math.floor((totalMs % 60_000) / 1000)).padStart(2, "0");
  const milliseconds = String(totalMs % 1000).padStart(3, "0");
  return `${hours}:${minutes}:${seconds},${milliseconds}`;
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

function safeStem(title: string): string {
  const stem = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return stem || "long-form-tutorial";
}

export interface AssembleLongFormTutorialOptions {
  tutorial: LongFormTutorial;
  outDir: string;
  captions?: CaptionCue[];
  voiceoverPath?: string;
  /** Returns output metadata without probing or invoking ffmpeg. */
  dryRun?: boolean;
}

export interface LongFormAssemblyResult {
  videoId: string;
  platform: "youtube_long";
  filePath: string;
  durationSec: number;
  aspectRatio: "16:9";
  captionsBurned: boolean;
  voiceoverAdded: boolean;
}

/**
 * Renders only caller-provided files into a 16:9 tutorial. Asset paths are never
 * fetched or generated here: every scene is normalized locally, then concatenated.
 */
export async function assembleLongFormTutorial(
  options: AssembleLongFormTutorialOptions
): Promise<LongFormAssemblyResult> {
  const { tutorial, outDir, captions = [], voiceoverPath, dryRun = false } = options;
  const videoId = safeStem(tutorial.title);
  const filePath = join(outDir, `${videoId}-final.mp4`);

  if (dryRun) {
    return {
      videoId,
      platform: "youtube_long",
      filePath,
      durationSec: tutorial.durationSec,
      aspectRatio: "16:9",
      captionsBurned: captions.length > 0,
      voiceoverAdded: Boolean(voiceoverPath)
    };
  }

  configureFfmpeg();

  for (const scene of tutorial.scenes) {
    if (!existsSync(scene.assetPath)) throw new Error(`Long-form scene asset does not exist: ${scene.assetPath}`);
  }
  if (voiceoverPath && !existsSync(voiceoverPath)) {
    throw new Error(`Long-form voiceover does not exist: ${voiceoverPath}`);
  }

  mkdirSync(outDir, { recursive: true });
  const normalizedPaths: string[] = [];
  const threadLimit = process.env.VVUGC_FFMPEG_THREADS;
  const encoderOptions = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-an"];
  if (threadLimit) encoderOptions.push("-threads", threadLimit, "-x264-params", `threads=${threadLimit}`);

  for (const [index, scene] of tutorial.scenes.entries()) {
    const normalizedPath = join(outDir, `${videoId}-scene-${String(index).padStart(3, "0")}.mp4`);
    normalizedPaths.push(normalizedPath);
    const isVideo = VIDEO_ASSET_TYPES.has(scene.assetType);
    if (!isVideo && !STATIC_ASSET_TYPES.has(scene.assetType)) {
      throw new Error(`Unsupported long-form asset type: ${scene.assetType}`);
    }

    await run((command) => {
      command.input(scene.assetPath);
      command.inputOptions(isVideo ? ["-stream_loop -1"] : ["-loop 1"]);
      return command
        .videoFilters([
          `scale=${LONG_FORM_DIMENSIONS.w}:${LONG_FORM_DIMENSIONS.h}:force_original_aspect_ratio=increase`,
          `crop=${LONG_FORM_DIMENSIONS.w}:${LONG_FORM_DIMENSIONS.h}`,
          "setsar=1"
        ])
        .outputOptions(["-t", String(scene.durationSec), ...encoderOptions]);
    }, normalizedPath);
  }

  const concatListPath = join(outDir, `${videoId}-concat.txt`);
  writeFileSync(concatListPath, normalizedPaths.map((path) => `file '${escapeConcatPath(path)}'`).join("\n"));
  const srtPath = join(outDir, `${videoId}.srt`);
  if (captions.length > 0) writeFileSync(srtPath, cuesToSrt(captions));

  await run((command) => {
    command.input(concatListPath).inputOptions(["-f concat", "-safe 0"]);
    if (voiceoverPath) command.input(voiceoverPath);
    const outputOptions = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
    if (threadLimit) outputOptions.push("-threads", threadLimit, "-x264-params", `threads=${threadLimit}`);
    if (voiceoverPath) outputOptions.push("-map", "0:v:0", "-map", "1:a:0", "-shortest");
    if (captions.length > 0) {
      const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      command.videoFilters([`subtitles='${escapedSrt}'`]);
    }
    return command.outputOptions(outputOptions);
  }, filePath);

  return {
    videoId,
    platform: "youtube_long",
    filePath,
    durationSec: tutorial.durationSec,
    aspectRatio: "16:9",
    captionsBurned: captions.length > 0,
    voiceoverAdded: Boolean(voiceoverPath)
  };
}
