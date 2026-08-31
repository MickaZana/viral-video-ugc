import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireEnvVar } from "@vvugc/shared-config";
import { fetchWithRetry } from "@vvugc/shared-http";
import type { RawClip } from "@vvugc/shared-schema";
import { DIMENSIONS_BY_ASPECT_RATIO } from "../dimensions.js";
import { mapToPromptEnrichment } from "../visual-mapping.js";
import { stillImageToClip } from "../ken-burns.js";
import type { VideoGenAdapter, VideoGenRequest } from "./VideoGenAdapter.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// gemini-2.5-flash-image ("Nano Banana") — the stable, flat-per-image-priced
// ($0.039/image up to 1024x1024) Gemini image model, verified against the
// current Gemini API docs. Overridable via GEMINI_IMAGE_MODEL for anyone who
// wants a newer/higher-resolution model instead (see shared-cost's rate-table
// comment: those are priced per resolution tier, not flat, so the recorded
// cost estimate will drift if you override this).
//
// The three real Nano Banana tiers, live-confirmed against this project's own
// GEMINI_API_KEY via GET /v1beta/models (response `displayName` quoted below)
// — all are already reachable through this same GEMINI_IMAGE_MODEL override,
// no new config plumbing needed:
//   - "Nano Banana" (legacy, default): gemini-2.5-flash-image
//   - "Nano Banana Pro":               gemini-3-pro-image-preview  (also
//                                       offered as a non-preview alias,
//                                       gemini-3-pro-image)
//   - "Nano Banana 2":                 gemini-3.1-flash-image-preview  (also
//                                       offered as a non-preview alias,
//                                       gemini-3.1-flash-image — NOT
//                                       "Gemini 3.1 Flash Image" as a bare
//                                       string; that's the display name, the
//                                       API model id has the gemini-3.1-flash-
//                                       image[-preview] form). A fourth,
//                                       gemini-3.1-flash-lite-image ("Nano
//                                       Banana 2 Lite"), also exists but isn't
//                                       one of the three asked for here.
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

interface GeminiInteractionResponse {
  output_image?: { data: string; mime_type?: string };
}

export interface GenerateImageOptions {
  /** Overrides GEMINI_IMAGE_MODEL / DEFAULT_IMAGE_MODEL for this call only. */
  model?: string;
  /**
   * Image-to-image / image-editing input, as a full `data:image/...;base64,...`
   * URI passed straight through to Gemini's single `image` input slot — the
   * same inline-image-transport convention every other adapter in this
   * package uses for VideoGenRequest.referenceImageDataUri (see
   * seedance.ts, wan.ts, grok-video.ts, replicate.ts: all pass the data URI
   * through untouched to the vendor's one image field rather than splitting
   * it into mime type + raw base64).
   */
  referenceImageDataUri?: string;
  aspectRatio?: "9:16" | "1:1" | "16:9";
  /** Gemini's response_format.image_size. Defaults to "1K". */
  imageSize?: "1K" | "2K" | "4K";
}

export interface GeneratedImage {
  imageBytes: Buffer;
  mimeType: string;
}

/**
 * Standalone Nano Banana image generation — no video attached. Calls the same
 * Gemini Interactions API endpoint createGeminiAdapter's video-generation flow
 * uses internally (see that function below, which now delegates here), but
 * exposed as its own function for callers that just want an image: a still
 * for the marketing gallery, a reference/identity frame, image editing via
 * `referenceImageDataUri`, etc. Mirrors the standalone-function convention
 * mcp-voiceover/src/lib.ts uses for generateVoiceoverTrack (a plain async
 * function callers invoke directly, independent of any single adapter).
 */
export async function generateImage(prompt: string, opts: GenerateImageOptions = {}): Promise<GeneratedImage> {
  const apiKey = requireEnvVar("GEMINI_API_KEY");
  const model = opts.model || process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const aspectRatio = opts.aspectRatio || "1:1";
  const imageSize = opts.imageSize || "1K";

  const res = await fetchWithRetry(`${GEMINI_API_BASE}/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ type: "text", text: prompt }, ...(opts.referenceImageDataUri ? [{ type: "image", image: opts.referenceImageDataUri }] : [])],
      response_format: { type: "image", aspect_ratio: aspectRatio, image_size: imageSize }
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

  return {
    imageBytes: Buffer.from(imageBase64, "base64"),
    // The Interactions API's documented response shape doesn't always echo a
    // mime type back; Gemini image output defaults to PNG (matches the
    // `.png` extension createGeminiAdapter has always written stills as
    // below), so fall back to that when the response omits it.
    mimeType: body.output_image?.mime_type || "image/png"
  };
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
      const dims = DIMENSIONS_BY_ASPECT_RATIO[req.aspectRatio];

      // Cinema Controls: enrich prompt with visual direction
      const enrichedPrompt = req.visualDirection ? `${req.prompt}. ${mapToPromptEnrichment(req.visualDirection)}` : req.prompt;
      const { imageBytes } = await generateImage(enrichedPrompt, {
        referenceImageDataUri: req.referenceImageDataUri,
        aspectRatio: req.aspectRatio,
        imageSize: "1K"
      });

      mkdirSync(outDir, { recursive: true });
      const stillPath = join(outDir, `gemini-still-${req.scriptSegmentIndex}.png`);
      writeFileSync(stillPath, imageBytes);

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
