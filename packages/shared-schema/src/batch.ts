/**
 * Batch Variation Generation — Atom A: Request Schema & Types
 *
 * Defines the BatchRequest Zod schema, BatchPlan, BatchVariation,
 * and BatchProgress types, plus non-overridable HARD_LIMITS.
 */
import { z } from "zod";
import { PlatformSchema } from "./platform.js";

// ─── Video Vendor enum (mirrors RawClip["vendor"]) ─────────────────────────
export const VideoVendorSchema = z.enum([
  "higgsfield", "kling", "runway", "pika", "gemini", "replicate", "seedance", "grok_video", "wan"
]);
export type VideoVendor = z.infer<typeof VideoVendorSchema>;

// ─── Caption Style enum ─────────────────────────────────────────────────────
export const CaptionStyleSchema = z.enum(["clean", "bold", "minimal"]);
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

// ─── Vendor Policy ──────────────────────────────────────────────────────────
export const VendorPolicySchema = z.discriminatedUnion("policy", [
  z.object({
    policy: z.literal("cheapest"),
  }),
  z.object({
    policy: z.literal("quality"),
  }),
  z.object({
    policy: z.literal("specific"),
    specificVendor: VideoVendorSchema,
  }),
]);
export type VendorPolicy = z.infer<typeof VendorPolicySchema>;

// ─── Deduplication Mode ─────────────────────────────────────────────────────
export const DeduplicationModeSchema = z.enum(["strict", "relaxed"]);
export type DeduplicationMode = z.infer<typeof DeduplicationModeSchema>;

// ─── HARD LIMITS (not user-overridable) ─────────────────────────────────────
export const HARD_LIMITS = Object.freeze({
  MAX_VARIATIONS_PER_BATCH: 200,
  MAX_CREATORS: 5,
  MAX_HOOKS: 10,
  MAX_PLATFORMS: 4,
  MAX_ESTIMATED_SPEND_USD: 500,
  MAX_CONCURRENT_PROVIDER_JOBS: 10,
  MAX_BATCH_RUNTIME_MINUTES: 120,
  MAX_RETRIES_PER_VARIATION: 3,
});

// ─── BatchRequest Schema ────────────────────────────────────────────────────
export const BatchRequestSchema = z.object({
  productProfileId: z.string().min(1),
  templateId: z.string().min(1).optional(),
  creatorProfileIds: z.array(z.string().min(1)).max(HARD_LIMITS.MAX_CREATORS).default([]),
  hookCount: z.number().int().min(1).max(HARD_LIMITS.MAX_HOOKS).default(3),
  scriptCount: z.number().int().min(1).max(3).default(1),
  visualTreatmentIds: z.array(z.string().min(1)).max(5).optional(),
  captionStyleIds: z.array(CaptionStyleSchema).max(3).optional(),
  ctaVariants: z.array(z.string().min(1).max(300)).max(5).optional(),
  platforms: z.array(PlatformSchema).min(1).max(HARD_LIMITS.MAX_PLATFORMS),
  vendorPolicy: VendorPolicySchema.default({ policy: "cheapest" }),
  targetDurationSec: z.number().int().min(15).max(60).default(25),
  maxVariations: z.number().int().min(1).max(HARD_LIMITS.MAX_VARIATIONS_PER_BATCH).default(50),
  maxEstimatedCostUsd: z.number().min(0).max(HARD_LIMITS.MAX_ESTIMATED_SPEND_USD).default(50),
  dryRun: z.boolean().default(true),
  clientId: z.string().min(1),
  orgId: z.string().min(1),
  locale: z.string().min(2).default("en"),
  deduplicationMode: DeduplicationModeSchema.default("strict"),
  requestedBy: z.string().min(1),
});
export type BatchRequest = z.infer<typeof BatchRequestSchema>;

// ─── Variation Status ───────────────────────────────────────────────────────
export const BatchVariationStatusSchema = z.enum([
  "planned", "queued", "running", "completed", "failed", "cancelled"
]);
export type BatchVariationStatus = z.infer<typeof BatchVariationStatusSchema>;

// ─── BatchVariation ─────────────────────────────────────────────────────────
export interface BatchVariation {
  variationId: string;
  variationLabel: string;
  idempotencyKey: string;
  productProfileId: string;
  creatorProfileId?: string;
  templateId?: string;
  hookIndex: number;
  scriptIndex: number;
  visualTreatment?: string;
  captionStyle: CaptionStyle;
  ctaVariant?: string;
  platform: z.infer<typeof PlatformSchema>;
  vendor: VideoVendor;
  estimatedCost: number;
  status: BatchVariationStatus;
}

// ─── BatchPlan ──────────────────────────────────────────────────────────────
export interface BatchPlan {
  batchId: string;
  variations: BatchVariation[];
  totalEstimatedCost: number;
  warnings: string[];
  rejected: Array<{
    reason: string;
    details?: string;
  }>;
}

// ─── BatchProgress ──────────────────────────────────────────────────────────
export interface BatchProgress {
  batchId: string;
  planned: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  totalVariations: number;
  totalEstimatedCost: number;
  totalActualCost: number;
  startedAt?: string;
  updatedAt: string;
}
