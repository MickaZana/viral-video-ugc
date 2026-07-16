import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { CandidateVideo, Platform } from "@vvugc/shared-schema";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
const MEDIA_FIELDS = "id,caption,comments_count,like_count,media_type,permalink,timestamp";

interface HashtagSearchResponse {
  data: { id: string }[];
}

interface MediaItem {
  id: string;
  caption?: string;
  comments_count?: number;
  like_count?: number;
  media_type: string;
  permalink: string;
  timestamp: string;
}

interface MediaResponse {
  data: MediaItem[];
}

/**
 * Instagram hashtag discovery — ig_hashtag_search then {hashtag-id}/top_media,
 * verified against https://developers.facebook.com/docs/instagram-api/guides/hashtag-search
 * and https://developers.facebook.com/docs/instagram-api/reference/ig-hashtag/top-media.
 * Requires an approved Meta app with instagram_basic permission, a Meta access
 * token, AND (a second, separate requirement) the IG Business/Creator Account ID
 * making the request — see README's Platform support section for what approval
 * involves; this function is real and tested, not a placeholder, but will fail
 * without both.
 */
async function discoverInstagramHashtag(niche: string, limit: number): Promise<CandidateVideo[]> {
  const accessToken = requireEnvVar("META_ACCESS_TOKEN");
  const businessAccountId = requireEnvVar("META_IG_BUSINESS_ACCOUNT_ID");

  const hashtag = niche.trim().replace(/\s+/g, "").toLowerCase();
  const searchUrl = new URL(`${GRAPH_API_BASE}/ig_hashtag_search`);
  searchUrl.searchParams.set("user_id", businessAccountId);
  searchUrl.searchParams.set("q", hashtag);
  searchUrl.searchParams.set("access_token", accessToken);

  const searchRes = await fetchWithRetry(searchUrl, { timeoutMs: 15_000 });
  if (!searchRes.ok) {
    throw new Error(`Instagram ig_hashtag_search failed: ${searchRes.status} ${await searchRes.text()}`);
  }
  const searchBody = (await searchRes.json()) as HashtagSearchResponse;
  const hashtagId = searchBody.data?.[0]?.id;
  if (!hashtagId) return [];

  const mediaUrl = new URL(`${GRAPH_API_BASE}/${hashtagId}/top_media`);
  mediaUrl.searchParams.set("user_id", businessAccountId);
  mediaUrl.searchParams.set("fields", MEDIA_FIELDS);
  mediaUrl.searchParams.set("access_token", accessToken);

  const mediaRes = await fetchWithRetry(mediaUrl, { timeoutMs: 15_000 });
  if (!mediaRes.ok) {
    throw new Error(`Instagram top_media failed: ${mediaRes.status} ${await mediaRes.text()}`);
  }
  const mediaBody = (await mediaRes.json()) as MediaResponse;

  return (mediaBody.data ?? [])
    .filter((m) => m.media_type === "VIDEO")
    .slice(0, limit)
    .map((m) => ({
      id: m.id,
      platform: "instagram_reels" as const,
      url: m.permalink,
      title: m.caption,
      publishedAt: m.timestamp,
      niche,
      metrics: {
        views: 0, // top_media does not return a view/play count field for hashtag-discovered media
        likes: m.like_count ?? 0,
        comments: m.comments_count ?? 0
      }
    }));
}

export async function discoverMeta(
  niche: string,
  limit: number,
  platform: Extract<Platform, "instagram_reels" | "facebook">
): Promise<CandidateVideo[]> {
  if (platform === "instagram_reels") {
    return discoverInstagramHashtag(niche, limit);
  }

  // Facebook has no hashtag-search equivalent — the Page Feed API
  // (https://developers.facebook.com/docs/graph-api/reference/page/feed/) reads
  // posts from a *specific page you already operate/track*, not an open-ended
  // "trending by niche" search. That's a genuinely different input (a page ID
  // per niche) than this function's (niche, limit) signature provides, so this
  // isn't implementable as a drop-in the way Instagram's hashtag search is —
  // it needs a niche → tracked-page-ID mapping this scaffold doesn't have a
  // config shape for yet, not just an approved app and a token.
  requireEnvVar("META_ACCESS_TOKEN");
  throw new Error(
    "Facebook discovery needs a tracked Page ID, not just a niche keyword — Facebook's Graph API has no " +
      "hashtag/trending search (see packages/mcp-discovery/src/tools/meta.ts). Add a niche-to-Page-ID " +
      "mapping and call GET /{page-id}/feed directly, or use --dry-run for now."
  );
}
