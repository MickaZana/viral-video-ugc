/**
 * growth-memory.ts — Persistent intelligence that learns from every job
 *
 * The growth memory is the pipeline's "brain" — it persists winning patterns,
 * penalizes losing ones, and uses accumulated data to forecast what will work.
 *
 * Key capabilities:
 * 1. Learns from EVERY job (not just published ones) — even rejected items teach
 * 2. Builds a "niche × platform × time" performance model
 * 3. Forecasts which angles/hooks/templates will perform best in the next period
 * 4. Tracks what's trending UP vs fading DOWN across the content landscape
 * 5. Provides concrete recommendations for the next run
 */
import { z } from "zod";
import type { HookCategory } from "./hook-registry.js";

// ─── Memory Schemas ─────────────────────────────────────────────────────────

export const NicheInsightSchema = z.object({
  niche: z.string(),
  platform: z.string(),
  /** What angles worked (high QA + approved + good performance) */
  winningAngles: z.array(z.object({
    angle: z.string(),
    avgViralityScore: z.number(),
    sampleCount: z.number(),
    lastSuccess: z.string().datetime(),
  })).default([]),
  /** What angles flopped (rejected or low performance) */
  losingAngles: z.array(z.object({
    angle: z.string(),
    avgViralityScore: z.number(),
    sampleCount: z.number(),
    lastFailure: z.string().datetime(),
  })).default([]),
  /** Best-performing hook categories for this niche */
  bestHookCategories: z.array(z.string()).default([]),
  /** Best-performing templates for this niche */
  bestTemplates: z.array(z.string()).default([]),
  /** Optimal video duration range for this niche (learned from performance) */
  optimalDurationRange: z.object({
    minSec: z.number().int().min(15).max(60),
    maxSec: z.number().int().min(15).max(60),
  }).default({ minSec: 20, maxSec: 30 }),
  /** Best time patterns (day of week / time of day that gets traction) */
  bestPublishPatterns: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6).optional(), // 0=Sunday
    hourUtc: z.number().int().min(0).max(23).optional(),
    avgViralityBoost: z.number(),
  })).default([]),
  /** Running stats */
  totalVideosProduced: z.number().nonnegative().default(0),
  totalApproved: z.number().nonnegative().default(0),
  totalPublished: z.number().nonnegative().default(0),
  avgViralityScore: z.number().default(0),
  updatedAt: z.string().datetime(),
});
export type NicheInsight = z.infer<typeof NicheInsightSchema>;

export const TrendSignalSchema = z.object({
  /** What's trending (keyword, phrase, format, sound) */
  signal: z.string(),
  /** Category: content format, audio trend, topic, hashtag */
  type: z.enum(["format", "audio", "topic", "hashtag", "hook_style", "cta_style"]),
  /** Platform(s) where observed */
  platforms: z.array(z.string()),
  /** Strength: how many high-performing items used this */
  strength: z.number().min(0).max(100),
  /** Direction */
  direction: z.enum(["emerging", "peaking", "fading"]),
  /** First observed */
  firstSeen: z.string().datetime(),
  /** Last confirmed */
  lastSeen: z.string().datetime(),
});
export type TrendSignal = z.infer<typeof TrendSignalSchema>;

export const GrowthMemorySchema = z.object({
  version: z.number().int().default(1),
  /** Per-niche + per-platform intelligence */
  nicheInsights: z.array(NicheInsightSchema).default([]),
  /** Detected trend signals across all niches */
  trendSignals: z.array(TrendSignalSchema).default([]),
  /** Global learning: patterns that work across ALL niches */
  universalWinners: z.array(z.object({
    pattern: z.string(),
    type: z.enum(["hook", "cta", "structure", "pacing", "caption_style"]),
    avgViralityScore: z.number(),
    sampleCount: z.number(),
  })).default([]),
  /** Global failures: things to avoid regardless of niche */
  universalLosers: z.array(z.object({
    pattern: z.string(),
    reason: z.string(),
    sampleCount: z.number(),
  })).default([]),
  /** Total jobs processed by the memory system */
  totalJobsProcessed: z.number().nonnegative().default(0),
  /** Forecasting model weights (evolve over time) */
  forecastWeights: z.object({
    hookCategoryWeight: z.number().default(0.25),
    nicheRelevanceWeight: z.number().default(0.20),
    templateWeight: z.number().default(0.15),
    trendAlignmentWeight: z.number().default(0.20),
    historicalPerformanceWeight: z.number().default(0.20),
  }).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GrowthMemory = z.infer<typeof GrowthMemorySchema>;

// ─── Memory Operations ──────────────────────────────────────────────────────

/**
 * Initialize a fresh growth memory.
 */
export function createGrowthMemory(): GrowthMemory {
  const now = new Date().toISOString();
  return GrowthMemorySchema.parse({
    version: 1,
    nicheInsights: [],
    trendSignals: [],
    universalWinners: [],
    universalLosers: [],
    totalJobsProcessed: 0,
    forecastWeights: {},
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Learn from a completed pipeline job. This is called after EVERY run,
 * regardless of whether items were approved or published.
 */
export function learnFromJob(
  memory: GrowthMemory,
  job: {
    runId: string;
    niche: string;
    platforms: string[];
    items: Array<{
      hook: string;
      hookCategory?: HookCategory;
      templateId?: string;
      platform: string;
      qaScore: number;
      approved: boolean;
      viralityScore?: number;
      durationSec: number;
      trendingPhrases: string[];
    }>;
  }
): GrowthMemory {
  const updated = { ...memory };
  updated.totalJobsProcessed += 1;

  for (const platform of job.platforms) {
    const platformItems = job.items.filter((i) => i.platform === platform);
    if (platformItems.length === 0) continue;

    // Find or create niche insight
    let insight = updated.nicheInsights.find(
      (n) => n.niche === job.niche && n.platform === platform
    );
    if (!insight) {
      insight = NicheInsightSchema.parse({
        niche: job.niche,
        platform,
        updatedAt: new Date().toISOString(),
      });
      updated.nicheInsights.push(insight);
    }

    // Update stats
    insight.totalVideosProduced += platformItems.length;
    insight.totalApproved += platformItems.filter((i) => i.approved).length;

    // Learn winning/losing angles
    for (const item of platformItems) {
      const angle = extractAngle(item.hook);
      const isWinner = item.approved && item.qaScore >= 80 && (item.viralityScore ?? 50) >= 60;
      const isLoser = !item.approved || item.qaScore < 50 || (item.viralityScore ?? 50) < 30;

      if (isWinner) {
        const existing = insight.winningAngles.find((a) => a.angle === angle);
        if (existing) {
          existing.sampleCount += 1;
          existing.avgViralityScore = existing.avgViralityScore +
            ((item.viralityScore ?? item.qaScore) - existing.avgViralityScore) / existing.sampleCount;
          existing.lastSuccess = new Date().toISOString();
        } else {
          insight.winningAngles.push({
            angle,
            avgViralityScore: item.viralityScore ?? item.qaScore,
            sampleCount: 1,
            lastSuccess: new Date().toISOString(),
          });
        }
      } else if (isLoser) {
        const existing = insight.losingAngles.find((a) => a.angle === angle);
        if (existing) {
          existing.sampleCount += 1;
          existing.avgViralityScore = existing.avgViralityScore +
            ((item.viralityScore ?? item.qaScore) - existing.avgViralityScore) / existing.sampleCount;
          existing.lastFailure = new Date().toISOString();
        } else {
          insight.losingAngles.push({
            angle,
            avgViralityScore: item.viralityScore ?? item.qaScore,
            sampleCount: 1,
            lastFailure: new Date().toISOString(),
          });
        }
      }

      // Track best hook categories
      if (item.hookCategory && isWinner) {
        if (!insight.bestHookCategories.includes(item.hookCategory)) {
          insight.bestHookCategories.push(item.hookCategory);
        }
      }

      // Track best templates
      if (item.templateId && isWinner) {
        if (!insight.bestTemplates.includes(item.templateId)) {
          insight.bestTemplates.push(item.templateId);
        }
      }

      // Learn optimal duration
      if (isWinner && item.durationSec) {
        insight.optimalDurationRange.minSec = Math.min(
          insight.optimalDurationRange.minSec,
          Math.max(15, item.durationSec - 3)
        );
        insight.optimalDurationRange.maxSec = Math.max(
          insight.optimalDurationRange.maxSec,
          Math.min(60, item.durationSec + 3)
        );
      }

      // Detect trending phrases → trend signals
      for (const phrase of item.trendingPhrases) {
        updateTrendSignal(updated, phrase, platform, isWinner);
      }
    }

    insight.updatedAt = new Date().toISOString();

    // Keep lists bounded (top 20 winning, top 10 losing)
    insight.winningAngles = insight.winningAngles
      .sort((a, b) => b.avgViralityScore - a.avgViralityScore)
      .slice(0, 20);
    insight.losingAngles = insight.losingAngles
      .sort((a, b) => a.avgViralityScore - b.avgViralityScore)
      .slice(0, 10);
  }

  updated.updatedAt = new Date().toISOString();
  return updated;
}

/**
 * Forecast what will work for an upcoming run based on accumulated intelligence.
 * Returns concrete recommendations the conductor/script-agent should follow.
 */
export function forecast(
  memory: GrowthMemory,
  query: {
    niche: string;
    platform: string;
    targetDate?: Date;
  }
): ForecastResult {
  const insight = memory.nicheInsights.find(
    (n) => n.niche === query.niche && n.platform === query.platform
  );

  // Get active trend signals for this platform
  const activeTrends = memory.trendSignals.filter(
    (t) => t.platforms.includes(query.platform) && t.direction !== "fading"
  );

  const recommendations: ForecastRecommendation[] = [];
  let predictedViralityScore = 50; // Baseline

  if (insight) {
    // Recommend top winning angles
    for (const angle of insight.winningAngles.slice(0, 3)) {
      recommendations.push({
        type: "angle",
        suggestion: angle.angle,
        confidence: Math.min(95, angle.sampleCount * 15 + 40),
        reason: `Proven winner: ${angle.avgViralityScore.toFixed(0)} avg virality, ${angle.sampleCount} successes`,
      });
    }

    // Recommend best hook categories
    for (const cat of insight.bestHookCategories.slice(0, 2)) {
      recommendations.push({
        type: "hook_category",
        suggestion: cat,
        confidence: 70,
        reason: `Best-performing hook style for ${query.niche} on ${query.platform}`,
      });
    }

    // Warn about losing angles
    for (const loser of insight.losingAngles.slice(0, 2)) {
      recommendations.push({
        type: "avoid",
        suggestion: loser.angle,
        confidence: Math.min(90, loser.sampleCount * 20 + 30),
        reason: `Low performer: ${loser.avgViralityScore.toFixed(0)} avg virality, ${loser.sampleCount} failures`,
      });
    }

    // Recommend optimal duration
    recommendations.push({
      type: "duration",
      suggestion: `${insight.optimalDurationRange.minSec}-${insight.optimalDurationRange.maxSec}s`,
      confidence: 75,
      reason: `Optimal duration range based on ${insight.totalApproved} approved videos`,
    });

    // Predict virality based on historical performance
    predictedViralityScore = insight.avgViralityScore || 50;
    if (insight.winningAngles.length > 3) predictedViralityScore += 10;
  }

  // Incorporate trend signals
  for (const trend of activeTrends.slice(0, 3)) {
    recommendations.push({
      type: "trend",
      suggestion: `${trend.type}: "${trend.signal}"`,
      confidence: trend.strength,
      reason: `${trend.direction} trend on ${trend.platforms.join(", ")}`,
    });
    if (trend.direction === "emerging") predictedViralityScore += 5;
  }

  // Add universal winners
  for (const winner of memory.universalWinners.slice(0, 2)) {
    recommendations.push({
      type: "universal_pattern",
      suggestion: winner.pattern,
      confidence: Math.min(90, winner.sampleCount * 10 + 50),
      reason: `Works across niches: ${winner.avgViralityScore.toFixed(0)} avg virality`,
    });
  }

  return {
    predictedViralityScore: Math.min(100, Math.max(0, predictedViralityScore)),
    recommendations: recommendations.sort((a, b) => b.confidence - a.confidence),
    dataPointsUsed: memory.totalJobsProcessed,
    insightStrength: insight ? Math.min(100, insight.totalVideosProduced * 5) : 0,
  };
}

export interface ForecastResult {
  /** Predicted virality score for content following these recommendations */
  predictedViralityScore: number;
  /** Concrete recommendations sorted by confidence */
  recommendations: ForecastRecommendation[];
  /** How many historical jobs informed this forecast */
  dataPointsUsed: number;
  /** 0-100: how much data we have for this specific niche+platform */
  insightStrength: number;
}

export interface ForecastRecommendation {
  type: "angle" | "hook_category" | "avoid" | "duration" | "trend" | "universal_pattern" | "template";
  suggestion: string;
  confidence: number; // 0-100
  reason: string;
}

/**
 * Prune stale data from memory to keep it focused and current.
 * Call periodically (e.g. weekly) to prevent memory bloat.
 */
export function pruneMemory(memory: GrowthMemory, maxAgeDays: number = 90): GrowthMemory {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  // Remove fading trends older than cutoff
  memory.trendSignals = memory.trendSignals.filter(
    (t) => t.direction !== "fading" || t.lastSeen > cutoff
  );

  // Remove losing angles with very low sample counts that are old
  for (const insight of memory.nicheInsights) {
    insight.losingAngles = insight.losingAngles.filter(
      (a) => a.sampleCount > 1 || a.lastFailure > cutoff
    );
  }

  memory.updatedAt = new Date().toISOString();
  return memory;
}

// ─── Internal Utilities ─────────────────────────────────────────────────────

/** Extract the "angle" from a hook (simplified version of the creative direction) */
function extractAngle(hook: string): string {
  // Remove specific product names and numbers, keep the structural pattern
  return hook
    .replace(/\d+/g, "[N]")
    .replace(/\$[\d,.]+/g, "[PRICE]")
    .toLowerCase()
    .trim()
    .slice(0, 80);
}

/** Update or create a trend signal */
function updateTrendSignal(memory: GrowthMemory, phrase: string, platform: string, isWinner: boolean): void {
  const existing = memory.trendSignals.find((t) => t.signal === phrase);
  if (existing) {
    if (!existing.platforms.includes(platform)) {
      existing.platforms.push(platform);
    }
    existing.lastSeen = new Date().toISOString();
    if (isWinner) {
      existing.strength = Math.min(100, existing.strength + 10);
      if (existing.strength > 70) existing.direction = "peaking";
    } else {
      existing.strength = Math.max(0, existing.strength - 5);
      if (existing.strength < 30) existing.direction = "fading";
    }
  } else if (isWinner) {
    memory.trendSignals.push({
      signal: phrase,
      type: "topic",
      platforms: [platform],
      strength: 40,
      direction: "emerging",
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
  }

  // Cap trend signals at 50
  if (memory.trendSignals.length > 50) {
    memory.trendSignals = memory.trendSignals
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 50);
  }
}
