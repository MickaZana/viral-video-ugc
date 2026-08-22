import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToSeedanceParams } from "../visual-mapping.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * Seedance 2.0 (ByteDance) — accessed via fal.ai API.
 *
 * Seedance has no standalone first-party REST API. It's available through
 * aggregator platforms: fal.ai, Atlas Cloud, Higgsfield, etc. We use fal.ai
 * because it has the simplest REST interface and competitive pricing
 * (~$0.022–0.074/sec at 480p Fast, ~$0.092–0.199/sec at 720p Standard).
 *
 * fal.ai REST contract (verified from docs.fal.ai):
 * - POST https://queue.fal.run/{model_id} → queues generation, returns request_id
 * - GET https://queue.fal.run/{model_id}/requests/{request_id}/status → poll
 * - GET https://queue.fal.run/{model_id}/requests/{request_id} → get result
 * - Auth: Key-based via "Authorization: Key {FAL_KEY}" header
 *
 * The FAL_KEY env var is already in shared-config (used by Pika adapter too).
 */

const SEEDANCE_MODEL = "fal-ai/seedance-2";

interface FalQueueResponse {
  request_id: string;
  status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}

interface FalStatusResponse {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}

interface FalResultResponse {
  video: { url: string };
}

export function createSeedanceAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "seedance",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("FAL_KEY");
      const model = loadEnv().SEEDANCE_MODEL || SEEDANCE_MODEL;
      const headers = {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      };

      const input: Record<string, unknown> = {
        prompt: req.prompt,
        duration: req.durationSec,
        aspect_ratio: req.aspectRatio,
      };
      // Soul ID: identityRef takes priority over generic referenceImageUrl
      if (req.identityRef?.primaryImageUrl) {
        input.image_url = req.identityRef.primaryImageUrl;
      } else if (req.referenceImageUrl) {
        input.image_url = req.referenceImageUrl;
      } else if (req.referenceImageDataUri) {
        input.image_url = req.referenceImageDataUri;
      }

      // Cinema Controls: merge native Seedance motion/camera params
      if (req.visualDirection) {
        Object.assign(input, mapToSeedanceParams(req.visualDirection));
      }

      // Submit to queue
      const submitRes = await fetchWithRetry(`https://queue.fal.run/${model}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      if (!submitRes.ok) {
        throw new Error(`Seedance submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const queued = (await submitRes.json()) as FalQueueResponse;
      const requestId = queued.request_id;

      // Poll for completion
      const result = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(
          `https://queue.fal.run/${model}/requests/${requestId}/status`,
          { headers, timeoutMs: 15_000 }
        );
        if (!statusRes.ok) {
          throw new Error(`Seedance status check failed: ${statusRes.status} ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as FalStatusResponse;
        return status.status === "COMPLETED" ? true : undefined;
      });

      if (!result) {
        throw new Error(`Seedance request ${requestId} did not complete in time`);
      }

      // Fetch result
      const resultRes = await fetchWithRetry(
        `https://queue.fal.run/${model}/requests/${requestId}`,
        { headers, timeoutMs: 30_000 }
      );
      if (!resultRes.ok) {
        throw new Error(`Seedance result fetch failed: ${resultRes.status} ${await resultRes.text()}`);
      }
      const resultBody = (await resultRes.json()) as FalResultResponse;
      const videoUrl = resultBody.video?.url;
      if (!videoUrl) {
        throw new Error(`Seedance request ${requestId} completed but no video URL found: ${JSON.stringify(resultBody)}`);
      }

      // Download clip
      const filePath = `${outDir}/seedance-${req.scriptSegmentIndex}-${requestId}.mp4`;
      mkdirSync(dirname(filePath), { recursive: true });
      const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
      writeFileSync(filePath, Buffer.from(bytes));

      return {
        id: requestId,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "seedance",
        filePath,
        durationSec: req.durationSec,
      };
    },
  };
}
