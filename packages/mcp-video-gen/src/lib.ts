import type { RawClip } from "@vvugc/shared-schema";
import type { McpToolCaller, VideoGenAdapter } from "./adapters/VideoGenAdapter.js";
import { createHiggsfieldAdapter } from "./adapters/higgsfield.js";
import { createKlingAdapter } from "./adapters/kling.js";
import { createRunwayAdapter } from "./adapters/runway.js";
import { createPikaAdapter } from "./adapters/pika.js";
import { createGeminiAdapter } from "./adapters/gemini.js";
import { createReplicateAdapter } from "./adapters/replicate.js";
import { createSeedanceAdapter } from "./adapters/seedance.js";
import { createGrokVideoAdapter } from "./adapters/grok-video.js";
import { createWanAdapter } from "./adapters/wan.js";
import { createMockAdapter } from "./adapters/mock.js";

export type { VideoGenAdapter, VideoGenRequest, McpToolCaller } from "./adapters/VideoGenAdapter.js";
export { VIDEO_VENDOR_CAPABILITIES, creatorCapabilityWarnings } from "./capabilities.js";
export { mapToKlingParams, mapToSeedanceParams, mapToPromptEnrichment } from "./visual-mapping.js";
// Standalone Nano Banana image generation (no video attached) — the image-first
// generation precursor: generate a frame here, then animate it via any adapter's
// startingFrame. See gemini.ts's own doc comment for why this exists as a
// standalone export rather than only inside createGeminiAdapter.
export { generateImage, type GenerateImageOptions, type GeneratedImage } from "./adapters/gemini.js";
// Character Builder — "generate a person from scratch," a standalone flow
// separate from the main run pipeline. See character-builder.ts's own doc
// comment for how this hands off to the existing creator reference-image path.
export {
  buildCharacterPrompt,
  generateCharacterPortraitBatch,
  CharacterAttributesSchema,
  CHARACTER_ATTRIBUTE_OPTIONS,
  type CharacterAttributes,
  type CharacterPortrait,
  type CharacterPortraitBatchOptions
} from "./character-builder.js";

export function getVideoGenAdapter(
  vendor: RawClip["vendor"],
  opts: { outDir: string; dryRun: boolean; callMcpTool?: McpToolCaller }
): VideoGenAdapter {
  if (opts.dryRun) return createMockAdapter(vendor, opts.outDir);

  switch (vendor) {
    case "higgsfield":
      if (!opts.callMcpTool) {
        throw new Error(
          "The Higgsfield adapter requires a callMcpTool callback wired to the conductor's connected " +
            "HiggsfieldAi MCP server — pass one in, or use --dry-run."
        );
      }
      return createHiggsfieldAdapter(opts.callMcpTool, opts.outDir);
    case "kling":
      return createKlingAdapter(opts.outDir);
    case "runway":
      return createRunwayAdapter(opts.outDir);
    case "pika":
      return createPikaAdapter(opts.outDir);
    case "gemini":
      return createGeminiAdapter(opts.outDir);
    case "replicate":
      return createReplicateAdapter(opts.outDir);
    case "seedance":
      return createSeedanceAdapter(opts.outDir);
    case "grok_video":
      return createGrokVideoAdapter(opts.outDir);
    case "wan":
      return createWanAdapter(opts.outDir);
  }
}
