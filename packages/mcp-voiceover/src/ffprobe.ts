import { execFileSync } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Same "prefer the downloaded static binary, fall back to PATH" logic as
 * mcp-assembly/src/lib.ts — see that file's comment for why. Applied here too
 * since fluent-ffmpeg's ffprobe() call needs a working ffmpeg install exactly
 * the same way its video encoding calls do.
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

/**
 * `ffmpeg-static` only bundles the `ffmpeg` binary, not `ffprobe` — fluent-ffmpeg's
 * `ffprobe()` calls fall back to searching PATH for `ffprobe` unless told otherwise,
 * which silently worked in local dev (a system ffprobe happened to be on PATH) but
 * fails outright ("Cannot find ffprobe") on a clean CI runner with neither ffmpeg nor
 * ffprobe preinstalled. `ffprobe-static` is the sibling package providing a prebuilt
 * ffprobe binary for exactly this case.
 */
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

/** Reads the real duration of an audio/video file via ffprobe — TTS vendor APIs
 *  don't reliably report exact duration in their response, so this is the source
 *  of truth for "how long is the clip I just got back". */
export function probeDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const duration = data.format.duration;
      if (duration === undefined) return reject(new Error(`ffprobe returned no duration for ${filePath}`));
      resolve(duration);
    });
  });
}
