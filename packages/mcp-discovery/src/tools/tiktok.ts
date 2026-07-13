import { requireEnvVar } from "@vvugc/shared-config";
import type { CandidateVideo } from "@vvugc/shared-schema";

/**
 * TikTok Research API (https://developers.tiktok.com/doc/research-api-specs-query-videos)
 * requires an approved research-access application; Content Posting/Display
 * APIs don't expose trending-by-niche discovery. This adapter targets the
 * Research API's query/videos endpoint and expects an approved client.
 */
export async function discoverTikTok(niche: string, limit: number): Promise<CandidateVideo[]> {
  requireEnvVar("TIKTOK_CLIENT_KEY");
  requireEnvVar("TIKTOK_CLIENT_SECRET");

  throw new Error(
    "TikTok Research API access has not been wired up yet. This adapter's shape is ready " +
      "(query by niche keywords, region, and date range) but requires an approved Research API " +
      "application from TikTok before it can make live calls. Use --dry-run for now, or " +
      "swap in a licensed data provider behind this same discoverTikTok(niche, limit) signature."
  );
}
