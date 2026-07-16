import { execFileSync } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

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

const resolvedFfmpegPath = resolveFfmpegPath();
if (resolvedFfmpegPath) ffmpeg.setFfmpegPath(resolvedFfmpegPath);

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
