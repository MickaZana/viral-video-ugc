import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { CandidateVideo, Transcript } from "@vvugc/shared-schema";
import ytdlp from "yt-dlp-exec";
import { extractAudio } from "./audio-extract.js";
import { transcribeWithWhisper } from "./asr.js";

/**
 * Injectable so tests can verify the yt-dlp subtitle invocation (and skip the
 * network) without a real download — same pattern as extractAudio's runner.
 * The default is the real yt-dlp-exec call.
 */
export type YtDlpSubtitleRunner = (url: string, opts: Record<string, unknown>) => Promise<unknown>;
const defaultSubtitleRunner: YtDlpSubtitleRunner = (url, opts) => ytdlp(url, opts) as unknown as Promise<unknown>;

/**
 * Fetches a YouTube video's captions, trying the fast unofficial timedtext
 * endpoint first and falling back to yt-dlp's auto-subtitle extraction when
 * timedtext comes up empty. No API key needed. The timedtext endpoint has been
 * increasingly disabled by Google (it returns nothing for many real videos),
 * which is why the yt-dlp fallback exists — yt-dlp (already a dependency for
 * ASR audio extraction) can dump the auto-generated caption track without
 * downloading the video. Only covers YouTube; TikTok/Instagram/Facebook
 * captions require platform-specific endpoints or ASR fallback.
 */
export async function fetchYouTubeCaptions(
  videoId: string,
  subtitleRunner: YtDlpSubtitleRunner = defaultSubtitleRunner
): Promise<Transcript | undefined> {
  const timedtext = await fetchTimedtextCaptions(videoId);
  if (timedtext) return timedtext;
  return fetchYtDlpCaptions(videoId, subtitleRunner);
}

async function fetchTimedtextCaptions(videoId: string): Promise<Transcript | undefined> {
  const url = `https://video.google.com/timedtext?lang=en&v=${videoId}`;
  const res = await fetchWithRetry(url, { timeoutMs: 15_000 });
  if (!res.ok) return undefined;
  const xml = await res.text();
  if (!xml.includes("<text")) return undefined;

  const segments = [...xml.matchAll(/<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(
    (m) => ({
      startSec: Number(m[1]),
      endSec: Number(m[1]) + Number(m[2]),
      text: decodeHtmlEntities(m[3])
    })
  );
  if (segments.length === 0) return undefined;

  return {
    videoId,
    source: "platform_captions",
    text: segments.map((s) => s.text).join(" "),
    segments
  };
}

async function fetchYtDlpCaptions(
  videoId: string,
  runner: YtDlpSubtitleRunner
): Promise<Transcript | undefined> {
  const outDir = mkdtempSync(join(tmpdir(), `ytdlp-captions-${videoId}-`));
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runner(`https://www.youtube.com/watch?v=${videoId}`, {
        skipDownload: true,
        writeAutoSub: true,
        subLangs: "en",
        subFormat: "json3",
        output: join(outDir, "%(id)s.%(ext)s"),
        noCheckCertificates: true,
        noWarnings: true,
        quiet: true
      });
      break; // command ran (subs may or may not exist); stop retrying
    } catch (err) {
      // Only retry transient failures like YouTube rate-limiting (429); a
      // genuine error (e.g. video removed, region block) should surface quickly.
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /429|Too Many Requests|timeout|timed out|ECONNRESET/i.test(msg);
      if (!transient || attempt === maxAttempts) return undefined;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  const file = readdirSync(outDir).find((f) => f.endsWith(".en.json3"));
  if (!file) return undefined;

  let data: { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  try {
    data = JSON.parse(readFileSync(join(outDir, file), "utf8"));
  } catch {
    return undefined;
  }

  const segments = (data.events ?? [])
    .map((e) => {
      const text = (e.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
      if (!text) return null;
      const startSec = (e.tStartMs ?? 0) / 1000;
      const endSec = startSec + (e.dDurationMs ?? 0) / 1000;
      return { startSec, endSec, text };
    })
    .filter((s): s is { startSec: number; endSec: number; text: string } => s !== null);

  if (segments.length === 0) return undefined;

  return {
    videoId,
    source: "platform_captions",
    text: segments.map((s) => s.text).join(" "),
    segments
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Extracts audio via yt-dlp (./audio-extract.ts) then transcribes it with
 * Whisper (./asr.ts) — the two pieces that used to be a `throw` placeholder
 * and an unreachable real client, respectively, are now connected end to end.
 * `outDir` is where the extracted audio file is written (caller's run
 * directory — see conductor.ts's `runDir`), not cleaned up here since other
 * per-run artifacts (clips, voiceover) live under the same directory and are
 * cleaned up as a unit by whatever retention policy the caller has.
 */
export async function transcribeWithAsrFallback(video: CandidateVideo, outDir: string): Promise<Transcript> {
  const { filePath } = await extractAudio(video, outDir);
  const audio = readFileSync(filePath);
  return transcribeWithWhisper({ videoId: video.id, audio, filename: `${video.id}.mp3` });
}

export async function transcribeCandidate(
  video: CandidateVideo,
  outDir: string,
  subtitleRunner: YtDlpSubtitleRunner = defaultSubtitleRunner
): Promise<Transcript> {
  if (video.platform === "youtube_shorts") {
    const captions = await fetchYouTubeCaptions(video.id, subtitleRunner);
    if (captions) return captions;
  }
  return transcribeWithAsrFallback(video, outDir);
}

export function mockTranscript(video: CandidateVideo): Transcript {
  return {
    videoId: video.id,
    source: "platform_captions",
    text: `[mock transcript] This is a placeholder transcript for "${video.title ?? video.id}" used in --dry-run mode.`,
    segments: [
      { startSec: 0, endSec: 3, text: "Hook line goes here." },
      { startSec: 3, endSec: 20, text: "Main content points go here." },
      { startSec: 20, endSec: 25, text: "Call to action goes here." }
    ]
  };
}
