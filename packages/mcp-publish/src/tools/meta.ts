import { readFileSync, statSync } from "node:fs";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { PublishAdapter, PublishRequest, PublishResult } from "../adapter.js";

const GRAPH_API_VERSION = "v25.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const GRAPH_VIDEO_API_BASE = `https://graph-video.facebook.com/${GRAPH_API_VERSION}`;

interface UploadSessionResponse {
  id: string; // "upload:<SESSION_ID>"
}
interface UploadChunkResponse {
  h: string; // file handle, passed to the final publish call
}
interface VideoPublishResponse {
  id: string;
}
interface MediaContainerResponse {
  id: string;
}
interface MediaStatusResponse {
  status_code: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";
}

/**
 * Facebook Page video publishing via the Graph API's resumable Upload API —
 * verified against the current docs: init a session (POST /<APP_ID>/uploads),
 * PUT the file bytes to the returned session (POST /upload:<SESSION_ID> with an
 * `Authorization: OAuth` header and a `file_offset` header, not the usual Bearer
 * scheme most other Graph API calls use), then publish with the returned file
 * handle. Requires a Page access token (not a user token) with pages_manage_posts.
 */
export function createFacebookPagePublishAdapter(): PublishAdapter {
  return {
    platform: "facebook",
    async publish(req: PublishRequest): Promise<PublishResult> {
      const pageAccessToken = requireEnvVar("META_PAGE_ACCESS_TOKEN");
      const userAccessToken = requireEnvVar("META_USER_ACCESS_TOKEN");
      const appId = requireEnvVar("META_APP_ID");
      const pageId = requireEnvVar("META_PAGE_ID");

      const videoSize = statSync(req.videoPath).size;

      const sessionRes = await fetchWithRetry(`${GRAPH_API_BASE}/${appId}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: req.videoPath.split(/[/\\]/).pop(),
          file_length: videoSize,
          file_type: "video/mp4",
          access_token: userAccessToken
        })
      });
      if (!sessionRes.ok) {
        throw new Error(`Facebook upload session init failed: ${sessionRes.status} ${await sessionRes.text()}`);
      }
      const { id: uploadSessionId } = (await sessionRes.json()) as UploadSessionResponse;

      const videoBytes = readFileSync(req.videoPath);
      const chunkRes = await fetchWithRetry(`${GRAPH_API_BASE}/${uploadSessionId}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${userAccessToken}`, file_offset: "0" },
        body: videoBytes,
        timeoutMs: 120_000
      });
      if (!chunkRes.ok) {
        throw new Error(`Facebook video byte upload failed: ${chunkRes.status} ${await chunkRes.text()}`);
      }
      const { h: fileHandle } = (await chunkRes.json()) as UploadChunkResponse;

      const publishRes = await fetchWithRetry(`${GRAPH_VIDEO_API_BASE}/${pageId}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: pageAccessToken,
          description: buildCaption(req),
          fbuploader_video_file_chunk: fileHandle
        })
      });
      if (!publishRes.ok) {
        throw new Error(`Facebook video publish failed: ${publishRes.status} ${await publishRes.text()}`);
      }
      const { id: postId } = (await publishRes.json()) as VideoPublishResponse;

      return { platform: "facebook", postId, url: `https://facebook.com/${postId}` };
    }
  };
}

/**
 * Instagram Reels publishing via the Content Publishing API — unlike Facebook
 * Pages, this has no byte-upload path at all: it only accepts a publicly
 * reachable `video_url` it fetches itself (POST /{ig-user-id}/media with
 * media_type=REELS), then processes that fetch asynchronously before a
 * container can be published. Callers must supply PublishRequest.publicVideoUrl
 * — see apps/review-dashboard/src/public-assets.ts for how this pipeline
 * produces one (a signed, time-limited URL back to this dashboard's own
 * runs directory; requires PUBLIC_BASE_URL to be configured).
 */
export function createInstagramReelsPublishAdapter(): PublishAdapter {
  return {
    platform: "instagram_reels",
    async publish(req: PublishRequest): Promise<PublishResult> {
      if (!req.publicVideoUrl) {
        throw new Error(
          "Instagram Reels publishing requires PublishRequest.publicVideoUrl — a publicly " +
            "reachable URL Meta can fetch the video from. See apps/review-dashboard/src/public-assets.ts."
        );
      }
      const pageAccessToken = requireEnvVar("META_PAGE_ACCESS_TOKEN");
      const igUserId = requireEnvVar("META_IG_BUSINESS_ACCOUNT_ID");

      const createRes = await fetchWithRetry(`${GRAPH_API_BASE}/${igUserId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "REELS",
          video_url: req.publicVideoUrl,
          caption: buildCaption(req),
          access_token: pageAccessToken
        })
      });
      if (!createRes.ok) {
        throw new Error(`Instagram Reels media container creation failed: ${createRes.status} ${await createRes.text()}`);
      }
      const { id: creationId } = (await createRes.json()) as MediaContainerResponse;

      const finished = await pollContainerUntilFinished(creationId, pageAccessToken);
      if (!finished) {
        throw new Error(`Instagram Reels container ${creationId} did not finish processing in time`);
      }

      const publishRes = await fetchWithRetry(`${GRAPH_API_BASE}/${igUserId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId, access_token: pageAccessToken })
      });
      if (!publishRes.ok) {
        throw new Error(`Instagram Reels publish failed: ${publishRes.status} ${await publishRes.text()}`);
      }
      const { id: mediaId } = (await publishRes.json()) as VideoPublishResponse;

      return { platform: "instagram_reels", postId: mediaId, url: `https://www.instagram.com/reel/${mediaId}/` };
    }
  };
}

/**
 * Instagram fetches and transcodes `video_url` asynchronously after the
 * container is created — media_publish rejects a container that isn't
 * FINISHED yet, so this polls status_code with backoff (same shape as
 * packages/mcp-video-gen/src/poll.ts's pollWithBackoff, kept local here
 * rather than a cross-package dependency for one small loop).
 */
async function pollContainerUntilFinished(creationId: string, accessToken: string): Promise<boolean> {
  const maxAttempts = 20;
  let delay = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const statusRes = await fetchWithRetry(
      `${GRAPH_API_BASE}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      { timeoutMs: 15_000 }
    );
    if (!statusRes.ok) {
      throw new Error(`Instagram Reels status check failed: ${statusRes.status} ${await statusRes.text()}`);
    }
    const { status_code } = (await statusRes.json()) as MediaStatusResponse;
    if (status_code === "FINISHED") return true;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`Instagram Reels container ${creationId} failed processing (status: ${status_code})`);
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 15_000);
    }
  }
  return false;
}

function buildCaption(req: PublishRequest): string {
  const hashtags = (req.hashtags ?? []).join(" ");
  return hashtags ? `${req.caption} ${hashtags}` : req.caption;
}
