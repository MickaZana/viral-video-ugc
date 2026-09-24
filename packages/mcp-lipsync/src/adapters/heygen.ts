/**
 * HeyGen LipSync Adapter
 *
 * API: POST https://api.heygen.com/v2/video/generate → submit
 *      GET  https://api.heygen.com/v1/video_status.get?video_id={id} → poll
 *
 * Input: audio file + avatar image → output: talking-head video.
 * Requires HEYGEN_API_KEY environment variable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { LipSyncAdapter, LipSyncInput, LipSyncResult } from "./LipSyncAdapter.js";

const API_BASE = "https://api.heygen.com";

export function createHeyGenAdapter(): LipSyncAdapter {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    throw new Error("HEYGEN_API_KEY is required for the HeyGen lipsync adapter");
  }

  return {
    vendor: "heygen",
    async generate(input: LipSyncInput): Promise<LipSyncResult> {
      mkdirSync(input.outDir, { recursive: true });

      // Step 1: Submit the video generation job
      const submitRes = await fetchWithRetry(`${API_BASE}/v2/video/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify({
          video_inputs: [{
            character: {
              type: "photo",
              photo_url: input.characterImageUrl,
            },
            voice: {
              type: "audio",
              audio_url: input.audioPath, // pre-signed URL to the voiceover audio
            },
          }],
          dimension: { width: 1080, height: 1920 }, // 9:16 portrait
        }),
      });

      if (!submitRes.ok) {
        const err = await submitRes.text();
        throw new Error(`HeyGen submit failed (${submitRes.status}): ${err}`);
      }

      const submitData = (await submitRes.json()) as { data?: { video_id: string }; error?: string };
      const videoId = submitData.data?.video_id;
      if (!videoId) {
        throw new Error(`HeyGen submit returned no video_id: ${JSON.stringify(submitData)}`);
      }

      // Step 2: Poll for completion
      const result = await pollHeyGenJob(videoId, apiKey);

      // Step 3: Download the result video
      const filename = `lipsync-heygen-${randomUUID().slice(0, 8)}.mp4`;
      const videoPath = join(input.outDir, filename);

      const videoRes = await fetchWithRetry(result.videoUrl, {});
      if (!videoRes.ok) {
        throw new Error(`Failed to download HeyGen result video: ${videoRes.status}`);
      }
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
      writeFileSync(videoPath, videoBuffer);

      return {
        videoPath,
        vendor: "heygen",
        durationSec: input.durationSec,
      };
    },
  };
}

async function pollHeyGenJob(videoId: string, apiKey: string, maxAttempts = 60, intervalMs = 5000): Promise<{ videoUrl: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetchWithRetry(
      `${API_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
      { headers: { "X-Api-Key": apiKey } }
    );

    if (!res.ok) {
      throw new Error(`HeyGen poll failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { data?: { status: string; video_url?: string; error?: string } };
    const status = data.data?.status;

    if (status === "completed" && data.data?.video_url) {
      return { videoUrl: data.data.video_url };
    }
    if (status === "failed") {
      throw new Error(`HeyGen job failed: ${data.data?.error ?? "unknown error"}`);
    }
    // else: processing/pending — continue polling
  }

  throw new Error(`HeyGen job ${videoId} timed out after ${maxAttempts * intervalMs / 1000}s`);
}
