import type { CandidateVideo, Platform, Transcript } from "@vvugc/shared-schema";
import { transcribeCandidate } from "@vvugc/mcp-transcript";

/**
 * Remix-from-URL ingress. The "adapt a viral video to my niche" flow starts with
 * the user pasting a link to any TikTok / YouTube / Instagram (Reels) video; this
 * module turns that raw URL into a `Transcript` the rest of the pipeline can ingest.
 *
 * It deliberately reuses the exact same transcript machinery as a normal run
 * (@vvugc/mcp-transcript): YouTube gets its public auto-caption track with no key,
 * everything else falls back to yt-dlp audio extraction + Whisper ASR. So a remix
 * URL is just "a discovery candidate the user handed us directly" — no new vendor,
 * no divergent code path past this point.
 */

export interface SourceUrl {
  platform: Platform;
  videoId: string;
}

function parseYouTube(videoId: string | undefined): string | undefined {
  return videoId?.match(/^[A-Za-z0-9_-]{11}$/)?.[0];
}

/** Extract (platform, videoId) from a raw social-share URL, or undefined if we
 *  don't recognize it. Kept strict: a URL we can't place shouldn't silently
 *  become a mystery candidate. */
export function parseSourceUrl(raw: string): SourceUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = url.pathname;

  if (host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    const viaQuery = url.searchParams.get("v") ?? undefined;
    const fromPath = path.match(/^\/(?:shorts|live)\/([^/?#]+)/)?.[1];
    const youtuBe = host === "youtu.be" ? path.split("/")[1]?.split(/[/?#]/)[0] : undefined;
    const videoId = parseYouTube(viaQuery ?? fromPath ?? youtuBe);
    if (videoId) return { platform: "youtube_shorts", videoId };
  }

  if (host === "tiktok.com") {
    const segment = path.includes("/video/") ? path.split("/video/")[1]?.split(/[/?#]/)[0] : undefined;
    if (segment) return { platform: "tiktok", videoId: segment };
  }

  if (host === "instagram.com") {
    // Instagram video ids are base64-ish; we just need a stable unique id per post.
    const segment = /^\/(reel|p)\/([^/?#]+)/.exec(path)?.[2];
    if (segment) return { platform: "instagram_reels", videoId: segment };
  }

  return undefined;
}

/** Build a discovery-shaped candidate from a source URL so the existing
 *  transcript pipeline can consume it unchanged. */
export function candidateFromSource(url: string, parsed: SourceUrl, niche: string): CandidateVideo {
  return {
    id: parsed.videoId,
    platform: parsed.platform,
    url,
    title: `Remix source (${parsed.platform})`,
    publishedAt: new Date().toISOString(),
    metrics: { views: 0, likes: 0, comments: 0 },
    niche
  };
}

/** Resolve the captions/ASR transcript for a source URL. `outDir` is where any
 *  downloaded audio for ASR fallback is written (the caller's run directory). */
export async function fetchRemixTranscript(
  raw: string,
  outDir: string,
  niche: string
): Promise<{ parsed: SourceUrl; transcript: Transcript }> {
  const parsed = parseSourceUrl(raw);
  if (!parsed) {
    throw new Error(
      "unsupported source URL — paste a TikTok, YouTube, or Instagram (Reels) link"
    );
  }
  const candidate = candidateFromSource(raw, parsed, niche);
  const transcript = await transcribeCandidate(candidate, outDir);
  return { parsed, transcript };
}
