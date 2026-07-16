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

/**
 * Facebook Page video publishing via the Graph API's resumable Upload API —
 * verified against the current docs: init a session (POST /<APP_ID>/uploads),
 * PUT the file bytes to the returned session (POST /upload:<SESSION_ID> with an
 * `Authorization: OAuth` header and a `file_offset` header, not the usual Bearer
 * scheme most other Graph API calls use), then publish with the returned file
 * handle. Requires a Page access token (not a user token) with pages_manage_posts.
 *
 * Instagram (Reels) publishing is deliberately NOT implemented here — its
 * Content Publishing API requires a publicly reachable `video_url` (POST
 * /{ig-user-id}/media with media_type=REELS), which this pipeline can't supply
 * since finished videos are local files with no public asset host. Facebook
 * Pages support direct byte upload instead, which is why only that path exists.
 */
export function createFacebookPagePublishAdapter(): PublishAdapter {
  return {
    platform: "facebook",
    async publish(req: PublishRequest): Promise<PublishResult> {
      const pageAccessToken = requireEnvVar("META_PAGE_ACCESS_TOKEN");
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
          access_token: pageAccessToken
        })
      });
      if (!sessionRes.ok) {
        throw new Error(`Facebook upload session init failed: ${sessionRes.status} ${await sessionRes.text()}`);
      }
      const { id: uploadSessionId } = (await sessionRes.json()) as UploadSessionResponse;

      const videoBytes = readFileSync(req.videoPath);
      const chunkRes = await fetchWithRetry(`${GRAPH_API_BASE}/${uploadSessionId}`, {
        method: "POST",
        headers: { Authorization: `OAuth ${pageAccessToken}`, file_offset: "0" },
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

function buildCaption(req: PublishRequest): string {
  const hashtags = (req.hashtags ?? []).join(" ");
  return hashtags ? `${req.caption} ${hashtags}` : req.caption;
}
