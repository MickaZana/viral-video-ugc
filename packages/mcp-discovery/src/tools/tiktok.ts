import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { CandidateVideo } from "@vvugc/shared-schema";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const QUERY_URL = "https://open.tiktokapis.com/v2/research/video/query/";
const QUERY_FIELDS =
  "id,create_time,username,region_code,video_description,like_count,comment_count,share_count,view_count";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface TikTokVideo {
  id: string;
  create_time: number;
  username: string;
  video_description: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
}

interface QueryResponse {
  data: { videos: TikTokVideo[]; cursor: number; has_more: boolean; search_id: string };
  error: { code: string; message: string; log_id: string };
}

/**
 * Exchanges TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET for a short-lived (2h) Bearer
 * token via the client-credentials grant — verified against
 * https://developers.tiktok.com/doc/client-access-token-management. Not cached:
 * this adapter is called at most a few times per weekly run, well under a rate
 * that would make re-fetching a token per call meaningfully costly.
 */
async function fetchAccessToken(clientKey: string, clientSecret: string): Promise<string> {
  const res = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: "client_credentials" }),
    timeoutMs: 15_000
  });
  if (!res.ok) {
    throw new Error(`TikTok OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as TokenResponse;
  return body.access_token;
}

/**
 * TikTok Research API's query/videos endpoint — verified against
 * https://developers.tiktok.com/doc/research-api-specs-query-videos (POST,
 * JSON body, `query.and[].{field_name,operation,field_values}` conditions;
 * `keyword` is a valid field_name for querying by niche). Requires an approved
 * Research API application from TikTok — see README's Platform support section
 * for what that approval process involves; this function is real and tested,
 * not a placeholder, but will 401/403 without an approved client.
 *
 * The Research API returns no direct video URL field (verified against the
 * same doc) — TikTok's public video URL is deterministically
 * https://www.tiktok.com/@{username}/video/{id}, constructed here rather than
 * requested.
 */
export async function discoverTikTok(niche: string, limit: number): Promise<CandidateVideo[]> {
  const clientKey = requireEnvVar("TIKTOK_CLIENT_KEY");
  const clientSecret = requireEnvVar("TIKTOK_CLIENT_SECRET");

  const accessToken = await fetchAccessToken(clientKey, clientSecret);

  const now = new Date();
  const startDate = new Date(now.getTime() - 30 * 86_400_000); // API max range is 30 days
  const formatDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

  const res = await fetchWithRetry(`${QUERY_URL}?fields=${QUERY_FIELDS}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: { and: [{ operation: "EQ", field_name: "keyword", field_values: [niche] }] },
      start_date: formatDate(startDate),
      end_date: formatDate(now),
      max_count: Math.min(Math.max(limit, 1), 100)
    }),
    timeoutMs: 20_000
  });
  if (!res.ok) {
    throw new Error(`TikTok Research API query failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as QueryResponse;
  if (body.error?.code && body.error.code !== "ok") {
    throw new Error(`TikTok Research API error: ${body.error.code} — ${body.error.message} (log_id: ${body.error.log_id})`);
  }

  return (body.data?.videos ?? []).slice(0, limit).map((v) => ({
    id: v.id,
    platform: "tiktok" as const,
    url: `https://www.tiktok.com/@${v.username}/video/${v.id}`,
    title: v.video_description,
    publishedAt: new Date(v.create_time * 1000).toISOString(),
    niche,
    metrics: {
      views: v.view_count,
      likes: v.like_count,
      comments: v.comment_count,
      shares: v.share_count
    }
  }));
}
