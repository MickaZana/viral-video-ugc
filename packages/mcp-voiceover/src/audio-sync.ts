import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { probeDurationSec } from "./ffprobe.js";

function resolveFfmpegPath(): string | undefined {
  if (!ffmpegPath) return undefined;
  try {
    execFileSync(ffmpegPath as unknown as string, ["-version"], { stdio: "ignore" });
    return ffmpegPath as unknown as string;
  } catch {
    return undefined;
  }
}

const resolvedFfmpegPath = resolveFfmpegPath();
if (resolvedFfmpegPath) ffmpeg.setFfmpegPath(resolvedFfmpegPath);

/**
 * ffmpeg's `atempo` filter only accepts a ratio in [0.5, 2.0] per instance —
 * outside that range you chain multiple instances. A single caption cue's TTS
 * audio should never need more than mild correction (captions are already
 * timed by reading-length estimate, see caption-agent.ts's system prompt), so
 * this exists as a safety net for the rare cue that comes back badly off, not
 * the normal case.
 */
export function buildAtempoChain(ratio: number): string[] {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error(`buildAtempoChain: ratio must be a positive finite number, got ${ratio}`);
  }
  const filters: string[] = [];
  let remaining = ratio;
  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters;
}

/**
 * Forces `inputPath`'s audio to exactly `targetDurationSec` and writes the
 * result to `outputPath` — this is what guarantees perfect sync with the
 * caption cue it belongs to: speed up (atempo) if the raw TTS came back
 * longer than the cue's time window, pad with silence if shorter, then a
 * final hard trim/pad (`apad` + `atrim`) as a floating-point safety net so the
 * output is exactly on target regardless of how well the speed correction
 * landed.
 */
export async function conformAudioDuration(
  inputPath: string,
  targetDurationSec: number,
  outputPath: string
): Promise<void> {
  if (targetDurationSec <= 0) {
    throw new Error(`conformAudioDuration: targetDurationSec must be positive, got ${targetDurationSec}`);
  }
  const actualDurationSec = await probeDurationSec(inputPath);
  if (actualDurationSec <= 0) {
    throw new Error(`conformAudioDuration: ${inputPath} has no measurable duration (ffprobe reported ${actualDurationSec}s)`);
  }

  const ratio = actualDurationSec / targetDurationSec;
  const atempoFilters = buildAtempoChain(ratio);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters([...atempoFilters, `apad=whole_dur=${targetDurationSec}`, `atrim=0:${targetDurationSec}`])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outputPath);
  });
}

/** Concatenates already-conformed per-cue clips, in order, into one continuous
 *  track — same concat-list-file technique as mcp-assembly's video concat, for
 *  the same reason: a lossless stream copy would be nice but these clips may
 *  come from different TTS calls with slightly different encoder parameters,
 *  so this re-encodes (no `-c copy`) to guarantee a single consistent stream. */
export async function concatAudioTrack(clipPaths: string[], outputPath: string): Promise<void> {
  if (clipPaths.length === 0) {
    throw new Error("concatAudioTrack: at least one clip is required");
  }
  const concatListPath = `${outputPath}.concat.txt`;
  writeFileSync(concatListPath, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(["-f concat", "-safe 0"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outputPath);
  });
}
