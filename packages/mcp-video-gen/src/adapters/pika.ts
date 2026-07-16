import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const FAL_QUEUE_BASE = "https://queue.fal.run";
const PIKA_MODEL_ID = "pika/v2.2/text-to-video";

interface FalStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}

interface FalVideoResult {
  video?: { url: string };
}

/**
 * Pika no longer runs its own public API — as of Dec 2025 it's served exclusively
 * through fal.ai's model-hosting platform (https://fal.ai/docs/model-apis/model-endpoints/queue).
 * The original version of this adapter targeted a standalone api.pika.art endpoint that
 * no longer exists for this purpose; this rewrite goes through fal's queue API instead.
 * Auth is a fal API key ("FAL_KEY" env var, `Authorization: Key <key>` header), not a
 * Pika-specific key.
 */
export function createPikaAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "pika",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("FAL_KEY");
      const headers = { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };

      const submitRes = await fetchWithRetry(`${FAL_QUEUE_BASE}/${PIKA_MODEL_ID}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: req.prompt,
          resolution: "720p",
          length: req.durationSec
        })
      });
      if (!submitRes.ok) {
        throw new Error(`fal.ai Pika submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const { request_id: requestId } = (await submitRes.json()) as { request_id: string };

      const completed = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(`${FAL_QUEUE_BASE}/${PIKA_MODEL_ID}/requests/${requestId}/status`, {
          headers,
          timeoutMs: 15_000
        });
        const status = (await statusRes.json()) as FalStatus;
        return status.status === "COMPLETED" ? true : undefined;
      });
      if (!completed) throw new Error(`fal.ai Pika request ${requestId} did not complete in time`);

      const resultRes = await fetchWithRetry(`${FAL_QUEUE_BASE}/${PIKA_MODEL_ID}/requests/${requestId}`, { headers });
      const result = (await resultRes.json()) as FalVideoResult;
      const videoUrl = result.video?.url;
      if (!videoUrl) throw new Error(`fal.ai Pika request ${requestId} completed without a video URL`);

      const filePath = `${outDir}/pika-${req.scriptSegmentIndex}-${requestId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: requestId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "pika",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}
