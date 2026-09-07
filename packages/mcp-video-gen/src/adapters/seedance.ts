import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToSeedanceParams } from "../visual-mapping.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * Seedance 2.5 (ByteDance) — accessed via fal.ai API.
 *
 * Seedance has no standalone first-party REST API. It's available through
 * aggregator platforms: fal.ai, Atlas Cloud, Higgsfield, etc. We use fal.ai
 * because it has the simplest REST interface and competitive pricing.
 *
 * fal.ai REST contract (verified from docs.fal.ai):
 * - POST https://queue.fal.run/{model_id} → queues generation, returns request_id
 * - GET https://queue.fal.run/{model_id}/requests/{request_id}/status → poll
 * - GET https://queue.fal.run/{model_id}/requests/{request_id} → get result
 * - Auth: Key-based via "Authorization: Key {FAL_KEY}" header
 *
 * The FAL_KEY env var is already in shared-config (used by Pika adapter too).
 *
 * --- 2.0 → 2.5 upgrade notes (verified against fal.ai/models/bytedance/seedance-2.5/*
 *     docs pages directly, Aug 2026 — schema does NOT carry over unchanged from 2.0) ---
 *
 * - Native 30-second single-pass generation at up to 720p (per fal.ai's own 2.5 model
 *   copy: "no stitching or visible seams" — a materially higher ceiling than 2.0's
 *   shorter native single-pass length at the same tier).
 * - Audio (dialogue lip-sync + ambient sound) is now generated jointly with video in
 *   the same latent pass — every endpoint below defaults `generate_audio` to `true`,
 *   so this capability needs no extra flag from us; we simply don't need a separate
 *   voiceover/mux step for Seedance-sourced clips anymore. Not set explicitly here
 *   since the API default already matches what we want.
 * - 2.0 exposed generation through what was effectively one implicit endpoint (image_url
 *   present → image-to-video behavior, absent → text-to-video behavior, on the same
 *   model id). 2.5 splits this into THREE explicit endpoints with different schemas:
 *     - text-to-video:      { prompt, duration, aspect_ratio, generate_audio, ... }   — no image field at all.
 *     - image-to-video:     { prompt, image_url, duration, aspect_ratio, ... }        — ONE starting-frame image.
 *     - reference-to-video: { prompt, image_urls[], video_urls[], audio_urls[], ... } — up to 50 multimodal
 *       references (images/video/audio/style), addressed positionally in the prompt as
 *       [Image1], [Image2], [Video1], etc. This endpoint has NO singular `image_url`
 *       field — multi-image identity has to travel as `image_urls`.
 *
 * Endpoint-selection decision (documented the way kling.ts/grok-video.ts document their
 * own endpoint/field choices):
 *   1. req.startingFrame present → image-to-video, using that frame as `image_url`.
 *      startingFrame's contract is "animate exactly this image" (see VideoGenAdapter.ts's
 *      startingFrame doc) — the most specific single-image intent this request shape can
 *      carry. reference-to-video has no "first frame to animate" semantics (its refs are
 *      compositional, not a starting point), so startingFrame always wins image-to-video
 *      even when identityRef also carries multiple reference images.
 *   2. Else, identityRef.primaryImageUrl present AND identityRef.additionalImageUrls is
 *      non-empty → reference-to-video, sending primary + all additional images as
 *      `image_urls` (in that order, so a prompt can address them as [Image1]/[Image2]/...).
 *      This is new leverage 2.5 unlocks over 2.0: 2.0's single image_url slot could only
 *      ever carry identityRef.primaryImageUrl and silently discarded additionalImageUrls;
 *      2.5's reference-to-video endpoint actually uses the full Soul ID reference set
 *      instead of dropping it on the floor.
 *   3. Else, a single image is available (identityRef.primaryImageUrl with no additional
 *      images, or a generic referenceImageUrl/referenceImageDataUri) → image-to-video,
 *      same precedence used elsewhere in this codebase: startingFrame >
 *      identityRef.primaryImageUrl > referenceImageUrl > referenceImageDataUri.
 *   4. Else (no image signal at all) → text-to-video.
 */

const SEEDANCE_MODEL_BASE = "bytedance/seedance-2.5";

type SeedanceEndpoint = "text-to-video" | "image-to-video" | "reference-to-video";

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
      // SEEDANCE_MODEL overrides the model *base* (e.g. pin back to
      // "bytedance/seedance-2.0"); the endpoint suffix chosen below is always appended,
      // so the override keeps working across the 2.0 -> 2.5 default bump.
      const modelBase = loadEnv().SEEDANCE_MODEL || SEEDANCE_MODEL_BASE;
      const headers = {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      };

      const input: Record<string, unknown> = {
        prompt: req.prompt,
        // 2.5's duration field is a string enum ("auto" | "4".."30"), not a number —
        // confirmed on all three endpoint schema pages.
        duration: String(req.durationSec),
        aspect_ratio: req.aspectRatio,
      };

      // Endpoint selection — see file header comment for full reasoning.
      let endpoint: SeedanceEndpoint;
      const startingImage = req.startingFrame?.imageUrl ?? req.startingFrame?.imageDataUri;
      const additionalRefs = req.identityRef?.additionalImageUrls ?? [];

      if (startingImage) {
        endpoint = "image-to-video";
        input.image_url = startingImage;
      } else if (req.identityRef?.primaryImageUrl && additionalRefs.length > 0) {
        endpoint = "reference-to-video";
        input.image_urls = [req.identityRef.primaryImageUrl, ...additionalRefs];
      } else if (req.identityRef?.primaryImageUrl) {
        endpoint = "image-to-video";
        input.image_url = req.identityRef.primaryImageUrl;
      } else if (req.referenceImageUrl) {
        endpoint = "image-to-video";
        input.image_url = req.referenceImageUrl;
      } else if (req.referenceImageDataUri) {
        endpoint = "image-to-video";
        input.image_url = req.referenceImageDataUri;
      } else {
        endpoint = "text-to-video";
      }

      const model = `${modelBase}/${endpoint}`;

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
