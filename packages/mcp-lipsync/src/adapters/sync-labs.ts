/**
 * Sync Labs (sync.so) LipSync Adapter
 *
 * API: POST https://api.synclabs.so/video → submit job
 *      GET  https://api.synclabs.so/video/{id} → poll status
 *
 * Input: audio file URL + face image URL → output: video URL of talking head.
 * Requires SYNC_LABS_API_KEY environment variable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { LipSyncAdapter, LipSyncInput, LipSyncResult } from "./LipSyncAdapter.js";

const API_BASE = "https://api.synclabs.so";

export function createSyncLabsAdapter(): LipSyncAdapter {
  const apiKey = process.env.SYNC_LABS_API_KEY;
  if (!apiKey) {
    throw new Error("SYNC_LABS_API_KEY is required for the Sync Labs lipsync adapter");
  }

  return {
    vendor: "sync_labs",
    async generate(input: LipSyncInput): Promise<LipSyncResult> {
      mkdirSync(input.outDir, { recursive: true });

      // Step 1: Submit the lipsync job
      const submitRes = await fetchWithRetry(`${API_BASE}/video`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          audioUrl: input.audioPath, // In production, this would be a pre-signed URL
          videoUrl: input.characterImageUrl, // Sync Labs accepts image as "video" input for photo-to-talking-head
          model: "sync-1.7.1-beta",
        }),
      });

      if (!submitRes.ok) {
        const err = await submitRes.text();
        throw new Error(`Sync Labs submit failed (${submitRes.status}): ${err}`);
      }

      const { id: jobId } = (await submitRes.json()) as { id: string };

      // Step 2: Poll for completion
      const result = await pollJob(jobId, apiKey);

      // Step 3: Download the result video
      const filename = `lipsync-synclabs-${randomUUID().slice(0, 8)}.mp4`;
      const videoPath = join(input.outDir, filename);

      const videoRes = await fetchWithRetry(result.videoUrl, {});
      if (!videoRes.ok) {
        throw new Error(`Failed to download Sync Labs result video: ${videoRes.status}`);
      }
      const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
      writeFileSync(videoPath, videoBuffer);

      return {
        videoPath,
        vendor: "sync_labs",
        durationSec: input.durationSec,
      };
    },
  };
}

async function pollJob(jobId: string, apiKey: string, maxAttempts = 60, intervalMs = 5000): Promise<{ videoUrl: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetchWithRetry(`${API_BASE}/video/${jobId}`, {
      headers: { "x-api-key": apiKey },
    });

    if (!res.ok) {
      throw new Error(`Sync Labs poll failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { status: string; videoUrl?: string; error?: string };

    if (data.status === "COMPLETED" && data.videoUrl) {
      return { videoUrl: data.videoUrl };
    }
    if (data.status === "FAILED") {
      throw new Error(`Sync Labs job failed: ${data.error ?? "unknown error"}`);
    }
    // else: PROCESSING — continue polling
  }

  throw new Error(`Sync Labs job ${jobId} timed out after ${maxAttempts * intervalMs / 1000}s`);
}
