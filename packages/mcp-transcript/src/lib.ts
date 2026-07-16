import { readFileSync } from "node:fs";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { CandidateVideo, Transcript } from "@vvugc/shared-schema";
import { extractAudio } from "./audio-extract.js";
import { transcribeWithWhisper } from "./asr.js";

/**
 * Fetches the auto-generated caption track YouTube exposes publicly via the
 * (unofficial but widely used) timedtext endpoint. No API key needed. This
 * only covers YouTube; TikTok/Instagram/Facebook captions require either
 * platform-specific authenticated endpoints or ASR fallback (see
 * transcribeWithWhisperFallback below, not yet wired to a provider).
 */
export async function fetchYouTubeCaptions(videoId: string): Promise<Transcript | undefined> {
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

export async function transcribeCandidate(video: CandidateVideo, outDir: string): Promise<Transcript> {
  if (video.platform === "youtube_shorts") {
    const captions = await fetchYouTubeCaptions(video.id);
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
