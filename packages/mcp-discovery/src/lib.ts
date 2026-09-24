import type { CandidateVideo, Platform } from "@vvugc/shared-schema";
import { discoverYouTube } from "./tools/youtube.js";
import { discoverTikTok } from "./tools/tiktok.js";
import { discoverMeta } from "./tools/meta.js";

export { discoverYouTube, discoverTikTok, discoverMeta };

export async function discoverPlatform(
  platform: Platform,
  niche: string,
  limit: number
): Promise<CandidateVideo[]> {
  switch (platform) {
    case "youtube_shorts":
      return discoverYouTube(niche, limit);
    case "tiktok":
      return discoverTikTok(niche, limit);
    case "instagram_reels":
      return discoverMeta(niche, limit, "instagram_reels");
    case "facebook":
      return discoverMeta(niche, limit, "facebook");
    default:
      throw new Error(`Unsupported platform for discovery: ${platform}`);
  }
}

/** Deterministic fixture data so --dry-run works with zero API keys configured. */
export function mockCandidates(platform: Platform, niche: string, limit: number): CandidateVideo[] {
  return Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
    id: `mock-${platform}-${i}`,
    platform,
    url: `https://example.com/${platform}/mock-${i}`,
    title: `Mock viral ${niche} video #${i + 1}`,
    publishedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
    niche,
    metrics: {
      views: 1_000_000 - i * 100_000,
      likes: 80_000 - i * 5_000,
      comments: 3_000 - i * 200,
      velocityScore: 5_000 - i * 500
    }
  }));
}
