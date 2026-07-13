import { requireEnvVar } from "@vvugc/shared-config";
import type { CandidateVideo, Platform } from "@vvugc/shared-schema";

/**
 * Meta Graph API has no public "trending by niche" endpoint — discovery here
 * means polling engagement on pages/hashtags you already track (via
 * ig_hashtag_search + insights, or Page/Post endpoints for Facebook) rather
 * than open-ended trend scanning. This adapter is scoped to that shape.
 */
export async function discoverMeta(
  niche: string,
  limit: number,
  platform: Extract<Platform, "instagram_reels" | "facebook">
): Promise<CandidateVideo[]> {
  requireEnvVar("META_ACCESS_TOKEN");

  throw new Error(
    `Meta Graph API discovery for ${platform} has not been wired up yet. This adapter targets ` +
      "ig_hashtag_search + hashtag insights (Instagram) or Page Post insights (Facebook), which " +
      "requires an approved Meta app with the relevant permissions and a list of tracked " +
      "pages/hashtags for the niche. Use --dry-run for now."
  );
}
