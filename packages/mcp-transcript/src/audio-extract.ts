import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import ytdlp from "yt-dlp-exec";
import type { CandidateVideo } from "@vvugc/shared-schema";

/**
 * Injectable so tests can verify the exact yt-dlp invocation (URL, output path,
 * audio-extraction flags) without a real network download of a real video —
 * same pattern as VideoGenAdapter's callMcpTool or the voiceover adapters'
 * fetch mocking. The default is the real yt-dlp-exec call.
 */
export type YtDlpRunner = (url: string, opts: Record<string, unknown>) => Promise<unknown>;

const defaultRunner: YtDlpRunner = (url, opts) => ytdlp(url, opts) as unknown as Promise<unknown>;

/**
 * Downloads and extracts audio-only from a candidate's source URL via yt-dlp —
 * the missing upstream step transcribeWithWhisper (./asr.ts) needs, since that
 * function takes already-extracted bytes rather than a URL. yt-dlp (not
 * youtube-dl, which is unmaintained) supports YouTube/TikTok/Instagram/Facebook
 * out of the box, matching every platform this pipeline discovers candidates
 * from — no per-platform downloader branching needed.
 */
export async function extractAudio(
  video: CandidateVideo,
  outDir: string,
  runner: YtDlpRunner = defaultRunner
): Promise<{ filePath: string }> {
  mkdirSync(outDir, { recursive: true });
  const filePath = join(outDir, `${video.id}.mp3`);

  try {
    await runner(video.url, {
      extractAudio: true,
      audioFormat: "mp3",
      output: filePath,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      quiet: true
    });
  } catch (err) {
    throw new Error(
      `Audio extraction failed for candidate "${video.id}" (${video.url}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!existsSync(filePath)) {
    throw new Error(
      `yt-dlp reported success but produced no file at ${filePath} for candidate "${video.id}" (${video.url})`
    );
  }

  return { filePath };
}
