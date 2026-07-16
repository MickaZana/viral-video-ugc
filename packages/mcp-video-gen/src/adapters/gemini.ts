import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { DIMENSIONS_BY_ASPECT_RATIO } from "../dimensions.js";
import { stillImageToClip } from "../ken-burns.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// gemini-2.5-flash-image ("Nano Banana") — the stable, flat-per-image-priced
// ($0.039/image up to 1024x1024) Gemini image model, verified against the
// current Gemini API docs. Overridable via GEMINI_IMAGE_MODEL for anyone who
// wants a newer/higher-resolution model instead (see shared-cost's rate-table
// comment: those are priced per resolution tier, not flat, so the recorded
// cost estimate will drift if you override this).
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

interface GeminiInteractionResponse {
  output_image?: { data: string };
}

/**
 * Gemini has no video-generation endpoint this pipeline can call directly —
 * this adapter generates a single still image per script segment via the
 * Gemini API's image-generation endpoint, then turns it into a `durationSec`
 * clip with a Ken Burns pan/zoom (see ../ken-burns.ts) so it still reads as
 * B-roll rather than a frozen frame. Useful both as a still-photo-driven
 * alternative to the talking-head/B-roll video vendors (--video-vendor
 * gemini) and for populating the marketing site's placeholder gallery (see
 * apps/marketing-site/scripts/generate-demo-videos.ts).
 *
 * Endpoint verified against the current Gemini API docs: POST
 * /v1beta/interactions, auth via the `x-goog-api-key` header, JSON body
 * `{model, input: [{type: "text", text}], response_format: {type: "image",
 * aspect_ratio, image_size}}`, response image bytes at `output_image.data`
 * (base64).
 */
export function createGeminiAdapter(outDir: string): VideoGenAdapter {
  return {
    vendor: "gemini",
    async generate(req: VideoGenRequest): Promise<RawClip> {
      const apiKey = requireEnvVar("GEMINI_API_KEY");
      const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
      const dims = DIMENSIONS_BY_ASPECT_RATIO[req.aspectRatio];

      const res = await fetchWithRetry(`${GEMINI_API_BASE}/interactions`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: [{ type: "text", text: req.prompt }],
          response_format: { type: "image", aspect_ratio: req.aspectRatio, image_size: "1K" }
        }),
        timeoutMs: 60_000
      });
      if (!res.ok) {
        throw new Error(`Gemini image generation failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as GeminiInteractionResponse;
      const imageBase64 = body.output_image?.data;
      if (!imageBase64) {
        throw new Error("Gemini image generation returned no output_image.data");
      }

      mkdirSync(outDir, { recursive: true });
      const stillPath = join(outDir, `gemini-still-${req.scriptSegmentIndex}.png`);
      writeFileSync(stillPath, Buffer.from(imageBase64, "base64"));

      const filePath = join(outDir, `gemini-${req.scriptSegmentIndex}.mp4`);
      await stillImageToClip(stillPath, req.durationSec, dims, filePath);

      return {
        id: `gemini-${req.scriptSegmentIndex}`,
        scriptSegmentIndex: req.scriptSegmentIndex,
        vendor: "gemini",
        filePath,
        durationSec: req.durationSec
      };
    }
  };
}
