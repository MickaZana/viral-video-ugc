import { readFileSync, statSync } from "node:fs";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { PublishAdapter, PublishRequest, PublishResult } from "../adapter.js";

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

interface InitResponse {
  data: { publish_id: string; upload_url: string };
  error: { code: string; message: string };
}

/**
 * TikTok Content Posting API — direct post, verified against the current API docs
 * (POST /v2/post/publish/video/init/, `video.publish` scope, Bearer user access
 * token). Uses FILE_UPLOAD (raw bytes we already have locally) rather than
 * PULL_FROM_URL, since this pipeline's finished videos are local files with no
 * public URL to hand TikTok's servers — PULL_FROM_URL would need a public asset
 * host this repo doesn't have. Single-chunk upload (chunk_size = full file size,
 * total_chunk_count = 1) — TikTok's own limit for un-chunked upload is 64MB,
 * comfortably above a ~25s vertical short's typical output size.
 */
export function createTikTokPublishAdapter(): PublishAdapter {
  return {
    platform: "tiktok",
    async publish(req: PublishRequest): Promise<PublishResult> {
      const accessToken = requireEnvVar("TIKTOK_ACCESS_TOKEN");
      const videoSize = statSync(req.videoPath).size;

      const initRes = await fetchWithRetry(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          post_info: {
            privacy_level: "SELF_ONLY", // never defaults to public — see docs/architecture.md's human-review-gate note
            title: buildCaption(req),
            disable_duet: false,
            disable_stitch: false,
            disable_comment: false,
            is_aigc: true
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: videoSize,
            chunk_size: videoSize,
            total_chunk_count: 1
          }
        })
      });
      if (!initRes.ok) {
        throw new Error(`TikTok publish init failed: ${initRes.status} ${await initRes.text()}`);
      }
      const initBody = (await initRes.json()) as InitResponse;
      if (initBody.error?.code && initBody.error.code !== "ok") {
        throw new Error(`TikTok publish init returned an error: ${initBody.error.code} — ${initBody.error.message}`);
      }
      const { publish_id, upload_url } = initBody.data;

      const videoBytes = readFileSync(req.videoPath);
      const uploadRes = await fetchWithRetry(upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`
        },
        body: videoBytes,
        timeoutMs: 120_000
      });
      if (!uploadRes.ok) {
        throw new Error(`TikTok video upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
      }

      return { platform: "tiktok", postId: publish_id };
    }
  };
}

function buildCaption(req: PublishRequest): string {
  const hashtags = (req.hashtags ?? []).join(" ");
  return hashtags ? `${req.caption} ${hashtags}` : req.caption;
}
