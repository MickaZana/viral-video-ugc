import { execFileSync } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Same "prefer the downloaded static binary, fall back to PATH" logic as
 * mcp-assembly/src/lib.ts and mcp-voiceover/src/ffprobe.ts — see the former's
 * comment for why. Every package that shells out to ffmpeg repeats this
 * rather than sharing it, since none of them depend on each other.
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
 *  fails on a clean CI runner without one). */
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

export interface Dimensions {
  w: number;
  h: number;
}

/** Reads the real duration of a rendered clip via ffprobe — used by tests to verify
 *  stillImageToClip actually produced a clip matching the requested duration. */
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

/**
 * Turns a single still image into a `durationSec`-long video clip with a slow
 * zoom (the "Ken Burns effect") via ffmpeg's `zoompan` filter — this is how a
 * Gemini-generated still becomes something that reads as B-roll instead of a
 * frozen frame. `zoompan` is a normal filter, not the `lavfi` *input device*
 * mcp-voiceover's README documents as broken under fluent-ffmpeg 2.1.3/ffmpeg
 * 8.x (that bug is specific to lavfi's capability-listing output, which
 * filters never go through), so it isn't affected by that workaround.
 *
 * Oversampling before `zoompan` (scaling to 2x the target, then letting
 * zoompan crop back down while zooming) avoids the visible pixelation
 * `zoompan` produces when it zooms into an image already at its final size.
 */
export async function stillImageToClip(
  imagePath: string,
  durationSec: number,
  dims: Dimensions,
  outPath: string
): Promise<void> {
  const fps = 30;
  const totalFrames = Math.max(1, Math.round(durationSec * fps));

  await new Promise<void>((resolve, reject) => {
    ffmpeg(imagePath)
      .inputOptions(["-loop 1"])
      .duration(durationSec)
      .videoFilters([
        `scale=${dims.w * 2}:${dims.h * 2}:force_original_aspect_ratio=increase`,
        `crop=${dims.w * 2}:${dims.h * 2}`,
        `zoompan=z='min(zoom+0.0015,1.3)':d=${totalFrames}:s=${dims.w}x${dims.h}:fps=${fps}`,
        "format=yuv420p"
      ])
      .fps(fps)
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}
