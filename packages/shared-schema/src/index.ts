import { z } from "zod";
import { VisualDirectionSchema } from "./visual-direction.js";
export { PlatformSchema, type Platform } from "./platform.js";
import { PlatformSchema } from "./platform.js";


export const BrandKitSchema = z.object({
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  captionStyle: z.enum(["clean", "bold", "minimal"]).default("bold"),
  defaultCta: z.string().trim().max(160).optional(),
  forbiddenClaims: z.array(z.string().trim().min(1).max(160)).max(20).default([])
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

export const ProductImageSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1).max(160),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  filePath: z.string().min(1),
  createdAt: z.string().datetime()
});
export type ProductImage = z.infer<typeof ProductImageSchema>;

export const ProductProfileSchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  clientId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(160),
  canonicalUrl: z.string().url().optional(),
  description: z.string().max(5000).default(""),
  shortDescription: z.string().max(500).default(""),
  productCategory: z.string().max(160).default(""),
  targetCustomer: z.string().max(1000).default(""),
  customerPain: z.string().max(1000).default(""),
  primaryBenefits: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  features: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  claims: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  forbiddenClaims: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  differentiators: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  price: z.string().max(120).optional(),
  callToAction: z.string().max(300).default("Learn more"),
  brandTone: z.string().max(500).optional(),
  productImages: z.array(ProductImageSchema).max(12).default([]),
  extractedImageUrls: z.array(z.string().url()).max(12).default([]),
  extractedSourceText: z.string().max(20000).optional(),
  extractionStatus: z.enum(["manual", "pending", "complete", "failed"]).default("manual"),
  extractionError: z.string().max(1000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;

export const CreatorReferenceImageSchema = z.object({
  id: z.string().min(1), fileName: z.string().min(1).max(160), mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), filePath: z.string().min(1), createdAt: z.string().datetime()
});
export type CreatorReferenceImage = z.infer<typeof CreatorReferenceImageSchema>;

export const CreatorProfileSchema = z.object({
  id: z.string().min(1), orgId: z.string().min(1), clientId: z.string().min(1).optional(), displayName: z.string().trim().min(1).max(160), description: z.string().max(3000).default(""), referenceImages: z.array(CreatorReferenceImageSchema).max(8).default([]), faceEmbeddingStatus: z.enum(["none", "training", "ready", "failed"]).default("none"), primaryReferenceImageUrl: z.string().url().optional(), avatarMode: z.enum(["reference_images", "vendor_avatar", "none"]).default("reference_images"), preferredVideoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video"]).optional(), compatibleVendors: z.array(z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video"])).max(8).default([]), voiceVendor: z.enum(["elevenlabs", "grok"]).optional(), voiceId: z.string().trim().max(160).optional(), lipSyncVendor: z.enum(["sync_labs", "heygen", "none"]).default("none"), speechStyle: z.string().max(500).default(""), tone: z.string().max(500).default(""), wardrobe: z.string().max(500).default(""), visualStyle: z.string().max(1000).default(""), ageRange: z.string().max(80).optional(), language: z.string().trim().min(2).max(35).default("en"), accent: z.string().max(120).optional(), prohibitedDepictions: z.array(z.string().trim().min(1).max(300)).max(30).default([]), defaultLocation: z.string().max(300).optional(), consentConfirmed: z.boolean().default(false), consentConfirmedAt: z.string().datetime().optional(), consentConfirmedBy: z.string().min(1).max(200).optional(), active: z.boolean().default(true), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;

export const UGC_TEMPLATE_IDS = ["testimonial", "unboxing", "tutorial", "problem_solution", "comparison", "before_after", "founder_story"] as const;
export const UGC_TEMPLATE_IDSchema = z.enum(UGC_TEMPLATE_IDS);
export const UGCTemplateSchema = z.object({ id: UGC_TEMPLATE_IDSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/), name: z.string().min(1).max(120), description: z.string().max(1000), category: z.string().max(80), targetPlatforms: z.array(PlatformSchema).min(1), recommendedDurationSec: z.number().int().min(15).max(60), scriptStructure: z.array(z.string().min(1).max(120)).min(2).max(12), hookPatterns: z.array(z.string().min(1).max(300)).min(1).max(12), requiredInputs: z.array(z.string().min(1).max(80)).max(20), optionalInputs: z.array(z.string().min(1).max(80)).max(20), visualDirection: z.string().max(1000), cameraDirection: z.string().max(1000), creatorDirection: z.string().max(1000), productPlacementDirection: z.string().max(1000), captionStyle: z.enum(["clean", "bold", "minimal"]), ctaPatterns: z.array(z.string().min(1).max(300)).min(1).max(8), forbiddenPatterns: z.array(z.string().min(1).max(300)).max(20), qaRubric: z.array(z.string().min(1).max(300)).min(1).max(12), defaultVariants: z.array(z.string().min(1).max(120)).max(12), active: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type UGCTemplate = z.infer<typeof UGCTemplateSchema>;

export const TranscriptSegmentSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string()
});

export const TranscriptSchema = z.object({
  videoId: z.string(),
  source: z.enum(["platform_captions", "whisper", "claude_audio"]),
  text: z.string().min(1),
  segments: z.array(TranscriptSegmentSchema).default([])
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const RunConfigSchema = z.object({
  runId: z.string(),
  niche: z.string().min(1),
  platforms: z.array(PlatformSchema).min(1),
  brandVoice: z.string().default("neutral, energetic, concise"),
  brandKit: BrandKitSchema.optional(),
  productProfileId: z.string().min(1).optional(),
  productProfile: ProductProfileSchema.optional(),
  creatorProfileId: z.string().min(1).optional(),
  creatorProfile: CreatorProfileSchema.optional(),
  templateId: UGC_TEMPLATE_IDSchema.optional(),
  template: UGCTemplateSchema.optional(),
  /** BCP-47-ish language tag (e.g. "en", "es", "pt-BR") the script should be written in —
   *  threaded straight into script-agent.ts's prompt. Captions/originality-scoring need no
   *  separate locale handling: captions time whatever text the script already has, and
   *  shared-originality's tokenizer is Unicode-aware (not English-only). */
  locale: z.string().default("en"),
  targetDurationSec: z.number().int().min(15).max(60).default(25),
  maxCandidates: z.number().int().min(1).max(50).default(10),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video"]).default("kling"),
  /** Ordered fallback chain for video generation. If the primary `videoVendor`
   *  fails on a clip, the conductor tries the next vendor in this list (and so on)
   *  before giving up on that platform. The actual vendor that produced each clip
   *  is recorded on the RawClip. When omitted, the conductor falls back to a
   *  cost/quality-sensible default chain (seedance → grok_video → kling → ...), which
   *  can be overridden globally via VIDEO_VENDOR_FALLBACKS. */
  videoVendorFallbacks: z
    .array(z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video"]))
    .max(8)
    .optional(),
  /** Narration synced to burned-in captions (see packages/mcp-voiceover) — opt-in,
   *  omitted means the current silent/vendor-native-audio behavior is unchanged. */
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  /** LipSync vendor for talking-head segments. "none" or undefined = B-roll + voiceover. */
  lipSyncVendor: z.enum(["sync_labs", "heygen", "none"]).default("none"),
  dryRun: z.boolean().default(false),
  autoPost: z.boolean().default(false),
  /** Cinema Controls: visual direction applied to all clips in a run. */
  visualDirection: VisualDirectionSchema.optional(),
  /** Owning account (see @vvugc/shared-auth) — optional so CLI/--dry-run usage
   *  without an account stays exactly as it was; only self-service/API-driven
   *  runs need to tag ownership for usage metering (see shared-auth's usage.ts). */
  accountId: z.string().optional(),
  /** Organization and agency-client ownership. Optional for backwards-compatible
   * CLI runs; every customer-triggered run must provide both. */
  orgId: z.string().optional(),
  clientId: z.string().optional(),
  /** Remix-from-URL ingress: when set, the conductor skips discovery and uses the
   *  transcript of this single source video as the only candidate — the "adapt a
   *  viral video to my niche" flow. `sourceUrl` (raw link the caller pasted) is
   *  kept for provenance on the run; `sourceTranscript` is the resolved captions
   *  (either captured up-front by the remix endpoint, or fetched in-conductor).
   *  Both optional so plain discovery-driven runs are unchanged. */
  sourceUrl: z.string().url().optional(),
  sourceTranscript: TranscriptSchema.optional(),
  /** Optional brief a user riffed from the discovery panel. Threaded into the run
   *  so the Studio can surface "your brief" alongside the live nine-stage progress.
   *  Typed loosely (z.any) on purpose — the brief shape lives in the discovery
   *  analyzer, and importing it here would create a circular workspace dependency. */
  discoveryBrief: z.any().nullable().optional(),
  createdAt: z.string().datetime()
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const VideoMetricsSchema = z.object({
  views: z.number().nonnegative().default(0),
  likes: z.number().nonnegative().default(0),
  comments: z.number().nonnegative().default(0),
  shares: z.number().nonnegative().optional(),
  velocityScore: z.number().nonnegative().optional().describe("views-per-hour or platform-equivalent")
});
export type VideoMetrics = z.infer<typeof VideoMetricsSchema>;

export const CandidateVideoSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  url: z.string().url(),
  title: z.string().optional(),
  publishedAt: z.string().datetime(),
  metrics: VideoMetricsSchema,
  niche: z.string()
});
export type CandidateVideo = z.infer<typeof CandidateVideoSchema>;

export const RewrittenScriptSchema = z.object({
  videoId: z.string(),
  hook: z.string().min(1),
  points: z.array(z.string()).min(1),
  cta: z.string().min(1),
  durationSec: z.number().int().min(15).max(60),
  brandVoice: z.string(),
  /** See RunConfigSchema.locale — carried onto the script so a reviewer/regeneration
   *  call can see what language a script was written in without re-reading RunConfig. */
  locale: z.string().default("en"),
  trendingPhrases: z.array(z.string()).default([]),
  // Zod 4 made z.record() with an enum key exhaustive by default (every enum member
  // required as a key) — this field is genuinely partial (Claude only returns notes
  // for the platforms actually targeted in the request), so it needs partialRecord,
  // not record, to keep the pre-Zod-4 "subset of keys is fine" behavior.
  platformNotes: z.partialRecord(PlatformSchema, z.string()).optional()
});
export type RewrittenScript = z.infer<typeof RewrittenScriptSchema>;

/** Source asset categories permitted in a long-form tutorial scene. */
export const LongFormTutorialAssetTypeSchema = z.enum([
  "screen_recording",
  "slide",
  "screenshot",
  "image",
  "video"
]);
export type LongFormTutorialAssetType = z.infer<typeof LongFormTutorialAssetTypeSchema>;

/** Whether a scene's visual is substantiated evidence or an illustrative workflow. */
export const LongFormTutorialProofStatusSchema = z.enum([
  "verified",
  "illustrative",
  "required_before_release"
]);
export type LongFormTutorialProofStatus = z.infer<typeof LongFormTutorialProofStatusSchema>;

/**
 * A long-form scene must identify the exact source used for its visual asset so
 * the tutorial can be reviewed and reproduced without inventing proof footage.
 */
export const LongFormTutorialSceneSchema = z.object({
  narration: z.string().trim().min(1).max(10000),
  durationSec: z.number().positive(),
  assetType: LongFormTutorialAssetTypeSchema,
  assetPath: z.string().trim().min(1).max(2000),
  source: z.string().trim().min(1).max(2000),
  proofStatus: LongFormTutorialProofStatusSchema
});
export type LongFormTutorialScene = z.infer<typeof LongFormTutorialSceneSchema>;

/**
 * Isolated contract for 16:9 YouTube tutorials. It intentionally does not
 * extend RunConfigSchema or RewrittenScriptSchema: Shorts remain capped at 60s.
 */
export const LongFormTutorialSchema = z.object({
  platform: z.literal("youtube_long"),
  title: z.string().trim().min(1).max(160),
  durationSec: z.number().int().min(300).max(1800),
  aspectRatio: z.literal("16:9"),
  scenes: z.array(LongFormTutorialSceneSchema).min(1).max(100)
}).superRefine((tutorial, ctx) => {
  const sceneDurationSec = tutorial.scenes.reduce((total, scene) => total + scene.durationSec, 0);
  if (sceneDurationSec !== tutorial.durationSec) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scenes"],
      message: "Scene durations must sum exactly to durationSec"
    });
  }
});
export type LongFormTutorial = z.infer<typeof LongFormTutorialSchema>;

export const CaptionCueSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1)
});
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const RawClipSchema = z.object({
  id: z.string(),
  scriptSegmentIndex: z.number().int().nonnegative(),
  vendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video"]),
  filePath: z.string(),
  durationSec: z.number().positive()
});
export type RawClip = z.infer<typeof RawClipSchema>;

export const AssembledVideoSchema = z.object({
  videoId: z.string(),
  platform: PlatformSchema,
  filePath: z.string(),
  durationSec: z.number().positive(),
  aspectRatio: z.enum(["9:16", "1:1", "16:9"]),
  captionsBurned: z.boolean(),
  hashtags: z.array(z.string()).default([]),
  thumbnailPath: z.string().optional(),
  /** True when narration audio (synced to the burned-in captions — see
   *  packages/mcp-voiceover) replaced the vendor clips' own audio track.
   *  Defaults false so older manifests/callers that never set it stay valid. */
  voiceoverAdded: z.boolean().default(false)
});
export type AssembledVideo = z.infer<typeof AssembledVideoSchema>;

export const ReviewItemStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ReviewItemStatus = z.infer<typeof ReviewItemStatusSchema>;

export const ReviewItemSchema = z.object({
  id: z.string(),
  runId: z.string(),
  orgId: z.string().optional(),
  clientId: z.string().optional(),
  productProfileId: z.string().optional(),
  templateId: UGC_TEMPLATE_IDSchema.optional(),
  template: UGCTemplateSchema.optional(),
  niche: z.string(),
  videoPath: z.string(),
  platform: PlatformSchema,
  script: RewrittenScriptSchema,
  score: z.number().min(0).max(100),
  structuralScore: z.number().min(0).max(100).optional(),
  flags: z.array(z.string()).default([]),
  /** Algorithmic "trend-informed but original" check (@vvugc/shared-originality) — separate
   *  from `score`, which is Claude's virality judgment. Optional so older review-queue JSON
   *  entries written before this field existed stay valid. */
  originalityScore: z.number().min(0).max(100).optional(),
  /** Per-segment clips, the caption cues, and (if used) the narration track path — captured
   *  so a reviewer can regenerate one scene or the whole script later (apps/orchestrator/src/
   *  regenerate.ts) without re-running discovery/transcript. All optional: items created before
   *  regeneration existed simply can't be regenerated in place. */
  clips: z.array(RawClipSchema).optional(),
  captions: z.array(CaptionCueSchema).optional(),
  voiceoverPath: z.string().optional(),
  /** The source transcript's full text — needed to recompute originalityScore after a
   *  regeneration, without re-transcribing. */
  sourceTranscriptText: z.string().optional(),
  /** Set once a human-approved item is actually posted (apps/review-dashboard's
   *  POST /queue/:id/publish, @vvugc/mcp-publish) — absent means never published.
   *  Nothing in the pipeline sets these automatically; see docs/architecture.md's
   *  human-review-gate note. */
  publishedPostId: z.string().optional(),
  publishedUrl: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  status: ReviewItemStatusSchema.default("pending"),
  /** True when this item came from a dry-run (mock) pipeline run — see RunConfig.dryRun.
   *  Carried onto the item so the review UI can badge/deprioritize mock items and the
   *  publish route can refuse to ship a fake asset. Defaults to false for items written
   *  before this field existed. */
  dryRun: z.boolean().default(false),
  createdAt: z.string().datetime()
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  /** Mirrors RunConfig.accountId — carried onto the manifest so usage.ts (@vvugc/shared-auth)
   *  can attribute this run's cost-ledger spend to an account without re-reading RunConfig. */
  accountId: z.string().optional(),
  orgId: z.string().optional(),
  clientId: z.string().optional(),
  niche: z.string(),
  candidatesFound: z.number().int().nonnegative(),
  reviewItemsCreated: z.number().int().nonnegative(),
  manifestPath: z.string(),
  completedAt: z.string().datetime(),
  costLedgerPath: z.string().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  /** Candidates skipped entirely (transcript/script rewrite failed) — see conductor.ts's per-candidate try/catch. */
  candidatesFailed: z.number().int().nonnegative().optional(),
  /** Individual platform attempts skipped (video-gen/assembly/QA failed for that candidate+platform only). */
  platformsFailed: z.number().int().nonnegative().optional()
});
export type RunResult = z.infer<typeof RunResultSchema>;

// ─── Batch Variation Generation ─────────────────────────────────────────────
export * from "./batch.js";
export * from "./batch-planner.js";

// ─── Cinema Controls ────────────────────────────────────────────────────────
export * from "./visual-direction.js";
export * from "./segment-type.js";
