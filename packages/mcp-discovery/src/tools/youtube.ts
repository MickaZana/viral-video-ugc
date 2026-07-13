import { requireEnvVar } from "@vvugc/shared-config";
import type { CandidateVideo } from "@vvugc/shared-schema";

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: { title: string; publishedAt: string };
}
interface YouTubeSearchResponse {
  items: YouTubeSearchItem[];
}
interface YouTubeVideoStats {
  id: string;
  statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
}
interface YouTubeVideosResponse {
  items: YouTubeVideoStats[];
}

/**
 * Two-call pattern required by YouTube Data API v3: search.list finds
 * candidates (no engagement counts), videos.list fills in statistics.
 */
export async function discoverYouTube(niche: string, limit: number): Promise<CandidateVideo[]> {
  const apiKey = requireEnvVar("YOUTUBE_API_KEY");

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("q", niche);
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("videoDuration", "short");
  searchUrl.searchParams.set("order", "viewCount");
  searchUrl.searchParams.set("maxResults", String(Math.min(limit, 50)));
  searchUrl.searchParams.set("key", apiKey);

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) {
    throw new Error(`YouTube search.list failed: ${searchRes.status} ${await searchRes.text()}`);
  }
  const search = (await searchRes.json()) as YouTubeSearchResponse;
  const ids = search.items.map((i) => i.id.videoId).filter(Boolean);
  if (ids.length === 0) return [];

  const statsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  statsUrl.searchParams.set("part", "statistics");
  statsUrl.searchParams.set("id", ids.join(","));
  statsUrl.searchParams.set("key", apiKey);

  const statsRes = await fetch(statsUrl);
  if (!statsRes.ok) {
    throw new Error(`YouTube videos.list failed: ${statsRes.status} ${await statsRes.text()}`);
  }
  const stats = (await statsRes.json()) as YouTubeVideosResponse;
  const statsById = new Map(stats.items.map((v) => [v.id, v.statistics]));

  return search.items.map((item) => {
    const videoId = item.id.videoId;
    const s = statsById.get(videoId);
    return {
      id: videoId,
      platform: "youtube_shorts" as const,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: item.snippet.title,
      publishedAt: item.snippet.publishedAt,
      niche,
      metrics: {
        views: Number(s?.viewCount ?? 0),
        likes: Number(s?.likeCount ?? 0),
        comments: Number(s?.commentCount ?? 0)
      }
    };
  });
}
