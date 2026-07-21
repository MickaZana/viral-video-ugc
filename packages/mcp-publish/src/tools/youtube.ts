import { readFileSync, statSync } from "node:fs";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { PublishAdapter, PublishRequest, PublishResult } from "../adapter.js";

const YOUTUBE_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3/videos";

interface VideoInsertResponse {
  id: string;
}

/**
 * YouTube Data API v3's resumable upload flow for videos.insert — verified
 * against the current docs: POST the metadata (snippet/status) to the upload
 * endpoint with uploadType=resumable, read the session URL back from the
 * Location response header (not the body), then PUT the raw video bytes to
 * that URL. Requires an OAuth access token with the youtube.upload scope —
 * a full OAuth consent flow, not a static API key, which is why this needs
 * YOUTUBE_ACCESS_TOKEN already minted rather than a client id/secret pair here.
 */
export function createYouTubePublishAdapter(options: { accessToken?: string } = {}): PublishAdapter {
  return {
    platform: "youtube_shorts",
    async publish(req: PublishRequest): Promise<PublishResult> {
      const accessToken = options.accessToken ?? requireEnvVar("YOUTUBE_ACCESS_TOKEN");
      const videoSize = statSync(req.videoPath).size;

      const initRes = await fetchWithRetry(
        `${YOUTUBE_UPLOAD_BASE}?uploadType=resumable&part=snippet,status`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": String(videoSize)
          },
          body: JSON.stringify({
            snippet: {
              title: req.caption.slice(0, 100), // YouTube titles are capped at 100 chars
              description: buildDescription(req),
              tags: req.hashtags?.map((h) => h.replace(/^#/, ""))
            },
            status: { privacyStatus: "private" } // never defaults to public — see docs/architecture.md's human-review-gate note
          })
        }
      );
      if (!initRes.ok) {
        throw new Error(`YouTube resumable upload init failed: ${initRes.status} ${await initRes.text()}`);
      }
      const uploadUrl = initRes.headers.get("location");
      if (!uploadUrl) {
        throw new Error("YouTube resumable upload init response had no Location header to upload bytes to");
      }

      const videoBytes = readFileSync(req.videoPath);
      const uploadRes = await fetchWithRetry(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: videoBytes,
        timeoutMs: 120_000
      });
      if (!uploadRes.ok) {
        throw new Error(`YouTube video byte upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
      }
      const { id: videoId } = (await uploadRes.json()) as VideoInsertResponse;

      return { platform: "youtube_shorts", postId: videoId, url: `https://youtube.com/shorts/${videoId}` };
    }
  };
}

function buildDescription(req: PublishRequest): string {
  const hashtags = (req.hashtags ?? []).join(" ");
  return hashtags ? `${req.caption}\n\n${hashtags}` : req.caption;
}
