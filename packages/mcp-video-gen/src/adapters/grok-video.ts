import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToPromptEnrichment } from "../visual-mapping.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

/**
 * Grok Imagine Video (xAI) — text-to-video and image-to-video generation.
 *
 * xAI's official API (docs.x.ai) provides video generation via the Imagine endpoint.
 * Pricing: ~$0.05–0.08/sec (Aug 2026). Strong on image-to-video animation.
 * Uses the same XAI_API_KEY already configured for Grok voiceover.
 *
 * API contract (from docs.x.ai/developers/models/grok-imagine-video):
 * - POST https://api.x.ai/v1/images/generations (with video params)
 *   OR POST https://api.x.ai/v1/video/generations (dedicated video endpoint)
 * - Auth: "Authorization: Bearer {XAI_API_KEY}"
 * - Async: returns a generation ID, poll for result
 * - Per-second billing based on duration and resolution
 */

const XAI_API_BASE = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-imagine-video-1.5";

interface GrokVideoSubmitResponse {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  video?: { url: string };
}

interface GrokVideoStatusResponse {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  video?: { url: string };
  error?: string;
}

export function createGrokVideoAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "grok_video",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("XAI_API_KEY");
      const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };

      // Cinema Controls: enrich prompt with visual direction
      const enrichedPrompt = req.visualDirection ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}` : req.prompt;
      const body: Record<string, unknown> = {
        model: DEFAULT_MODEL,
        prompt: enrichedPrompt,
        duration: req.durationSec,
        aspect_ratio: req.aspectRatio,
      };
      // Image-to-video: startingFrame > identityRef > generic referenceImageUrl
      // — see VideoGenAdapter.ts's startingFrame doc for the precedence rationale.
      if (req.startingFrame?.imageUrl) body.image = req.startingFrame.imageUrl;
      else if (req.startingFrame?.imageDataUri) body.image = req.startingFrame.imageDataUri;
      else if (req.identityRef?.primaryImageUrl) body.image = req.identityRef.primaryImageUrl;
      else if (req.referenceImageUrl) body.image = req.referenceImageUrl;
      else if (req.referenceImageDataUri) body.image = req.referenceImageDataUri;

      // Submit generation request
      const submitRes = await fetchWithRetry(`${XAI_API_BASE}/video/generations`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!submitRes.ok) {
        throw new Error(`Grok Video submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const submitted = (await submitRes.json()) as GrokVideoSubmitResponse;
      const generationId = submitted.id;

      // Check if already completed (fast models)
      if (submitted.status === "completed" && submitted.video?.url) {
        return downloadClip(submitted.video.url, generationId, req, outDir);
      }
      if (submitted.status === "failed") {
        throw new Error(`Grok Video generation ${generationId} failed immediately: ${JSON.stringify(submitted)}`);
      }

      // Poll for completion
      const result = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(`${XAI_API_BASE}/video/generations/${generationId}`, {
          headers,
          timeoutMs: 15_000,
        });
        if (!statusRes.ok) {
          throw new Error(`Grok Video status check failed: ${statusRes.status} ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as GrokVideoStatusResponse;
        if (status.status === "failed") {
          throw new Error(`Grok Video generation ${generationId} failed: ${status.error ?? JSON.stringify(status)}`);
        }
        return status.status === "completed" ? status : undefined;
      });

      if (!result?.video?.url) {
        throw new Error(`Grok Video generation ${generationId} completed but no video URL found`);
      }

      return downloadClip(result.video.url, generationId, req, outDir);
    },
  };
}

async function downloadClip(
  videoUrl: string,
  generationId: string,
  req: VideoGenRequest,
  outDir: string
): Promise<RawClip> {
  const filePath = `${outDir}/grok-video-${req.scriptSegmentIndex}-${generationId}.mp4`;
  mkdirSync(dirname(filePath), { recursive: true });
  const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
  writeFileSync(filePath, Buffer.from(bytes));

  return {
    id: generationId,
    scriptSegmentIndex: req.scriptSegmentIndex,
    vendor: "grok_video",
    filePath,
    durationSec: req.durationSec,
  };
}
