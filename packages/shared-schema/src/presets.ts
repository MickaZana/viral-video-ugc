/**
 * Curated Presets — one-click starting configurations for a Studio run or
 * Batch Studio batch, e.g. "Skincare Before/After" or "SaaS Founder Story".
 *
 * A preset is a step ABOVE a UGCTemplate (packages/shared-schema/src/
 * index.ts's UGCTemplateSchema): a template defines a production format's
 * script structure and QA bar; a preset picks a template plus the niche/
 * brand-voice/caption-style/visual-treatment/platform/duration combination
 * that actually works well together for a specific, common use case, so a
 * new user has real starting points instead of an empty form. This is the
 * "curated presets" catch-up item from the Higgsfield gap analysis.
 *
 * The schema/type live here (not in the orchestrator app that owns the
 * actual curated data in apps/orchestrator/src/presets.ts) for the same
 * reason BatchRequest/BatchPlan/UGCTemplate do: the browser-bundled
 * control-panel app needs to import this type directly without pulling in
 * the orchestrator's node-only dependencies (ffmpeg-static etc.).
 */
import { z } from "zod";
import { PlatformSchema } from "./platform.js";
import { CaptionStyleSchema } from "./batch.js";

export const PRESET_CATEGORY_IDS = ["ecommerce_dtc", "saas_apps", "beauty_wellness", "food_beverage"] as const;
export const PresetCategorySchema = z.enum(PRESET_CATEGORY_IDS);
export type PresetCategory = z.infer<typeof PresetCategorySchema>;

export const PresetSchema = z.object({
  id: z.string().min(1).max(80),
  category: PresetCategorySchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  /** References a UGCTemplateSchema id (index.ts's UGC_TEMPLATE_IDSchema) — not
   *  typed as that enum directly to avoid a circular import between this file
   *  and index.ts; getPreset()'s caller cross-checks it against a real
   *  template via getUgcTemplate(). */
  templateId: z.string().min(1),
  niche: z.string().min(1).max(160),
  brandVoice: z.string().min(1).max(300),
  captionStyle: CaptionStyleSchema,
  visualTreatments: z.array(z.string().min(1).max(80)).min(1).max(5),
  platforms: z.array(PlatformSchema).min(1).max(4),
  targetDurationSec: z.number().int().min(15).max(60),
  vendorPolicy: z.enum(["cheapest", "quality"]),
  /** 2-3 example hooks shown as inspiration, not filled into the form
   *  verbatim — the actual hook is always generated fresh per product. */
  exampleHooks: z.array(z.string().min(1).max(200)).min(1).max(3)
});
export type Preset = z.infer<typeof PresetSchema>;
