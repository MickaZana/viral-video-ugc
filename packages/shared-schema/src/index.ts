import { z } from "zod";

export const PlatformSchema = z.enum(["tiktok", "youtube_shorts", "instagram_reels", "facebook"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const BrandKitSchema = z.object({
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  captionStyle: z.enum(["clean", "bold", "minimal"]).default("bold"),
  defaultCta: z.string().trim().max(160).optional(),
  forbiddenClaims: z.array(z.string().trim().min(1).max(160)).max(20).default([])
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

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
  /** BCP-47-ish language tag (e.g. "en", "es", "pt-BR") the script should be written in —
   *  threaded straight into script-agent.ts's prompt. Captions/originality-scoring need no
   *  separate locale handling: captions time whatever text the script already has, and
   *  shared-originality's tokenizer is Unicode-aware (not English-only). */
  locale: z.string().default("en"),
  targetDurationSec: z.number().int().min(15).max(60).default(25),
  maxCandidates: z.number().int().min(1).max(50).default(10),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate"]).default("higgsfield"),
  /** Ordered fallback chain for video generation. If the primary `videoVendor`
   *  fails on a clip, the conductor tries the next vendor in this list (and so on)
   *  before giving up on that platform. The actual vendor that produced each clip
   *  is recorded on the RawClip. When omitted, the conductor falls back to a
   *  cost/quality-sensible default chain (higgsfield → gemini → replicate), which
   *  can be overridden globally via VIDEO_VENDOR_FALLBACKS. */
  videoVendorFallbacks: z
    .array(z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate"]))
    .max(5)
    .optional(),
  /** Narration synced to burned-in captions (see packages/mcp-voiceover) — opt-in,
   *  omitted means the current silent/vendor-native-audio behavior is unchanged. */
  voiceVendor: z.enum(["elevenlabs", "grok"]).optional(),
  dryRun: z.boolean().default(false),
  autoPost: z.boolean().default(false),
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

export const CaptionCueSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1)
});
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

export const RawClipSchema = z.object({
  id: z.string(),
  scriptSegmentIndex: z.number().int().nonnegative(),
  vendor: z.enum(["higgsfield", "kling", "runway", "pika", "gemini", "replicate"]),
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
  niche: z.string(),
  videoPath: z.string(),
  platform: PlatformSchema,
  script: RewrittenScriptSchema,
  score: z.number().min(0).max(100),
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
