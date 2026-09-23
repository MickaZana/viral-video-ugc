import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import type { AssembledVideo, CaptionCue, Platform, RawClip, RewrittenScript } from "@vvugc/shared-schema";

// Kept separate from assembleVideo: long-form tutorials have their own scene
// contract and never pass through the Shorts assembly path.
export {
  assembleLongFormTutorial,
  type AssembleLongFormTutorialOptions,
  type LongFormAssemblyResult
} from "./long-form.js";

/**
 * ffmpeg-static's downloaded binary isn't always runnable — in this project's dev
 * sandbox it fails with "Exec format error" despite being a valid PE32+ binary,
 * apparently an environment execution-policy restriction rather than a corrupt
 * download. Rather than hard-depend on that binary, prefer it when it actually
 * runs and fall back to whatever `ffmpeg` fluent-ffmpeg finds on PATH otherwise
 * (fluent-ffmpeg's default behavior when setFfmpegPath is never called). This is
 * what let the assembly pipeline actually be verified end-to-end in that sandbox,
 * against a real system ffmpeg install, instead of staying permanently unverified.
 */
function resolveFfmpegPath(): string | undefined {
  if (!ffmpegPath) return undefined;
  try {
    execFileSync(ffmpegPath as unknown as string, ["-version"], { stdio: "ignore" });
    return ffmpegPath as unknown as string;
  } catch {
    return undefined;
  }
}

/** ffmpeg-static doesn't bundle ffprobe — see mcp-voiceover/src/ffprobe.ts's comment
 *  for why this is needed (silently worked in local dev via a system ffprobe on PATH,
 *  fails on a clean CI runner without one — this is what screenshots()/ffprobe() below need). */
function resolveFfprobePath(): string | undefined {
  if (!ffprobeStatic?.path) return undefined;
  try {
    execFileSync(ffprobeStatic.path, ["-version"], { stdio: "ignore" });
    return ffprobeStatic.path;
  } catch {
    return undefined;
  }
}

const resolvedFfmpegPath = resolveFfmpegPath();
if (resolvedFfmpegPath) ffmpeg.setFfmpegPath(resolvedFfmpegPath);
const resolvedFfprobePath = resolveFfprobePath();
if (resolvedFfprobePath) ffmpeg.setFfprobePath(resolvedFfprobePath);

export const ASPECT_RATIO_BY_PLATFORM: Record<Platform, AssembledVideo["aspectRatio"]> = {
  tiktok: "9:16",
  youtube_shorts: "9:16",
  youtube_long: "16:9",
  instagram_reels: "9:16",
  facebook: "1:1"
};

export const DIMENSIONS: Record<AssembledVideo["aspectRatio"], { w: number; h: number }> = {
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
export function cuesToSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${cue.text}\n`)
    .join("\n");
}

export function formatSrtTime(sec: number): string {
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
  /**
   * Path to a narration track already time-conformed to these exact `captions`
   * cues (see packages/mcp-voiceover's generateVoiceoverTrack) — entirely
   * optional and additive. When given, it replaces the vendor clips' own audio
   * track in the final output (video from the clips, audio from this file);
   * when omitted, behavior is byte-for-byte what it was before this option
   * existed — clips' native audio (if any) passes through untouched.
   */
  voiceoverPath?: string;
  /** Optional background music. It is duration-conformed and mixed beneath narration. */
  musicPath?: string;
  /** Background music gain before mixing, from 0 through 1. Defaults to a quiet bed. */
  musicVolume?: number;
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
      hashtags: opts.hashtags ?? deriveHashtags(script),
      voiceoverAdded: Boolean(opts.voiceoverPath)
    };
  }

  const sorted = [...clips].sort((a, b) => a.scriptSegmentIndex - b.scriptSegmentIndex);

  const concatListPath = join(outDir, `${script.videoId}-concat.txt`);
  writeFileSync(concatListPath, sorted.map((c) => `file '${c.filePath.replace(/'/g, "'\\''")}'`).join("\n"));

  const srtPath = join(outDir, `${script.videoId}.srt`);
  writeFileSync(srtPath, cuesToSrt(captions));

  const { w, h } = DIMENSIONS[ASPECT_RATIO_BY_PLATFORM[platform]];
  const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // Concat, scale/crop, and subtitle burn-in all happen in one ffmpeg pass — the concat
  // demuxer accepts filters directly, so there's no need for separate intermediate files
  // (each extra pass would mean an extra full decode/encode cycle and quality loss for
  // no benefit, since only the final output is ever kept).
  //
  // x264 defaults to one thread per detected CPU, which allocates a large working buffer
  // per thread — verified live in a memory-constrained sandbox that this can exceed the
  // available address space and crash the encoder (`x264 [error]: malloc ... failed`) even
  // though the ffmpeg invocation itself (concat list, path handling, subtitle filter) is
  // correct. VVUGC_FFMPEG_THREADS lets a constrained host (small container, CI runner) cap
  // it; left unset, ffmpeg keeps its normal auto-detected thread count.
  const threadLimit = process.env.VVUGC_FFMPEG_THREADS;
  const finalPath = join(outDir, `${script.videoId}-final.mp4`);
  const hasVoiceover = Boolean(opts.voiceoverPath);
  const hasMusic = Boolean(opts.musicPath);
  const musicVolume = opts.musicVolume ?? 0.16;
  if (!Number.isFinite(musicVolume) || musicVolume < 0 || musicVolume > 1) {
    throw new Error(`assembleVideo musicVolume must be between 0 and 1, got ${musicVolume}`);
  }
  await run(
    (cmd) => {
      cmd.input(concatListPath).inputOptions(["-f concat", "-safe 0"]);
      if (opts.voiceoverPath) cmd.input(opts.voiceoverPath);
      if (opts.musicPath) {
        cmd.input(opts.musicPath).inputOptions(["-stream_loop", "-1"]);
        const duration = script.durationSec;
        const fadeOutStart = Math.max(0, duration - Math.min(1.2, duration / 4));
        const musicFilter = `[${hasVoiceover ? 2 : 1}:a]volume=${musicVolume},afade=t=in:st=0:d=0.35,afade=t=out:st=${fadeOutStart}:d=${duration - fadeOutStart},atrim=0:${duration},asetpts=PTS-STARTPTS[music]`;
        if (hasVoiceover) {
          cmd.complexFilter([
            musicFilter,
            `[1:a]aresample=48000,asetpts=PTS-STARTPTS[voice]`,
            `[voice][music]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[mixed]`
          ]);
        } else {
          cmd.complexFilter([musicFilter]);
        }
      }

      cmd.videoFilters([
        `scale=${w}:${h}:force_original_aspect_ratio=increase`,
        `crop=${w}:${h}`,
        `subtitles='${escapedSrt}'`
      ]);

      const outputOptions = threadLimit ? ["-threads", threadLimit, "-x264-params", `threads=${threadLimit}`] : [];
      if (hasMusic || hasVoiceover) {
        // Voiceover alone replaces clip audio; music is either the only audio
        // stream or mixed beneath voiceover by the complex filter above.
        outputOptions.push("-map", "0:v:0", "-map", hasMusic ? (hasVoiceover ? "[mixed]" : "[music]") : "1:a:0", "-shortest");
      }
      return cmd.outputOptions(outputOptions);
    },
    finalPath
  );

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
    thumbnailPath,
    voiceoverAdded: hasVoiceover
  };
}

export function deriveHashtags(script: RewrittenScript): string[] {
  return [...new Set(script.trendingPhrases.map((p) => `#${p.replace(/\s+/g, "").toLowerCase()}`))].slice(
    0,
    8
  );
}
