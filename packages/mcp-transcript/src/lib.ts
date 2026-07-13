import type { CandidateVideo, Transcript } from "@vvugc/shared-schema";

/**
 * Fetches the auto-generated caption track YouTube exposes publicly via the
 * (unofficial but widely used) timedtext endpoint. No API key needed. This
 * only covers YouTube; TikTok/Instagram/Facebook captions require either
 * platform-specific authenticated endpoints or ASR fallback (see
 * transcribeWithWhisperFallback below, not yet wired to a provider).
 */
export async function fetchYouTubeCaptions(videoId: string): Promise<Transcript | undefined> {
  const url = `https://video.google.com/timedtext?lang=en&v=${videoId}`;
  const res = await fetch(url);
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
 * Not yet wired to a real ASR provider (Whisper API, AssemblyAI, Deepgram).
 * Plug one in here behind this same signature when platform captions are
 * unavailable for a candidate.
 */
export async function transcribeWithAsrFallback(_video: CandidateVideo): Promise<Transcript> {
  throw new Error(
    "No ASR fallback provider configured. Wire transcribeWithAsrFallback() to Whisper/AssemblyAI/Deepgram, " +
      "or use --dry-run for mock transcripts."
  );
}

export async function transcribeCandidate(video: CandidateVideo): Promise<Transcript> {
  if (video.platform === "youtube_shorts") {
    const captions = await fetchYouTubeCaptions(video.id);
    if (captions) return captions;
  }
  return transcribeWithAsrFallback(video);
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
