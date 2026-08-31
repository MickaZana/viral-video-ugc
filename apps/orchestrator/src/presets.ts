import { PresetSchema, type Preset } from "@vvugc/shared-schema";

/**
 * Curated starting configurations — see PresetSchema's doc comment
 * (packages/shared-schema/src/presets.ts) for what a preset is and why it's
 * a level above a UGCTemplate. Each `templateId` below references a real
 * BUILTIN_UGC_TEMPLATES id (./templates.ts); each `visualTreatments` entry
 * matches the fixed VISUAL_TREATMENTS list Batch Studio's UI already offers
 * (apps/control-panel/src/pages/BatchStudio.tsx) so a preset's picks are
 * always selectable in that form, not just descriptive text.
 *
 * 4 categories x 4 presets = 16, covering the most common short-form UGC use
 * cases across physical-product, software, beauty/wellness, and food/
 * beverage brands — the "curated presets" catch-up item from the Higgsfield
 * gap analysis (docs/... comparative analysis this session).
 */
const definitions: Preset[] = [
  // ─── E-commerce & DTC ───────────────────────────────────────────────────
  {
    id: "ecom_unboxing_reveal",
    category: "ecommerce_dtc",
    name: "Unboxing Reveal",
    description: "Sensory first-impression unboxing for a physical DTC product — packaging, reveal, first use.",
    templateId: "unboxing",
    niche: "DTC physical product first impressions",
    brandVoice: "excited, sensory, authentic",
    captionStyle: "bold",
    visualTreatments: ["product-closeup", "b-roll-overlay"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 25,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "This just arrived and the packaging is already giving main character energy",
      "Wait until you see what's actually inside this box",
      "I was NOT ready for this unboxing"
    ]
  },
  {
    id: "ecom_customer_testimonial",
    category: "ecommerce_dtc",
    name: "Customer Testimonial",
    description: "Repeat-purchase social proof from a real customer's perspective — credible, not spokesperson-y.",
    templateId: "testimonial",
    niche: "DTC repeat-purchase social proof",
    brandVoice: "warm, personal, believable",
    captionStyle: "clean",
    visualTreatments: ["talking-head", "product-closeup"],
    platforms: ["tiktok", "instagram_reels", "facebook"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "I did not expect this to actually work",
      "3 months in and here's my honest take",
      "If you're on the fence about this, watch this first"
    ]
  },
  {
    id: "ecom_product_comparison",
    category: "ecommerce_dtc",
    name: "Product Comparison",
    description: "Fair, considered side-by-side of two options for a higher-consideration purchase decision.",
    templateId: "comparison",
    niche: "DTC considered-purchase decision help",
    brandVoice: "analytical, fair, confident",
    captionStyle: "minimal",
    visualTreatments: ["split-screen", "product-closeup"],
    platforms: ["tiktok", "youtube_shorts"],
    targetDurationSec: 40,
    vendorPolicy: "quality",
    exampleHooks: [
      "I compared the two so you don't have to",
      "Before you buy either one, watch this"
    ]
  },
  {
    id: "ecom_problem_solution",
    category: "ecommerce_dtc",
    name: "Problem/Solution Demo",
    description: "Tension-led pain point into a concrete product mechanism — direct, no-nonsense conversion format.",
    templateId: "problem_solution",
    niche: "DTC pain-point-driven conversion",
    brandVoice: "relatable, direct, no-nonsense",
    captionStyle: "bold",
    visualTreatments: ["raw-handheld", "product-closeup"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "I was so tired of dealing with this",
      "Nobody tells you this about it until it's too late"
    ]
  },

  // ─── SaaS & Apps ────────────────────────────────────────────────────────
  {
    id: "saas_founder_story",
    category: "saas_apps",
    name: "Founder Story",
    description: "Mission-led origin story connecting a real customer insight to why the product exists.",
    templateId: "founder_story",
    niche: "SaaS/app brand trust and origin",
    brandVoice: "mission-led, specific, credible",
    captionStyle: "clean",
    visualTreatments: ["talking-head", "text-heavy"],
    platforms: ["tiktok", "youtube_shorts", "instagram_reels"],
    targetDurationSec: 45,
    vendorPolicy: "quality",
    exampleHooks: [
      "I started this because I kept seeing the same problem",
      "The real reason we built this might surprise you"
    ]
  },
  {
    id: "saas_feature_tutorial",
    category: "saas_apps",
    name: "Feature Tutorial",
    description: "Step-by-step walkthrough of a specific feature for adoption/activation, not a generic demo.",
    templateId: "tutorial",
    niche: "SaaS/app feature adoption walkthrough",
    brandVoice: "helpful, clear, expert",
    captionStyle: "clean",
    visualTreatments: ["text-heavy", "product-closeup"],
    platforms: ["tiktok", "youtube_shorts"],
    targetDurationSec: 35,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "Here's how I use this to save 5 hours a week",
      "Most people miss this one feature"
    ]
  },
  {
    id: "saas_problem_solution_pitch",
    category: "saas_apps",
    name: "Problem/Solution Pitch",
    description: "Workflow-pain-driven signup pitch — names the friction, then the mechanism that fixes it.",
    templateId: "problem_solution",
    niche: "SaaS workflow-pain-driven signup",
    brandVoice: "confident, tension-led, plain-spoken",
    captionStyle: "bold",
    visualTreatments: ["talking-head", "text-heavy"],
    platforms: ["tiktok", "youtube_shorts", "instagram_reels"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "I was tired of switching between five different tools",
      "This one workflow change saved my team hours"
    ]
  },
  {
    id: "saas_customer_testimonial",
    category: "saas_apps",
    name: "Customer Testimonial",
    description: "Case-study-style social proof with concrete, believable results, not vague praise.",
    templateId: "testimonial",
    niche: "SaaS/app case-study-style social proof",
    brandVoice: "credible, specific, results-driven",
    captionStyle: "clean",
    visualTreatments: ["talking-head"],
    platforms: ["youtube_shorts", "tiktok"],
    targetDurationSec: 35,
    vendorPolicy: "quality",
    exampleHooks: [
      "Since switching, our team ships twice as fast",
      "I was skeptical until I saw the numbers"
    ]
  },

  // ─── Beauty & Wellness ──────────────────────────────────────────────────
  {
    id: "beauty_before_after",
    category: "beauty_wellness",
    name: "Before/After Transformation",
    description: "Qualified transformation story with a real process shown, not just an unsupported before/after.",
    templateId: "before_after",
    niche: "beauty/wellness qualified transformation",
    brandVoice: "encouraging, honest, documentary",
    captionStyle: "bold",
    visualTreatments: ["product-closeup", "lifestyle"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "Here's my before and after using this for 6 weeks",
      "This is what actually changed, no filter"
    ]
  },
  {
    id: "beauty_routine_tutorial",
    category: "beauty_wellness",
    name: "Routine Tutorial",
    description: "Calm, expert walkthrough of a daily routine that naturally features the product in use.",
    templateId: "tutorial",
    niche: "beauty/wellness daily routine walkthrough",
    brandVoice: "calm, expert, approachable",
    captionStyle: "clean",
    visualTreatments: ["talking-head", "product-closeup"],
    platforms: ["tiktok", "instagram_reels", "youtube_shorts"],
    targetDurationSec: 35,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "Here's my exact morning routine step by step",
      "Stop doing this before you try my method instead"
    ]
  },
  {
    id: "beauty_testimonial",
    category: "beauty_wellness",
    name: "Personal Result Testimonial",
    description: "Warm, personal-result story framed as individual experience, not a universal promise.",
    templateId: "testimonial",
    niche: "beauty/wellness personal-result story",
    brandVoice: "warm, personal, relatable",
    captionStyle: "clean",
    visualTreatments: ["talking-head", "product-closeup"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "I did not expect this to change my skin this fast",
      "If your skin does this too, you need to see this"
    ]
  },
  {
    id: "beauty_unboxing",
    category: "beauty_wellness",
    name: "Unboxing First Impressions",
    description: "Product reveal plus first-use reaction — genuine, in-the-moment, not scripted praise.",
    templateId: "unboxing",
    niche: "beauty/wellness product reveal and first use",
    brandVoice: "excited, sensory, genuine",
    captionStyle: "bold",
    visualTreatments: ["product-closeup", "lifestyle"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 25,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "This just arrived and I'm testing it live",
      "The packaging alone is worth it"
    ]
  },

  // ─── Food & Beverage ────────────────────────────────────────────────────
  {
    id: "food_unboxing_first_taste",
    category: "food_beverage",
    name: "Unboxing / First Taste",
    description: "First-impression reveal and reaction for a food or beverage product.",
    templateId: "unboxing",
    niche: "food & beverage first-impression reveal",
    brandVoice: "excited, sensory, fun",
    captionStyle: "bold",
    visualTreatments: ["product-closeup", "lifestyle"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 25,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "This just arrived and I'm trying it on camera",
      "The smell alone sold me before I even opened it"
    ]
  },
  {
    id: "food_recipe_tutorial",
    category: "food_beverage",
    name: "Recipe / Use-Case Tutorial",
    description: "Practical walkthrough of a recipe or use case that puts the product to work.",
    templateId: "tutorial",
    niche: "food & beverage recipe/use-case walkthrough",
    brandVoice: "helpful, warm, practical",
    captionStyle: "clean",
    visualTreatments: ["product-closeup", "b-roll-overlay"],
    platforms: ["tiktok", "instagram_reels", "youtube_shorts"],
    targetDurationSec: 35,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "Here's my go-to way to use this",
      "3 ways I use this that you probably haven't tried"
    ]
  },
  {
    id: "food_taste_test_comparison",
    category: "food_beverage",
    name: "Taste-Test Comparison",
    description: "Playful, honest side-by-side taste test between two options.",
    templateId: "comparison",
    niche: "food & beverage side-by-side taste test",
    brandVoice: "playful, honest, curious",
    captionStyle: "minimal",
    visualTreatments: ["split-screen", "product-closeup"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "I taste-tested both so you don't have to",
      "One of these surprised me"
    ]
  },
  {
    id: "food_customer_testimonial",
    category: "food_beverage",
    name: "Repeat Customer Testimonial",
    description: "Genuine repeat-customer story explaining why the product became a regular habit.",
    templateId: "testimonial",
    niche: "food & beverage repeat-customer story",
    brandVoice: "warm, personal, genuine",
    captionStyle: "clean",
    visualTreatments: ["talking-head", "lifestyle"],
    platforms: ["tiktok", "instagram_reels"],
    targetDurationSec: 30,
    vendorPolicy: "cheapest",
    exampleHooks: [
      "I've ordered this every week for two months",
      "Here's why this became my go-to"
    ]
  }
];

export const BUILTIN_PRESETS: Preset[] = definitions.map((definition) => PresetSchema.parse(definition));
export function getPreset(id: string): Preset | undefined {
  return BUILTIN_PRESETS.find((preset) => preset.id === id);
}
export function listPresetsByCategory(category: Preset["category"]): Preset[] {
  return BUILTIN_PRESETS.filter((preset) => preset.category === category);
}
