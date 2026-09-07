import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { probeDurationSec } from "./ffprobe.js";

/**
 * Same "prefer the downloaded static binary" resolution as ffprobe.ts/audio-sync.ts.
 * Kept as a separate copy rather than importing theirs because this module needs
 * the raw binary *path* for a direct spawnSync call (to read stderr regardless of
 * exit code), not just to configure fluent-ffmpeg's global path.
 */
function resolveFfmpegPath(): string {
  if (ffmpegPath) {
    try {
      execFileSync(ffmpegPath as unknown as string, ["-version"], { stdio: "ignore" });
      return ffmpegPath as unknown as string;
    } catch {
      // fall through to PATH
    }
  }
  return "ffmpeg";
}

const resolvedFfmpegPath = resolveFfmpegPath();
ffmpeg.setFfmpegPath(resolvedFfmpegPath);

export interface SpeechBounds {
  /** Seconds from clip start to the first non-silent sample. */
  startSec: number;
  /** Seconds from clip start to the last non-silent sample. */
  endSec: number;
}

interface SilenceInterval {
  start: number;
  /** `Infinity` when silence runs to end-of-file with no matching `silence_end`. */
  end: number;
}

function parseSilenceIntervals(stderr: string): SilenceInterval[] {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) starts.push(Number(startMatch[1]));
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (endMatch) ends.push(Number(endMatch[1]));
  }
  // ffmpeg emits silence_start/silence_end in matched chronological pairs; a
  // trailing silence_start with no following silence_end means silence ran to EOF.
  return starts.map((start, i) => ({ start, end: ends[i] ?? Infinity }));
}

/**
 * Energy-threshold voice activity detection via ffmpeg's `silencedetect` filter —
 * no ML model, no new dependency: the same bundled `ffmpeg-static` binary every
 * other audio/video stage in this repo already uses. Used to trim TTS-engine
 * silence padding from a synthesized cue's raw audio *before* audio-sync.ts
 * computes its atempo conform ratio — otherwise that ratio is skewed by however
 * much silence the vendor happened to add, and the "perfect sync" guarantee
 * lib.ts describes ends up syncing captions to silence padding rather than to
 * the actual spoken words.
 *
 * Returns the [startSec, endSec) span containing real audio content, or `null`
 * when there's nothing worth trimming (no detected silence, or the whole clip
 * reads as silence) — callers should treat `null` as "use the full clip as-is",
 * the same behavior as before this existed, never as a hard failure.
 */
export async function detectSpeechBounds(
  filePath: string,
  opts: { noiseFloorDb?: number; minSilenceSec?: number } = {}
): Promise<SpeechBounds | null> {
  const noiseFloorDb = opts.noiseFloorDb ?? -30;
  const minSilenceSec = opts.minSilenceSec ?? 0.15;

  let totalDurationSec: number;
  try {
    totalDurationSec = await probeDurationSec(filePath);
  } catch {
    return null;
  }
  if (totalDurationSec <= 0) return null;

  let stderr: string;
  try {
    const result = spawnSync(
      resolvedFfmpegPath,
      ["-i", filePath, "-af", `silencedetect=noise=${noiseFloorDb}dB:d=${minSilenceSec}`, "-f", "null", "-"],
      { encoding: "utf-8" }
    );
    stderr = result.stderr ?? "";
  } catch {
    // ffmpeg missing/unusable — VAD is a refinement, not a correctness
    // requirement, so fail open to "use the full clip" rather than throw.
    return null;
  }

  const intervals = parseSilenceIntervals(stderr);
  if (intervals.length === 0) return null;

  const half = minSilenceSec / 2;
  let startSec = 0;
  const first = intervals[0];
  if (first.start <= half) {
    startSec = Math.min(first.end, totalDurationSec);
  }

  let endSec = totalDurationSec;
  const last = intervals[intervals.length - 1];
  if (last.end === Infinity || last.end >= totalDurationSec - half) {
    endSec = last.start;
  }

  if (startSec <= 0 && endSec >= totalDurationSec) return null; // nothing to trim
  if (endSec <= startSec) return null; // degenerate (e.g. entirely silent) — bail safely

  return { startSec, endSec };
}

/** Trims `inputPath`'s audio to `[startSec, endSec)` and resets timestamps so
 *  downstream tools (conformAudioDuration, concatAudioTrack) see a clip that
 *  starts at 0, not one still carrying its original offset. */
export async function trimAudio(inputPath: string, startSec: number, endSec: number, outputPath: string): Promise<void> {
  if (endSec <= startSec) {
    throw new Error(`trimAudio: endSec (${endSec}) must be greater than startSec (${startSec})`);
  }
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([`atrim=${startSec}:${endSec}`, "asetpts=PTS-STARTPTS"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outputPath);
  });
}
