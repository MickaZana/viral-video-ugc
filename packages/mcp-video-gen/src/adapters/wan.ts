import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { pollWithBackoff } from "../poll.js";
import { mapToPromptEnrichment } from "../visual-mapping.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/**
 * Alibaba Wan 3.0, reached through Replicate the same way replicate.ts's
 * DEFAULT_MODEL is — but given its own dedicated adapter (rather than being
 * left as a REPLICATE_MODEL override) because it's a specific, deliberately
 * chosen model with its own pricing/capability story (native 30s clips, up
 * to 1080p, up to 10 reference images), the same reasoning seedance.ts uses
 * for a model reached through fal.ai rather than folding it into a generic
 * adapter. No env-var override (no `WAN_MODEL` in shared-config's Env type,
 * and shared-config is out of scope for this change) — the slug below is a
 * fixed constant, confirmed live rather than added speculatively.
 *
 * VERIFIED LIVE against the real Replicate API on 2026-08-31 with the repo's
 * own REPLICATE_API_TOKEN (`GET /v1/models/alibaba/wan-3` → 200, not a
 * guess/404):
 *   - Model slug: `alibaba/wan-3` (exactly the slug the task named — confirmed
 *     real, not assumed). latest_version id observed:
 *     bb8bf2a1273cabad48e6c566ad7112e06bbc6ccf39684ffd81b618822735f056
 *   - description on the model confirms this is Wan 3.0: "...generates video
 *     from a text prompt or a starting image, with cinematic motion and
 *     support for 480p, 720p, and 1080p output up to 30 seconds."
 *   - Full Input schema read from `latest_version.openapi_schema` (every
 *     field name below is copied verbatim from that live response, not
 *     guessed from public docs):
 *       prompt (string, required)
 *       image (string, uri, optional) — "Optional first-frame image to
 *         animate into a video (jpg/png/bmp/webp, ≤10MB). When provided, the
 *         video is generated from this image guided by the prompt."
 *       negative_prompt (string, default "")
 *       resolution (enum: "480p" | "720p" | "1080p", default "1080p")
 *       aspect_ratio (enum: "adaptive" | "16:9" | "9:16" | "1:1" | "4:3" |
 *         "3:4", default "adaptive") — "Ignored when an image is provided
 *         (the input image's aspect ratio is used)."
 *       duration (integer, min 2, max 30, default 5)
 *       enable_prompt_expansion (boolean, default true)
 *       seed (integer, nullable)
 *     Output schema: a bare `{"type":"string","format":"uri"}` — Wan always
 *     returns a single URL string, not the array/object shapes some other
 *     Replicate models use. extractVideoUrl() below still checks those other
 *     shapes defensively (matching replicate.ts's own helper) in case a
 *     future model version changes this, but the plain-string case is the
 *     one actually confirmed live.
 *   - This adapter sends only the four VideoGenRequest-backed fields (prompt,
 *     aspect_ratio, duration, image) — negative_prompt/resolution/
 *     enable_prompt_expansion/seed have no corresponding field on
 *     VideoGenRequest, so they're left unset and fall back to Wan's own
 *     defaults above (1080p, prompt expansion on) rather than being invented.
 *   - req.aspectRatio's three values ("9:16" | "1:1" | "16:9") are a strict
 *     subset of Wan's own aspect_ratio enum, confirmed live above — passed
 *     straight through with no translation needed.
 *   - NOT verified live: submit → poll → download was not exercised through
 *     this exact code path before this file was written (see wan.ts's
 *     accompanying report for what the live end-to-end attempt actually
 *     showed). The submit/poll/download REST contract itself (POST
 *     /models/{owner}/{name}/predictions, GET /predictions/{id}, the
 *     id/status/output/error shape) is the same one replicate.ts already
 *     verified against Replicate's own docs — Wan is just another model on
 *     the identical platform, not a different contract.
 */
const WAN_MODEL = "alibaba/wan-3";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: unknown;
}

export function createWanAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "wan",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiToken = requireEnvVar("REPLICATE_API_TOKEN");
      const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };

      // Cinema Controls: enrich prompt with visual direction (same convention
      // as replicate.ts/grok-video.ts).
      const enrichedPrompt = req.visualDirection ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}` : req.prompt;
      const input: Record<string, unknown> = {
        prompt: enrichedPrompt,
        aspect_ratio: req.aspectRatio,
        duration: req.durationSec
      };
      // Image-to-video: startingFrame > identityRef > generic referenceImageUrl
      // — see VideoGenAdapter.ts's startingFrame doc for the precedence rationale.
      if (req.startingFrame?.imageUrl) input.image = req.startingFrame.imageUrl;
      else if (req.startingFrame?.imageDataUri) input.image = req.startingFrame.imageDataUri;
      else if (req.identityRef?.primaryImageUrl) input.image = req.identityRef.primaryImageUrl;
      else if (req.referenceImageUrl) input.image = req.referenceImageUrl;
      else if (req.referenceImageDataUri) input.image = req.referenceImageDataUri;

      // No `Prefer: wait` — same rationale as replicate.ts: a video job
      // routinely outlasts fetchWithRetry's own timeout, so plain
      // submit-then-poll is both simpler and actually correct here.
      const submitRes = await fetchWithRetry(`${REPLICATE_API_BASE}/models/${WAN_MODEL}/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input })
      });
      if (!submitRes.ok) {
        throw new Error(`Wan (${WAN_MODEL}) prediction submit failed: ${submitRes.status} ${await submitRes.text()}`);
      }
      const submitted = (await submitRes.json()) as ReplicatePrediction;

      // `Prefer: wait` (or a naturally fast run) can mean the submit response
      // is already terminal — check before polling separately, same shortcut
      // replicate.ts uses.
      if (submitted.status === "succeeded") {
        const videoUrl = extractVideoUrl(submitted.output);
        if (videoUrl) return downloadClip(videoUrl, submitted.id, req, outDir);
      }
      if (submitted.status === "failed" || submitted.status === "canceled") {
        throw new Error(`Wan prediction ${submitted.id} ${submitted.status}: ${JSON.stringify(submitted.error ?? submitted)}`);
      }

      const prediction = await pollWithBackoff(async () => {
        const statusRes = await fetchWithRetry(`${REPLICATE_API_BASE}/predictions/${submitted.id}`, {
          headers,
          timeoutMs: 15_000
        });
        if (!statusRes.ok) {
          throw new Error(`Wan prediction ${submitted.id} status check failed: ${statusRes.status} ${await statusRes.text()}`);
        }
        const status = (await statusRes.json()) as ReplicatePrediction;
        if (status.status === "failed" || status.status === "canceled") {
          throw new Error(`Wan prediction ${submitted.id} ${status.status}: ${JSON.stringify(status.error ?? status)}`);
        }
        return status.status === "succeeded" ? status : undefined;
      });
      if (!prediction) throw new Error(`Wan prediction ${submitted.id} did not complete in time`);

      const videoUrl = extractVideoUrl(prediction.output);
      if (!videoUrl) {
        throw new Error(`Wan prediction ${submitted.id} succeeded but no video URL was found in output: ${JSON.stringify(prediction.output)}`);
      }

      return downloadClip(videoUrl, submitted.id, req, outDir);
    }
  };
}

async function downloadClip(videoUrl: string, predictionId: string, req: VideoGenRequest, outDir: string): Promise<RawClip> {
  const filePath = `${outDir}/wan-${req.scriptSegmentIndex}-${predictionId}.mp4`;
  mkdirSync(dirname(filePath), { recursive: true });
  const bytes = await (await fetchWithRetry(videoUrl, { timeoutMs: 120_000 })).arrayBuffer();
  writeFileSync(filePath, Buffer.from(bytes));

  return {
    id: predictionId,
    scriptSegmentIndex: req.scriptSegmentIndex,
    vendor: "wan",
    filePath,
    durationSec: req.durationSec
  };
}

/** Confirmed live: Wan's Output schema is a bare URI string. The array/object
 *  fallbacks mirror replicate.ts's own defensive helper for other models on
 *  the same platform, kept here in case a future Wan version changes shape —
 *  not something observed from Wan itself. */
function extractVideoUrl(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (typeof output === "object" && output !== null) {
    const record = output as Record<string, unknown>;
    if (typeof record.video === "string") return record.video;
    if (typeof record.url === "string") return record.url;
  }
  return undefined;
}
