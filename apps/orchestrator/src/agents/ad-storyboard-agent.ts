import type { CostLedger } from "@vvugc/shared-cost";
import { z } from "zod";
import { generateWithFailover } from "./llm-failover.js";
import type { AdDeconstructionResult } from "./ad-deconstruction-agent.js";

/**
 * Ad Storyboard Agent: turns the Ad Deconstruction Agent's raw scene analysis into a
 * clean, schema-validated storyboard shaped for what a video-generation call actually
 * needs — a prompt per scene, a suggested duration, and suggested visualDirection
 * fields. visualDirection's field names/enum values are copied VERBATIM from
 * packages/mcp-video-gen/src/adapters/VideoGenAdapter.ts's VideoGenRequest.visualDirection
 * (not reinvented) so this output can be handed straight to that pipeline later.
 */

const SYSTEM_PROMPT = `You are a video-generation storyboard director. Given a raw scene-by-scene
deconstruction of an existing ad (shot descriptions, on-screen text, product/brand beats), reshape
it into a storyboard ready to drive AI video generation for a NEW video inspired by the same
structure — not a copy of the source.

For each scene, produce:
- prompt: a concrete, visual, single-scene prompt a text-to-video model could act on directly
  (describe the subject, action, and setting — do not just restate the source's on-screen text)
- visualDirection: camera/lighting/tempo suggestions using ONLY these exact field names and
  values (omit a field entirely if you have no strong suggestion for it — never invent a value
  outside this list):
  - cameraMovement: static | pan_left | pan_right | tilt_up | tilt_down | tracking | dolly_in | dolly_out | orbit | handheld | drone | helicopter | pov
  - lens: wide | normal | telephoto | macro | anamorphic | fisheye
  - lighting: natural | golden_hour | blue_hour | studio | silhouette | neon | overcast | dramatic | soft
  - colorPalette: neutral | warm | cool | desaturated | high_contrast | pastel | noir | vintage
  - tempo: calm | dynamic | chaotic | single_shot
  - filmGrain: none | subtle | heavy
  - era: modern | 90s | 80s | 70s | film_noir
  - genre: general | action | epic | drama | comedy | horror | noir | sci_fi | documentary
  - emotion: joy | anger | fear | sadness | surprise | trust | hope | tension | nostalgia
  - cameraType: modern | 35mm_film | 8mm_film | dv_camcorder | iphone | dslr
- durationSec: a suggested duration for this scene, in seconds (positive number)

Preserve the deconstruction's scene order and count exactly (sceneIndex 0-based, matching each
source scene 1:1). Respond with ONLY a JSON array, no prose, no markdown fences:
[{"sceneIndex": number, "prompt": string, "visualDirection": {...}, "durationSec": number}, ...]`;

/** Field names/values copied verbatim from VideoGenRequest.visualDirection in
 *  packages/mcp-video-gen/src/adapters/VideoGenAdapter.ts — do not diverge from that
 *  shape without updating both places. */
export const VisualDirectionSchema = z.object({
  cameraMovement: z
    .enum(["static", "pan_left", "pan_right", "tilt_up", "tilt_down", "tracking", "dolly_in", "dolly_out", "orbit", "handheld", "drone", "helicopter", "pov"])
    .optional(),
  lens: z.enum(["wide", "normal", "telephoto", "macro", "anamorphic", "fisheye"]).optional(),
  lighting: z.enum(["natural", "golden_hour", "blue_hour", "studio", "silhouette", "neon", "overcast", "dramatic", "soft"]).optional(),
  colorPalette: z.enum(["neutral", "warm", "cool", "desaturated", "high_contrast", "pastel", "noir", "vintage"]).optional(),
  tempo: z.enum(["calm", "dynamic", "chaotic", "single_shot"]).optional(),
  filmGrain: z.enum(["none", "subtle", "heavy"]).optional(),
  era: z.enum(["modern", "90s", "80s", "70s", "film_noir"]).optional(),
  genre: z.enum(["general", "action", "epic", "drama", "comedy", "horror", "noir", "sci_fi", "documentary"]).optional(),
  emotion: z.enum(["joy", "anger", "fear", "sadness", "surprise", "trust", "hope", "tension", "nostalgia"]).optional(),
  cameraType: z.enum(["modern", "35mm_film", "8mm_film", "dv_camcorder", "iphone", "dslr"]).optional()
});
export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

export const AdStoryboardSceneSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  prompt: z.string().trim().min(1),
  visualDirection: VisualDirectionSchema.default({}),
  durationSec: z.number().positive()
});
export type AdStoryboardScene = z.infer<typeof AdStoryboardSceneSchema>;

export const AdStoryboardResultSchema = z.array(AdStoryboardSceneSchema).min(1);
export type AdStoryboardResult = z.infer<typeof AdStoryboardResultSchema>;

export async function buildAdStoryboard(
  deconstruction: AdDeconstructionResult,
  opts: { dryRun?: boolean; costLedger?: CostLedger } = {}
): Promise<AdStoryboardResult> {
  if (opts.dryRun) return mockStoryboard(deconstruction);

  const userPrompt = `Raw ad deconstruction (scene-by-scene shot list extracted from the source video):
${JSON.stringify(deconstruction, null, 2)}

Reshape each scene into a video-generation-ready storyboard entry.`;

  // Kimi (kimi-k3) is tried FIRST here, specifically for its long-horizon agentic reasoning
  // on structured extraction/synthesis tasks — a distinct reason from Grok's existing role
  // in this codebase as "the resilient fallback when Gemini is unfunded" (see
  // llm-failover.ts). This is a request, not a guarantee: no MOONSHOT_API_KEY/KIMI_API_KEY
  // exists in this repo's .env, so in practice every real run here falls through to the
  // SAME anthropic->gemini->grok chain every other agent uses. claude-sonnet-5 is that
  // chain's Anthropic-leg model — classified the same way qa-agent's gatekeeping call is:
  // a judgment/synthesis call (moderate reasoning, real downstream consequences — a bad
  // visualDirection choice or vague prompt directly degrades the generated video), not the
  // creative bottleneck (script-agent's claude-fable-5) or mechanical/high-volume work
  // (caption-agent's claude-haiku-4-5). See CLAUDE.md's "Model selection" section.
  const model = "claude-sonnet-5";
  const { text } = await generateWithFailover({
    system: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2048,
    anthropicModel: model,
    geminiModel: "gemini-2.5-pro",
    grokModel: process.env.GROK_MODEL || "grok-2",
    kimiModel: process.env.KIMI_MODEL || "kimi-k3",
    preferredProvider: "kimi",
    stage: "ad_storyboard",
    costLedger: opts.costLedger
  });

  const parsed = JSON.parse(extractJsonArray(text));
  return AdStoryboardResultSchema.parse(parsed);
}

/** Offline fallback for --dry-run — no API call, deterministic 1:1 mapping so dry runs
 *  stay reproducible and exercise the full scene count. */
function mockStoryboard(deconstruction: AdDeconstructionResult): AdStoryboardResult {
  return AdStoryboardResultSchema.parse(
    deconstruction.map((scene, i) => ({
      sceneIndex: i,
      prompt: `[mock] ${scene.shotDescription}`,
      visualDirection: { cameraMovement: "static" as const, lighting: "natural" as const, tempo: "calm" as const },
      durationSec: Math.max(0.5, scene.endSec - scene.startSec)
    }))
  );
}

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`No JSON array found in Claude response: ${text}`);
  return text.slice(start, end + 1);
}
