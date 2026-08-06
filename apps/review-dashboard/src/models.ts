/**
 * Model catalog for the Video Generator / model-choice flow.
 *
 * This is the single source of truth for the models the pipeline can actually
 * invoke. Each model maps to a real adapter in the workspace:
 *   - text/script  -> apps/orchestrator/src/agents/* (Anthropic Claude)
 *   - image        -> packages/mcp-video-gen/src/adapters/gemini.ts
 *   - video        -> packages/mcp-video-gen/src/adapters/{higgsfield,kling,runway,pika,replicate}.ts
 *   - voiceover    -> packages/mcp-voiceover/src/adapters/{grok,elevenlabs}.ts
 *
 * Billing is per-consumption (units -> USD), priced from @vvugc/shared-cost's
 * rate table. The `priceUsdPerUnit` values here mirror those rates so the UI can
 * show the user what a run will cost before they commit, and the actual metering
 * at runtime is done by the CostLedger / overage ledger.
 */
export type ModelKind = "text" | "image" | "video" | "voiceover";

export interface ModelOption {
  /** Stable catalog id (vendor + model). */
  id: string;
  /** The result this model is meant to produce (groups the catalog in the UI). */
  kind: ModelKind;
  /** Human-facing result label, e.g. "Script rewrite". */
  result: string;
  /** Vendor/marketplace name. */
  vendor: string;
  /** Model id/name as the pipeline uses it. */
  model: string;
  /** Short marketing description of what it produces. */
  description: string;
  /** What consumption is metered in (the shared-cost `unit`). */
  unit: string;
  /** Price per single `unit`, in USD, for the user-facing estimate. */
  priceUsdPerUnit: number;
  /** Optional note shown when the model's default differs from the catalog default. */
  note?: string;
}

export const MODEL_CATALOG: ModelOption[] = [
  // --- Script / text (Anthropic Claude, priced per token) ---
  {
    id: "claude-fable-5",
    kind: "text",
    result: "Script rewrite",
    vendor: "Anthropic",
    model: "claude-fable-5",
    description: "Creative bottleneck — rewrites a viral source into your brand's voice.",
    unit: "output_tokens",
    priceUsdPerUnit: 50 / 1_000_000,
    note: "Also meters input tokens at $10/M."
  },
  {
    id: "claude-sonnet-5",
    kind: "text",
    result: "Quality gate / judgment",
    vendor: "Anthropic",
    model: "claude-sonnet-5",
    description: "Scores and flags each candidate before it ships.",
    unit: "output_tokens",
    priceUsdPerUnit: 15 / 1_000_000,
    note: "Also meters input tokens at $3/M."
  },
  {
    id: "claude-haiku-4-5",
    kind: "text",
    result: "Caption timing",
    vendor: "Anthropic",
    model: "claude-haiku-4-5",
    description: "Mechanical, high-volume caption timing per clip.",
    unit: "output_tokens",
    priceUsdPerUnit: 5 / 1_000_000,
    note: "Also meters input tokens at $1/M."
  },

  // --- Image (Gemini) ---
  {
    id: "gemini-2.5-flash-image",
    kind: "image",
    result: "Thumbnail / reference image",
    vendor: "Google Gemini",
    model: "gemini-2.5-flash-image",
    description: "Generates an on-brand reference image for a clip.",
    unit: "image",
    priceUsdPerUnit: 0.039
  },

  // --- Video (text-to-video, priced per clip) ---
  {
    id: "higgsfield:kling3_0_turbo",
    kind: "video",
    result: "Short viral clip",
    vendor: "Higgsfield",
    model: "kling3_0_turbo",
    description: "Fast, prompt-driven text-to-video clips.",
    unit: "clip",
    priceUsdPerUnit: 0.4
  },
  {
    id: "kling",
    kind: "video",
    result: "Short viral clip",
    vendor: "Kling AI",
    model: "kling (text2video)",
    description: "Text-to-video generation via Kling API.",
    unit: "clip",
    priceUsdPerUnit: 0.35
  },
  {
    id: "runway",
    kind: "video",
    result: "Cinematic clip",
    vendor: "Runway",
    model: "runway (text_to_video)",
    description: "Higher-fidelity, more cinematic text-to-video.",
    unit: "clip",
    priceUsdPerUnit: 0.5
  },
  {
    id: "pika:v2.2/text-to-video",
    kind: "video",
    result: "Short viral clip",
    vendor: "Pika",
    model: "pika/v2.2/text-to-video",
    description: "Text-to-video clips hosted on fal.ai.",
    unit: "clip",
    priceUsdPerUnit: 0.3
  },
  {
    id: "replicate:minimax/video-01",
    kind: "video",
    result: "Short viral clip",
    vendor: "Replicate",
    model: "minimax/video-01",
    description: "Marketplace text-to-video; model overridable via REPLICATE_MODEL.",
    unit: "clip",
    priceUsdPerUnit: 0.4,
    note: "Overridable: REPLICATE_MODEL."
  },

  // --- Voiceover (TTS) ---
  {
    id: "grok:tts",
    kind: "voiceover",
    result: "Voiceover narration",
    vendor: "xAI Grok",
    model: "grok (voice eve)",
    description: "Text-to-speech narration from a script's caption cues.",
    unit: "character",
    priceUsdPerUnit: 4.2 / 1_000_000
  },
  {
    id: "elevenlabs:eleven_multilingual_v2",
    kind: "voiceover",
    result: "Voiceover narration",
    vendor: "ElevenLabs",
    model: "eleven_multilingual_v2",
    description: "Multilingual TTS narration.",
    unit: "character",
    priceUsdPerUnit: 0.24 / 1000
  }
];

/** Grouped by result type so the Video Generator UI can show models by goal. */
export function groupModelsByResult(): Record<ModelKind, ModelOption[]> {
  const grouped: Record<ModelKind, ModelOption[]> = {
    text: [],
    image: [],
    video: [],
    voiceover: []
  };
  for (const m of MODEL_CATALOG) grouped[m.kind].push(m);
  return grouped;
}
