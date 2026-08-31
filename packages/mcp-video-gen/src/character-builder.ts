import { z } from "zod";
import { generateImage, type GeneratedImage } from "./adapters/gemini.js";

/**
 * Character Builder: "generate a person from scratch," Higgsfield AI Influencer
 * Studio's equivalent. Deliberately a SEPARATE, standalone flow from the main
 * discovery -> script -> voiceover -> video -> QA -> review pipeline — it has no
 * niche, no script, no platform target. Its only job is: turn a structured set
 * of attributes into a small batch of candidate portrait images, so a user can
 * pick one (or a few) to become a CreatorProfile's referenceImages — the exact
 * same reference-image slot the rest of the app already builds identity
 * consistency around (Soul ID / identityRef, wired into every video adapter).
 *
 * This intentionally does NOT create a CreatorProfile itself or touch the
 * creator store — apps/review-dashboard/src/soul-id-routes.ts's existing
 * POST /accounts/creators/:id/images already owns "attach this image to a
 * creator." Character Builder only produces candidate images; the caller
 * (a new backend route, wired separately) hands the chosen one(s) to that
 * existing upload path, same as if the user had uploaded their own photo.
 */

const CHARACTER_TYPES = ["human", "stylized_illustration", "anime"] as const;
const GENDERS = ["woman", "man", "non_binary_presenting"] as const;
const AGE_RANGES = ["early_20s", "late_20s", "30s", "40s", "50_plus"] as const;
const BODY_TYPES = ["slim", "athletic", "average", "curvy", "muscular", "plus_size"] as const;
const HAIR_STYLES = [
  "long_straight", "long_wavy", "long_curly", "shoulder_length", "short_bob",
  "pixie_cut", "buzz_cut", "braids", "ponytail", "bald"
] as const;
const HAIR_COLORS = ["black", "dark_brown", "light_brown", "blonde", "red", "auburn", "gray", "silver", "dyed_vivid"] as const;
const SKIN_TONES = ["very_fair", "fair", "light_medium", "medium", "tan", "deep", "very_deep"] as const;
const EYE_COLORS = ["brown", "dark_brown", "hazel", "green", "blue", "gray", "amber"] as const;
const STYLES = [
  "casual_everyday", "athletic_activewear", "business_professional", "streetwear",
  "elegant_formal", "cozy_homewear", "outdoorsy"
] as const;
const RENDERING_STYLES = ["photorealistic", "cinematic_photo", "editorial_fashion_photo"] as const;

export const CharacterAttributesSchema = z.object({
  characterType: z.enum(CHARACTER_TYPES).default("human"),
  gender: z.enum(GENDERS),
  ageRange: z.enum(AGE_RANGES),
  bodyType: z.enum(BODY_TYPES).optional(),
  hairStyle: z.enum(HAIR_STYLES).optional(),
  hairColor: z.enum(HAIR_COLORS).optional(),
  skinTone: z.enum(SKIN_TONES).optional(),
  eyeColor: z.enum(EYE_COLORS).optional(),
  style: z.enum(STYLES).default("casual_everyday"),
  renderingStyle: z.enum(RENDERING_STYLES).default("photorealistic"),
  /** Free-text escape hatch for anything the enums above don't cover (e.g.
   *  "small nose stud", "septum piercing", "visible forearm tattoo") — same
   *  role as VideoGenRequest's own free-text prompt alongside its structured
   *  visualDirection fields. Never used to smuggle in a public figure's name,
   *  a franchise character, or another real person's likeness — see
   *  buildCharacterPrompt's negative-prompt guard for enforcement. */
  additionalDetails: z.string().trim().max(500).optional()
});
export type CharacterAttributes = z.infer<typeof CharacterAttributesSchema>;

export const CHARACTER_ATTRIBUTE_OPTIONS = {
  characterType: CHARACTER_TYPES,
  gender: GENDERS,
  ageRange: AGE_RANGES,
  bodyType: BODY_TYPES,
  hairStyle: HAIR_STYLES,
  hairColor: HAIR_COLORS,
  skinTone: SKIN_TONES,
  eyeColor: EYE_COLORS,
  style: STYLES,
  renderingStyle: RENDERING_STYLES
} as const;

const ATTRIBUTE_LABELS: Record<string, string> = {
  characterType: "", // folded into the opening clause instead of a labeled fragment
  gender: "",
  ageRange: "",
  bodyType: "body type",
  hairStyle: "hairstyle",
  hairColor: "hair color",
  skinTone: "skin tone",
  eyeColor: "eye color",
  style: "wearing",
  renderingStyle: ""
};

const AGE_RANGE_PHRASE: Record<(typeof AGE_RANGES)[number], string> = {
  early_20s: "early 20s", late_20s: "late 20s", "30s": "in their 30s", "40s": "in their 40s", "50_plus": "50 or older"
};

const CHARACTER_TYPE_PHRASE: Record<(typeof CHARACTER_TYPES)[number], string> = {
  human: "photorealistic human",
  stylized_illustration: "stylized digital illustration of a person",
  anime: "anime-style character"
};

const RENDERING_STYLE_PHRASE: Record<(typeof RENDERING_STYLES)[number], string> = {
  photorealistic: "photorealistic, natural lighting, shot on a modern mirrorless camera",
  cinematic_photo: "cinematic photo, dramatic but flattering lighting, shallow depth of field",
  editorial_fashion_photo: "editorial fashion photograph, studio lighting, high-detail skin and fabric texture"
};

/**
 * Turns structured attributes into a single, concrete Nano Banana prompt.
 * Deliberately never accepts a person's name, a franchise/character name, or
 * "in the style of X" — CharacterAttributesSchema's fields are all closed
 * enums except additionalDetails, and this function appends an explicit
 * negative instruction so a model that free-associates from additionalDetails
 * doesn't drift toward a real identifiable person. This is a wholly synthetic
 * character generator, not a likeness/impersonation tool.
 */
export function buildCharacterPrompt(attrs: CharacterAttributes, opts: { angle?: string; expression?: string } = {}): string {
  const parts: string[] = [];
  parts.push(
    `A single ${CHARACTER_TYPE_PHRASE[attrs.characterType]}, a ${attrs.gender.replace(/_/g, " ")} ${AGE_RANGE_PHRASE[attrs.ageRange]}`
  );
  if (attrs.bodyType) parts.push(`${attrs.bodyType.replace(/_/g, " ")} build`);
  if (attrs.skinTone) parts.push(`${attrs.skinTone.replace(/_/g, " ")} skin tone`);
  if (attrs.hairStyle || attrs.hairColor) {
    const hair = [attrs.hairColor?.replace(/_/g, " "), attrs.hairStyle?.replace(/_/g, " ")].filter(Boolean).join(" ");
    parts.push(`${hair} hair`);
  }
  if (attrs.eyeColor) parts.push(`${attrs.eyeColor.replace(/_/g, " ")} eyes`);
  parts.push(`wearing ${attrs.style.replace(/_/g, " ")} clothing`);
  if (opts.angle) parts.push(opts.angle);
  if (opts.expression) parts.push(`${opts.expression} expression`);
  if (attrs.additionalDetails) parts.push(attrs.additionalDetails);
  parts.push(RENDERING_STYLE_PHRASE[attrs.renderingStyle]);
  parts.push("plain neutral studio background, centered composition, looking at camera");
  parts.push(
    "This is a wholly fictional, AI-generated person — do not depict any real, identifiable individual, " +
    "public figure, celebrity, or copyrighted/trademarked character."
  );
  return parts.join(", ");
}

export interface CharacterPortraitBatchOptions {
  /** How many candidate portraits to generate (default 4, matching a typical
   *  "pick one of a few" UI grid). Capped at 8 — this is a UI picker, not a
   *  bulk-generation tool. */
  count?: number;
  model?: string;
  aspectRatio?: "9:16" | "1:1" | "16:9";
}

export interface CharacterPortrait extends GeneratedImage {
  index: number;
  prompt: string;
}

const PORTRAIT_VARIATION_ANGLES = [
  { angle: "front-facing headshot", expression: "warm, friendly" },
  { angle: "three-quarter angle headshot", expression: "confident, relaxed" },
  { angle: "front-facing headshot", expression: "genuine, subtle smile" },
  { angle: "three-quarter angle headshot", expression: "calm, neutral" },
  { angle: "front-facing headshot", expression: "bright, engaged" },
  { angle: "three-quarter angle headshot", expression: "warm, approachable" },
  { angle: "front-facing headshot", expression: "thoughtful, composed" },
  { angle: "three-quarter angle headshot", expression: "genuine, subtle smile" }
];

/**
 * Generates a small batch of candidate portraits for the same character
 * (same attributes, varied angle/expression per candidate so the batch is a
 * genuine set of options rather than near-duplicates) — the "generate a
 * person from scratch" step. Sequential, not parallel: this calls the same
 * real Nano Banana endpoint N times, and running them concurrently would
 * just race against the same per-key rate limit for no benefit here (a user
 * reviewing a picker grid isn't time-sensitive the way a pipeline run is).
 */
export async function generateCharacterPortraitBatch(
  attrs: CharacterAttributes,
  opts: CharacterPortraitBatchOptions = {}
): Promise<CharacterPortrait[]> {
  const count = Math.min(Math.max(opts.count ?? 4, 1), 8);
  const portraits: CharacterPortrait[] = [];
  for (let i = 0; i < count; i++) {
    const variation = PORTRAIT_VARIATION_ANGLES[i % PORTRAIT_VARIATION_ANGLES.length];
    const prompt = buildCharacterPrompt(attrs, variation);
    const image = await generateImage(prompt, { model: opts.model, aspectRatio: opts.aspectRatio ?? "1:1" });
    portraits.push({ ...image, index: i, prompt });
  }
  return portraits;
}
