import { z } from "zod";

export const PlatformSchema = z.enum(["tiktok", "youtube_shorts", "instagram_reels", "facebook"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const RunConfigSchema = z.object({
  runId: z.string(),
  niche: z.string().min(1),
  platforms: z.array(PlatformSchema).min(1),
  brandVoice: z.string().default("neutral, energetic, concise"),
  targetDurationSec: z.number().int().min(15).max(60).default(25),
  maxCandidates: z.number().int().min(1).max(50).default(10),
  videoVendor: z.enum(["higgsfield", "kling", "runway", "pika"]).default("higgsfield"),
  dryRun: z.boolean().default(false),
  autoPost: z.boolean().default(false),
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

export const RewrittenScriptSchema = z.object({
  videoId: z.string(),
  hook: z.string().min(1),
  points: z.array(z.string()).min(1),
  cta: z.string().min(1),
  durationSec: z.number().int().min(15).max(60),
  brandVoice: z.string(),
  trendingPhrases: z.array(z.string()).default([]),
  platformNotes: z.record(PlatformSchema, z.string()).optional()
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
  vendor: z.enum(["higgsfield", "kling", "runway", "pika"]),
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
  thumbnailPath: z.string().optional()
});
export type AssembledVideo = z.infer<typeof AssembledVideoSchema>;

export const ReviewItemSchema = z.object({
  id: z.string(),
  runId: z.string(),
  niche: z.string(),
  videoPath: z.string(),
  platform: PlatformSchema,
  script: RewrittenScriptSchema,
  score: z.number().min(0).max(100),
  flags: z.array(z.string()).default([]),
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  createdAt: z.string().datetime()
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  niche: z.string(),
  candidatesFound: z.number().int().nonnegative(),
  reviewItemsCreated: z.number().int().nonnegative(),
  manifestPath: z.string(),
  completedAt: z.string().datetime(),
  costLedgerPath: z.string().optional(),
  estimatedCostUsd: z.number().nonnegative().optional()
});
export type RunResult = z.infer<typeof RunResultSchema>;
